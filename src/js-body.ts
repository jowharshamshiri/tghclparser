const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const BACKTICK = 96;
const DOLLAR = 36;
const BACKSLASH = 92;
const SLASH = 47;
const STAR = 42;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const NEWLINE = 10;
const RETURN = 13;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const CLOSE_PAREN = 41;
const REGEX_PRECEDING_KEYWORDS = [
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
	'throw', 'case', 'do', 'else', 'yield', 'await'
];

/**
 * Scans the JavaScript body of an inline function to find where it ends. Brace depth is tracked through string
 * literals, template literals (including nested substitutions, which may themselves contain braces and strings),
 * regular expression literals, and both comment forms, so that a brace inside any of those does not end the body.
 *
 * @param source the whole source text.
 * @param start the offset of the first character after the body's opening brace.
 * @returns the offset of the last character belonging to the body, which is one before the matching closing
 *   brace and so `start - 1` for an empty body; or -1 when the body is unterminated, so that the caller can
 *   report a located error rather than consume the rest of the file.
 */
export function scanJsBody(source: string, start: number): number {
	// Tracks the nesting of substitutions inside template literals. Each entry is the brace depth at which the
	// enclosing template resumes.
	const templateStack: number[] = [];
	let depth = 1;
	let index = start;

	/**
	 * Scans a template literal.
	 *
	 * @param position the offset just after an opening backtick, or after the closing brace of a substitution.
	 * @returns the offset to resume the outer scan from, or -1 when the template is unterminated. Entering a
	 *   substitution raises `depth` and records the depth at which the template resumes.
	 */
	const scanTemplate = (position: number): number => {
		let scan = position;
		while (scan < source.length) {
			const code = source.charCodeAt(scan);
			if (code === BACKSLASH) {
				scan += 2;
				continue;
			}
			if (code === BACKTICK) return scan + 1;
			if (code === DOLLAR && source.charCodeAt(scan + 1) === OPEN_BRACE) {
				templateStack.push(depth);
				depth += 1;
				return scan + 2;
			}
			scan += 1;
		}
		return -1;
	};

	/**
	 * Decides whether a slash opens a regular expression literal rather than dividing, from the significant
	 * character before it.
	 *
	 * @param position the offset of the slash.
	 * @returns true when a regular expression may start there.
	 */
	const regexAllowed = (position: number): boolean => {
		let scan = position - 1;
		while (scan >= start) {
			const code = source.charCodeAt(scan);
			if (code === 32 || code === 9 || code === NEWLINE || code === RETURN) {
				scan -= 1;
				continue;
			}
			if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) return false;
			if (/[A-Za-z0-9_$]/.test(source[scan])) {
				// A keyword may be followed by a regular expression; a name or a literal may not.
				const wordEnd = scan + 1;
				let wordStart = scan;
				while (wordStart >= start && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
				return REGEX_PRECEDING_KEYWORDS.includes(source.slice(wordStart + 1, wordEnd));
			}
			return true;
		}
		return true;
	};

	while (index < source.length) {
		const code = source.charCodeAt(index);

		if (code === BACKSLASH) {
			index += 2;
			continue;
		}

		if (code === SLASH && source.charCodeAt(index + 1) === SLASH) {
			const newlineIndex = source.indexOf('\n', index);
			if (newlineIndex === -1) return -1;
			index = newlineIndex + 1;
			continue;
		}

		if (code === SLASH && source.charCodeAt(index + 1) === STAR) {
			const closeIndex = source.indexOf('*/', index + 2);
			if (closeIndex === -1) return -1;
			index = closeIndex + 2;
			continue;
		}

		if (code === SLASH && regexAllowed(index)) {
			let scan = index + 1;
			let inClass = false;
			let terminated = false;
			while (scan < source.length) {
				const inner = source.charCodeAt(scan);
				if (inner === BACKSLASH) {
					scan += 2;
					continue;
				}
				if (inner === NEWLINE || inner === RETURN) break;
				if (inner === OPEN_BRACKET) inClass = true;
				else if (inner === CLOSE_BRACKET) inClass = false;
				else if (inner === SLASH && !inClass) {
					terminated = true;
					scan += 1;
					break;
				}
				scan += 1;
			}
			if (terminated) {
				// The flags after the closing slash belong to the literal.
				while (scan < source.length && /[a-z]/.test(source[scan])) scan += 1;
				index = scan;
				continue;
			}
			// Not a regular expression after all, so the slash divides.
			index += 1;
			continue;
		}

		if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
			let scan = index + 1;
			let terminated = false;
			while (scan < source.length) {
				const inner = source.charCodeAt(scan);
				if (inner === BACKSLASH) {
					scan += 2;
					continue;
				}
				if (inner === NEWLINE || inner === RETURN) break;
				if (inner === code) {
					terminated = true;
					scan += 1;
					break;
				}
				scan += 1;
			}
			if (!terminated) return -1;
			index = scan;
			continue;
		}

		if (code === BACKTICK) {
			const resumed = scanTemplate(index + 1);
			if (resumed === -1) return -1;
			index = resumed;
			continue;
		}

		if (code === OPEN_BRACE) {
			depth += 1;
			index += 1;
			continue;
		}

		if (code === CLOSE_BRACE) {
			depth -= 1;
			index += 1;
			if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
				// The brace closes a substitution, so the template it sits in resumes.
				templateStack.pop();
				const resumed = scanTemplate(index);
				if (resumed === -1) return -1;
				index = resumed;
				continue;
			}
			// `index` is just past the closing brace, so the body's last character is two before it.
			if (depth === 0) return index - 2;
			continue;
		}

		index += 1;
	}

	return -1;
}
