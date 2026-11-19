/**
 * Quotes text the way Go's `%q` does, which is how Terragrunt and the HCL parser show a value in a message: printable
 * characters as they are, and the rest as escapes.
 *
 * @param text the text.
 * @returns the text in double quotes.
 */
export function goQuoted(text: string): string {
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
