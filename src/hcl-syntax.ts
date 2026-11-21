/*
 * This file is a TypeScript port of the parts of the `hclsyntax` parser that decide whether source is valid, from
 * https://github.com/hashicorp/hcl (Copyright IBM Corp. 2014, 2026).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Terragrunt refuses a file exactly when this parser reports an error in it, so saying the same of a file means
 * following the same rules, one for one. Like the original, it carries on after an error, recovering where the
 * original recovers and keeping quiet where the original keeps quiet, so the errors it lists are the original's, word
 * for word, at the same ranges and in the same order. It keeps as much of the tree as decides what Terragrunt reports
 * after the parser: the extent of each expression, and the literals the original's partial tree holds.
 */

import { CtyNumber, NUMBER_OUT_OF_RANGE } from './cty-number';
import { goQuoted } from './go-quote';
import { graphemeClusters } from './grapheme-clusters';
import { scanHclTokens } from './hcl-scanner';
import type { HclToken, HclTokenType } from './hcl-scanner';

/** A position in source text. */
export interface HclPosition {
	/** Counted from zero. */
	offset: number;
	/** Counted from one; zero only in the empty range the HCL library gives a function call it found no end for. */
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

/**
 * Says where a problem is and what it is, in a line.
 *
 * @param problem the problem.
 * @returns the line, such as `line 2, column 7: Invalid expression; Expected the start of an expression, ...`.
 */
export function describeHclSyntaxProblem(problem: HclSyntaxProblem): string {
	return `line ${problem.start.line}, column ${problem.start.column}: ${problem.summary}; ${problem.detail}`;
}

/**
 * Source that is not valid HCL. The message says where and why for each problem, one to a line;
 * {@link HclSyntaxError.problems} has the parts.
 */
export class HclSyntaxError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param problems what is wrong and where, in the order the parser reports it; never empty.
	 */
	constructor(public readonly problems: HclSyntaxProblem[]) {
		super(problems.map(describeHclSyntaxProblem).join('\n'));
		this.name = 'HclSyntaxError';
	}
}

/** A part of the source, from where it starts to where it ends. */
interface Range {
	start: HclPosition;
	end: HclPosition;
}

/** A token, with the part of the source it covers counted as the HCL library counts it. */
interface PlacedToken extends HclToken {
	range: Range;
}

/** An error the parser reports. */
interface Diagnostic {
	summary: string;
	detail: string;
	subject: Range;
}

/**
 * A literal value of the tree the parser builds: a number, or the placeholder that stands for an expression the
 * parser could not read. Literals of other kinds are never refused after parsing, so they are not kept.
 */
interface Literal {
	range: Range;
	/** The number; undefined when the value is unknown, as a placeholder's and an unreadable number's are. */
	value: CtyNumber | undefined;
}

/** What the parser makes of an expression, as far as anything reported depends on it. */
interface Expression {
	/** Its extent, as the HCL library works it out for the kind of expression it is. */
	range: Range;
	/** The literals its tree holds, in the order the HCL library visits them. */
	literals: Literal[];
	/** Whether it is a literal value itself, which an index folds into a traversal step rather than keeping. */
	literal: boolean;
}

/** What the parser makes of an argument or a block of a body. */
type BodyItem = { kind: 'attribute'; name: PlacedToken; literals: Literal[] } | { kind: 'block'; literals: Literal[] };

/** One piece of a template, as the template parser reads it after the expressions in it have been parsed. */
type TemplatePart =
	| { kind: 'literal'; range: Range }
	| { kind: 'interp'; expression: Expression; range: Range }
	| { kind: 'if'; condition: Expression; range: Range }
	| { kind: 'for'; collection: Expression; range: Range }
	| { kind: 'else' | 'endif' | 'endfor'; range: Range }
	| { kind: 'end'; range: Range };

/** The position of the empty range the HCL library gives a token it never found. */
const nowhere: HclPosition = { offset: 0, line: 0, column: 0 };

/** How deeply expressions and blocks may nest before the check stops rather than exhaust the stack. */
const maximumNesting = 1000;

/** Checking stops when source nests more deeply than {@link maximumNesting}; this carries the error out. */
class TooDeep extends Error {
	constructor(public readonly diagnostic: Diagnostic) {
		super(diagnostic.summary);
	}
}

/**
 * Makes the range from the start of one range to the end of another, as the HCL library's RangeBetween does.
 *
 * @param first the range it starts with.
 * @param last the range it ends with.
 * @returns the range.
 */
function between(first: Range, last: Range): Range {
	return { start: first.start, end: last.end };
}

/** The binary operators, by precedence from the loosest: precedence decides which operands the parser keeps. */
const binaryOperators: Set<HclTokenType>[] = [
	new Set(['Or']),
	new Set(['And']),
	new Set(['EqualOp', 'NotEqual']),
	new Set(['GreaterThan', 'GreaterThanEq', 'LessThan', 'LessThanEq']),
	new Set(['Plus', 'Minus']),
	new Set(['Star', 'Slash', 'Percent'])
];

/** The bracket that opens or closes against each one, for recovering to the end of a bracketed part. */
const oppositeBrackets: Partial<Record<HclTokenType, HclTokenType>> = {
	OBrace: 'CBrace', OBrack: 'CBrack', OParen: 'CParen', OQuote: 'CQuote', OHeredoc: 'CHeredoc',
	CBrace: 'OBrace', CBrack: 'OBrack', CParen: 'OParen', CQuote: 'OQuote', CHeredoc: 'OHeredoc',
	TemplateControl: 'TemplateSeqEnd', TemplateInterp: 'TemplateSeqEnd', TemplateSeqEnd: 'TemplateInterp'
};

/**
 * Finds the bracket that opposes another.
 *
 * @param type the bracket.
 * @returns its opposite, or `Nil` for a token that is not a bracket.
 */
function oppositeBracket(type: HclTokenType): HclTokenType {
	return oppositeBrackets[type] ?? 'Nil';
}

/**
 * Parses tokens as the HCL parser does, collecting every error it reports and the literals of the tree it builds.
 */
class SyntaxChecker {
	private index = 0;
	private depth = 0;
	/** Set once the parser has tried to recover from an error, after which it holds back the errors that follow from it. */
	private recovery = false;
	/** Whether newlines are tokens or skipped, innermost last: they end arguments but not bracketed expressions. */
	private readonly includeNewlines = [true];

	/**
	 * Creates the checker.
	 *
	 * @param tokens the source's tokens, placed.
	 * @param filename the name of the source, which messages that point back at an earlier part of it use.
	 */
	constructor(private readonly tokens: PlacedToken[], private readonly filename: string) {}

	/**
	 * Parses a whole configuration file.
	 *
	 * @returns the errors, in the order the parser reports them, and the literals of the tree it builds.
	 */
	checkFile(): { diagnostics: Diagnostic[]; literals: Literal[] } {
		try {
			const [literals, diagnostics] = this.parseBody('EOF');
			return { diagnostics, literals };
		} catch (error) {
			if (!(error instanceof TooDeep)) throw error;
			return { diagnostics: [error.diagnostic], literals: [] };
		}
	}

	/**
	 * Finds the next token the parser sees: comments are skipped, as are newlines where they do not count, and a
	 * single-line comment stands for the newline it ends with where they do.
	 *
	 * @returns the token and the index after it.
	 */
	private next(): [PlacedToken, number] {
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

	private peek(): PlacedToken {
		return this.next()[0];
	}

	private read(): PlacedToken {
		const [token, index] = this.next();
		this.index = index;
		return token;
	}

	/** The range of the next token the parser sees. */
	private nextRange(): Range {
		return this.peek().range;
	}

	/** The range of the token before the next, whatever kind it is, or of the next when nothing has been read. */
	private previousRange(): Range {
		return this.index === 0 ? this.nextRange() : this.tokens[this.index - 1].range;
	}

	private pushNewlines(include: boolean): void {
		this.includeNewlines.push(include);
	}

	private popNewlines(): void {
		this.includeNewlines.pop();
	}

	/**
	 * Reads on to the token that ends the part being parsed, counting nested brackets of its kind, and leaves the
	 * parser in recovery.
	 *
	 * @param end the kind of token that ends it.
	 * @returns that token, or the end of the file when there is none.
	 */
	private recover(end: HclTokenType): PlacedToken {
		const start = oppositeBracket(end);
		this.recovery = true;
		for (let nesting = 0; ;) {
			const token = this.read();
			// A control sequence's opener differs from an interpolation's, but the same closer ends both.
			const type = end === 'TemplateSeqEnd' && token.type === 'TemplateControl' ? 'TemplateInterp' : token.type;
			if (type === start) {
				nesting++;
			} else if (type === end) {
				if (nesting < 1) return token;
				nesting--;
			} else if (type === 'EOF') {
				return token;
			}
		}
	}

	/**
	 * Reads on to the next bracketed part that opens with a given bracket, and past the bracket that closes it.
	 *
	 * @param start the bracket.
	 */
	private recoverOver(start: HclTokenType): void {
		for (;;) {
			const type = this.read().type;
			if (type === start || type === 'EOF') break;
		}
		this.recover(oppositeBracket(start));
	}

	/** Reads on past the newline that ends the argument or block being parsed, and leaves the parser in recovery. */
	private recoverAfterBodyItem(): void {
		this.recovery = true;
		const open: HclTokenType[] = [];
		for (;;) {
			const token = this.read();
			switch (token.type) {
				case 'Newline':
					if (open.length === 0) return;
					break;
				case 'EOF':
					return;
				case 'OBrace': case 'OBrack': case 'OParen': case 'OQuote': case 'OHeredoc': case 'TemplateInterp': case 'TemplateControl':
					open.push(token.type);
					break;
				case 'CBrace': case 'CBrack': case 'CParen': case 'CQuote': case 'CHeredoc': {
					const opener = oppositeBracket(token.type);
					while (open.length > 0 && open[open.length - 1] !== opener) open.pop();
					open.pop();
					break;
				}
				case 'TemplateSeqEnd':
					while (open.length > 0 && open[open.length - 1] !== 'TemplateInterp' && open[open.length - 1] !== 'TemplateControl') open.pop();
					open.pop();
					break;
			}
		}
	}

	/**
	 * Runs a parse one level deeper, refusing source nested so deeply that parsing it would exhaust the stack.
	 *
	 * @param token where the nesting is, for the message.
	 * @param parse the parse to run.
	 * @returns what it returns.
	 */
	private nested<T>(token: PlacedToken, parse: () => T): T {
		if (++this.depth > maximumNesting) {
			throw new TooDeep({ summary: 'Nesting too deep', detail: `Expressions and blocks nested more than ${maximumNesting} deep cannot be checked.`, subject: token.range });
		}
		const result = parse();
		this.depth--;
		return result;
	}

	/**
	 * Names a part of the source the way the HCL library does: the file, the line and column it starts at, and the
	 * column it ends at, with the line it ends on when that is another.
	 *
	 * @param range the part.
	 * @returns the name.
	 */
	private rangeText(range: Range): string {
		return range.start.line === range.end.line
			? `${this.filename}:${range.start.line},${range.start.column}-${range.end.column}`
			: `${this.filename}:${range.start.line},${range.start.column}-${range.end.line},${range.end.column}`;
	}

	/**
	 * Parses the arguments and blocks of a body up to the token that ends it.
	 *
	 * @param end `EOF` for the file's own body, `CBrace` for a block's.
	 * @returns the literals of its arguments, then those of its blocks, and the errors.
	 */
	private parseBody(end: 'EOF' | 'CBrace'): [Literal[], Diagnostic[]] {
		const attributes = new Map<string, { name: PlacedToken; literals: Literal[] }>();
		const blocks: Literal[][] = [];
		const diagnostics: Diagnostic[] = [];
		const startRange = this.previousRange();
		for (;;) {
			const next = this.peek();
			if (next.type === end) {
				this.read();
				break;
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
				const [item, itemDiagnostics] = this.parseBodyItem();
				diagnostics.push(...itemDiagnostics);
				if (item?.kind === 'block') {
					blocks.push(item.literals);
				} else if (item?.kind === 'attribute') {
					const existing = attributes.get(item.name.text);
					if (existing) {
						diagnostics.push({
							summary: 'Attribute redefined',
							detail: `The argument ${goQuoted(item.name.text)} was already set at ${this.rangeText(existing.name.range)}. Each argument may be set only once.`,
							subject: item.name.range
						});
					} else {
						attributes.set(item.name.text, item);
					}
				}
				continue;
			}
			const bad = this.read();
			if (!this.recovery) {
				if (bad.type === 'OQuote') {
					diagnostics.push({ summary: 'Invalid argument name', detail: 'Argument names must not be quoted.', subject: bad.range });
				} else if (bad.type === 'EOF') {
					diagnostics.push(end === 'CBrace'
						? { summary: 'Unclosed configuration block', detail: 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', subject: startRange }
						: { summary: 'Unclosed configuration body', detail: 'Found end of file before the end of this configuration body.', subject: startRange });
				} else {
					diagnostics.push({ summary: 'Argument or block definition required', detail: 'An argument or block definition is required here.', subject: bad.range });
				}
			}
			this.recover(end);
			break;
		}
		// The library walks a body's arguments before its blocks.
		const literals = [...attributes.values()].flatMap(attribute => attribute.literals);
		for (const block of blocks) literals.push(...block);
		return [literals, diagnostics];
	}

	/**
	 * Parses one argument or block of a body.
	 *
	 * @returns what it is, or undefined when nothing could be made of it, and the errors.
	 */
	private parseBodyItem(): [BodyItem | undefined, Diagnostic[]] {
		const name = this.read();
		const next = this.peek();
		if (next.type === 'Equal') return this.finishParsingBodyAttribute(name, false);
		if (next.type === 'OQuote' || next.type === 'OBrace' || next.type === 'Ident') return this.nested(name, () => this.finishParsingBodyBlock());
		this.recoverAfterBodyItem();
		return [undefined, [{ summary: 'Argument or block definition required', detail: 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.', subject: name.range }]];
	}

	/**
	 * Parses a body of one argument on the line of the block's opening brace, which the brace after it must close.
	 *
	 * @returns the literals of the argument, and the errors.
	 */
	private parseSingleAttributeBody(): [Literal[], Diagnostic[]] {
		const name = this.read();
		if (name.type !== 'Ident') {
			this.recoverAfterBodyItem();
			return [[], [{ summary: 'Argument or block definition required', detail: 'An argument or block definition is required here.', subject: name.range }]];
		}
		const next = this.peek();
		if (next.type === 'Equal') {
			const [attribute, diagnostics] = this.finishParsingBodyAttribute(name, true);
			return [attribute.literals, diagnostics];
		}
		this.recoverAfterBodyItem();
		if (next.type === 'OQuote' || next.type === 'OBrace' || next.type === 'Ident') {
			return [[], [{
				summary: 'Argument definition required',
				detail: `A single-line block definition can contain only a single argument. If you meant to define argument ${goQuoted(name.text)}, use an equals sign to assign it a value. To define a nested block, place it on a line of its own within its parent block.`,
				subject: between(name.range, next.range)
			}]];
		}
		return [[], [{ summary: 'Argument or block definition required', detail: 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.', subject: name.range }]];
	}

	/**
	 * Parses an argument from its equals sign.
	 *
	 * @param name the argument's name, already read.
	 * @param singleLine true inside a one-line block, whose closing brace ends the argument rather than a newline.
	 * @returns the argument, and the errors.
	 */
	private finishParsingBodyAttribute(name: PlacedToken, singleLine: boolean): [{ kind: 'attribute'; name: PlacedToken; literals: Literal[] }, Diagnostic[]] {
		this.read();
		const [expression, diagnostics] = this.parseExpression();
		if (this.recovery && diagnostics.length > 0) {
			this.recoverAfterBodyItem();
		} else if (!singleLine) {
			const end = this.peek();
			if (end.type !== 'Newline' && end.type !== 'EOF') {
				if (!this.recovery) {
					diagnostics.push(end.type === 'Comma'
						? { summary: 'Unexpected comma after argument', detail: 'Argument definitions must be separated by newlines, not commas. An argument definition must end with a newline.', subject: end.range }
						: { summary: 'Missing newline after argument', detail: 'An argument definition must end with a newline.', subject: end.range });
				}
				this.recoverAfterBodyItem();
			} else {
				this.read();
			}
		}
		return [{ kind: 'attribute', name, literals: expression.literals }, diagnostics];
	}

	/**
	 * Parses a block from its labels onwards, its type name having been read.
	 *
	 * @returns the block, and the errors.
	 */
	private finishParsingBodyBlock(): [BodyItem, Diagnostic[]] {
		const diagnostics: Diagnostic[] = [];
		let open: PlacedToken;
		for (;;) {
			const token = this.peek();
			if (token.type === 'OBrace') {
				open = this.read();
				break;
			}
			if (token.type === 'OQuote') {
				diagnostics.push(...this.parseQuotedStringLiteral());
				continue;
			}
			if (token.type === 'Ident') {
				this.read();
				continue;
			}
			if (token.type === 'Equal') {
				diagnostics.push({ summary: 'Invalid block definition', detail: 'The equals sign "=" indicates an argument definition, and must not be used when defining a block.', subject: token.range });
			} else if (token.type === 'Newline') {
				diagnostics.push({ summary: 'Invalid block definition', detail: 'A block definition must have block content delimited by "{" and "}", starting on the same line as the block header.', subject: token.range });
			} else if (!this.recovery) {
				diagnostics.push({ summary: 'Invalid block definition', detail: 'Either a quoted string block label or an opening brace ("{") is expected here.', subject: token.range });
			}
			this.recoverAfterBodyItem();
			return [{ kind: 'block', literals: [] }, diagnostics];
		}

		let body: [Literal[], Diagnostic[]];
		const first = this.peek().type;
		if (first === 'Newline' || first === 'EOF' || first === 'CBrace') {
			body = this.parseBody('CBrace');
		} else {
			body = this.parseSingleAttributeBody();
			const close = this.peek();
			if (close.type === 'CBrace') {
				this.read();
			} else {
				if (close.type === 'Comma') {
					diagnostics.push({ summary: 'Invalid single-argument block definition', detail: 'Single-line block syntax can include only one argument definition. To define multiple arguments, use the multi-line block syntax with one argument definition per line.', subject: close.range });
				} else if (close.type === 'Newline') {
					diagnostics.push({ summary: 'Invalid single-argument block definition', detail: 'An argument definition on the same line as its containing block creates a single-line block definition, which must also be closed on the same line. Place the block\'s closing brace immediately after the argument definition.', subject: close.range });
				} else if (!this.recovery) {
					diagnostics.push(close.type === 'EOF'
						? { summary: 'Unclosed configuration block', detail: 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', subject: open.range }
						: { summary: 'Invalid single-argument block definition', detail: 'A single-line block definition must end with a closing brace immediately after its single argument definition.', subject: close.range });
				}
				this.recover('CBrace');
			}
		}
		// The library lists a one-line block's complaints about how it ends ahead of what went wrong inside it.
		diagnostics.push(...body[1]);

		const end = this.peek();
		if (end.type === 'Newline' || end.type === 'EOF') {
			this.read();
		} else {
			if (!this.recovery) diagnostics.push({ summary: 'Missing newline after block definition', detail: 'A block definition must end with a newline.', subject: end.range });
			this.recoverAfterBodyItem();
		}
		return [{ kind: 'block', literals: body[0] }, diagnostics];
	}

	/** Parses an expression: a conditional, then any pipes, which are this project's syntax and not HCL's. */
	private parseExpression(): [Expression, Diagnostic[]] {
		return this.nested(this.peek(), () => {
			let [expression, diagnostics] = this.parseTernaryConditional();
			if (this.recovery && diagnostics.length > 0) return [expression, diagnostics];
			while (this.peek().type === 'Pipe') {
				const pipe = this.read();
				const name = this.read();
				const after = this.peek().type;
				if (name.type !== 'Ident' || (after !== 'OParen' && after !== 'DoubleColon')) {
					if (!this.recovery) diagnostics.push({ summary: 'Invalid pipe', detail: 'The pipe operator ("|>") must be followed by a function call.', subject: name.type === 'Ident' ? pipe.range : name.range });
					this.recovery = true;
					return [expression, diagnostics];
				}
				const [call, callDiagnostics] = this.finishParsingFunctionCall(name);
				diagnostics = [...diagnostics, ...callDiagnostics];
				expression = { range: between(expression.range, call.range), literals: [...expression.literals, ...call.literals], literal: false };
				if (this.recovery && callDiagnostics.length > 0) return [expression, diagnostics];
			}
			return [expression, diagnostics];
		});
	}

	/** Parses a conditional, or the operation it would start with. */
	private parseTernaryConditional(): [Expression, Diagnostic[]] {
		const startRange = this.nextRange();
		const [condition, diagnostics] = this.parseBinaryOperations(0);
		if (this.recovery && diagnostics.length > 0) return [condition, diagnostics];
		if (this.peek().type !== 'Question') return [condition, diagnostics];
		this.read();

		const [whenTrue, trueDiagnostics] = this.parseExpression();
		diagnostics.push(...trueDiagnostics);
		if (this.recovery && trueDiagnostics.length > 0) return [condition, diagnostics];

		const colon = this.peek();
		if (colon.type !== 'Colon') {
			diagnostics.push({ summary: 'Missing false expression in conditional', detail: 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.', subject: colon.range });
			return [condition, diagnostics];
		}
		this.read();

		const [whenFalse, falseDiagnostics] = this.parseExpression();
		diagnostics.push(...falseDiagnostics);
		if (this.recovery && falseDiagnostics.length > 0) return [condition, diagnostics];
		return [{ range: between(startRange, whenFalse.range), literals: [...condition.literals, ...whenTrue.literals, ...whenFalse.literals], literal: false }, diagnostics];
	}

	/**
	 * Parses operands joined by the binary operators of one precedence and those that bind more tightly.
	 *
	 * @param level the precedence, as an index into {@link binaryOperators}.
	 */
	private parseBinaryOperations(level: number): [Expression, Diagnostic[]] {
		if (level === binaryOperators.length) return this.parseExpressionWithTraversals();
		const operators = binaryOperators[level];
		let [left, diagnostics] = this.parseBinaryOperations(level + 1);
		if (this.recovery && diagnostics.length > 0) return [left, diagnostics];
		let right: Expression | undefined;
		while (operators.has(this.peek().type)) {
			if (right) left = combined(left, right);
			this.read();
			let rightDiagnostics: Diagnostic[];
			[right, rightDiagnostics] = this.parseBinaryOperations(level + 1);
			diagnostics = [...diagnostics, ...rightDiagnostics];
			if (this.recovery && rightDiagnostics.length > 0) return [left, diagnostics];
		}
		return [right ? combined(left, right) : left, diagnostics];
	}

	/** Parses a term and the attribute accesses, indexes and splats that follow it. */
	private parseExpressionWithTraversals(): [Expression, Diagnostic[]] {
		const [term, diagnostics] = this.parseExpressionTerm();
		const [result, more] = this.parseExpressionTraversals(term);
		return [result, [...diagnostics, ...more]];
	}

	/**
	 * Parses the attribute accesses, indexes and splats after an expression.
	 *
	 * @param from the expression they follow.
	 */
	private parseExpressionTraversals(from: Expression): [Expression, Diagnostic[]] {
		const diagnostics: Diagnostic[] = [];
		let result = from;
		traversal: for (;;) {
			const next = this.peek();
			if (next.type === 'Dot') {
				const dot = this.read();
				const attribute = this.peek();
				if (attribute.type === 'Ident') {
					this.read();
					result = traversed(result, between(dot.range, attribute.range));
				} else if (attribute.type === 'NumberLit') {
					const number = this.read();
					if (number.text.includes('.')) {
						const [whole, fraction] = splitAtFirstDot(number.text);
						diagnostics.push({ summary: 'Invalid legacy index syntax', detail: `When using the legacy index syntax, chaining two indexes together is not permitted. Use the proper index syntax instead, like [${whole}][${fraction}].`, subject: number.range });
					} else {
						diagnostics.push(...numberValue(number)[1]);
					}
					result = traversed(result, between(dot.range, number.range));
				} else if (attribute.type === 'Star') {
					// An attribute-only splat takes only attribute names and legacy indexes after it.
					const marker = this.read();
					let lastRange = marker.range;
					while (this.peek().type === 'Dot') {
						this.read();
						const step = this.peek();
						if (step.type === 'NumberLit') {
							const number = this.read();
							if (number.text.includes('.')) {
								const [whole, fraction] = splitAtFirstDot(number.text);
								diagnostics.push({ summary: 'Invalid legacy index syntax', detail: `When using the legacy index syntax, chaining two indexes together is not permitted. Use the proper index syntax with a full splat expression [*] instead, like [${whole}][${fraction}].`, subject: attribute.range });
							} else {
								diagnostics.push(...numberValue(number)[1]);
							}
							lastRange = number.range;
							continue;
						}
						if (step.type !== 'Ident') {
							if (!this.recovery) {
								diagnostics.push(step.type === 'Star'
									? { summary: 'Nested splat expression not allowed', detail: 'A splat expression (*) cannot be used inside another attribute-only splat expression.', subject: step.range }
									: { summary: 'Invalid attribute name', detail: 'An attribute name is required after a dot.', subject: attribute.range });
							}
							this.recovery = true;
							continue traversal;
						}
						lastRange = this.read().range;
					}
					result = { range: between(from.range, lastRange), literals: result.literals, literal: false };
				} else {
					diagnostics.push({ summary: 'Invalid attribute name', detail: 'An attribute name is required after a dot.', subject: attribute.range });
					result = { range: between(from.range, dot.range), literals: [], literal: false };
					this.recovery = true;
				}
				continue;
			}
			if (next.type === 'OBrack') {
				const open = this.read();
				if (this.peek().type === 'Star') {
					this.read();
					let close = this.read();
					if (close.type !== 'CBrack' && !this.recovery) {
						// The library keeps a pointer to the token it found, then points that at the bracket it recovers
						// to, so the error is reported there.
						close = this.recover('CBrack');
						diagnostics.push({ summary: 'Missing close bracket on splat index', detail: 'The star for a full splat operator must be immediately followed by a closing bracket ("]").', subject: close.range });
					}
					const item: Expression = { range: between(open.range, close.range), literals: [], literal: false };
					const [each, nested] = this.parseExpressionTraversals(item);
					diagnostics.push(...nested);
					result = { range: between(from.range, each.range), literals: [...result.literals, ...each.literals], literal: false };
					continue;
				}
				let close: PlacedToken;
				this.pushNewlines(false);
				const [key, keyDiagnostics] = this.parseExpression();
				diagnostics.push(...keyDiagnostics);
				if (this.recovery && keyDiagnostics.length > 0) {
					close = this.recover('CBrack');
				} else {
					close = this.read();
					if (close.type !== 'CBrack' && !this.recovery) {
						close = this.recover('CBrack');
						diagnostics.push({ summary: 'Missing close bracket on index', detail: 'The index operator must end with a closing bracket ("]").', subject: close.range });
					}
				}
				this.popNewlines();
				// A literal key becomes a step of the traversal, so the literal is no longer in the tree.
				result = key.literal
					? traversed(result, between(open.range, close.range))
					: { range: between(from.range, close.range), literals: [...result.literals, ...key.literals], literal: false };
				continue;
			}
			return [result, diagnostics];
		}
	}

	/** Parses one term: a literal, a name, a call, a template, a collection, or one of those negated. */
	private parseExpressionTerm(): [Expression, Diagnostic[]] {
		const start = this.peek();
		switch (start.type) {
			case 'OParen': {
				const open = this.read();
				this.pushNewlines(false);
				const [expression, diagnostics] = this.parseExpression();
				if (diagnostics.length > 0) {
					this.recover('CParen');
					this.popNewlines();
					return [expression, diagnostics];
				}
				const close = this.peek();
				if (close.type !== 'CParen') {
					diagnostics.push({ summary: 'Unbalanced parentheses', detail: 'Expected a closing parenthesis to terminate the expression.', subject: close.range });
					this.recovery = true;
				}
				const closed = this.read();
				this.popNewlines();
				return [{ range: between(open.range, closed.range), literals: expression.literals, literal: false }, diagnostics];
			}
			case 'NumberLit': {
				const token = this.read();
				const [value, diagnostics] = numberValue(token);
				return [{ range: token.range, literals: [{ range: token.range, value }], literal: true }, diagnostics];
			}
			case 'Ident': {
				const name = this.read();
				const after = this.peek().type;
				if (after === 'OParen' || after === 'DoubleColon') return this.finishParsingFunctionCall(name);
				return [{ range: name.range, literals: [], literal: name.text === 'true' || name.text === 'false' || name.text === 'null' }, []];
			}
			case 'OQuote':
			case 'OHeredoc': {
				const open = this.read();
				const [literals, diagnostics] = this.parseTemplate(start.type === 'OQuote' ? 'CQuote' : 'CHeredoc');
				return [{ range: between(open.range, this.previousRange()), literals, literal: false }, diagnostics];
			}
			case 'Minus':
			case 'Bang': {
				this.read();
				const [operand, diagnostics] = this.nested(start, () => this.parseExpressionWithTraversals());
				return [{ range: between(start.range, operand.range), literals: operand.literals, literal: false }, diagnostics];
			}
			case 'OBrack':
				return this.parseTupleConstructor();
			case 'OBrace':
				return this.parseObjectConstructor();
			default: {
				const diagnostics: Diagnostic[] = [];
				if (!this.recovery) {
					diagnostics.push(start.type === 'EOF'
						? { summary: 'Missing expression', detail: 'Expected the start of an expression, but found the end of the file.', subject: start.range }
						: { summary: 'Invalid expression', detail: 'Expected the start of an expression, but found an invalid expression token.', subject: start.range });
				}
				this.recovery = true;
				// A placeholder keeps the tree whole where there is no expression.
				return [{ range: start.range, literals: [{ range: start.range, value: undefined }], literal: true }, diagnostics];
			}
		}
	}

	/**
	 * Parses a function call from the token after its name.
	 *
	 * @param name the first part of the function's name, already read.
	 */
	private finishParsingFunctionCall(name: PlacedToken): [Expression, Diagnostic[]] {
		const diagnostics: Diagnostic[] = [];
		let open = this.read();
		while (open.type === 'DoubleColon') {
			const part = this.read();
			if (part.type !== 'Ident') {
				diagnostics.push({ summary: 'Missing function name', detail: 'Function scope resolution symbol :: must be followed by a function name in this scope.', subject: part.range });
				this.recoverOver('OParen');
				return [{ range: between(name.range, part.range), literals: [], literal: false }, diagnostics];
			}
			open = this.read();
		}
		if (open.type !== 'OParen') {
			diagnostics.push({ summary: 'Missing open parenthesis', detail: 'Function selector must be followed by an open parenthesis to begin the function call.', subject: open.range });
			this.recoverOver('OParen');
			return [{ range: between(name.range, open.range), literals: [], literal: false }, diagnostics];
		}

		const literals: Literal[] = [];
		// Where the call ends, unless recovering from an error in its arguments reached the end of the file.
		let close: PlacedToken | undefined;
		this.pushNewlines(false);
		for (;;) {
			if (this.peek().type === 'CParen') {
				close = this.read();
				break;
			}
			const [argument, argumentDiagnostics] = this.parseExpression();
			literals.push(...argument.literals);
			diagnostics.push(...argumentDiagnostics);
			if (this.recovery && argumentDiagnostics.length > 0) {
				const recovered = this.recover('CParen');
				if (recovered.type === 'CParen') close = recovered;
				break;
			}
			const separator = this.read();
			if (separator.type === 'CParen') {
				close = separator;
				break;
			}
			if (separator.type === 'Ellipsis') {
				if (this.peek().type !== 'CParen') {
					if (!this.recovery) diagnostics.push({ summary: 'Missing closing parenthesis', detail: 'An expanded function argument (with ...) must be immediately followed by closing parentheses.', subject: separator.range });
					close = this.recover('CParen');
				} else {
					close = this.read();
				}
				break;
			}
			if (separator.type !== 'Comma') {
				diagnostics.push(separator.type === 'EOF'
					? { summary: 'Unterminated function call', detail: 'There is no closing parenthesis for this function call before the end of the file. This may be caused by incorrect parenthesis nesting elsewhere in this file.', subject: between(name.range, open.range) }
					: { summary: 'Missing argument separator', detail: 'A comma is required to separate each function argument from the next.', subject: separator.range });
				close = this.recover('CParen');
				break;
			}
			// A comma may follow the last argument.
			if (this.peek().type === 'CParen') {
				close = this.read();
				break;
			}
		}
		this.popNewlines();
		return [{ range: { start: name.range.start, end: close ? close.range.end : nowhere }, literals, literal: false }, diagnostics];
	}

	/** Parses a tuple in square brackets, or the `for` expression that builds one. */
	private parseTupleConstructor(): [Expression, Diagnostic[]] {
		const open = this.read();
		this.pushNewlines(false);
		const result = isKeyword(this.peek(), 'for') ? this.finishParsingForExpression(open) : this.finishParsingTuple(open);
		this.popNewlines();
		return result;
	}

	/**
	 * Parses the items of a tuple.
	 *
	 * @param open its opening bracket, already read.
	 */
	private finishParsingTuple(open: PlacedToken): [Expression, Diagnostic[]] {
		const literals: Literal[] = [];
		const diagnostics: Diagnostic[] = [];
		let close: PlacedToken;
		for (;;) {
			if (this.peek().type === 'CBrack') {
				close = this.read();
				break;
			}
			const [item, itemDiagnostics] = this.parseExpression();
			literals.push(...item.literals);
			diagnostics.push(...itemDiagnostics);
			if (this.recovery && itemDiagnostics.length > 0) {
				close = this.recover('CBrack');
				break;
			}
			const next = this.peek();
			if (next.type === 'CBrack') {
				close = this.read();
				break;
			}
			if (next.type !== 'Comma') {
				if (!this.recovery) {
					diagnostics.push(next.type === 'EOF'
						? { summary: 'Unterminated tuple constructor expression', detail: 'There is no corresponding closing bracket before the end of the file. This may be caused by incorrect bracket nesting elsewhere in this file.', subject: open.range }
						: { summary: 'Missing item separator', detail: 'Expected a comma to mark the beginning of the next item.', subject: next.range });
				}
				close = this.recover('CBrack');
				break;
			}
			this.read();
		}
		return [{ range: between(open.range, close.range), literals, literal: false }, diagnostics];
	}

	/** Parses an object in braces, or the `for` expression that builds one. */
	private parseObjectConstructor(): [Expression, Diagnostic[]] {
		const open = this.read();
		// A `for` expression may start on a later line, though the items of an object are divided by newlines.
		this.pushNewlines(false);
		const isFor = isKeyword(this.peek(), 'for');
		this.popNewlines();
		if (isFor) return this.finishParsingForExpression(open);

		this.pushNewlines(true);
		const literals: Literal[] = [];
		const diagnostics: Diagnostic[] = [];
		let close: PlacedToken;
		for (;;) {
			let next = this.peek();
			if (next.type === 'Newline') {
				this.read();
				continue;
			}
			if (next.type === 'CBrace') {
				close = this.read();
				break;
			}
			const [key, keyDiagnostics] = this.parseExpression();
			diagnostics.push(...keyDiagnostics);
			if (this.recovery && keyDiagnostics.length > 0) {
				close = this.recover('CBrace');
				break;
			}
			next = this.peek();
			if (next.type !== 'Equal' && next.type !== 'Colon') {
				if (!this.recovery) {
					if (next.type === 'Newline' || next.type === 'Comma') {
						diagnostics.push({ summary: 'Missing attribute value', detail: 'Expected an attribute value, introduced by an equals sign ("=").', subject: next.range });
					} else if (next.type === 'Ident') {
						diagnostics.push({ summary: 'Missing key/value separator', detail: 'Expected an equals sign ("=") to mark the beginning of the attribute value. If you intended to given an attribute name containing periods or spaces, write the name in quotes to create a string literal.', subject: next.range });
					} else if (next.type === 'EOF') {
						diagnostics.push({ summary: 'Unterminated object constructor expression', detail: 'There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', subject: open.range });
					} else {
						diagnostics.push({ summary: 'Missing key/value separator', detail: 'Expected an equals sign ("=") to mark the beginning of the attribute value.', subject: next.range });
					}
				}
				close = this.recover('CBrace');
				break;
			}
			this.read();
			const [value, valueDiagnostics] = this.parseExpression();
			diagnostics.push(...valueDiagnostics);
			// An item joins the tree once its value has been parsed, whatever became of the value.
			literals.push(...key.literals, ...value.literals);
			if (this.recovery && valueDiagnostics.length > 0) {
				close = this.recover('CBrace');
				break;
			}
			next = this.peek();
			if (next.type === 'CBrace') {
				close = this.read();
				break;
			}
			if (next.type !== 'Comma' && next.type !== 'Newline') {
				if (!this.recovery) {
					diagnostics.push(next.type === 'EOF'
						? { summary: 'Unterminated object constructor expression', detail: 'There is no corresponding closing brace before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.', subject: open.range }
						: { summary: 'Missing attribute separator', detail: 'Expected a newline or comma to mark the beginning of the next attribute.', subject: next.range });
				}
				close = this.recover('CBrace');
				break;
			}
			this.read();
		}
		this.popNewlines();
		return [{ range: between(open.range, close.range), literals, literal: false }, diagnostics];
	}

	/**
	 * Parses a `for` expression from its keyword to its closing bracket.
	 *
	 * @param open the bracket or brace it opened with, which decides whether it builds a tuple or an object.
	 */
	private finishParsingForExpression(open: PlacedToken): [Expression, Diagnostic[]] {
		this.pushNewlines(false);
		const result = this.parseForExpression(open);
		this.popNewlines();
		return result;
	}

	/**
	 * Parses the parts of a `for` expression.
	 *
	 * @param open the bracket or brace it opened with.
	 */
	private parseForExpression(open: PlacedToken): [Expression, Diagnostic[]] {
		this.read();
		const object = open.type === 'OBrace';
		const closeType = object ? 'CBrace' : 'CBrack';
		const diagnostics: Diagnostic[] = [];
		/**
		 * Gives up on the expression, which the tree then holds a placeholder for, from its opening bracket to the
		 * one it recovered to.
		 *
		 * @param close the bracket recovered to.
		 * @returns the placeholder, and the errors.
		 */
		const placeholder = (close: PlacedToken): [Expression, Diagnostic[]] => {
			const range = between(open.range, close.range);
			return [{ range, literals: [{ range, value: undefined }], literal: true }, diagnostics];
		};
		/**
		 * Reports a missing part where the parser stands, unless it is recovering, and gives up on the expression.
		 *
		 * @param detail what is missing.
		 * @returns the placeholder, and the errors.
		 */
		const invalid = (detail: string): [Expression, Diagnostic[]] => {
			if (!this.recovery) diagnostics.push({ summary: 'Invalid \'for\' expression', detail, subject: this.peek().range });
			return placeholder(this.recover(closeType));
		};

		if (this.peek().type !== 'Ident') return invalid('For expression requires variable name after \'for\'.');
		this.read();
		if (this.peek().type === 'Comma') {
			this.read();
			if (this.peek().type !== 'Ident') return invalid('For expression requires value variable name after comma.');
			this.read();
		}
		if (!isKeyword(this.peek(), 'in')) return invalid('For expression requires the \'in\' keyword after its name declarations.');
		this.read();

		const [collection, collectionDiagnostics] = this.parseExpression();
		diagnostics.push(...collectionDiagnostics);
		if (this.recovery && collectionDiagnostics.length > 0) return placeholder(this.recover(closeType));
		if (this.peek().type !== 'Colon') return invalid('For expression requires a colon after the collection expression.');
		this.read();

		let [value, valueDiagnostics] = this.parseExpression();
		let key: Expression | undefined;
		let keyDiagnostics: Diagnostic[] = [];
		if (this.peek().type === 'FatArrow') {
			this.read();
			[key, keyDiagnostics] = [value, valueDiagnostics];
			[value, valueDiagnostics] = this.parseExpression();
		}
		diagnostics.push(...keyDiagnostics, ...valueDiagnostics);
		if (this.recovery && (keyDiagnostics.length > 0 || valueDiagnostics.length > 0)) return placeholder(this.recover(closeType));

		const ellipsis = this.peek().type === 'Ellipsis' ? this.read() : undefined;
		let condition: Expression | undefined;
		if (isKeyword(this.peek(), 'if')) {
			this.read();
			let conditionDiagnostics: Diagnostic[];
			[condition, conditionDiagnostics] = this.parseExpression();
			diagnostics.push(...conditionDiagnostics);
			if (this.recovery && conditionDiagnostics.length > 0) return placeholder(this.recover(oppositeBracket(open.type)));
		}

		let close: PlacedToken;
		if (this.peek().type === closeType) {
			close = this.read();
		} else {
			if (!this.recovery) diagnostics.push({ summary: 'Invalid \'for\' expression', detail: 'Extra characters after the end of the \'for\' expression.', subject: this.peek().range });
			close = this.recover(closeType);
		}
		if (!object) {
			if (key) diagnostics.push({ summary: 'Invalid \'for\' expression', detail: 'Key expression is not valid when building a tuple.', subject: key.range });
			if (ellipsis) diagnostics.push({ summary: 'Invalid \'for\' expression', detail: 'Grouping ellipsis (...) cannot be used when building a tuple.', subject: ellipsis.range });
		} else if (!key) {
			diagnostics.push({ summary: 'Invalid \'for\' expression', detail: 'Key expression is required when building an object.', subject: value.range });
		}
		const literals = [...collection.literals, ...(key?.literals ?? []), ...value.literals, ...(condition?.literals ?? [])];
		return [{ range: between(open.range, close.range), literals, literal: false }, diagnostics];
	}

	/**
	 * Parses a quoted string that may not hold template sequences, such as a block label.
	 *
	 * @returns the errors.
	 */
	private parseQuotedStringLiteral(): Diagnostic[] {
		this.read();
		const diagnostics: Diagnostic[] = [];
		for (;;) {
			const token = this.read();
			if (token.type === 'CQuote') break;
			if (token.type === 'QuotedLit') {
				diagnostics.push(...escapeDiagnostics(token));
			} else if (token.type === 'TemplateInterp' || token.type === 'TemplateControl') {
				const sigil = token.type === 'TemplateControl' ? '%' : '$';
				diagnostics.push({ summary: 'Invalid string literal', detail: `Template sequences are not allowed in this string. To include a literal "${sigil}", double it (as "${sigil}${sigil}") to escape it.`, subject: token.range });
				this.recover('TemplateSeqEnd');
			} else if (token.type === 'EOF') {
				diagnostics.push({ summary: 'Unterminated string literal', detail: 'Unable to find the closing quote mark before the end of the file.', subject: token.range });
				break;
			} else {
				diagnostics.push({ summary: 'Invalid string literal', detail: 'This item is not valid in a string literal.', subject: token.range });
				this.recover('CQuote');
				break;
			}
		}
		return diagnostics;
	}

	/**
	 * Parses a template from after its opening marker: its literals and the expressions in its sequences, and then
	 * the structure its `if` and `for` directives make.
	 *
	 * @param end the token that closes it.
	 * @returns the literals of the tree it makes, and the errors.
	 */
	private parseTemplate(end: 'CQuote' | 'CHeredoc'): [Literal[], Diagnostic[]] {
		const [parts, diagnostics] = this.parseTemplateParts(end);
		const [literals, structureDiagnostics] = new TemplateParser(parts, range => this.rangeText(range)).parseRoot();
		return [literals, [...diagnostics, ...structureDiagnostics]];
	}

	/**
	 * Reads a template into its parts: literals, interpolations and directives, each sequence's expressions parsed.
	 *
	 * @param end the token that closes it.
	 * @returns the parts, ending with one for where the template ends, and the errors.
	 */
	private parseTemplateParts(end: 'CQuote' | 'CHeredoc'): [TemplatePart[], Diagnostic[]] {
		const parts: TemplatePart[] = [];
		const diagnostics: Diagnostic[] = [];
		const startRange = this.nextRange();
		let endRange: Range;
		for (;;) {
			const next = this.read();
			if (next.type === end) {
				endRange = next.range;
				break;
			}
			if (next.type === 'StringLit' || next.type === 'QuotedLit') {
				diagnostics.push(...escapeDiagnostics(next));
				parts.push({ kind: 'literal', range: next.range });
				continue;
			}
			if (next.type === 'TemplateInterp') {
				this.pushNewlines(false);
				const [expression, expressionDiagnostics] = this.parseExpression();
				diagnostics.push(...expressionDiagnostics);
				const close = this.peek();
				if (close.type !== 'TemplateSeqEnd') {
					if (!this.recovery) {
						if (close.type === 'EOF') {
							diagnostics.push({ summary: 'Unclosed template interpolation sequence', detail: 'There is no closing brace for this interpolation sequence before the end of the file. This might be caused by incorrect nesting inside the given expression.', subject: startRange });
						} else if (close.type === 'Colon') {
							diagnostics.push({ summary: 'Extra characters after interpolation expression', detail: 'Template interpolation doesn\'t expect a colon at this location. Did you intend this to be a literal sequence to be processed as part of another language? If so, you can escape it by starting with "$${" instead of just "${".', subject: close.range });
						} else if ((close.type === 'CQuote' || close.type === 'OQuote') && end === 'CQuote') {
							diagnostics.push({ summary: 'Unclosed template interpolation sequence', detail: 'There is no closing brace for this interpolation sequence before the end of the quoted template. This might be caused by incorrect nesting inside the given expression.', subject: startRange });
						} else {
							diagnostics.push({ summary: 'Extra characters after interpolation expression', detail: 'Expected a closing brace to end the interpolation expression, but found extra characters.\n\nThis can happen when you include interpolation syntax for another language, such as shell scripting, but forget to escape the interpolation start token. If this is an embedded sequence for another language, escape it by starting with "$${" instead of just "${".', subject: close.range });
						}
					}
					this.recover('TemplateSeqEnd');
				} else {
					this.read();
				}
				this.popNewlines();
				parts.push({ kind: 'interp', expression, range: between(next.range, close.range) });
				continue;
			}
			if (next.type === 'TemplateControl') {
				this.pushNewlines(false);
				const keyword = this.peek();
				if (keyword.type !== 'Ident') {
					if (!this.recovery) diagnostics.push({ summary: 'Invalid template directive', detail: 'A template directive keyword ("if", "for", etc) is expected at the beginning of a %{ sequence.', subject: keyword.range });
					this.recover('TemplateSeqEnd');
					this.popNewlines();
					continue;
				}
				this.read();
				/**
				 * Gives up on the directive, reporting what is missing where the parser stands unless it is recovering.
				 *
				 * @param detail what is missing.
				 */
				const invalidFor = (detail: string) => {
					if (!this.recovery) diagnostics.push({ summary: 'Invalid \'for\' directive', detail, subject: this.peek().range });
					this.recover('TemplateSeqEnd');
					this.popNewlines();
				};
				if (keyword.text === 'if') {
					const [condition, conditionDiagnostics] = this.parseExpression();
					diagnostics.push(...conditionDiagnostics);
					parts.push({ kind: 'if', condition, range: between(next.range, this.nextRange()) });
				} else if (keyword.text === 'else' || keyword.text === 'endif' || keyword.text === 'endfor') {
					parts.push({ kind: keyword.text, range: between(next.range, this.nextRange()) });
				} else if (keyword.text === 'for') {
					if (this.peek().type !== 'Ident') {
						invalidFor('For directive requires variable name after \'for\'.');
						continue;
					}
					this.read();
					if (this.peek().type === 'Comma') {
						this.read();
						if (this.peek().type !== 'Ident') {
							invalidFor('For directive requires value variable name after comma.');
							continue;
						}
						this.read();
					}
					if (!isKeyword(this.peek(), 'in')) {
						invalidFor('For directive requires \'in\' keyword after names.');
						continue;
					}
					this.read();
					const [collection, collectionDiagnostics] = this.parseExpression();
					diagnostics.push(...collectionDiagnostics);
					parts.push({ kind: 'for', collection, range: between(next.range, this.nextRange()) });
				} else {
					if (!this.recovery) {
						const suggestion = ['if', 'for', 'else', 'endif', 'endfor'].find(candidate => editDistance(keyword.text, candidate) < 3);
						diagnostics.push({ summary: 'Invalid template control keyword', detail: `${goQuoted(keyword.text)} is not a valid template control keyword.${suggestion ? ` Did you mean ${goQuoted(suggestion)}?` : ''}`, subject: keyword.range });
					}
					this.recover('TemplateSeqEnd');
					this.popNewlines();
					continue;
				}
				const close = this.peek();
				if (close.type !== 'TemplateSeqEnd') {
					if (!this.recovery) diagnostics.push({ summary: `Extra characters in ${keyword.text} marker`, detail: 'Expected a closing brace to end the sequence, but found extra characters.', subject: close.range });
					this.recover('TemplateSeqEnd');
				} else {
					this.read();
				}
				this.popNewlines();
				continue;
			}
			if (!this.recovery) diagnostics.push({ summary: 'Unterminated template string', detail: 'No closing marker was found for the string.', subject: next.range });
			endRange = this.recover(end).range;
			break;
		}
		if (parts.length === 0) parts.push({ kind: 'literal', range: { start: startRange.end, end: startRange.end } });
		parts.push({ kind: 'end', range: endRange });
		return [parts, diagnostics];
	}
}

/**
 * Reads the parts of a template into the structure its `if` and `for` directives make, as the HCL library's template
 * parser does.
 */
class TemplateParser {
	private position = 0;

	/**
	 * Creates the parser.
	 *
	 * @param parts the template's parts, ending with the one for where it ends.
	 * @param rangeText names a part of the source as the HCL library does.
	 */
	constructor(private readonly parts: TemplatePart[], private readonly rangeText: (range: Range) => string) {}

	/** Reads every part up to the template's end. */
	parseRoot(): [Literal[], Diagnostic[]] {
		const literals: Literal[] = [];
		const diagnostics: Diagnostic[] = [];
		while (this.peek().kind !== 'end') {
			const [partLiterals, partDiagnostics] = this.parseExpression();
			literals.push(...partLiterals);
			diagnostics.push(...partDiagnostics);
		}
		return [literals, diagnostics];
	}

	private peek(): TemplatePart {
		return this.parts[this.position];
	}

	/** Reads a part; the template's end is never read past. */
	private read(): TemplatePart {
		const part = this.peek();
		if (part.kind !== 'end') this.position++;
		return part;
	}

	/** Reads one part, or a whole `if` or `for` directive with what it holds. */
	private parseExpression(): [Literal[], Diagnostic[]] {
		const next = this.peek();
		switch (next.kind) {
			case 'literal':
				this.read();
				return [[], []];
			case 'interp':
				this.read();
				return [next.expression.literals, []];
			case 'if':
				return this.parseIf();
			case 'for':
				return this.parseFor();
			case 'end':
				this.read();
				return [[{ range: next.range, value: undefined }], [{ summary: 'Unexpected end of template', detail: 'The control directives within this template are unbalanced.', subject: next.range }]];
			default:
				this.read();
				return [[{ range: next.range, value: undefined }], [{ summary: `Unexpected ${next.kind} directive`, detail: 'The control directives within this template are unbalanced.', subject: next.range }]];
		}
	}

	/** Reads an `if` directive to its `endif`. */
	private parseIf(): [Literal[], Diagnostic[]] {
		const open = this.read() as Extract<TemplatePart, { kind: 'if' }>;
		const whenTrue: Literal[] = [];
		const whenFalse: Literal[] = [];
		let current = whenTrue;
		const diagnostics: Diagnostic[] = [];
		for (;;) {
			const next = this.peek();
			if (next.kind === 'end') {
				diagnostics.push({ summary: 'Unexpected end of template', detail: `The if directive at ${this.rangeText(open.range)} is missing its corresponding endif directive.`, subject: next.range });
				return [[{ range: next.range, value: undefined }], diagnostics];
			}
			if (next.kind === 'else' || next.kind === 'endif' || next.kind === 'endfor') {
				this.read();
				if (next.kind === 'endif') break;
				if (next.kind === 'else' && current === whenTrue) {
					current = whenFalse;
					continue;
				}
				diagnostics.push(next.kind === 'else'
					? { summary: 'Unexpected else directive', detail: `Already in the else clause for the if started at ${this.rangeText(open.range)}.`, subject: next.range }
					: { summary: 'Unexpected endfor directive', detail: `Expecting an endif directive for the if started at ${this.rangeText(open.range)}.`, subject: next.range });
				return [[{ range: next.range, value: undefined }], diagnostics];
			}
			const [literals, partDiagnostics] = this.parseExpression();
			diagnostics.push(...partDiagnostics);
			current.push(...literals);
		}
		return [[...open.condition.literals, ...whenTrue, ...whenFalse], diagnostics];
	}

	/** Reads a `for` directive to its `endfor`. */
	private parseFor(): [Literal[], Diagnostic[]] {
		const open = this.read() as Extract<TemplatePart, { kind: 'for' }>;
		const content: Literal[] = [];
		const diagnostics: Diagnostic[] = [];
		for (;;) {
			const next = this.peek();
			if (next.kind === 'end') {
				diagnostics.push({ summary: 'Unexpected end of template', detail: `The for directive at ${this.rangeText(open.range)} is missing its corresponding endfor directive.`, subject: next.range });
				return [[{ range: next.range, value: undefined }], diagnostics];
			}
			if (next.kind === 'else' || next.kind === 'endif' || next.kind === 'endfor') {
				this.read();
				if (next.kind === 'endfor') break;
				diagnostics.push(next.kind === 'else'
					? { summary: 'Unexpected else directive', detail: 'An else clause is not expected for a for directive.', subject: next.range }
					: { summary: 'Unexpected endif directive', detail: `Expecting an endfor directive corresponding to the for directive at ${this.rangeText(open.range)}.`, subject: next.range });
				return [[{ range: next.range, value: undefined }], diagnostics];
			}
			const [literals, partDiagnostics] = this.parseExpression();
			diagnostics.push(...partDiagnostics);
			content.push(...literals);
		}
		return [[...open.collection.literals, ...content], diagnostics];
	}
}

/**
 * Joins two operands with a binary operator.
 *
 * @param left the left operand.
 * @param right the right operand.
 * @returns the operation.
 */
function combined(left: Expression, right: Expression): Expression {
	return { range: between(left.range, right.range), literals: [...left.literals, ...right.literals], literal: false };
}

/**
 * Adds a step to a traversal, which keeps what it starts from.
 *
 * @param from the expression the traversal starts from.
 * @param step the extent of the step.
 * @returns the traversal.
 */
function traversed(from: Expression, step: Range): Expression {
	return { range: between(from.range, step), literals: from.literals, literal: false };
}

/**
 * Splits a number written after a dot where the old way of indexing reads two indexes run together, as `.0.1` does.
 *
 * @param text the number.
 * @returns what comes before its first dot, and everything after it.
 */
function splitAtFirstDot(text: string): [string, string] {
	const dot = text.indexOf('.');
	return [text.slice(0, dot), text.slice(dot + 1)];
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
 * Reads a number literal as go-cty's ParseNumberVal, which HCL reads it with, does.
 *
 * @param token the number literal.
 * @returns its value, undefined when it has none, and the error for one that has none.
 */
function numberValue(token: PlacedToken): [CtyNumber | undefined, Diagnostic[]] {
	const value = CtyNumber.tryParse(token.text);
	return value === undefined
		? [undefined, [{ summary: 'Invalid number literal', detail: 'Failed to recognize the value of this number literal.', subject: token.range }]]
		: [value, []];
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
 * Checks the backslash escapes in the literal text of a quoted string, each piece of which the parser counts on its
 * own, taking a lone carriage return for a line break. A heredoc's text has no escapes.
 *
 * @param token a literal of a template.
 * @returns an error for each backslash that begins no valid escape, at that escape.
 */
function escapeDiagnostics(token: PlacedToken): Diagnostic[] {
	if (token.type !== 'QuotedLit') return [];
	const diagnostics: Diagnostic[] = [];
	const breaksLine = (cluster: string) => cluster[0] === '\r' || cluster[0] === '\n';
	let end = token.range.start;
	for (const piece of quotedPieces(token.text)) {
		const start = end;
		end = advance(start, piece, breaksLine);
		if (piece[0] !== '\\') continue;
		const invalid = (detail: string) => diagnostics.push({ summary: 'Invalid escape sequence', detail, subject: { start, end } });
		const selector = piece[1];
		if (selector === undefined) {
			invalid('Backslash must be followed by an escape sequence selector character.');
		} else if (selector === 'u' || selector === 'U') {
			const wanted = selector === 'u' ? 4 : 8;
			if (piece.length !== 2 + wanted) {
				invalid(`The \\${selector} escape sequence must be followed by ${wanted === 4 ? 'four' : 'eight'} hexadecimal digits.`);
			} else {
				const code = Number.parseInt(piece.slice(2), 16);
				if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) invalid(`Cannot encode character U+${code.toString(16).padStart(4, '0')} in UTF-8.`);
			}
		} else if (!'nrt"\\'.includes(selector)) {
			invalid(`The symbol ${goQuoted(piece.slice(1))} is not a valid escape sequence selector.`);
		}
	}
	return diagnostics;
}

/**
 * Reports the characters the scanner never accepts, as the HCL library does before it parses: each of them, except
 * that it tells of bitwise operators at most four times, of semicolons once, and of only the first and third backtick
 * and single quote, taking the others for the ends of strings quoted with them.
 *
 * @param tokens the tokens.
 * @returns the errors.
 */
function scannerDiagnostics(tokens: PlacedToken[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	let bitwise = 0;
	let backticks = 0;
	let apostrophes = 0;
	let semicolons = 0;
	for (const token of tokens) {
		const report = (summary: string, detail: string) => diagnostics.push({ summary, detail, subject: token.range });
		switch (token.type) {
			case 'BitwiseAnd': case 'BitwiseOr': case 'BitwiseXor': case 'BitwiseNot': {
				if (bitwise < 4) {
					const suggestion = { BitwiseAnd: ' Did you mean boolean AND ("&&")?', BitwiseOr: ' Did you mean boolean OR ("||")?', BitwiseNot: ' Did you mean boolean NOT ("!")?', BitwiseXor: '' }[token.type];
					report('Unsupported operator', `Bitwise operators are not supported.${suggestion}`);
					bitwise++;
				}
				break;
			}
			case 'Backtick':
				if (backticks % 2 === 0) report('Invalid character', 'The "`" character is not valid. To create a multi-line string, use the "heredoc" syntax, like "<<EOT".');
				if (backticks <= 2) backticks++;
				break;
			case 'Apostrophe':
				if (apostrophes % 2 === 0) report('Invalid character', 'Single quotes are not valid. Use double quotes (") to enclose strings.');
				if (apostrophes <= 2) apostrophes++;
				break;
			case 'Semicolon':
				if (semicolons < 1) {
					report('Invalid character', 'The ";" character is not valid. Use newlines to separate arguments and blocks, and commas to separate items in collection values.');
					semicolons++;
				}
				break;
			case 'QuotedNewline':
				report('Invalid multi-line string', 'Quoted strings may not be split over multiple lines. To produce a multi-line string, either use the \\n escape to represent a newline character or use the "heredoc" multi-line template syntax.');
				break;
			case 'Invalid':
				if (token.text === '“' || token.text === '”') {
					report('Invalid character', '"Curly quotes" are not valid here. These can sometimes be inadvertently introduced when sharing code via documents or discussion forums. It might help to replace the character with a "straight quote".');
				} else {
					report('Invalid character', 'This character is not used within the language.');
				}
				break;
		}
	}
	return diagnostics;
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
 * @returns the tokens, placed.
 */
function placeTokens(source: string, tokens: HclToken[]): PlacedToken[] {
	let at: HclPosition = { offset: source.startsWith('\u{FEFF}') ? 1 : 0, line: 1, column: 1 };
	return tokens.map(token => {
		const start = { offset: token.start, line: at.line, column: at.column + Buffer.byteLength(source.slice(at.offset, token.start)) };
		at = advance(start, token.text, cluster => cluster === '\n' || cluster === '\r\n');
		return { ...token, range: { start, end: at } };
	});
}

/**
 * Parses source as the HCL library's ParseConfig does.
 *
 * @param source the source text.
 * @param filename the name of the source.
 * @returns the errors the scanner and then the parser report, and the literals of the tree the parser builds.
 */
function parseConfig(source: string, filename: string): { diagnostics: Diagnostic[]; literals: Literal[] } {
	const tokens = placeTokens(source, scanHclTokens(source));
	const parsed = new SyntaxChecker(tokens, filename).checkFile();
	return { diagnostics: [...scannerDiagnostics(tokens), ...parsed.diagnostics], literals: parsed.literals };
}

/**
 * Turns an error into the problem reported.
 *
 * @param diagnostic the error.
 * @returns the problem.
 */
function problem(diagnostic: Diagnostic): HclSyntaxProblem {
	return { summary: diagnostic.summary, detail: diagnostic.detail, start: diagnostic.subject.start, end: diagnostic.subject.end };
}

/**
 * Finds every error the HCL parser reports in source, in the order it reports them: first each character the scanner
 * never accepts, then what the parser finds, carrying on after each error as the parser does. Two things here are
 * valid that are not HCL, because they are this project's own syntax: an inline function as a statement of the file,
 * and the pipe operator after an expression.
 *
 * @param source the source text.
 * @param filename the name of the source, which the few messages that point back at an earlier part of it use.
 * @returns the problems; none when the source is valid.
 */
export function findHclSyntaxProblems(source: string, filename = ''): HclSyntaxProblem[] {
	return parseConfig(source, filename).diagnostics.map(problem);
}

/**
 * Finds every error Terragrunt reports when it parses a configuration file: the HCL parser's, as
 * {@link findHclSyntaxProblems} gives them, then "Number out of range" for each literal in the tree the parser built
 * that Terragrunt refuses. It refuses a number too far from zero or too close to it, and an unknown value, which is
 * what the parser leaves in place of a number it cannot read and of an expression it could not parse. The errors are
 * not yet told apart by range, as `hcl validate` tells them apart.
 *
 * @param source the source text.
 * @param filename the name of the source, which the few messages that point back at an earlier part of it use.
 * @returns the problems; none when Terragrunt parses the source.
 */
export function findTerragruntParseProblems(source: string, filename = ''): HclSyntaxProblem[] {
	const { diagnostics, literals } = parseConfig(source, filename);
	const refused = literals.filter(literal => literal.value === undefined || !literal.value.withinSupportedRange());
	return [
		...diagnostics.map(problem),
		...refused.map(literal => problem({ summary: 'Number out of range', detail: NUMBER_OUT_OF_RANGE, subject: literal.range }))
	];
}

/** A position as Terragrunt's diagnostics give it: the line and column, and how many UTF-8 bytes come before it. */
export interface ShownPosition {
	line: number;
	column: number;
	byte: number;
}

/**
 * Gives the range Terragrunt shows for a problem, as its diagnostics give one: the problem's own, except that an
 * empty range ends a column and a byte later, so that it covers something. `hcl validate` reports a problem once for
 * each range shown, keeping the first.
 *
 * @param source the source text the problem is in.
 * @param problem the problem.
 * @returns where it starts and ends.
 */
export function shownRange(source: string, problem: HclSyntaxProblem): { start: ShownPosition; end: ShownPosition } {
	const shown = (at: HclPosition) => ({ line: at.line, column: at.column, byte: Buffer.byteLength(source.slice(0, at.offset), 'utf8') });
	const start = shown(problem.start);
	const end = shown(problem.end);
	if (end.byte === start.byte) {
		end.column++;
		end.byte++;
	}
	return { start, end };
}

/**
 * Requires source to be valid HCL, as {@link findHclSyntaxProblems} judges it.
 *
 * @param source the source text.
 * @param filename the name of the source, for the messages that point back at an earlier part of it.
 * @throws {HclSyntaxError} when it is not, with every problem.
 */
export function assertHclSyntax(source: string, filename = ''): void {
	const problems = findHclSyntaxProblems(source, filename);
	if (problems.length > 0) throw new HclSyntaxError(problems);
}

/**
 * Requires Terragrunt to parse source, as {@link findTerragruntParseProblems} judges it.
 *
 * @param source the source text.
 * @param filename the name of the source, for the messages that point back at an earlier part of it.
 * @throws {HclSyntaxError} when it does not, with every problem.
 */
export function assertTerragruntParse(source: string, filename = ''): void {
	const problems = findTerragruntParseProblems(source, filename);
	if (problems.length > 0) throw new HclSyntaxError(problems);
}
