/*
 * This file is a TypeScript port of the parts of the `hclsyntax` parser that decide whether source is valid, from
 * https://github.com/hashicorp/hcl (Copyright IBM Corp. 2014, 2026).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Terragrunt refuses a file exactly when this parser reports an error in it, so saying the same of a file means
 * following the same rules, one for one. The original recovers after an error to find more; this stops at the
 * first, which is enough to know the source is refused and to say why. What it reports is one of the original's
 * errors, word for word and at the same range: the first the original lists, except that the original lists a
 * one-line block's complaint about how it ends ahead of a failure inside that block, and the failure inside is
 * what is reported here.
 */

import { graphemeClusters } from './grapheme-clusters';
import { scanHclTokens } from './hcl-scanner';
import type { HclToken, HclTokenType } from './hcl-scanner';

/** A position in source text. */
export interface HclPosition {
	/** Counted from zero. */
	offset: number;
	/** Counted from one. */
	line: number;
	/**
	 * Counted from one, as the HCL library counts columns: in grapheme clusters, each token's counted on their own.
	 * It is the column a diagnostic names, and not always how far along the line an editor would put it.
	 */
	column: number;
}

/** Why source is not valid HCL, and where. */
export interface HclSyntaxProblem {
	/** What kind of problem it is, such as "Invalid expression". */
	summary: string;
	/** What is wrong, as a sentence or more. */
	detail: string;
	start: HclPosition;
	end: HclPosition;
}

/** Source that is not valid HCL. The message says where and why; {@link HclSyntaxError.problem} has the parts. */
export class HclSyntaxError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param problem what is wrong and where.
	 */
	constructor(public readonly problem: HclSyntaxProblem) {
		super(`line ${problem.start.line}, column ${problem.start.column}: ${problem.summary}; ${problem.detail}`);
		this.name = 'HclSyntaxError';
	}
}

/** A problem found while checking, before its offsets are turned into positions. */
class Problem extends Error {
	/**
	 * Creates the problem.
	 *
	 * @param summary what kind of problem it is.
	 * @param detail what is wrong; a function when the sentence names where something earlier in the source is.
	 * @param token where the problem is.
	 * @param earlier the part of the source the detail names, when it names one.
	 * @param within when the problem is with a piece of the token, the pieces before it and the piece itself.
	 */
	constructor(
		public readonly summary: string,
		public readonly detail: string | ((earlier: string) => string),
		public readonly token: HclToken,
		public readonly earlier?: { start: number; end: number },
		public readonly within?: { before: string[]; piece: string }
	) {
		super(summary);
	}
}

/**
 * Makes the extent from the start of one token to the end of another.
 *
 * @param first the token it starts with.
 * @param last the token it ends with.
 * @returns a token standing for the extent.
 */
function between(first: HclToken, last: HclToken): HclToken {
	return { ...first, end: last.end };
}

/** How deeply expressions and blocks may nest before the check stops rather than exhaust the stack. */
const maximumNesting = 1000;

const binaryOperators = new Set<HclTokenType>([
	'Or', 'And', 'EqualOp', 'NotEqual', 'GreaterThan', 'GreaterThanEq', 'LessThan', 'LessThanEq',
	'Plus', 'Minus', 'Star', 'Slash', 'Percent'
]);

/** Tokens that are never valid, with what the parser says of each. */
const invalidTokens: Partial<Record<HclTokenType, [string, string]>> = {
	BitwiseAnd: ['Unsupported operator', 'Bitwise operators are not supported. Did you mean boolean AND ("&&")?'],
	BitwiseOr: ['Unsupported operator', 'Bitwise operators are not supported. Did you mean boolean OR ("||")?'],
	BitwiseNot: ['Unsupported operator', 'Bitwise operators are not supported. Did you mean boolean NOT ("!")?'],
	BitwiseXor: ['Unsupported operator', 'Bitwise operators are not supported.'],
	Backtick: ['Invalid character', 'The "`" character is not valid. To create a multi-line string, use the "heredoc" syntax, like "<<EOT".'],
	Apostrophe: ['Invalid character', 'Single quotes are not valid. Use double quotes (") to enclose strings.'],
	Semicolon: ['Invalid character', 'The ";" character is not valid. Use newlines to separate arguments and blocks, and commas to separate items in collection values.'],
	QuotedNewline: ['Invalid multi-line string', 'Quoted strings may not be split over multiple lines. To produce a multi-line string, either use the \\n escape to represent a newline character or use the "heredoc" multi-line template syntax.'],
	Invalid: ['Invalid character', 'This character is not used within the language.']
};

/** What a template is made of, once its expressions have been checked: only the directives' structure is left. */
type TemplatePart = 'content' | 'if' | 'else' | 'endif' | 'for' | 'endfor';

/** One part of a template; for a directive the token spans it from its opening marker to its closing brace. */
interface DirectivePart {
	part: TemplatePart;
	token: HclToken;
}

/**
 * Checks tokens against the HCL grammar, throwing at the first thing the parser would report as an error.
 */
class SyntaxChecker {
	private index = 0;
	private depth = 0;
	/** Whether newlines are tokens or skipped, innermost last: they end arguments but not bracketed expressions. */
	private readonly includeNewlines = [true];

	constructor(private readonly tokens: HclToken[]) {}

	/** Checks a whole configuration file. */
	checkFile(): void {
		this.parseBody('EOF', this.tokens[0]);
	}

	/**
	 * Finds the next token the parser sees: comments are skipped, as are newlines where they do not count, and a
	 * single-line comment stands for the newline it ends with where they do.
	 *
	 * @returns the token and the index after it.
	 */
	private next(): [HclToken, number] {
		const including = this.includeNewlines[this.includeNewlines.length - 1];
		for (let index = this.index; index < this.tokens.length; index++) {
			const token = this.tokens[index];
			if (token.type === 'Comment') {
				if (including && token.text.endsWith('\n')) return [{ ...token, type: 'Newline' }, index + 1];
				continue;
			}
			if (token.type === 'Newline' && !including) continue;
			return [token, index + 1];
		}
		return [this.tokens[this.tokens.length - 1], this.tokens.length];
	}

	private peek(): HclToken {
		return this.next()[0];
	}

	private read(): HclToken {
		const [token, index] = this.next();
		this.index = index;
		return token;
	}

	/**
	 * Reads on to the bracket that closes the one being checked, as the parser does to carry on after a problem.
	 *
	 * @param open the kind of bracket that opens a nested pair.
	 * @param close the kind that closes one.
	 * @returns the closing bracket, or the end of the file when there is none.
	 */
	private recover(open: HclTokenType, close: HclTokenType): HclToken {
		for (let nesting = 0; ;) {
			const token = this.read();
			if (token.type === 'EOF') return token;
			if (token.type === open) nesting++;
			else if (token.type === close && nesting-- < 1) return token;
		}
	}

	/**
	 * Runs a check one level deeper, refusing source nested so deeply that checking it would exhaust the stack.
	 *
	 * @param token where the nesting is, for the message.
	 * @param check the check to run.
	 */
	private nested(token: HclToken, check: () => void): void {
		if (++this.depth > maximumNesting) {
			throw new Problem('Nesting too deep', `Expressions and blocks nested more than ${maximumNesting} deep cannot be checked.`, token);
		}
		check();
		this.depth--;
	}

	/**
	 * Checks the arguments and blocks of a body up to the token that ends it.
	 *
	 * @param end `EOF` for the file's own body, `CBrace` for a block's.
	 * @param opening the token the body starts after, which an unclosed body is reported at.
	 */
	private parseBody(end: 'EOF' | 'CBrace', opening: HclToken): void {
		const attributes = new Map<string, HclToken>();
		for (;;) {
			const next = this.peek();
			if (next.type === end) {
				this.read();
				return;
			}
			if (next.type === 'Newline') {
				this.read();
				continue;
			}
			// An inline function is a statement of the file's own body. It is this project's syntax, not HCL's.
			if (next.type === 'InlineFunction' && end === 'EOF') {
				this.read();
				continue;
			}
			if (next.type === 'Ident') {
				const name = this.parseBodyItem();
				if (name === undefined) continue;
				const existing = attributes.get(name);
				if (existing) {
					throw new Problem('Attribute redefined', earlier => `The argument ${quoted(name)} was already set at ${earlier}. Each argument may be set only once.`, next, existing);
				}
				attributes.set(name, next);
				continue;
			}
			if (next.type === 'OQuote') throw new Problem('Invalid argument name', 'Argument names must not be quoted.', next);
			if (next.type === 'EOF') {
				throw new Problem('Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', opening);
			}
			throw new Problem('Argument or block definition required', 'An argument or block definition is required here.', next);
		}
	}

	/**
	 * Checks one argument or block of a body.
	 *
	 * @returns the argument's name, or undefined for a block.
	 */
	private parseBodyItem(): string | undefined {
		const name = this.read();
		const next = this.peek();
		if (next.type === 'Equal') {
			this.parseAttribute(false);
			return name.text;
		}
		if (next.type === 'OQuote' || next.type === 'OBrace' || next.type === 'Ident') {
			this.nested(name, () => this.parseBlock());
			return undefined;
		}
		throw new Problem('Argument or block definition required', 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.', name);
	}

	/**
	 * Checks an argument from its equals sign.
	 *
	 * @param singleLine true inside a one-line block, whose closing brace ends the argument rather than a newline.
	 */
	private parseAttribute(singleLine: boolean): void {
		this.read();
		this.parseExpression();
		if (singleLine) return;
		const end = this.peek();
		if (end.type === 'Newline' || end.type === 'EOF') {
			this.read();
			return;
		}
		if (end.type === 'Comma') {
			throw new Problem('Unexpected comma after argument', 'Argument definitions must be separated by newlines, not commas. An argument definition must end with a newline.', end);
		}
		throw new Problem('Missing newline after argument', 'An argument definition must end with a newline.', end);
	}

	/** Checks a block from its labels onwards, its type name having been read. */
	private parseBlock(): void {
		let open: HclToken;
		for (;;) {
			const token = this.peek();
			if (token.type === 'OBrace') {
				open = this.read();
				break;
			}
			if (token.type === 'OQuote') {
				this.parseQuotedStringLiteral();
				continue;
			}
			if (token.type === 'Ident') {
				this.read();
				continue;
			}
			if (token.type === 'Equal') {
				throw new Problem('Invalid block definition', 'The equals sign "=" indicates an argument definition, and must not be used when defining a block.', token);
			}
			if (token.type === 'Newline') {
				throw new Problem('Invalid block definition', 'A block definition must have block content delimited by "{" and "}", starting on the same line as the block header.', token);
			}
			throw new Problem('Invalid block definition', 'Either a quoted string block label or an opening brace ("{") is expected here.', token);
		}

		const first = this.peek();
		if (first.type === 'Newline' || first.type === 'EOF' || first.type === 'CBrace') {
			this.parseBody('CBrace', open);
		} else {
			// A block on one line holds exactly one argument.
			const name = this.read();
			if (name.type !== 'Ident') throw new Problem('Argument or block definition required', 'An argument or block definition is required here.', name);
			const next = this.peek();
			if (next.type === 'OQuote' || next.type === 'OBrace' || next.type === 'Ident') {
				throw new Problem('Argument definition required', `A single-line block definition can contain only a single argument. If you meant to define argument "${name.text}", use an equals sign to assign it a value. To define a nested block, place it on a line of its own within its parent block.`, between(name, next));
			}
			if (next.type !== 'Equal') {
				throw new Problem('Argument or block definition required', 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.', name);
			}
			this.parseAttribute(true);
			const close = this.peek();
			if (close.type === 'Comma') {
				throw new Problem('Invalid single-argument block definition', 'Single-line block syntax can include only one argument definition. To define multiple arguments, use the multi-line block syntax with one argument definition per line.', close);
			}
			if (close.type === 'Newline') {
				throw new Problem('Invalid single-argument block definition', 'An argument definition on the same line as its containing block creates a single-line block definition, which must also be closed on the same line. Place the block\'s closing brace immediately after the argument definition.', close);
			}
			if (close.type === 'EOF') {
				throw new Problem('Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', open);
			}
			if (close.type !== 'CBrace') {
				throw new Problem('Invalid single-argument block definition', 'A single-line block definition must end with a closing brace immediately after its single argument definition.', close);
			}
			this.read();
		}

		const end = this.peek();
		if (end.type !== 'Newline' && end.type !== 'EOF') throw new Problem('Missing newline after block definition', 'A block definition must end with a newline.', end);
		this.read();
	}

	/**
	 * Checks an expression and says where it is.
	 *
	 * @returns the expression's extent, from its first token to its last.
	 */
	private parseExpressionSpan(): HclToken {
		const first = this.peek();
		this.parseExpression();
		return between(first, this.tokens[this.index - 1]);
	}

	/** Checks an expression: a conditional, then any pipes, which are this project's syntax and not HCL's. */
	private parseExpression(): void {
		this.nested(this.peek(), () => {
			this.parseOperation();
			if (this.peek().type === 'Question') {
				this.read();
				this.parseExpression();
				const colon = this.peek();
				if (colon.type !== 'Colon') {
					throw new Problem('Missing false expression in conditional', 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.', colon);
				}
				this.read();
				this.parseExpression();
			}
			while (this.peek().type === 'Pipe') {
				const pipe = this.read();
				const name = this.read();
				const after = this.peek().type;
				if (name.type !== 'Ident' || (after !== 'OParen' && after !== 'DoubleColon')) {
					throw new Problem('Invalid pipe', 'The pipe operator ("|>") must be followed by a function call.', name.type === 'Ident' ? pipe : name);
				}
				this.parseFunctionCall(name);
			}
		});
	}

	/** Checks operands joined by binary operators. Precedence decides what they mean, not whether they parse. */
	private parseOperation(): void {
		this.parseTermWithTraversals();
		while (binaryOperators.has(this.peek().type)) {
			this.read();
			this.parseTermWithTraversals();
		}
	}

	/** Checks a term and the attribute accesses, indexes and splats that follow it. */
	private parseTermWithTraversals(): void {
		this.parseTerm();
		for (;;) {
			const next = this.peek();
			if (next.type === 'Dot') {
				this.read();
				const attribute = this.peek();
				if (attribute.type === 'Ident') {
					this.read();
				} else if (attribute.type === 'NumberLit') {
					this.parseLegacyIndex('When using the legacy index syntax, chaining two indexes together is not permitted. Use the proper index syntax instead, like', attribute);
				} else if (attribute.type === 'Star') {
					// An attribute-only splat takes only attribute names and legacy indexes after it.
					this.read();
					while (this.peek().type === 'Dot') {
						this.read();
						const step = this.peek();
						if (step.type === 'NumberLit') {
							this.parseLegacyIndex('When using the legacy index syntax, chaining two indexes together is not permitted. Use the proper index syntax with a full splat expression [*] instead, like', attribute);
						} else if (step.type === 'Star') {
							throw new Problem('Nested splat expression not allowed', 'A splat expression (*) cannot be used inside another attribute-only splat expression.', step);
						} else if (step.type !== 'Ident') {
							throw new Problem('Invalid attribute name', 'An attribute name is required after a dot.', attribute);
						} else {
							this.read();
						}
					}
				} else {
					throw new Problem('Invalid attribute name', 'An attribute name is required after a dot.', attribute);
				}
				continue;
			}
			if (next.type === 'OBrack') {
				this.read();
				if (this.peek().type === 'Star') {
					this.read();
					// The parser reports these two at the bracket it carries on from, not at what it found in its place.
					if (this.read().type !== 'CBrack') {
						throw new Problem('Missing close bracket on splat index', 'The star for a full splat operator must be immediately followed by a closing bracket ("]").', this.recover('OBrack', 'CBrack'));
					}
					continue;
				}
				this.includeNewlines.push(false);
				this.parseExpression();
				if (this.read().type !== 'CBrack') {
					throw new Problem('Missing close bracket on index', 'The index operator must end with a closing bracket ("]").', this.recover('OBrack', 'CBrack'));
				}
				this.includeNewlines.pop();
				continue;
			}
			return;
		}
	}

	/**
	 * Checks a number written after a dot, the old way of indexing.
	 *
	 * @param advice how the message for two such indexes run together begins.
	 * @param subject the token that message is reported at.
	 */
	private parseLegacyIndex(advice: string, subject: HclToken): void {
		const number = this.read();
		const dot = number.text.indexOf('.');
		if (dot >= 0) {
			throw new Problem('Invalid legacy index syntax', `${advice} [${number.text.slice(0, dot)}][${number.text.slice(dot + 1)}].`, subject);
		}
		checkNumber(number);
	}

	/** Checks one term: a literal, a name, a call, a template, a collection, or one of those negated. */
	private parseTerm(): void {
		const start = this.peek();
		switch (start.type) {
			case 'OParen': {
				this.read();
				this.includeNewlines.push(false);
				this.parseExpression();
				const close = this.peek();
				if (close.type !== 'CParen') throw new Problem('Unbalanced parentheses', 'Expected a closing parenthesis to terminate the expression.', close);
				this.read();
				this.includeNewlines.pop();
				return;
			}
			case 'NumberLit':
				checkNumber(this.read());
				return;
			case 'Ident': {
				const name = this.read();
				const after = this.peek().type;
				if (after === 'OParen' || after === 'DoubleColon') this.parseFunctionCall(name);
				return;
			}
			case 'OQuote':
			case 'OHeredoc':
				this.read();
				this.parseTemplate(start.type === 'OQuote' ? 'CQuote' : 'CHeredoc');
				return;
			case 'Minus':
			case 'Bang':
				this.read();
				this.nested(start, () => this.parseTermWithTraversals());
				return;
			case 'OBrack':
				this.parseTuple();
				return;
			case 'OBrace':
				this.parseObject();
				return;
			case 'EOF':
				throw new Problem('Missing expression', 'Expected the start of an expression, but found the end of the file.', start);
			default:
				throw new Problem('Invalid expression', 'Expected the start of an expression, but found an invalid expression token.', start);
		}
	}

	/**
	 * Checks a function call from the token after its name.
	 *
	 * @param name the first part of the function's name, already read.
	 */
	private parseFunctionCall(name: HclToken): void {
		let open = this.read();
		while (open.type === 'DoubleColon') {
			const part = this.read();
			if (part.type !== 'Ident') {
				throw new Problem('Missing function name', 'Function scope resolution symbol :: must be followed by a function name in this scope.', part);
			}
			open = this.read();
		}
		if (open.type !== 'OParen') {
			throw new Problem('Missing open parenthesis', 'Function selector must be followed by an open parenthesis to begin the function call.', open);
		}
		this.includeNewlines.push(false);
		for (;;) {
			if (this.peek().type === 'CParen') {
				this.read();
				break;
			}
			this.parseExpression();
			const separator = this.read();
			if (separator.type === 'CParen') break;
			if (separator.type === 'Ellipsis') {
				if (this.peek().type !== 'CParen') {
					throw new Problem('Missing closing parenthesis', 'An expanded function argument (with ...) must be immediately followed by closing parentheses.', separator);
				}
				this.read();
				break;
			}
			if (separator.type === 'EOF') {
				throw new Problem('Unterminated function call', 'There is no closing parenthesis for this function call before the end of the file. This may be caused by incorrect parenthesis nesting elsewhere in this file.', between(name, open));
			}
			if (separator.type !== 'Comma') {
				throw new Problem('Missing argument separator', 'A comma is required to separate each function argument from the next.', separator);
			}
			// A comma may follow the last argument.
			if (this.peek().type === 'CParen') {
				this.read();
				break;
			}
		}
		this.includeNewlines.pop();
	}

	/** Checks a tuple in square brackets, or the `for` expression that builds one. */
	private parseTuple(): void {
		const open = this.read();
		this.includeNewlines.push(false);
		if (isKeyword(this.peek(), 'for')) {
			this.parseFor(open);
		} else {
			for (;;) {
				if (this.peek().type === 'CBrack') {
					this.read();
					break;
				}
				this.parseExpression();
				const next = this.peek();
				if (next.type === 'CBrack') {
					this.read();
					break;
				}
				if (next.type === 'EOF') {
					throw new Problem('Unterminated tuple constructor expression', 'There is no corresponding closing bracket before the end of the file. This may be caused by incorrect bracket nesting elsewhere in this file.', open);
				}
				if (next.type !== 'Comma') throw new Problem('Missing item separator', 'Expected a comma to mark the beginning of the next item.', next);
				this.read();
			}
		}
		this.includeNewlines.pop();
	}

	/** Checks an object in braces, or the `for` expression that builds one. */
	private parseObject(): void {
		const open = this.read();
		// A `for` expression may start on a later line, though the items of an object are divided by newlines.
		this.includeNewlines.push(false);
		const isFor = isKeyword(this.peek(), 'for');
		this.includeNewlines.pop();
		if (isFor) {
			this.parseFor(open);
			return;
		}
		this.includeNewlines.push(true);
		for (;;) {
			let next = this.peek();
			if (next.type === 'Newline') {
				this.read();
				continue;
			}
			if (next.type === 'CBrace') {
				this.read();
				break;
			}
			this.parseExpression();
			next = this.peek();
			if (next.type !== 'Equal' && next.type !== 'Colon') {
				if (next.type === 'Newline' || next.type === 'Comma') {
					throw new Problem('Missing attribute value', 'Expected an attribute value, introduced by an equals sign ("=").', next);
				}
				if (next.type === 'Ident') {
					throw new Problem('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value. If you intended to given an attribute name containing periods or spaces, write the name in quotes to create a string literal.', next);
				}
				if (next.type === 'EOF') {
					throw new Problem('Unterminated object constructor expression', 'There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', open);
				}
				throw new Problem('Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value.', next);
			}
			this.read();
			this.parseExpression();
			next = this.peek();
			if (next.type === 'CBrace') {
				this.read();
				break;
			}
			if (next.type === 'EOF') {
				throw new Problem('Unterminated object constructor expression', 'There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', open);
			}
			if (next.type !== 'Comma' && next.type !== 'Newline') {
				throw new Problem('Missing attribute separator', 'Expected a newline or comma to mark the beginning of the next attribute.', next);
			}
			this.read();
		}
		this.includeNewlines.pop();
	}

	/**
	 * Checks a `for` expression from its keyword to its closing bracket.
	 *
	 * @param open the bracket or brace it opened with, which decides whether it builds a tuple or an object.
	 */
	private parseFor(open: HclToken): void {
		const object = open.type === 'OBrace';
		const closeType = object ? 'CBrace' : 'CBrack';
		this.includeNewlines.push(false);
		this.read();
		if (this.peek().type !== 'Ident') throw new Problem('Invalid \'for\' expression', 'For expression requires variable name after \'for\'.', this.peek());
		this.read();
		if (this.peek().type === 'Comma') {
			this.read();
			if (this.peek().type !== 'Ident') throw new Problem('Invalid \'for\' expression', 'For expression requires value variable name after comma.', this.peek());
			this.read();
		}
		if (!isKeyword(this.peek(), 'in')) {
			throw new Problem('Invalid \'for\' expression', 'For expression requires the \'in\' keyword after its name declarations.', this.peek());
		}
		this.read();
		this.parseExpression();
		if (this.peek().type !== 'Colon') throw new Problem('Invalid \'for\' expression', 'For expression requires a colon after the collection expression.', this.peek());
		this.read();

		let value = this.parseExpressionSpan();
		let key: HclToken | undefined;
		if (this.peek().type === 'FatArrow') {
			this.read();
			key = value;
			value = this.parseExpressionSpan();
		}
		const ellipsis = this.peek().type === 'Ellipsis' ? this.read() : undefined;
		if (isKeyword(this.peek(), 'if')) {
			this.read();
			this.parseExpression();
		}
		if (this.peek().type !== closeType) throw new Problem('Invalid \'for\' expression', 'Extra characters after the end of the \'for\' expression.', this.peek());
		this.read();
		if (!object && key) throw new Problem('Invalid \'for\' expression', 'Key expression is not valid when building a tuple.', key);
		if (!object && ellipsis) throw new Problem('Invalid \'for\' expression', 'Grouping ellipsis (...) cannot be used when building a tuple.', ellipsis);
		if (object && !key) throw new Problem('Invalid \'for\' expression', 'Key expression is required when building an object.', value);
		this.includeNewlines.pop();
	}

	/** Checks a quoted string that may not hold template sequences, such as a block label. */
	private parseQuotedStringLiteral(): void {
		this.read();
		for (;;) {
			const token = this.read();
			if (token.type === 'CQuote') return;
			if (token.type === 'QuotedLit') {
				checkEscapes(token);
				continue;
			}
			if (token.type === 'TemplateInterp' || token.type === 'TemplateControl') {
				const sigil = token.type === 'TemplateControl' ? '%' : '$';
				throw new Problem('Invalid string literal', `Template sequences are not allowed in this string. To include a literal "${sigil}", double it (as "${sigil}${sigil}") to escape it.`, token);
			}
			if (token.type === 'EOF') throw new Problem('Unterminated string literal', 'Unable to find the closing quote mark before the end of the file.', token);
			throw new Problem('Invalid string literal', 'This item is not valid in a string literal.', token);
		}
	}

	/**
	 * Checks a template from after its opening marker: its literals, the expressions in its sequences, and that its
	 * `if` and `for` directives are closed in order.
	 *
	 * @param end the token that closes it.
	 */
	private parseTemplate(end: 'CQuote' | 'CHeredoc'): void {
		const start = this.peek();
		const parts: DirectivePart[] = [];
		for (;;) {
			const next = this.read();
			if (next.type === end) break;
			if (next.type === 'StringLit') {
				parts.push({ part: 'content', token: next });
			} else if (next.type === 'QuotedLit') {
				checkEscapes(next);
				parts.push({ part: 'content', token: next });
			} else if (next.type === 'TemplateInterp') {
				this.includeNewlines.push(false);
				this.parseExpression();
				const close = this.peek();
				if (close.type !== 'TemplateSeqEnd') {
					if (close.type === 'EOF') {
						throw new Problem('Unclosed template interpolation sequence', 'There is no closing brace for this interpolation sequence before the end of the file. This might be caused by incorrect nesting inside the given expression.', start);
					}
					if (close.type === 'Colon') {
						throw new Problem('Extra characters after interpolation expression', 'Template interpolation doesn\'t expect a colon at this location. Did you intend this to be a literal sequence to be processed as part of another language? If so, you can escape it by starting with "$${" instead of just "${".', close);
					}
					if ((close.type === 'CQuote' || close.type === 'OQuote') && end === 'CQuote') {
						throw new Problem('Unclosed template interpolation sequence', 'There is no closing brace for this interpolation sequence before the end of the quoted template. This might be caused by incorrect nesting inside the given expression.', start);
					}
					throw new Problem('Extra characters after interpolation expression', 'Expected a closing brace to end the interpolation expression, but found extra characters.\n\nThis can happen when you include interpolation syntax for another language, such as shell scripting, but forget to escape the interpolation start token. If this is an embedded sequence for another language, escape it by starting with "$${" instead of just "${".', close);
				}
				this.read();
				this.includeNewlines.pop();
				parts.push({ part: 'content', token: next });
			} else if (next.type === 'TemplateControl') {
				this.includeNewlines.push(false);
				const keyword = this.peek();
				if (keyword.type !== 'Ident') {
					throw new Problem('Invalid template directive', 'A template directive keyword ("if", "for", etc) is expected at the beginning of a %{ sequence.', keyword);
				}
				this.read();
				if (keyword.text === 'if') {
					this.parseExpression();
				} else if (keyword.text === 'for') {
					if (this.peek().type !== 'Ident') throw new Problem('Invalid \'for\' directive', 'For directive requires variable name after \'for\'.', this.peek());
					this.read();
					if (this.peek().type === 'Comma') {
						this.read();
						if (this.peek().type !== 'Ident') throw new Problem('Invalid \'for\' directive', 'For directive requires value variable name after comma.', this.peek());
						this.read();
					}
					if (!isKeyword(this.peek(), 'in')) throw new Problem('Invalid \'for\' directive', 'For directive requires \'in\' keyword after names.', this.peek());
					this.read();
					this.parseExpression();
				} else if (keyword.text !== 'else' && keyword.text !== 'endif' && keyword.text !== 'endfor') {
					const suggestion = ['if', 'for', 'else', 'endif', 'endfor'].find(candidate => editDistance(keyword.text, candidate) < 3);
					throw new Problem('Invalid template control keyword', `"${keyword.text}" is not a valid template control keyword.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, keyword);
				}
				const close = this.peek();
				if (close.type !== 'TemplateSeqEnd') {
					throw new Problem(`Extra characters in ${keyword.text} marker`, 'Expected a closing brace to end the sequence, but found extra characters.', close);
				}
				this.read();
				this.includeNewlines.pop();
				parts.push({ part: keyword.text as TemplatePart, token: { ...next, end: close.end } });
			} else {
				throw new Problem('Unterminated template string', 'No closing marker was found for the string.', next);
			}
		}
		checkDirectives(parts, this.tokens[this.index - 1]);
	}
}

/**
 * Tells whether a token is a given keyword. Keywords are names with a meaning in one place, not tokens of their own.
 *
 * @param token the token.
 * @param keyword the keyword.
 * @returns true when the token is that name.
 */
function isKeyword(token: HclToken, keyword: string): boolean {
	return token.type === 'Ident' && token.text === keyword;
}

/**
 * Quotes text the way Go's `%q` does, which is how the parser shows a character in a message: printable characters
 * as they are, and the rest as escapes.
 *
 * @param text the text.
 * @returns the text in double quotes.
 */
function quoted(text: string): string {
	const named: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '"': '\\"', '\\': '\\\\' };
	let out = '';
	for (const character of text) {
		const code = character.codePointAt(0)!;
		if (named[character] !== undefined) out += named[character];
		else if (/[\p{L}\p{M}\p{N}\p{P}\p{S} ]/u.test(character)) out += character;
		else if (code < 0x80) out += `\\x${code.toString(16).padStart(2, '0')}`;
		else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`;
		else out += `\\U${code.toString(16).padStart(8, '0')}`;
	}
	return `"${out}"`;
}

/**
 * Counts the single-character insertions, deletions and substitutions that turn one string into another.
 *
 * @param from one string.
 * @param to the other.
 * @returns the number of edits.
 */
function editDistance(from: string, to: string): number {
	const left = [...from];
	const right = [...to];
	let previous = right.map((_, index) => index + 1);
	previous.unshift(0);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			current.push(Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)));
		}
		previous = current;
	}
	return previous[right.length];
}

/**
 * Checks that a number literal has a value, as Go's arbitrary-precision parser decides it: digits, an optional
 * fraction, and an optional exponent that fits.
 *
 * @param token the number literal.
 * @throws {Problem} when it has no value.
 */
function checkNumber(token: HclToken): void {
	const parts = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(token.text);
	let valid = parts !== null;
	if (parts) {
		const mantissa = BigInt(parts[1] + (parts[2] ?? ''));
		const exponent = BigInt(parts[3] ?? '0');
		const int64 = 2n ** 63n;
		if (exponent >= int64 || exponent < -int64) valid = false;
		else if (mantissa !== 0n) {
			// The value is the mantissa's bits scaled by a power of ten, and its binary exponent must fit in 32 bits.
			const binaryExponent = BigInt(mantissa.toString(2).length) + exponent - BigInt((parts[2] ?? '').length);
			if (binaryExponent > 2n ** 31n - 1n || binaryExponent < -(2n ** 31n)) valid = false;
		}
	}
	if (!valid) throw new Problem('Invalid number literal', 'Failed to recognize the value of this number literal.', token);
}

/**
 * Cuts the literal text of a quoted string into the pieces the parser reads it as: each escape, each template
 * sigil with its doubling, each line break, and the runs of ordinary text between them.
 *
 * @param text the literal text.
 * @returns the pieces, in order; joined, they are the text.
 */
function quotedPieces(text: string): string[] {
	const pieces: string[] = [];
	let index = 0;
	while (index < text.length) {
		const start = index;
		const character = text[index];
		if (character === '\\') {
			index++;
			const selector = text[index];
			if (selector === 'u' || selector === 'U') {
				index++;
				for (let digits = selector === 'u' ? 4 : 8; digits > 0 && /^[0-9a-fA-F]$/.test(text[index] ?? ''); digits--) index++;
			} else if (selector !== undefined) {
				index += String.fromCodePoint(text.codePointAt(index)!).length;
			}
		} else if (character === '$' || character === '%') {
			index++;
			if (text[index] === character) {
				index++;
				if (text[index] === '{') index++;
			}
		} else if (character === '\r' || character === '\n') {
			index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
		} else {
			while (index < text.length && !'\\$%\r\n'.includes(text[index])) index++;
		}
		pieces.push(text.slice(start, index));
	}
	return pieces;
}

/**
 * Checks the backslash escapes in the literal text of a quoted string.
 *
 * @param token a quoted literal.
 * @throws {Problem} for a backslash that begins no valid escape, reported at that escape.
 */
function checkEscapes(token: HclToken): void {
	const pieces = quotedPieces(token.text);
	pieces.forEach((piece, index) => {
		if (piece[0] !== '\\') return;
		/**
		 * Reports this escape.
		 *
		 * @param detail what is wrong with it.
		 * @returns the problem.
		 */
		const invalid = (detail: string) => new Problem('Invalid escape sequence', detail, token, undefined, { before: pieces.slice(0, index), piece });
		const selector = piece[1];
		if (selector === undefined) throw invalid('Backslash must be followed by an escape sequence selector character.');
		if (selector === 'u' || selector === 'U') {
			const wanted = selector === 'u' ? 4 : 8;
			if (piece.length !== 2 + wanted) throw invalid(`The \\${selector} escape sequence must be followed by ${wanted === 4 ? 'four' : 'eight'} hexadecimal digits.`);
			const code = Number.parseInt(piece.slice(2), 16);
			if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) throw invalid(`Cannot encode character U+${code.toString(16).padStart(4, '0')} in UTF-8.`);
			return;
		}
		if (!'nrt"\\'.includes(selector)) throw invalid(`The symbol ${quoted(piece.slice(1))} is not a valid escape sequence selector.`);
	});
}

/**
 * Checks that the `if` and `for` directives of a template are closed, in order, by `endif` and `endfor`, with at
 * most one `else` in each `if`.
 *
 * @param parts the template's content and directives, in order.
 * @param end the token closing the template, which an unclosed directive is reported at.
 * @throws {Problem} when the directives are unbalanced.
 */
function checkDirectives(parts: DirectivePart[], end: HclToken): void {
	const open: { kind: 'if' | 'for'; inElse: boolean; token: HclToken }[] = [];
	for (const { part, token } of parts) {
		if (part === 'content') continue;
		if (part === 'if' || part === 'for') {
			open.push({ kind: part, inElse: false, token });
			continue;
		}
		const current = open[open.length - 1];
		const unbalanced = 'The control directives within this template are unbalanced.';
		if (current === undefined) throw new Problem(`Unexpected ${part} directive`, unbalanced, token);
		if (part === 'else') {
			if (current.kind === 'for') throw new Problem('Unexpected else directive', 'An else clause is not expected for a for directive.', token);
			if (current.inElse) throw new Problem('Unexpected else directive', earlier => `Already in the else clause for the if started at ${earlier}.`, token, current.token);
			current.inElse = true;
			continue;
		}
		if ((part === 'endif') !== (current.kind === 'if')) {
			const detail = current.kind === 'if'
				? (earlier: string) => `Expecting an endif directive for the if started at ${earlier}.`
				: (earlier: string) => `Expecting an endfor directive corresponding to the for directive at ${earlier}.`;
			throw new Problem(`Unexpected ${part} directive`, detail, token, current.token);
		}
		open.pop();
	}
	const unclosed = open[open.length - 1];
	if (unclosed) {
		throw new Problem('Unexpected end of template', earlier => `The ${unclosed.kind} directive at ${earlier} is missing its corresponding end${unclosed.kind} directive.`, end, unclosed.token);
	}
}

/**
 * Moves a position over text the way the HCL library does: a column for each grapheme cluster, and a new line for
 * each cluster that is a line break.
 *
 * @param from the position before the text.
 * @param text the text.
 * @param breaksLine whether a cluster is a line break.
 * @returns the position after the text.
 */
function advance(from: HclPosition, text: string, breaksLine: (cluster: string) => boolean): HclPosition {
	let { line, column } = from;
	for (const cluster of graphemeClusters(text)) {
		if (breaksLine(cluster)) {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return { offset: from.offset + text.length, line, column };
}

/**
 * Works out where every token starts and ends, as the HCL library's scanner does: token by token, so that a
 * grapheme cluster never reaches from one token into the next, with a column for each byte between tokens. A byte
 * order mark at the start of the source is not a column.
 *
 * @param source the source text.
 * @param tokens its tokens, in order.
 * @returns the positions of the offsets tokens start at and of the offsets they end at.
 */
function tokenPositions(source: string, tokens: HclToken[]): { starts: Map<number, HclPosition>; ends: Map<number, HclPosition> } {
	const starts = new Map<number, HclPosition>();
	const ends = new Map<number, HclPosition>();
	let at: HclPosition = { offset: source.startsWith('\u{FEFF}') ? 1 : 0, line: 1, column: 1 };
	for (const token of tokens) {
		const start = { offset: token.start, line: at.line, column: at.column + Buffer.byteLength(source.slice(at.offset, token.start)) };
		at = advance(start, token.text, cluster => cluster === '\n' || cluster === '\r\n');
		starts.set(token.start, start);
		ends.set(token.end, at);
	}
	return { starts, ends };
}

/**
 * Names a part of the source the way the HCL library does: the file, the line and column it starts at, and the
 * column it ends at, with the line it ends on when that is another.
 *
 * @param filename the name of the source.
 * @param start where the part starts.
 * @param end where it ends.
 * @returns the name.
 */
function rangeText(filename: string, start: HclPosition, end: HclPosition): string {
	return start.line === end.line
		? `${filename}:${start.line},${start.column}-${end.column}`
		: `${filename}:${start.line},${start.column}-${end.line},${end.column}`;
}

/**
 * Finds what the HCL parser Terragrunt uses reports first as an error in source, which is what makes Terragrunt
 * refuse a file: a character the scanner never accepts, wherever it is, and otherwise the first error the parser
 * comes to. Two things here are valid that are not HCL, because they are this project's own syntax: an inline
 * function as a statement of the file, and the pipe operator after an expression.
 *
 * @param source the source text.
 * @param filename the name of the source, which the few messages that point back at an earlier part of it use.
 * @returns the problem, or undefined when the source is valid.
 */
export function findHclSyntaxProblem(source: string, filename = ''): HclSyntaxProblem | undefined {
	const tokens = scanHclTokens(source);
	let found: Problem | undefined;
	try {
		new SyntaxChecker(tokens).checkFile();
	} catch (error) {
		if (!(error instanceof Problem)) throw error;
		found = error;
	}
	// The scanner's objections come before the parser's, so a character that is never valid is what is reported,
	// wherever it is.
	const invalid = tokens.find(token => invalidTokens[token.type] !== undefined);
	if (invalid) {
		const [summary, detail] = invalid.text === '“' || invalid.text === '”'
			? ['Invalid character', '"Curly quotes" are not valid here. These can sometimes be inadvertently introduced when sharing code via documents or discussion forums. It might help to replace the character with a "straight quote".']
			: invalidTokens[invalid.type]!;
		found = new Problem(summary, detail, invalid);
	}
	if (found === undefined) return undefined;
	const { starts, ends } = tokenPositions(source, tokens);
	const detail = typeof found.detail === 'string'
		? found.detail
		: found.detail(rangeText(filename, starts.get(found.earlier!.start)!, ends.get(found.earlier!.end)!));
	let start = starts.get(found.token.start)!;
	let end = ends.get(found.token.end)!;
	if (found.within) {
		// Within a quoted literal the parser counts piece by piece, and takes a lone carriage return for a line break.
		const breaksLine = (cluster: string) => cluster[0] === '\r' || cluster[0] === '\n';
		for (const piece of found.within.before) start = advance(start, piece, breaksLine);
		end = advance(start, found.within.piece, breaksLine);
	}
	return { summary: found.summary, detail, start, end };
}

/**
 * Requires source to be valid HCL, as {@link findHclSyntaxProblem} judges it.
 *
 * @param source the source text.
 * @param filename the name of the source, for the messages that point back at an earlier part of it.
 * @throws {HclSyntaxError} when it is not.
 */
export function assertHclSyntax(source: string, filename = ''): void {
	const problem = findHclSyntaxProblem(source, filename);
	if (problem) throw new HclSyntaxError(problem);
}
