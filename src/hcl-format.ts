/*
 * This file is a TypeScript port of the canonical HCL formatter, `hclwrite.Format`, from
 * https://github.com/hashicorp/hcl (Copyright IBM Corp. 2014, 2026).
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * `terragrunt hcl format` is `hclwrite.Format` applied to a file that parses, so matching its output means matching
 * this algorithm token for token. It changes whitespace only: the spaces before each token. Nothing else in the
 * source is rewritten, added or removed.
 */

import { graphemeCount } from './grapheme-clusters';
import { scanHclTokens } from './hcl-scanner';
import type { HclTokenType } from './hcl-scanner';
import { assertHclSyntax } from './hcl-syntax';

/** One token of source and the number of spaces written before it, which is all that formatting changes. */
interface FormatToken {
	type: HclTokenType;
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

const needsGraphemes = /[^\x20-\x7E]/;

/**
 * Scans source into the tokens the formatter lays out, each with the spaces and tabs found before it.
 *
 * @param source the source text.
 * @returns the tokens, ending with an `EOF` token.
 */
function formatTokens(source: string): FormatToken[] {
	// A byte order mark is dropped, and its three bytes count as spaces before the first token, as they do upstream.
	let lastEnd = source.charCodeAt(0) === 0xFEFF ? -2 : 0;
	return scanHclTokens(source).map(token => {
		const spacesBefore = token.start - lastEnd;
		lastEnd = token.end;
		return { type: token.type, text: token.text, spacesBefore };
	});
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
		else width += graphemeCount(token.text);
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
	const templateLiteral = (type: HclTokenType) => type === 'QuotedLit' || type === 'StringLit';
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
 * Two things are laid out that are not HCL, because they are this project's own syntax: an inline function is
 * kept exactly as written, since its body is JavaScript, and the pipe operator is one token.
 *
 * @param source the source text.
 * @returns the formatted text.
 */
export function formatHclTokens(source: string): string {
	const tokens = formatTokens(source);
	const lines = linesForFormat(tokens);
	formatIndent(lines);
	formatSpaces(lines);
	formatCells(lines);
	let formatted = '';
	for (const token of tokens) formatted += ' '.repeat(token.spacesBefore) + token.text;
	return formatted;
}

/**
 * Formats HCL the way `terragrunt hcl format` does: source its parser reports an error in is refused, and any
 * other is rewritten by {@link formatHclTokens}, which changes only the whitespace between tokens.
 *
 * @param source the source text.
 * @param filename the name of the source, which the messages that point back at an earlier part of it use.
 * @returns the formatted text, which equals `source` when it is already formatted.
 * @throws {HclSyntaxError} when the source is not valid HCL.
 */
export function formatHcl(source: string, filename = ''): string {
	assertHclSyntax(source, filename);
	return formatHclTokens(source);
}
