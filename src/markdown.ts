/**
 * Helpers for putting text a module author wrote into hover and completion markdown without letting it change the
 * markdown around it: a description is shown as plain text, a value goes into a code span whose delimiter it cannot
 * close, and a block goes into a fence it cannot end.
 */

/** Characters of author-written text shown before it is cut. */
const maximumTextLength = 2000;

/** Control and format characters, which includes the direction overrides that can disguise text; tabs and newlines are kept. */
const hiddenCharacters = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;

/**
 * Makes text a module author wrote safe to show as plain markdown text, so it can neither format nor disguise
 * itself.
 *
 * @param text author-written text, such as a variable description.
 * @returns the text with markdown syntax escaped, control and direction-changing characters removed, and its length
 *   capped.
 */
export function escapeMarkdownText(text: string): string {
	const cleaned = text.replace(/\r\n?/g, '\n').replace(hiddenCharacters, '');
	const capped = cleaned.length > maximumTextLength ? `${cleaned.slice(0, maximumTextLength)}…` : cleaned;
	return capped.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, character => `\\${character}`);
}

/**
 * Wraps a value in an inline code span it cannot close from inside, on one line.
 *
 * @param text a value to show as code inline.
 * @returns a code span delimited by more backticks than the text contains anywhere.
 */
export function markdownCode(text: string): string {
	const single = text.replace(/[\r\n]+/g, ' ').replace(hiddenCharacters, '').replace(/\t/g, ' ');
	const longest = Math.max(0, ...[...single.matchAll(/`+/g)].map(match => match[0].length));
	const fence = '`'.repeat(longest + 1);
	const padded = single.startsWith('`') || single.endsWith('`') || single === '' ? ` ${single} ` : single;
	return `${fence}${padded}${fence}`;
}

/**
 * Wraps a block in a code fence it cannot end from inside.
 *
 * @param text a block of code to show.
 * @param language the fence's language tag.
 * @returns a fenced block delimited by more backticks than any run in the text.
 */
export function markdownFence(text: string, language: string): string {
	const cleaned = text.replace(hiddenCharacters, '');
	const longest = Math.max(2, ...[...cleaned.matchAll(/`+/g)].map(match => match[0].length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}${language}\n${cleaned}\n${fence}`;
}
