// The pattern grammar of github.com/bmatcuk/doublestar v4.10.4, which
// Terragrunt v1.2.2's fileset matches with: '/'-separated, '*' within a
// segment, '**' as a whole segment for any number of directories (elsewhere it
// is '*'), '?', '[...]' classes negated by '^' or '!', '{a,b}' alternatives and
// '\' escapes. Both texts are taken as code points, as Go takes runes.

export class BadPatternError extends Error {
	constructor() {
		super('syntax error in pattern');
	}
}

// Go decodes past the end as U+FFFD with no width.
function runeAt(runes: string[], index: number): string {
	return index < runes.length ? runes[index] : '�';
}

function width(runes: string[], index: number): number {
	return index < runes.length ? 1 : 0;
}

// The index of the first unescaped `wanted` from `start`, or -1.
function indexUnescaped(runes: string[], start: number, wanted: string): number {
	for (let index = start; index < runes.length; index++) {
		if (runes[index] === '\\') index++;
		else if (runes[index] === wanted) return index;
	}
	return -1;
}

// With an opening '{' just before `start`, the index of the '}' that closes
// it, past nested braces, character classes and escapes, or -1.
function indexClosingAlternative(runes: string[], start: number): number {
	let depth = 1;
	for (let index = start; index < runes.length; index++) {
		if (runes[index] === '\\') index++;
		else if (runes[index] === '[') {
			for (index++; index < runes.length; index++) {
				if (runes[index] === '\\') index++;
				else if (runes[index] === ']') break;
			}
		} else if (runes[index] === '{') depth++;
		else if (runes[index] === '}' && --depth === 0) return index;
	}
	return -1;
}

// The index of the next ',' at the top level of [start, end), or -1.
function indexNextAlternative(runes: string[], start: number, end: number): number {
	let depth = 1;
	for (let index = start; index < end; index++) {
		if (runes[index] === '\\') index++;
		else if (runes[index] === '[') {
			for (index++; index < end; index++) {
				if (runes[index] === '\\') index++;
				else if (runes[index] === ']') break;
			}
		} else if (runes[index] === '{') depth++;
		else if (runes[index] === '}') depth--;
		else if (runes[index] === ',' && depth === 1) return index;
	}
	return -1;
}

/**
 * Whether a pattern is well formed: every class closed and non-empty, every brace balanced, and no trailing escape.
 *
 * @param pattern the pattern.
 * @returns true when it is valid.
 */
export function validDoublestarPattern(pattern: string): boolean {
	return validRunes(Array.from(pattern));
}

function validRunes(runes: string[]): boolean {
	let depth = 0;
	validate: for (let index = 0; index < runes.length; index++) {
		switch (runes[index]) {
			case '\\':
				if (++index >= runes.length) return false;
				continue;
			case '[':
				if (++index >= runes.length) return false;
				if (runes[index] === '^' || runes[index] === '!') index++;
				if (index >= runes.length || runes[index] === ']') return false;
				for (; index < runes.length; index++) {
					if (runes[index] === '\\') index++;
					else if (runes[index] === ']') continue validate;
				}
				return false;
			case '{':
				depth++;
				continue;
			case '}':
				if (depth === 0) return false;
				depth--;
				continue;
		}
	}
	return depth === 0;
}

/**
 * Whether a '/'-separated name matches a pattern as a whole.
 *
 * @param pattern the pattern.
 * @param name the name.
 * @returns true when it matches.
 * @throws {BadPatternError} when the pattern is malformed.
 */
export function doublestarMatch(pattern: string, name: string): boolean {
	return matchFrom(Array.from(pattern), Array.from(name), -1, -1, -1, -1, 0, 0);
}

function matchFrom(
	pattern: string[],
	name: string[],
	doublestarPattern: number,
	doublestarName: number,
	starPattern: number,
	starName: number,
	patternIndex: number,
	nameIndex: number
): boolean {
	let startOfSegment = patternIndex === 0 || pattern[patternIndex - 1] === '/';
	match: while (nameIndex < name.length) {
		if (patternIndex < pattern.length) {
			const current = pattern[patternIndex];
			if (current === '*') {
				patternIndex++;
				if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
					// A doublestar spans directories only as a whole segment;
					// anywhere else it is a single star.
					patternIndex++;
					if (startOfSegment) {
						if (patternIndex >= pattern.length) return true;
						if (pattern[patternIndex] === '/') {
							patternIndex++;
							doublestarPattern = patternIndex;
							doublestarName = nameIndex;
							starPattern = -1;
							starName = -1;
							continue;
						}
					}
				}
				startOfSegment = false;
				starPattern = patternIndex;
				starName = nameIndex;
				continue;
			} else if (current === '?') {
				startOfSegment = false;
				if (name[nameIndex] !== '/') {
					patternIndex++;
					nameIndex++;
					continue;
				}
			} else if (current === '[') {
				startOfSegment = false;
				if (++patternIndex >= pattern.length) throw new BadPatternError();
				const nameRune = name[nameIndex];
				let matched = false;
				const negate = pattern[patternIndex] === '!' || pattern[patternIndex] === '^';
				if (negate) patternIndex++;
				if (patternIndex >= pattern.length || pattern[patternIndex] === ']') throw new BadPatternError();
				let last: string | undefined;
				while (patternIndex < pattern.length && pattern[patternIndex] !== ']') {
					let patternRune = pattern[patternIndex++];
					if (last !== undefined && patternRune === '-' && patternIndex < pattern.length && pattern[patternIndex] !== ']') {
						if (pattern[patternIndex] === '\\') patternIndex++;
						patternRune = runeAt(pattern, patternIndex);
						patternIndex += width(pattern, patternIndex);
						const code = nameRune.codePointAt(0)!;
						if (last.codePointAt(0)! <= code && code <= patternRune.codePointAt(0)!) {
							matched = true;
							break;
						}
						last = undefined;
						continue;
					}
					if (patternRune === '\\') {
						patternRune = runeAt(pattern, patternIndex);
						patternIndex += width(pattern, patternIndex);
					}
					if (patternRune === nameRune) {
						matched = true;
						break;
					}
					last = patternRune;
				}
				if (matched !== negate) {
					const closing = indexUnescaped(pattern, patternIndex, ']');
					if (closing === -1) throw new BadPatternError();
					patternIndex = closing + 1;
					nameIndex++;
					continue;
				}
				if (patternIndex >= pattern.length) throw new BadPatternError();
			} else if (current === '{') {
				startOfSegment = false;
				const opening = patternIndex++;
				const closing = indexClosingAlternative(pattern, patternIndex);
				if (closing === -1) throw new BadPatternError();
				const alternative = (from: number, to: number) => matchFrom(
					[...pattern.slice(0, opening), ...pattern.slice(from, to), ...pattern.slice(closing + 1)],
					name, doublestarPattern, doublestarName, starPattern, starName, opening, nameIndex
				);
				for (let comma = indexNextAlternative(pattern, patternIndex, closing); comma !== -1; comma = indexNextAlternative(pattern, patternIndex, closing)) {
					if (alternative(patternIndex, comma)) return true;
					patternIndex = comma + 1;
				}
				return alternative(patternIndex, closing);
			} else {
				if (current === '\\' && ++patternIndex >= pattern.length) throw new BadPatternError();
				const patternRune = pattern[patternIndex];
				if (patternRune === name[nameIndex]) {
					patternIndex++;
					nameIndex++;
					startOfSegment = patternRune === '/';
					continue;
				}
				// An escaped rune that fails is looked at again from its escape.
				if (patternIndex > 0 && pattern[patternIndex - 1] === '\\') patternIndex--;
			}
		}

		if (starPattern >= 0 && name[starName] !== '/') {
			starName++;
			patternIndex = starPattern;
			nameIndex = starName;
			startOfSegment = false;
			continue;
		}

		if (doublestarPattern >= 0) {
			// Let the doublestar take one more directory.
			nameIndex = doublestarName;
			while (nameIndex < name.length) {
				if (name[nameIndex++] === '/') {
					doublestarName = nameIndex;
					patternIndex = doublestarPattern;
					startOfSegment = true;
					continue match;
				}
			}
		}

		if (patternIndex < pattern.length && !validRunes(pattern.slice(patternIndex))) throw new BadPatternError();
		return false;
	}

	return matchesEmpty(pattern.slice(patternIndex));
}

// Whether what is left of a pattern matches nothing at all: '/**', '**/' and
// '/**/' match the directory itself, so 'a/**' matches 'a'.
function matchesEmpty(pattern: string[]): boolean {
	if (['', '*', '**', '/**', '**/', '/**/'].includes(pattern.join(''))) return true;
	if (pattern[0] === '{') {
		const closing = indexClosingAlternative(pattern, 1);
		if (closing === -1) throw new BadPatternError();
		let start = 1;
		for (let comma = indexNextAlternative(pattern, start, closing); comma !== -1; comma = indexNextAlternative(pattern, start, closing)) {
			if (matchesEmpty([...pattern.slice(start, comma), ...pattern.slice(closing + 1)])) return true;
			start = comma + 1;
		}
		return matchesEmpty([...pattern.slice(start, closing), ...pattern.slice(closing + 1)]);
	}
	if (!validRunes(pattern)) throw new BadPatternError();
	return false;
}
