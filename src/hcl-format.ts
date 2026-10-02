/*
 * This file is a TypeScript port of the canonical HCL formatter, `hclwrite.Format`, and of the part of the
 * `hclsyntax` scanner it depends on, from https://github.com/hashicorp/hcl (Copyright IBM Corp. 2014, 2026).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * `terragrunt hcl format` is `hclwrite.Format` applied to a file that parses, so matching its output means matching
 * this algorithm token for token. It changes whitespace only: the spaces before each token. Nothing else in the
 * source is rewritten, added or removed.
 */

import { parseFailureMessage } from './module-variables';
import { parseHclSyntax } from './syntax';

/** The kinds of token the formatter tells apart; every other token is `Other` and is separated by single spaces. */
type TokenType =
	| 'Newline' | 'Comment' | 'Ident' | 'NumberLit'
	| 'OBrace' | 'CBrace' | 'OBrack' | 'CBrack' | 'OParen' | 'CParen'
	| 'OQuote' | 'CQuote' | 'OHeredoc' | 'CHeredoc' | 'QuotedLit' | 'StringLit'
	| 'TemplateInterp' | 'TemplateControl' | 'TemplateSeqEnd'
	| 'Dot' | 'Comma' | 'Ellipsis' | 'DoubleColon' | 'Equal' | 'Colon' | 'Question' | 'Bang'
	| 'Minus' | 'Plus' | 'Star' | 'Slash' | 'Percent'
	| 'EqualOp' | 'NotEqual' | 'GreaterThan' | 'GreaterThanEq' | 'LessThan' | 'LessThanEq' | 'And' | 'Or'
	| 'Verbatim' | 'Other' | 'Nil' | 'EOF';

/** One token of source and the number of spaces written before it, which is all that formatting changes. */
interface FormatToken {
	type: TokenType;
	text: string;
	spacesBefore: number;
}

/**
 * One line of source split into the cells that are aligned with the lines around it: `lead` is everything up to
 * the others, `assign` starts at the equals sign of an attribute whose value ends on the same line, and `comment`
 * is a single-line comment that follows other tokens.
 */
interface FormatLine {
	lead: FormatToken[];
	assign: FormatToken[] | undefined;
	comment: FormatToken[] | undefined;
}

/** A span of source that is kept exactly as written, as one token. */
export interface VerbatimSpan {
	/** The offset the span ends before. */
	end: number;
	/** The offset of its first character; the span is recognised only if a token starts exactly here. */
	start: number;
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
/** What Go's `bytes.TrimSpace` removes, which is how a heredoc's closing marker line is recognised. */
const goSpace = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const goTrim = new RegExp(`^[${goSpace}]+|[${goSpace}]+$`, 'g');
const needsGraphemes = /[^\x20-\x7E]/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const selfTokens: Record<string, TokenType> = {
	'[': 'OBrack', ']': 'CBrack', '(': 'OParen', ')': 'CParen', '.': 'Dot', ',': 'Comma', '*': 'Star', '/': 'Slash',
	'%': 'Percent', '+': 'Plus', '-': 'Minus', '=': 'Equal', '<': 'LessThan', '>': 'GreaterThan', '!': 'Bang',
	'?': 'Question', ':': 'Colon', '&': 'Other', '|': 'Other', '~': 'Other', '^': 'Other', ';': 'Other',
	'`': 'Other', '\'': 'Other'
};

const longTokens: [string, TokenType][] = [
	['...', 'Ellipsis'], ['==', 'EqualOp'], ['!=', 'NotEqual'], ['>=', 'GreaterThanEq'], ['<=', 'LessThanEq'],
	['&&', 'And'], ['||', 'Or'], ['::', 'DoubleColon'], ['=>', 'Other'],
	// The pipe operator is this project's, not HCL's, which would split it into `|` and `>`.
	['|>', 'Other']
];

/**
 * Splits source into the tokens the formatter works on, the way the `hclsyntax` scanner does, recording the spaces
 * and tabs before each. Nothing is rejected: text that is not valid HCL still becomes tokens, so every character
 * of the source other than spaces, tabs and a leading byte order mark is in exactly one token.
 *
 * @param source the source text.
 * @param verbatim spans kept as single tokens, in source order; each must start where a top-level token starts.
 * @returns the tokens, ending with an `EOF` token.
 */
function scanTokens(source: string, verbatim: VerbatimSpan[]): FormatToken[] {
	const tokens: FormatToken[] = [];
	// A byte order mark is dropped, and its three bytes count as spaces before the first token, as they do upstream.
	const hasMark = source.charCodeAt(0) === 0xFEFF;
	let position = hasMark ? 1 : 0;
	let lastEnd = hasMark ? -2 : 0;
	let braces = 0;
	let nextVerbatim = 0;
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
	const emit = (type: TokenType, end: number) => {
		tokens.push({ type, text: source.slice(position, end), spacesBefore: position - lastEnd });
		position = end;
		lastEnd = end;
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
	 * Scans a `$` or `%` inside a template: the start of a sequence, the `$${` or `%%{` that escapes one, or the
	 * character on its own.
	 *
	 * @param literal the token type of literal text in this template.
	 * @returns true when a sequence was opened, false when literal text was scanned.
	 */
	const scanSigil = (literal: 'QuotedLit' | 'StringLit') => {
		const sigil = source[position];
		if (source[position + 1] === '{') {
			beginSequence(sigil === '$' ? 'TemplateInterp' : 'TemplateControl');
			return true;
		}
		if (source[position + 1] === sigil && source[position + 2] === '{') emit(literal, position + (source[position + 3] === '~' ? 4 : 3));
		// A sigil that ends the source has nothing after it to say what it is, which the scanner calls invalid.
		else emit(position + 1 === source.length ? 'Other' : literal, position + 1);
		return false;
	};

	while (position < source.length) {
		const character = source[position];
		if (mode === 'quoted') {
			if (character === '"') {
				emit('CQuote', position + 1);
				mode = modes.pop()!;
			} else if (character === '$' || character === '%') {
				scanSigil('QuotedLit');
			} else if (character === '\r' || character === '\n') {
				emit('Other', position + match(quotedNewlines)![0].length);
			} else {
				const run = match(quotedLiteralRun);
				// A backslash before a line break escapes nothing, and is a token of its own.
				if (run) emit('QuotedLit', position + run[0].length);
				else emit('Other', position + 1);
			}
			continue;
		}
		if (mode === 'heredoc') {
			const heredoc = heredocs[heredocs.length - 1];
			if (character === '$' || character === '%') {
				if (!scanSigil('StringLit')) heredoc.startOfLine = false;
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
					emit('Other', source.length);
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
		const span = verbatim[nextVerbatim];
		if (span !== undefined && span.start === position && braces === 0) {
			nextVerbatim++;
			emit('Verbatim', span.end);
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
			continue;
		}
		const name = match(ident);
		if (name) {
			emit('Ident', position + name[0].length);
			continue;
		}
		// Anything else is one invalid character, which is kept like any other token.
		emit('Other', position + (source.codePointAt(position)! > 0xFFFF ? 2 : 1));
	}
	emit('EOF', position);
	return tokens;
}

/**
 * Tells whether a token ends a line. Single-line comments include their line break, so they end lines too.
 *
 * @param token the token.
 * @returns true for a newline, or a comment ending in one.
 */
function isNewline(token: FormatToken): boolean {
	return token.type === 'Newline' || (token.type === 'Comment' && token.text.endsWith('\n'));
}

/**
 * How a token changes the bracket nesting.
 *
 * @param token the token.
 * @returns 1 for an opening bracket or template sequence, -1 for a closing one, else 0.
 */
function bracketChange(token: FormatToken): number {
	switch (token.type) {
		case 'OBrace': case 'OBrack': case 'OParen': case 'TemplateControl': case 'TemplateInterp':
			return 1;
		case 'CBrace': case 'CBrack': case 'CParen': case 'TemplateSeqEnd':
			return -1;
		default:
			return 0;
	}
}

/**
 * The columns a run of tokens occupies: a column per space and per grapheme cluster.
 *
 * @param tokens the tokens of one cell, none of which holds a line break.
 * @returns the width.
 */
function columns(tokens: FormatToken[] | undefined): number {
	let width = 0;
	for (const token of tokens ?? []) {
		width += token.spacesBefore;
		if (!needsGraphemes.test(token.text)) width += token.text.length;
		else width += [...graphemes.segment(token.text)].length;
	}
	return width;
}

/**
 * Splits tokens into lines, and each line into its cells.
 *
 * @param tokens every token of the source, ending with `EOF`.
 * @returns the lines; the `EOF` token is in none of them.
 */
function linesForFormat(tokens: FormatToken[]): FormatLine[] {
	const lines: FormatLine[] = [];
	let lineStart = 0;
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type === 'EOF') {
			lines.push({ lead: tokens.slice(lineStart, index), assign: undefined, comment: undefined });
			break;
		}
		if (isNewline(tokens[index])) {
			lines.push({ lead: tokens.slice(lineStart, index + 1), assign: undefined, comment: undefined });
			lineStart = index + 1;
		}
	}
	for (const line of lines) {
		if (line.lead.length === 0) continue;
		if (line.lead.length > 1 && line.lead[line.lead.length - 1].type === 'Comment') {
			line.comment = line.lead.slice(-1);
			line.lead = line.lead.slice(0, -1);
		}
		const equals = line.lead.findIndex((token, index) => index > 0 && token.type === 'Equal');
		if (equals < 0) continue;
		// The value goes into its own cell only when it ends on this line, which balanced brackets suggest.
		const rest = line.lead.slice(equals);
		if (rest.reduce((net, token) => net + bracketChange(token), 0) === 0) {
			line.assign = rest;
			line.lead = line.lead.slice(0, equals);
		}
	}
	return lines;
}

/**
 * Sets the indentation of each line from the brackets opened and closed on the lines before it. A line that opens
 * more than it closes indents what follows by one level however many it opened, and closing brackets take levels
 * back off in the groups they were added in, so input whose brackets do not pair up line by line drifts neither
 * left nor right.
 *
 * @param lines the lines, whose first tokens are updated.
 */
function formatIndent(lines: FormatLine[]): void {
	const indents: number[] = [];
	for (const line of lines) {
		if (line.lead.length === 0) continue;
		if (line.lead[0].type === 'Newline') {
			line.lead[0].spacesBefore = 0;
			continue;
		}
		let net = 0;
		for (const token of line.lead) {
			net += bracketChange(token);
			if (token.type === 'OHeredoc') break;
		}
		for (const token of line.assign ?? []) net += bracketChange(token);

		if (net > 0) {
			line.lead[0].spacesBefore = 2 * indents.length;
			indents.push(net);
			continue;
		}
		let closed = -net;
		while (closed > 0 && indents.length > 0) {
			const top = indents[indents.length - 1];
			if (closed > top) {
				closed -= top;
				indents.pop();
			} else if (closed < top) {
				indents[indents.length - 1] -= closed;
				closed = 0;
			} else {
				indents.pop();
				closed = 0;
			}
		}
		line.lead[0].spacesBefore = 2 * indents.length;
	}
}

/**
 * Decides whether a token is followed by a space.
 *
 * @param subject the token.
 * @param before the token before it in the same cell, or the `Nil` token when it is the first.
 * @param after the token after it.
 * @returns true when one space separates `subject` from `after`, false when none does.
 */
function spaceAfter(subject: FormatToken, before: FormatToken, after: FormatToken): boolean {
	const templateLiteral = (type: TokenType) => type === 'QuotedLit' || type === 'StringLit';
	if (after.type === 'Newline' || after.type === 'Nil') return false;
	// A function name and its opening parenthesis stay together, as do the segments of a namespaced name.
	if (subject.type === 'Ident' && after.type === 'OParen') return false;
	if ((subject.type === 'Ident' && after.type === 'DoubleColon') || (subject.type === 'DoubleColon' && after.type === 'Ident')) return false;
	if (subject.type === 'Dot' || after.type === 'Dot') return false;
	if (after.type === 'Comma' || after.type === 'Ellipsis') return false;
	if (subject.type === 'Comma') return true;
	// Nothing is added inside a template.
	if (templateLiteral(subject.type) || subject.type === 'OQuote' || subject.type === 'OHeredoc'
		|| templateLiteral(after.type) || after.type === 'CQuote' || after.type === 'CHeredoc') return false;
	// `in` after a name is the keyword of a for expression, not a name being indexed: [for x in [a]: x].
	if (subject.type === 'Ident' && subject.text === 'in' && before.type === 'Ident') return true;
	if (after.type === 'OBrack' && (subject.type === 'Ident' || subject.type === 'NumberLit' || bracketChange(subject) < 0)) return false;
	if (subject.type === 'Bang') return false;
	if (subject.type === 'Minus') {
		// A minus is a negation, with nothing after it, when what comes before cannot end an expression.
		switch (before.type) {
			case 'Nil':
			case 'OParen': case 'OBrace': case 'OBrack': case 'Equal': case 'Colon': case 'Comma': case 'Question':
			case 'Plus': case 'Star': case 'Slash': case 'Percent': case 'Minus':
			case 'EqualOp': case 'NotEqual': case 'GreaterThan': case 'GreaterThanEq': case 'LessThan': case 'LessThanEq':
			case 'And': case 'Or': case 'Bang':
				return false;
			default:
				return true;
		}
	}
	// Braces have a space inside them, in a one-line block and in an object alike, unless they are empty.
	if (subject.type === 'OBrace' || after.type === 'CBrace') return !(subject.type === 'OBrace' && after.type === 'CBrace');
	// A template sequence holding only an object keeps its braces apart from the sequence's own.
	if ((subject.type === 'TemplateInterp' || subject.type === 'TemplateControl') && after.type === 'OBrace') return true;
	if (subject.type === 'CBrace' && after.type === 'TemplateSeqEnd') return true;
	if (subject.type === 'TemplateSeqEnd' && (after.type === 'TemplateInterp' || after.type === 'TemplateControl')) return false;
	if (bracketChange(subject) > 0) return false;
	if (bracketChange(after) < 0) return false;
	return true;
}

/**
 * Sets the space between the tokens of each cell.
 *
 * @param lines the lines, whose tokens are updated.
 */
function formatSpaces(lines: FormatLine[]): void {
	const nil: FormatToken = { type: 'Nil', text: '', spacesBefore: 0 };
	/**
	 * Spaces the tokens of one cell after its first.
	 *
	 * @param cell the cell's tokens.
	 */
	const space = (cell: FormatToken[]) => {
		for (let index = 0; index < cell.length - 1; index++) {
			cell[index + 1].spacesBefore = spaceAfter(cell[index], index > 0 ? cell[index - 1] : nil, cell[index + 1]) ? 1 : 0;
		}
	};
	for (const line of lines) {
		space(line.lead);
		if (line.assign) {
			line.assign[0].spacesBefore = 1;
			space(line.assign);
		}
	}
}

/**
 * Aligns the equals signs of consecutive attribute lines, then the comments that end consecutive lines.
 *
 * @param lines the lines, whose `assign` and `comment` cells are moved.
 */
function formatCells(lines: FormatLine[]): void {
	/**
	 * Aligns one kind of cell across each run of consecutive lines that have it.
	 *
	 * @param cell picks the cell to align from a line.
	 * @param width measures what comes before that cell on a line.
	 */
	const align = (cell: (line: FormatLine) => FormatToken[] | undefined, width: (line: FormatLine) => number) => {
		let chainStart = -1;
		let widest = 0;
		for (let index = 0; index <= lines.length; index++) {
			if (index < lines.length && cell(lines[index]) !== undefined) {
				if (chainStart < 0) chainStart = index;
				widest = Math.max(widest, width(lines[index]));
				continue;
			}
			if (chainStart < 0) continue;
			for (const line of lines.slice(chainStart, index)) cell(line)![0].spacesBefore = widest - width(line) + 1;
			chainStart = -1;
			widest = 0;
		}
	};
	// Moving an equals sign moves the comment after it, so the assignments go first.
	align(line => line.assign, line => columns(line.lead));
	align(line => line.comment, line => columns(line.lead) + columns(line.assign));
}

/**
 * Rewrites the whitespace of HCL source into the canonical layout, exactly as `hclwrite.Format` does: indentation
 * of two spaces per level, one space between tokens where the style puts one, and the equals signs and trailing
 * comments of consecutive lines aligned. Only spaces and tabs between tokens change; a leading byte order mark is
 * dropped.
 *
 * Like `hclwrite.Format`, this works on tokens and never fails: source with syntax errors is still laid out,
 * though the result may not be what anyone wants. Callers that should refuse such source check it first, as
 * {@link formatHcl} does.
 *
 * @param source the source text.
 * @param verbatim spans to keep exactly as written, in source order, such as the JavaScript of an inline function,
 *   which is not HCL and would be mangled if spaced as HCL.
 * @returns the formatted text.
 */
export function formatHclTokens(source: string, verbatim: VerbatimSpan[] = []): string {
	const tokens = scanTokens(source, verbatim);
	const lines = linesForFormat(tokens);
	formatIndent(lines);
	formatSpaces(lines);
	formatCells(lines);
	let formatted = '';
	for (const token of tokens) formatted += ' '.repeat(token.spacesBefore) + token.text;
	return formatted;
}

/** Source that cannot be formatted because it does not parse; the message says where and why. */
export class HclSyntaxError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param message where parsing stopped and what it found there.
	 * @param options the parser's own error.
	 */
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'HclSyntaxError';
	}
}

/**
 * Finds where an inline function begins: the `function` keyword after whatever blank space and comments its
 * syntax node starts with.
 *
 * @param source the source text.
 * @param from the offset the function's syntax node starts at.
 * @returns the offset of the keyword.
 * @throws when no `function` keyword is there, which means the syntax tree and this scan disagree.
 */
function inlineFunctionStart(source: string, from: number): number {
	const skipped = /(?:\s+|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
	skipped.lastIndex = from;
	const start = from + skipped.exec(source)![0].length;
	if (!source.startsWith('function', start)) throw new Error(`Expected an inline function at offset ${start}`);
	return start;
}

/**
 * Formats Terragrunt HCL the way `terragrunt hcl format` does: source that does not parse, or that sets an argument
 * twice in one body, is refused, and any other is rewritten by {@link formatHclTokens}, which changes only the
 * whitespace between tokens.
 *
 * Inline functions are the one construct here that Terragrunt does not have. Their signatures and JavaScript
 * bodies are kept exactly as written, since they are not HCL.
 *
 * @param source the source text.
 * @param name how messages name the source, such as its path.
 * @returns the formatted text, which equals `source` when it is already formatted.
 * @throws {HclSyntaxError} when the source does not parse.
 */
export function formatHcl(source: string, name = 'source'): string {
	let ast: any;
	try {
		ast = parseHclSyntax(source, name);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		throw new HclSyntaxError(parseFailureMessage(error), { cause: error });
	}
	const verbatim: VerbatimSpan[] = [];
	for (const node of ast.children ?? []) {
		if (node.type !== 'inline_function') continue;
		verbatim.push({ start: inlineFunctionStart(source, node.location.start.offset), end: node.location.end.offset });
	}
	return formatHclTokens(source, verbatim);
}
