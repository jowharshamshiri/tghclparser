/*
 * This file is a TypeScript port of the `hclsyntax` scanner from https://github.com/hashicorp/hcl (Copyright IBM
 * Corp. 2014, 2026).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * The formatter and the syntax check both work on these tokens, and matching Terragrunt in either means cutting
 * source into tokens exactly where its HCL library does.
 */

import { scanJsBody } from './js-body';

/** The kinds of token in HCL source, and the two this project adds: `Pipe` and `InlineFunction`. */
export type HclTokenType =
	| 'Newline' | 'Comment' | 'Ident' | 'NumberLit'
	| 'OBrace' | 'CBrace' | 'OBrack' | 'CBrack' | 'OParen' | 'CParen'
	| 'OQuote' | 'CQuote' | 'OHeredoc' | 'CHeredoc' | 'QuotedLit' | 'StringLit' | 'QuotedNewline'
	| 'TemplateInterp' | 'TemplateControl' | 'TemplateSeqEnd'
	| 'Dot' | 'Comma' | 'Ellipsis' | 'DoubleColon' | 'Equal' | 'Colon' | 'Question' | 'Bang' | 'FatArrow'
	| 'Minus' | 'Plus' | 'Star' | 'Slash' | 'Percent'
	| 'EqualOp' | 'NotEqual' | 'GreaterThan' | 'GreaterThanEq' | 'LessThan' | 'LessThanEq' | 'And' | 'Or'
	| 'BitwiseAnd' | 'BitwiseOr' | 'BitwiseXor' | 'BitwiseNot' | 'Backtick' | 'Apostrophe' | 'Semicolon'
	| 'Invalid' | 'Pipe' | 'InlineFunction' | 'Nil' | 'EOF';

/** One token: its kind and where it lies in the source. */
export interface HclToken {
	type: HclTokenType;
	/** The offset of its first character. */
	start: number;
	/** The offset its last character ends before. */
	end: number;
	/** Its text, exactly as in the source. */
	text: string;
}

/** A heredoc whose closing marker has not been seen yet. */
interface OpenHeredoc {
	marker: string;
	/** True when the next literal starts a line, the only place the closing marker counts. */
	startOfLine: boolean;
}

const numberLit = /\d(?:(?:\d|\.|[eE][+-]?\d)*(?:\d|[eE][+-]?\d))?/y;
const ident = /[\p{ID_Start}_][\p{ID_Continue}-]*/uy;
const heredocIntro = /<<-?([\p{ID_Start}_][\p{ID_Continue}-]*)\r?\n/uy;
const quotedLiteralRun = /(?:\\[^\r\n]|[^$%"\\\r\n])+/y;
const quotedNewlines = /[\r\n]+/y;
const heredocLiteralRun = /[^$%\r\n]*/y;
/** Blank space and comments, which may separate the parts of an inline function's signature. */
const blankAndComments = /(?:\s+|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
/** The `function` keyword of an inline function, which the name must not run into. */
const functionKeyword = /function(?![a-zA-Z0-9_-])/y;
/** What Go's `bytes.TrimSpace` removes, which is how a heredoc's closing marker line is recognised. */
const goSpace = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const goTrim = new RegExp(`^[${goSpace}]+|[${goSpace}]+$`, 'g');

const selfTokens: Record<string, HclTokenType> = {
	'[': 'OBrack', ']': 'CBrack', '(': 'OParen', ')': 'CParen', '.': 'Dot', ',': 'Comma', '*': 'Star', '/': 'Slash',
	'%': 'Percent', '+': 'Plus', '-': 'Minus', '=': 'Equal', '<': 'LessThan', '>': 'GreaterThan', '!': 'Bang',
	'?': 'Question', ':': 'Colon', '&': 'BitwiseAnd', '|': 'BitwiseOr', '~': 'BitwiseNot', '^': 'BitwiseXor',
	';': 'Semicolon', '`': 'Backtick', '\'': 'Apostrophe'
};

const longTokens: [string, HclTokenType][] = [
	['...', 'Ellipsis'], ['==', 'EqualOp'], ['!=', 'NotEqual'], ['>=', 'GreaterThanEq'], ['<=', 'LessThanEq'],
	['&&', 'And'], ['||', 'Or'], ['::', 'DoubleColon'], ['=>', 'FatArrow'],
	// The pipe operator is this project's, not HCL's, which would read it as `|` and `>`.
	['|>', 'Pipe']
];

/** Where a scan begins and what ends it early. */
interface ScanOptions {
	/** The offset to start at; the beginning of the source when omitted. */
	start?: number;
	/** Stop after the parenthesis that closes the first one opened, for reading an inline function's parameters. */
	untilParenthesesClose?: boolean;
}

/**
 * Splits source into tokens the way the `hclsyntax` scanner does. Nothing is rejected: text that is not valid HCL
 * still becomes tokens, so every character of the source other than the spaces and tabs between tokens, and a
 * leading byte order mark, is in exactly one token.
 *
 * An inline function, which is this project's syntax and holds JavaScript, is one `InlineFunction` token from its
 * `function` keyword to the brace closing its body.
 *
 * @param source the source text.
 * @param options where to start and what ends the scan early.
 * @returns the tokens, ending with an `EOF` token unless the scan was ended early.
 */
export function scanHclTokens(source: string, options: ScanOptions = {}): HclToken[] {
	const tokens: HclToken[] = [];
	const whole = options.start === undefined;
	let position = options.start ?? (source.charCodeAt(0) === 0xFEFF ? 1 : 0);
	let braces = 0;
	let parentheses = 0;
	const returnBraces: number[] = [];
	const heredocs: OpenHeredoc[] = [];
	const modes: ('main' | 'quoted' | 'heredoc')[] = [];
	let mode: 'main' | 'quoted' | 'heredoc' = 'main';

	/**
	 * Records a token ending at `end` and moves past it.
	 *
	 * @param type the token's type.
	 * @param end the offset the token ends before.
	 */
	const emit = (type: HclTokenType, end: number) => {
		tokens.push({ type, start: position, end, text: source.slice(position, end) });
		position = end;
	};

	/**
	 * Tries a sticky pattern at the current position.
	 *
	 * @param pattern a pattern with the `y` flag.
	 * @returns the match, or null when the pattern does not match here.
	 */
	const match = (pattern: RegExp) => {
		pattern.lastIndex = position;
		return pattern.exec(source);
	};

	/**
	 * Scans a `${` or `%{` that opens a template sequence, with its optional `~`, and enters the expression inside.
	 *
	 * @param type the sequence's token type.
	 */
	const beginSequence = (type: 'TemplateInterp' | 'TemplateControl') => {
		emit(type, position + (source[position + 2] === '~' ? 3 : 2));
		braces++;
		returnBraces.push(braces);
		if (heredocs.length > 0) heredocs[heredocs.length - 1].startOfLine = false;
		modes.push(mode);
		mode = 'main';
	};

	/**
	 * Scans a `$` or `%` inside a quoted template: the start of a sequence, the `$${` or `%%{` that escapes one, or
	 * the character on its own.
	 */
	const scanQuotedSigil = () => {
		const sigil = source[position];
		if (source[position + 1] === '{') beginSequence(sigil === '$' ? 'TemplateInterp' : 'TemplateControl');
		else if (source[position + 1] === sigil && source[position + 2] === '{') emit('QuotedLit', position + (source[position + 3] === '~' ? 4 : 3));
		// A sigil that ends the source has nothing after it to say what it is, which the scanner calls invalid.
		else emit(position + 1 === source.length ? 'Invalid' : 'QuotedLit', position + 1);
	};

	/**
	 * Scans a `$` or `%` inside a heredoc. A sequence and its escape are as in a quoted template, but a sigil that
	 * begins neither is scanned differently there: it takes the character after it along when a line break
	 * follows that character, and stands alone otherwise. The escape takes a line break directly after it along.
	 *
	 * @param heredoc the heredoc being scanned.
	 */
	const scanHeredocSigil = (heredoc: OpenHeredoc) => {
		const sigil = source[position];
		if (source[position + 1] === '{') {
			beginSequence(sigil === '$' ? 'TemplateInterp' : 'TemplateControl');
			return;
		}
		/**
		 * Measures the line break at an offset.
		 *
		 * @param at the offset.
		 * @returns the length of the line break there, or 0 when there is none.
		 */
		const lineBreakAt = (at: number) => source[at] === '\n' ? 1 : source[at] === '\r' && source[at + 1] === '\n' ? 2 : 0;
		if (source[position + 1] === sigil && source[position + 2] === '{') {
			const end = position + (source[position + 3] === '~' ? 4 : 3);
			heredoc.startOfLine = lineBreakAt(end) > 0;
			emit('StringLit', end + lineBreakAt(end));
			return;
		}
		// A sigil that ends the source has nothing after it to say what it is, which the scanner calls invalid.
		if (position + 1 === source.length) {
			emit('Invalid', position + 1);
			return;
		}
		// The scanner works on bytes, so only a character of one byte can be taken along.
		const after = source.charCodeAt(position + 1) < 0x80 ? source[position + 2] : undefined;
		if (after === '\r' || after === '\n') {
			heredoc.startOfLine = lineBreakAt(position + 2) > 0;
			emit('StringLit', position + 2);
			return;
		}
		heredoc.startOfLine = false;
		emit('StringLit', position + 1);
	};

	/**
	 * Finds where an inline function that starts at the current position ends.
	 *
	 * @returns the offset after the brace closing its body, or undefined when what is here is not an inline
	 *   function: the keyword, a name, parenthesised parameters and a JavaScript body that is closed.
	 */
	const inlineFunctionEnd = (): number | undefined => {
		const keyword = match(functionKeyword);
		if (!keyword) return undefined;
		/**
		 * Skips blank space and comments.
		 *
		 * @param from the offset to skip from.
		 * @returns the offset of what follows.
		 */
		const skip = (from: number) => {
			blankAndComments.lastIndex = from;
			return from + blankAndComments.exec(source)![0].length;
		};
		const nameStart = skip(position + keyword[0].length);
		ident.lastIndex = nameStart;
		const name = ident.exec(source);
		if (!name) return undefined;
		const open = skip(nameStart + name[0].length);
		if (source[open] !== '(') return undefined;
		const parameters = scanHclTokens(source, { start: open, untilParenthesesClose: true });
		const close = parameters[parameters.length - 1];
		if (close?.type !== 'CParen') return undefined;
		const body = skip(close.end);
		if (source[body] !== '{') return undefined;
		const last = scanJsBody(source, body + 1);
		return last === -1 ? undefined : last + 2;
	};

	while (position < source.length) {
		const character = source[position];
		if (mode === 'quoted') {
			if (character === '"') {
				emit('CQuote', position + 1);
				mode = modes.pop()!;
			} else if (character === '$' || character === '%') {
				scanQuotedSigil();
			} else if (character === '\r' || character === '\n') {
				emit('QuotedNewline', position + match(quotedNewlines)![0].length);
			} else {
				const run = match(quotedLiteralRun);
				// A backslash before a line break escapes nothing, and is an invalid token of its own.
				if (run) emit('QuotedLit', position + run[0].length);
				else emit('Invalid', position + 1);
			}
			continue;
		}
		if (mode === 'heredoc') {
			const heredoc = heredocs[heredocs.length - 1];
			if (character === '$' || character === '%') {
				scanHeredocSigil(heredoc);
				continue;
			}
			const run = match(heredocLiteralRun)![0];
			let end = position + run.length;
			const lineBreak = source[end] === '\n' ? 1 : source[end] === '\r' && source[end + 1] === '\n' ? 2 : 0;
			if (lineBreak === 0) {
				if (source[end] === '\r') {
					// A carriage return that begins no line break is where the scanner gives up on the heredoc:
					// what is left of the source is one invalid token.
					if (run.length > 0) emit('StringLit', end);
					emit('Invalid', source.length);
				} else {
					heredoc.startOfLine = false;
					emit('StringLit', end);
				}
				continue;
			}
			if (heredoc.startOfLine && run.replace(goTrim, '') === heredoc.marker) {
				// The closing marker and the line break after it are separate tokens, so the line break still
				// ends the attribute the heredoc belongs to.
				emit('CHeredoc', end);
				emit('Newline', end + lineBreak);
				heredocs.pop();
				mode = modes.pop()!;
				continue;
			}
			end += lineBreak;
			heredoc.startOfLine = true;
			emit('StringLit', end);
			continue;
		}

		if (character === ' ' || character === '\t') {
			position++;
			continue;
		}
		if (character >= '0' && character <= '9') {
			emit('NumberLit', position + match(numberLit)![0].length);
			continue;
		}
		if (character === '\n') {
			emit('Newline', position + 1);
			continue;
		}
		if (character === '\r' && source[position + 1] === '\n') {
			emit('Newline', position + 2);
			continue;
		}
		if (character === '#' || (character === '/' && source[position + 1] === '/')) {
			const lineEnd = source.indexOf('\n', position);
			emit('Comment', lineEnd < 0 ? source.length : lineEnd + 1);
			continue;
		}
		if (character === '/' && source[position + 1] === '*') {
			const close = source.indexOf('*/', position + 2);
			if (close >= 0) {
				emit('Comment', close + 2);
				continue;
			}
		}
		if (character === '{') {
			emit('OBrace', position + 1);
			braces++;
			continue;
		}
		if (character === '}' || (character === '~' && source[position + 1] === '}')) {
			// A brace that closes the template sequence it was opened by returns to the template around it. `~}`
			// always ends a sequence, even where none is open, which the parser then reports.
			const closesSequence = returnBraces.length > 0 && returnBraces[returnBraces.length - 1] === braces;
			emit(closesSequence || character === '~' ? 'TemplateSeqEnd' : 'CBrace', position + (character === '~' ? 2 : 1));
			braces--;
			if (closesSequence) {
				returnBraces.pop();
				mode = modes.pop()!;
			}
			continue;
		}
		if (character === '"') {
			emit('OQuote', position + 1);
			modes.push(mode);
			mode = 'quoted';
			continue;
		}
		if (character === '<' && source[position + 1] === '<') {
			const intro = match(heredocIntro);
			if (intro) {
				emit('OHeredoc', position + intro[0].length);
				heredocs.push({ marker: intro[1], startOfLine: true });
				modes.push(mode);
				mode = 'heredoc';
				continue;
			}
		}
		const long = longTokens.find(([text]) => source.startsWith(text, position));
		if (long) {
			emit(long[1], position + long[0].length);
			continue;
		}
		const self = selfTokens[character];
		if (self) {
			emit(self, position + 1);
			if (self === 'OParen') parentheses++;
			else if (self === 'CParen' && --parentheses === 0 && options.untilParenthesesClose) return tokens;
			continue;
		}
		if (character === 'f' && whole && braces === 0 && modes.length === 0) {
			// An inline function is a statement of the outermost body, so it can only start where one can: at
			// the beginning of the source or of a line.
			const before = tokens[tokens.length - 1];
			const end = before === undefined || before.type === 'Newline' || before.type === 'Comment' ? inlineFunctionEnd() : undefined;
			if (end !== undefined) {
				emit('InlineFunction', end);
				continue;
			}
		}
		const name = match(ident);
		if (name) {
			emit('Ident', position + name[0].length);
			continue;
		}
		// Anything else is one invalid character, which is kept like any other token.
		emit('Invalid', position + (source.codePointAt(position)! > 0xFFFF ? 2 : 1));
	}
	emit('EOF', position);
	return tokens;
}
