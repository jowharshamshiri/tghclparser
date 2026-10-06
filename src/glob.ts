/*
 * A TypeScript port of github.com/gobwas/glob v0.2.3 (Copyright (c) 2016 Sergey Kamardin, MIT licence), as
 * Terragrunt compiles it for filter paths: with "/" as the separator, and refusing the brace groups it cannot
 * match.
 *
 * Terragrunt decides which files a path filter selects with this library, so selecting the same files means
 * matching as it matches, including where its optimiser gives an answer the pattern would not suggest. That is
 * why this is a port of its matchers, one for one, and not a glob written afresh. Like the original it works on
 * UTF-8 bytes, which matters for text that is not ASCII: several matchers count in bytes where they mean
 * characters, and the port keeps that.
 */

/** A string holding one UTF-8 byte in each character, so that offsets and lengths are byte counts. */
type Bytes = string;

const RUNE_ERROR = 0xFFFD;

/**
 * Encodes text as UTF-8, one byte to a character.
 *
 * @param text the text.
 * @returns its bytes.
 */
function toBytes(text: string): Bytes {
	return Buffer.from(text, 'utf8').toString('latin1');
}

/**
 * Decodes the first rune of a byte string, as Go's `utf8.DecodeRuneInString` does.
 *
 * @param s the bytes.
 * @param at the offset to decode at.
 * @returns the rune and its width in bytes; the error rune with width 1 for an invalid sequence, and with width 0
 *   at the end.
 */
function decodeRune(s: Bytes, at = 0): [number, number] {
	const n = s.length - at;
	if (n < 1) return [RUNE_ERROR, 0];
	const b0 = s.charCodeAt(at);
	if (b0 < 0x80) return [b0, 1];
	if (b0 < 0xC2 || b0 > 0xF4) return [RUNE_ERROR, 1];
	const size = b0 < 0xE0 ? 2 : b0 < 0xF0 ? 3 : 4;
	if (n < size) return [RUNE_ERROR, 1];
	const b1 = s.charCodeAt(at + 1);
	const low = b0 === 0xE0 ? 0xA0 : b0 === 0xF0 ? 0x90 : 0x80;
	const high = b0 === 0xED ? 0x9F : b0 === 0xF4 ? 0x8F : 0xBF;
	if (b1 < low || b1 > high) return [RUNE_ERROR, 1];
	if (size === 2) return [((b0 & 0x1F) << 6) | (b1 & 0x3F), 2];
	const b2 = s.charCodeAt(at + 2);
	if (b2 < 0x80 || b2 > 0xBF) return [RUNE_ERROR, 1];
	if (size === 3) return [((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F), 3];
	const b3 = s.charCodeAt(at + 3);
	if (b3 < 0x80 || b3 > 0xBF) return [RUNE_ERROR, 1];
	return [((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F), 4];
}

/**
 * The bytes a rune takes in UTF-8, as Go's `utf8.RuneLen` counts them.
 *
 * @param rune the rune.
 * @returns its encoded length.
 */
function runeLength(rune: number): number {
	if (rune < 0x80) return 1;
	if (rune < 0x800) return 2;
	if (rune < 0x10000) return 3;
	return 4;
}

/**
 * Walks a byte string rune by rune, as a Go `range` over a string does.
 *
 * @param s the bytes.
 * @returns each rune with the offset it starts at.
 */
function runesOf(s: Bytes): [number, number][] {
	const out: [number, number][] = [];
	for (let at = 0; at < s.length;) {
		const [rune, width] = decodeRune(s, at);
		out.push([at, rune]);
		at += width;
	}
	return out;
}

/**
 * Finds the first of several runes in a byte string, trying the runes in order rather than the positions.
 *
 * @param s the bytes.
 * @param runes the runes to look for.
 * @returns the offset of the first rune found, or -1.
 */
function indexAnyRunes(s: Bytes, runes: number[]): number {
	for (const rune of runes) {
		const found = s.indexOf(toBytes(String.fromCodePoint(rune)));
		if (found !== -1) return found;
	}
	return -1;
}

/**
 * Finds the last of several runes in a byte string. The runes here are separators, which are ASCII.
 *
 * @param s the bytes.
 * @param runes the runes to look for.
 * @returns the offset of the last occurrence of the first rune that occurs, or -1.
 */
function lastIndexAnyRunes(s: Bytes, runes: number[]): number {
	for (const rune of runes) {
		const found = s.lastIndexOf(String.fromCharCode(rune));
		if (found !== -1) return found;
	}
	return -1;
}

/** One compiled piece of a pattern. */
interface Matcher {
	/** Names the kind of matcher, which the compiler's optimisations switch on. */
	readonly kind: string;
	/** Tells whether the whole of `s` matches. */
	match(s: Bytes): boolean;
	/**
	 * Finds where a match starts in `s`.
	 *
	 * @returns the offset of the first match, or -1, and the lengths a match there can have.
	 */
	index(s: Bytes): [number, number[] | undefined];
	/** The number of runes a match has, or -1 when that varies. */
	len(): number;
}

/**
 * Tells whether two rune lists are the same.
 *
 * @param a one list.
 * @param b the other.
 * @returns true when they hold the same runes in the same order.
 */
function sameRunes(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((rune, index) => rune === b[index]);
}

/** Matches any text without a separator: `*`. */
class Any implements Matcher {
	readonly kind = 'Any';
	constructor(readonly separators: number[]) {}
	match(s: Bytes): boolean {
		return indexAnyRunes(s, this.separators) === -1;
	}
	index(s: Bytes): [number, number[]] {
		const found = indexAnyRunes(s, this.separators);
		if (found === 0) return [0, [0]];
		const text = found === -1 ? s : s.slice(0, found);
		const segments = runesOf(text).map(([offset]) => offset);
		segments.push(text.length);
		return [0, segments];
	}
	len(): number {
		return -1;
	}
}

/** Matches when any of its alternatives does: `{a,b}`. */
class AnyOf implements Matcher {
	readonly kind = 'AnyOf';
	constructor(readonly matchers: Matcher[]) {}
	match(s: Bytes): boolean {
		return this.matchers.some(matcher => matcher.match(s));
	}
	index(s: Bytes): [number, number[] | undefined] {
		let index = -1;
		let segments: number[] = [];
		for (const matcher of this.matchers) {
			const [found, lengths] = matcher.index(s);
			if (found === -1) continue;
			if (index === -1 || found < index) {
				index = found;
				segments = [...(lengths ?? [])];
				continue;
			}
			if (found > index) continue;
			segments = mergeSegments(segments, lengths ?? []);
		}
		return index === -1 ? [-1, undefined] : [index, segments];
	}
	len(): number {
		let length = -1;
		for (const matcher of this.matchers) {
			const own = matcher.len();
			if (length === -1) {
				length = own;
				continue;
			}
			if (own === -1 || length !== own) return -1;
		}
		return length;
	}
}

/**
 * Merges two increasing lists of lengths into one without repeats.
 *
 * @param target one list.
 * @param sub the other.
 * @returns the merged list.
 */
function mergeSegments(target: number[], sub: number[]): number[] {
	const out: number[] = [];
	let x = 0;
	let y = 0;
	while (x < target.length || y < sub.length) {
		if (x >= target.length) {
			out.push(...sub.slice(y));
			break;
		}
		if (y >= sub.length) {
			out.push(...target.slice(x));
			break;
		}
		if (target[x] === sub[y]) {
			out.push(target[x]);
			x++;
			y++;
		} else if (target[x] < sub[y]) {
			out.push(target[x++]);
		} else {
			out.push(sub[y++]);
		}
	}
	return out;
}

/** Matches a value with whatever must come before and after it. */
class BTree implements Matcher {
	readonly kind = 'BTree';
	private readonly valueLength: number;
	private readonly leftLength: number;
	private readonly rightLength: number;
	private readonly length: number;
	constructor(readonly value: Matcher, public left: Matcher | undefined, public right: Matcher | undefined) {
		this.valueLength = value.len();
		this.leftLength = left ? left.len() : 0;
		this.rightLength = right ? right.len() : 0;
		const known = this.valueLength !== -1 && this.leftLength !== -1 && this.rightLength !== -1;
		this.length = known ? this.leftLength + this.valueLength + this.rightLength : -1;
	}
	len(): number {
		return this.length;
	}
	index(): [number, undefined] {
		return [-1, undefined];
	}
	match(s: Bytes): boolean {
		const inputLength = s.length;
		if (this.length !== -1 && this.length > inputLength) return false;
		let offset = this.leftLength >= 0 ? this.leftLength : 0;
		const limit = this.rightLength >= 0 ? inputLength - this.rightLength : inputLength;
		while (offset < limit) {
			const [index, segments] = this.value.index(s.slice(offset, limit));
			if (index === -1) return false;
			const before = s.slice(0, offset + index);
			if (this.left ? this.left.match(before) : before === '') {
				for (let at = (segments?.length ?? 0) - 1; at >= 0; at--) {
					const length = segments![at];
					const after = inputLength <= offset + index + length ? '' : s.slice(offset + index + length);
					if (this.right ? this.right.match(after) : after === '') return true;
				}
			}
			offset += index + decodeRune(s, offset + index)[1];
		}
		return false;
	}
}

/** Matches text that holds, or does not hold, a needle. */
class Contains implements Matcher {
	readonly kind = 'Contains';
	constructor(readonly needle: Bytes, readonly not: boolean) {}
	match(s: Bytes): boolean {
		return s.includes(this.needle) !== this.not;
	}
	index(s: Bytes): [number, number[] | undefined] {
		let offset = 0;
		let text = s;
		const found = s.indexOf(this.needle);
		if (!this.not) {
			if (found === -1) return [-1, undefined];
			offset = found + this.needle.length;
			if (s.length <= offset) return [0, [offset]];
			text = s.slice(offset);
		} else if (found !== -1) {
			text = s.slice(0, found);
		}
		const segments = runesOf(text).map(([at]) => offset + at);
		segments.push(offset + text.length);
		return [0, segments];
	}
	len(): number {
		return -1;
	}
}

/** Matches when all of its matchers do. */
class EveryOf implements Matcher {
	readonly kind = 'EveryOf';
	readonly matchers: Matcher[] = [];
	len(): number {
		// As in the original, where the running length is never positive when a matcher is reached.
		let length = 0;
		for (const matcher of this.matchers) {
			const own = matcher.len();
			if (length > 0) length += own;
			else return -1;
		}
		return length;
	}
	index(s: Bytes): [number, number[] | undefined] {
		let index = 0;
		let offset = 0;
		let current: number[] = [];
		let sub = s;
		for (let at = 0; at < this.matchers.length; at++) {
			const [found, segments] = this.matchers[at].index(sub);
			if (found === -1) return [-1, undefined];
			if (at === 0) {
				current = [...(segments ?? [])];
			} else {
				const delta = index - (found + offset);
				const next: number[] = [];
				for (const existing of current) for (const length of segments ?? []) if (existing + delta === length) next.push(length);
				if (next.length === 0) return [-1, undefined];
				current = next;
			}
			index = found + offset;
			sub = s.slice(index);
			offset += found;
		}
		return [index, current];
	}
	match(s: Bytes): boolean {
		return this.matchers.every(matcher => matcher.match(s));
	}
}

/** Matches one character that is, or is not, in a list: `[abc]`, `[!abc]`. */
class List implements Matcher {
	readonly kind = 'List';
	constructor(readonly list: number[], readonly not: boolean) {}
	match(s: Bytes): boolean {
		const [rune, width] = decodeRune(s);
		if (s.length > width) return false;
		return this.list.includes(rune) === !this.not;
	}
	len(): number {
		return 1;
	}
	index(s: Bytes): [number, number[] | undefined] {
		for (const [at, rune] of runesOf(s)) if (this.not === !this.list.includes(rune)) return [at, [runeLength(rune)]];
		return [-1, undefined];
	}
}

/** Matches text of at most a number of characters. */
class Max implements Matcher {
	readonly kind = 'Max';
	constructor(readonly limit: number) {}
	match(s: Bytes): boolean {
		return runesOf(s).length <= this.limit;
	}
	index(s: Bytes): [number, number[]] {
		const segments = [0];
		let count = 0;
		for (const [at, rune] of runesOf(s)) {
			if (++count > this.limit) break;
			segments.push(at + runeLength(rune));
		}
		return [0, segments];
	}
	len(): number {
		return -1;
	}
}

/** Matches text of at least a number of characters. */
class Min implements Matcher {
	readonly kind = 'Min';
	constructor(readonly limit: number) {}
	match(s: Bytes): boolean {
		// As in the original, which reaches a limit of zero only after reading a character.
		let count = 0;
		for (const _ of runesOf(s)) if (++count >= this.limit) return true;
		return false;
	}
	index(s: Bytes): [number, number[] | undefined] {
		if (s.length - this.limit + 1 <= 0) return [-1, undefined];
		const segments: number[] = [];
		let count = 0;
		for (const [at, rune] of runesOf(s)) if (++count >= this.limit) segments.push(at + runeLength(rune));
		return segments.length === 0 ? [-1, undefined] : [0, segments];
	}
	len(): number {
		return -1;
	}
}

/** Matches only the empty string. */
class Nothing implements Matcher {
	readonly kind = 'Nothing';
	match(s: Bytes): boolean {
		return s.length === 0;
	}
	index(): [number, number[]] {
		return [0, [0]];
	}
	len(): number {
		return 0;
	}
}

/** Matches text that starts with a prefix. */
class Prefix implements Matcher {
	readonly kind = 'Prefix';
	constructor(readonly prefix: Bytes) {}
	index(s: Bytes): [number, number[] | undefined] {
		const found = s.indexOf(this.prefix);
		if (found === -1) return [-1, undefined];
		const length = this.prefix.length;
		const sub = s.length > found + length ? s.slice(found + length) : '';
		const segments = [length];
		for (const [at, rune] of runesOf(sub)) segments.push(length + at + runeLength(rune));
		return [found, segments];
	}
	len(): number {
		return -1;
	}
	match(s: Bytes): boolean {
		return s.startsWith(this.prefix);
	}
}

/** Matches a prefix followed by text without a separator. */
class PrefixAny implements Matcher {
	readonly kind = 'PrefixAny';
	constructor(readonly prefix: Bytes, readonly separators: number[]) {}
	index(s: Bytes): [number, number[] | undefined] {
		const found = s.indexOf(this.prefix);
		if (found === -1) return [-1, undefined];
		const length = this.prefix.length;
		let sub = s.slice(found + length);
		const separator = indexAnyRunes(sub, this.separators);
		if (separator > -1) sub = sub.slice(0, separator);
		const segments = [length];
		for (const [at, rune] of runesOf(sub)) segments.push(length + at + runeLength(rune));
		return [found, segments];
	}
	len(): number {
		return -1;
	}
	match(s: Bytes): boolean {
		return s.startsWith(this.prefix) && indexAnyRunes(s.slice(this.prefix.length), this.separators) === -1;
	}
}

/** Matches text that starts with a prefix and ends with a suffix. */
class PrefixSuffix implements Matcher {
	readonly kind = 'PrefixSuffix';
	constructor(readonly prefix: Bytes, readonly suffix: Bytes) {}
	index(s: Bytes): [number, number[] | undefined] {
		const prefixIndex = s.indexOf(this.prefix);
		if (prefixIndex === -1) return [-1, undefined];
		const suffixLength = this.suffix.length;
		if (suffixLength <= 0) return [prefixIndex, [s.length - prefixIndex]];
		if (s.length - prefixIndex <= 0) return [-1, undefined];
		const segments: number[] = [];
		for (let sub = s.slice(prefixIndex); ;) {
			const suffixIndex = sub.lastIndexOf(this.suffix);
			if (suffixIndex === -1) break;
			segments.push(suffixIndex + suffixLength);
			sub = sub.slice(0, suffixIndex);
		}
		if (segments.length === 0) return [-1, undefined];
		return [prefixIndex, segments.reverse()];
	}
	len(): number {
		return -1;
	}
	match(s: Bytes): boolean {
		return s.startsWith(this.prefix) && s.endsWith(this.suffix);
	}
}

/** Matches one character that is, or is not, in a range: `[a-z]`, `[!a-z]`. */
class Range implements Matcher {
	readonly kind = 'Range';
	constructor(readonly low: number, readonly high: number, readonly not: boolean) {}
	len(): number {
		return 1;
	}
	match(s: Bytes): boolean {
		const [rune, width] = decodeRune(s);
		if (s.length > width) return false;
		return (rune >= this.low && rune <= this.high) === !this.not;
	}
	index(s: Bytes): [number, number[] | undefined] {
		for (const [at, rune] of runesOf(s)) if (this.not !== (rune >= this.low && rune <= this.high)) return [at, [runeLength(rune)]];
		return [-1, undefined];
	}
}

/** Matches matchers of fixed length, one after another. */
class Row implements Matcher {
	readonly kind = 'Row';
	constructor(readonly length: number, readonly matchers: Matcher[]) {}
	private matchAll(s: Bytes): boolean {
		let index = 0;
		for (const matcher of this.matchers) {
			const length = matcher.len();
			let next = 0;
			let count = 0;
			for (const [at] of runesOf(s.slice(index))) {
				next = at;
				count++;
				if (count === length) break;
			}
			// The part is cut one byte after the start of its last character, as in the original.
			if (count < length || !matcher.match(s.slice(index, index + next + 1))) return false;
			index += next + 1;
		}
		return true;
	}
	match(s: Bytes): boolean {
		return runesOf(s).length === this.length && this.matchAll(s);
	}
	len(): number {
		return this.length;
	}
	index(s: Bytes): [number, number[] | undefined] {
		for (const [at] of runesOf(s)) {
			if (s.length - at < this.length) break;
			if (this.matchAll(s.slice(at))) return [at, [this.length]];
		}
		return [-1, undefined];
	}
}

/** Matches one character that is not a separator: `?`. */
class Single implements Matcher {
	readonly kind = 'Single';
	constructor(readonly separators: number[]) {}
	match(s: Bytes): boolean {
		const [rune, width] = decodeRune(s);
		if (s.length > width) return false;
		return !this.separators.includes(rune);
	}
	len(): number {
		return 1;
	}
	index(s: Bytes): [number, number[] | undefined] {
		for (const [at, rune] of runesOf(s)) if (!this.separators.includes(rune)) return [at, [runeLength(rune)]];
		return [-1, undefined];
	}
}

/** Matches text that ends with a suffix. */
class Suffix implements Matcher {
	readonly kind = 'Suffix';
	constructor(readonly suffix: Bytes) {}
	len(): number {
		return -1;
	}
	match(s: Bytes): boolean {
		return s.endsWith(this.suffix);
	}
	index(s: Bytes): [number, number[] | undefined] {
		const found = s.indexOf(this.suffix);
		return found === -1 ? [-1, undefined] : [0, [found + this.suffix.length]];
	}
}

/** Matches text without a separator followed by a suffix. */
class SuffixAny implements Matcher {
	readonly kind = 'SuffixAny';
	constructor(readonly suffix: Bytes, readonly separators: number[]) {}
	index(s: Bytes): [number, number[] | undefined] {
		const found = s.indexOf(this.suffix);
		if (found === -1) return [-1, undefined];
		const start = lastIndexAnyRunes(s.slice(0, found), this.separators) + 1;
		return [start, [found + this.suffix.length - start]];
	}
	len(): number {
		return -1;
	}
	match(s: Bytes): boolean {
		return s.endsWith(this.suffix) && indexAnyRunes(s.slice(0, s.length - this.suffix.length), this.separators) === -1;
	}
}

/** Matches any text at all: `**`. */
class Super implements Matcher {
	readonly kind = 'Super';
	match(): boolean {
		return true;
	}
	len(): number {
		return -1;
	}
	index(s: Bytes): [number, number[]] {
		const segments = runesOf(s).map(([at]) => at);
		segments.push(s.length);
		return [0, segments];
	}
}

/** Matches exactly some text. */
class Text implements Matcher {
	readonly kind = 'Text';
	private readonly runes: number;
	constructor(readonly text: Bytes) {
		this.runes = runesOf(text).length;
	}
	match(s: Bytes): boolean {
		return this.text === s;
	}
	len(): number {
		return this.runes;
	}
	index(s: Bytes): [number, number[] | undefined] {
		const found = s.indexOf(this.text);
		return found === -1 ? [-1, undefined] : [found, [this.text.length]];
	}
}

/** A node of a parsed pattern. */
interface Node {
	kind: 'Nothing' | 'Pattern' | 'List' | 'Range' | 'Text' | 'Any' | 'Super' | 'Single' | 'AnyOf';
	parent: Node | undefined;
	children: Node[];
	/** The text of a `Text` node, as bytes. */
	text?: Bytes;
	/** The characters of a `List` node. */
	chars?: number[];
	/** The bounds of a `Range` node. */
	low?: number;
	high?: number;
	/** Whether a `List` or `Range` node is negated. */
	not?: boolean;
}

/**
 * Creates a node and makes it the parent of its children.
 *
 * @param kind the node's kind.
 * @param value the node's own value, if it has one.
 * @param children the nodes under it.
 * @returns the node.
 */
function node(kind: Node['kind'], value: Partial<Node> = {}, children: Node[] = []): Node {
	const created: Node = { kind, parent: undefined, children: [], ...value };
	insert(created, children);
	return created;
}

/**
 * Puts nodes under a parent.
 *
 * @param parent the parent.
 * @param children the nodes to add.
 */
function insert(parent: Node, children: Node[]): void {
	for (const child of children) {
		parent.children.push(child);
		child.parent = parent;
	}
}

/**
 * Tells whether two nodes are the same in kind, value and children.
 *
 * @param a one node.
 * @param b the other.
 * @returns true when they are.
 */
function sameNode(a: Node, b: Node): boolean {
	if (a.kind !== b.kind || a.text !== b.text || a.low !== b.low || a.high !== b.high || a.not !== b.not) return false;
	if ((a.chars === undefined) !== (b.chars === undefined) || (a.chars && !sameRunes(a.chars, b.chars!))) return false;
	return a.children.length === b.children.length && a.children.every((child, index) => sameNode(child, b.children[index]));
}

/** A token of a pattern. */
interface GlobToken {
	type: 'EOF' | 'Error' | 'Text' | 'Any' | 'Super' | 'Single' | 'Not' | 'Separator' | 'RangeOpen' | 'RangeClose' | 'RangeLo' | 'RangeHi' | 'RangeBetween' | 'TermsOpen' | 'TermsClose';
	raw: string;
}

const STAR = 0x2A;
const COMMA = 0x2C;
const QUESTION = 0x3F;
const BACKSLASH = 0x5C;
const OPEN_BRACKET = 0x5B;
const CLOSE_BRACKET = 0x5D;
const OPEN_BRACE = 0x7B;
const CLOSE_BRACE = 0x7D;
const BANG = 0x21;
const HYPHEN = 0x2D;
const textBreakers = [QUESTION, STAR, OPEN_BRACKET, OPEN_BRACE];
const termsBreakers = [...textBreakers, CLOSE_BRACE, COMMA];

/** Cuts a pattern into tokens. */
class GlobLexer {
	private readonly runes: number[];
	private position = 0;
	private error: string | undefined;
	private readonly tokens: GlobToken[] = [];
	private termsLevel = 0;
	private lastRune = 0;
	private lastSize = 0;
	private hasRune = false;

	constructor(pattern: string) {
		this.runes = [...pattern].map(character => character.codePointAt(0)!);
	}

	next(): GlobToken {
		for (;;) {
			if (this.error !== undefined) return { type: 'Error', raw: this.error };
			if (this.tokens.length > 0) return this.tokens.shift()!;
			this.fetchItem();
		}
	}

	/**
	 * Looks at the next rune without taking it. The end of the pattern reads as rune 0, as a NUL in it does, and
	 * the replacement character cannot be told from a decoding failure, so it is an error.
	 *
	 * @returns the rune, and 1 when there is one to take.
	 */
	private peek(): [number, number] {
		if (this.position === this.runes.length) return [0, 0];
		const rune = this.runes[this.position];
		if (rune === RUNE_ERROR) {
			this.error = 'could not read rune';
			return [0, 0];
		}
		return [rune, 1];
	}

	private read(): number {
		if (this.hasRune) {
			this.hasRune = false;
			this.position += this.lastSize;
			return this.lastRune;
		}
		const [rune, size] = this.peek();
		this.position += size;
		this.lastRune = rune;
		this.lastSize = size;
		return rune;
	}

	private unread(): void {
		if (this.hasRune) {
			this.error = 'could not unread rune';
			return;
		}
		this.position -= this.lastSize;
		this.hasRune = true;
	}

	private push(type: GlobToken['type'], ...runes: number[]): void {
		this.tokens.push({ type, raw: String.fromCodePoint(...runes) });
	}

	private fetchItem(): void {
		const rune = this.read();
		if (rune === 0) {
			this.tokens.push({ type: 'EOF', raw: '' });
		} else if (rune === OPEN_BRACE) {
			this.termsLevel++;
			this.push('TermsOpen', rune);
		} else if (rune === COMMA && this.termsLevel > 0) {
			this.push('Separator', rune);
		} else if (rune === CLOSE_BRACE && this.termsLevel > 0) {
			this.push('TermsClose', rune);
			this.termsLevel--;
		} else if (rune === OPEN_BRACKET) {
			this.push('RangeOpen', rune);
			this.fetchRange();
		} else if (rune === QUESTION) {
			this.push('Single', rune);
		} else if (rune === STAR) {
			if (this.read() === STAR) {
				this.push('Super', rune, rune);
			} else {
				this.unread();
				this.push('Any', rune);
			}
		} else {
			this.unread();
			this.fetchText(this.termsLevel > 0 ? termsBreakers : textBreakers);
		}
	}

	private fetchRange(): void {
		let wantHigh = false;
		let wantClose = false;
		let seenNot = false;
		for (;;) {
			const rune = this.read();
			if (rune === 0) {
				this.error = 'unexpected end of input';
				return;
			}
			if (wantClose) {
				if (rune !== CLOSE_BRACKET) this.error = 'expected close range character';
				else this.push('RangeClose', rune);
				return;
			}
			if (wantHigh) {
				this.push('RangeHi', rune);
				wantClose = true;
				continue;
			}
			if (!seenNot && rune === BANG) {
				this.push('Not', rune);
				seenNot = true;
				continue;
			}
			const [next, width] = this.peek();
			if (next === HYPHEN) {
				this.position += width;
				this.push('RangeLo', rune);
				this.push('RangeBetween', next);
				wantHigh = true;
				continue;
			}
			this.unread();
			this.fetchText([CLOSE_BRACKET]);
			wantClose = true;
		}
	}

	private fetchText(breakers: number[]): void {
		const data: number[] = [];
		let escaped = false;
		for (;;) {
			const rune = this.read();
			if (rune === 0) break;
			if (!escaped) {
				if (rune === BACKSLASH) {
					escaped = true;
					continue;
				}
				if (breakers.includes(rune)) {
					this.unread();
					break;
				}
			}
			escaped = false;
			data.push(rune);
		}
		if (data.length > 0) this.push('Text', ...data);
	}
}

/**
 * Parses a pattern into its tree.
 *
 * @param pattern the pattern.
 * @returns the root of the tree.
 * @throws when the pattern is malformed.
 */
function parseGlob(pattern: string): Node {
	const lexer = new GlobLexer(pattern);
	const root = node('Pattern');
	let tree = root;
	for (;;) {
		const token = lexer.next();
		switch (token.type) {
			case 'EOF':
				return root;
			case 'Error':
				throw new Error(token.raw);
			case 'Text':
				insert(tree, [node('Text', { text: toBytes(token.raw) })]);
				break;
			case 'Any':
				insert(tree, [node('Any')]);
				break;
			case 'Super':
				insert(tree, [node('Super')]);
				break;
			case 'Single':
				insert(tree, [node('Single')]);
				break;
			case 'RangeOpen':
				parseRange(tree, lexer);
				break;
			case 'TermsOpen': {
				const anyOf = node('AnyOf');
				insert(tree, [anyOf]);
				tree = node('Pattern');
				insert(anyOf, [tree]);
				break;
			}
			case 'Separator': {
				const alternative = node('Pattern');
				insert(tree.parent!, [alternative]);
				tree = alternative;
				break;
			}
			case 'TermsClose':
				tree = tree.parent!.parent!;
				break;
			default:
				throw new Error(`unexpected token: ${token.type}`);
		}
	}
}

/**
 * Parses the inside of a character class, after its opening bracket.
 *
 * @param tree the node the class goes under.
 * @param lexer the lexer, positioned in the class.
 * @throws when the class is malformed.
 */
function parseRange(tree: Node, lexer: GlobLexer): void {
	let not = false;
	let low = 0;
	let high = 0;
	let chars = '';
	for (;;) {
		const token = lexer.next();
		switch (token.type) {
			case 'EOF':
				throw new Error('unexpected end');
			case 'Error':
				throw new Error(token.raw);
			case 'Not':
				not = true;
				break;
			case 'RangeLo':
				low = token.raw.codePointAt(0)!;
				break;
			case 'RangeHi':
				high = token.raw.codePointAt(0)!;
				if (high < low) throw new Error(`hi character '${token.raw}' should be greater than lo '${String.fromCodePoint(low)}'`);
				break;
			case 'Text':
				chars = token.raw;
				break;
			case 'RangeClose': {
				const isRange = low !== 0 && high !== 0;
				if ((chars !== '') === isRange) throw new Error('could not parse range');
				if (isRange) insert(tree, [node('Range', { low, high, not })]);
				else insert(tree, [node('List', { chars: [...chars].map(character => character.codePointAt(0)!), not })]);
				return;
			}
			default:
				break;
		}
	}
}

/**
 * Replaces a matcher with a simpler one that matches the same, where one is known.
 *
 * @param matcher the matcher.
 * @returns the matcher to use.
 */
function optimize(matcher: Matcher): Matcher {
	if (matcher instanceof Any) return matcher.separators.length === 0 ? new Super() : matcher;
	if (matcher instanceof AnyOf) return matcher.matchers.length === 1 ? matcher.matchers[0] : matcher;
	if (matcher instanceof List) return !matcher.not && matcher.list.length === 1 ? new Text(toBytes(String.fromCodePoint(...matcher.list))) : matcher;
	if (!(matcher instanceof BTree)) return matcher;

	const left = matcher.left === undefined ? undefined : optimize(matcher.left);
	const right = matcher.right === undefined ? undefined : optimize(matcher.right);
	const tree = left === matcher.left && right === matcher.right ? matcher : new BTree(matcher.value, left, right);
	if (!(tree.value instanceof Text)) return tree;
	const text = tree.value.text;
	if (left === undefined && right === undefined) return new Text(text);
	if (left instanceof Super && right instanceof Super) return new Contains(text, false);
	if (left instanceof Super && right === undefined) return new Suffix(text);
	if (right instanceof Super && left === undefined) return new Prefix(text);
	if (left === undefined && right instanceof Suffix) return new PrefixSuffix(text, right.suffix);
	if (right === undefined && left instanceof Prefix) return new PrefixSuffix(left.prefix, text);
	if (right === undefined && left instanceof Any) return new SuffixAny(text, left.separators);
	if (left === undefined && right instanceof Any) return new PrefixAny(text, right.separators);
	return tree;
}

/**
 * Joins matchers that are all of fixed length into a row.
 *
 * @param matchers the matchers.
 * @returns the row, or undefined when a matcher has no fixed length.
 */
function glueAsRow(matchers: Matcher[]): Matcher | undefined {
	if (matchers.length <= 1) return undefined;
	let length = 0;
	for (const matcher of matchers) {
		const own = matcher.len();
		if (own === -1) return undefined;
		length += own;
	}
	return new Row(length, [...matchers]);
}

/**
 * Joins wildcards that share their separators into one matcher counting characters.
 *
 * @param matchers the matchers.
 * @returns the joined matcher, or undefined when they cannot be joined.
 */
function glueAsEvery(matchers: Matcher[]): Matcher | undefined {
	if (matchers.length <= 1) return undefined;
	let hasAny = false;
	let hasSuper = false;
	let hasSingle = false;
	let minimum = 0;
	let separator: number[] = [];
	for (let index = 0; index < matchers.length; index++) {
		const matcher = matchers[index];
		let own: number[];
		if (matcher instanceof Super) {
			own = [];
			hasSuper = true;
		} else if (matcher instanceof Any) {
			own = matcher.separators;
			hasAny = true;
		} else if (matcher instanceof Single) {
			own = matcher.separators;
			hasSingle = true;
			minimum++;
		} else if (matcher instanceof List) {
			if (!matcher.not) return undefined;
			own = matcher.list;
			hasSingle = true;
			minimum++;
		} else {
			return undefined;
		}
		if (index === 0) separator = own;
		if (!sameRunes(own, separator)) return undefined;
	}
	if (hasSuper && !hasAny && !hasSingle) return new Super();
	if (hasAny && !hasSuper && !hasSingle) return new Any(separator);
	if ((hasAny || hasSuper) && minimum > 0 && separator.length === 0) return new Min(minimum);
	const every = new EveryOf();
	if (minimum > 0) {
		every.matchers.push(new Min(minimum));
		if (!hasAny && !hasSuper) every.matchers.push(new Max(minimum));
	}
	if (separator.length > 0) every.matchers.push(new Contains(toBytes(String.fromCodePoint(...separator)), true));
	return every;
}

/**
 * Joins a run of matchers into one, where they can be.
 *
 * @param matchers the matchers.
 * @returns the joined matcher, or undefined.
 */
function glue(matchers: Matcher[]): Matcher | undefined {
	return glueAsEvery(matchers) ?? glueAsRow(matchers);
}

/**
 * Joins the runs of matchers that can be joined, largest first, until nothing more joins.
 *
 * @param matchers the matchers.
 * @returns the shorter list.
 */
function minimize(matchers: Matcher[]): Matcher[] {
	let done: Matcher | undefined;
	let left = 0;
	let right = 0;
	let count = 0;
	for (let from = 0; from < matchers.length; from++) {
		for (let to = matchers.length; to > from; to--) {
			const glued = glue(matchers.slice(from, to));
			if (glued === undefined) continue;
			let swap: boolean;
			if (done === undefined) {
				swap = true;
			} else {
				const current = done.len();
				const candidate = glued.len();
				swap = (current > -1 && candidate > -1 && candidate > current) || count < to - from;
			}
			if (swap) {
				done = glued;
				left = from;
				right = to;
				count = to - from;
			}
		}
	}
	if (done === undefined) return matchers;
	const next = [...matchers.slice(0, left), done, ...matchers.slice(right)];
	return next.length === matchers.length ? next : minimize(next);
}

/**
 * Builds one matcher from a sequence: the longest of fixed length becomes the value of a tree, with what comes
 * before and after it on either side.
 *
 * @param matchers the matchers, at least one.
 * @returns the matcher.
 */
function compileMatchers(matchers: Matcher[]): Matcher {
	if (matchers.length === 0) throw new Error('compile error: need at least one matcher');
	if (matchers.length === 1) return matchers[0];
	const glued = glue(matchers);
	if (glued) return glued;

	let index = -1;
	let longest = -1;
	for (let at = 0; at < matchers.length; at++) {
		const length = matchers[at].len();
		if (length !== -1 && length >= longest) {
			longest = length;
			index = at;
		}
	}
	if (index === -1) return new BTree(matchers[0], undefined, compileMatchers(matchers.slice(1)));
	const before = matchers.slice(0, index);
	const after = matchers.slice(index + 1);
	return new BTree(matchers[index], before.length > 0 ? compileMatchers(before) : undefined, after.length > 0 ? compileMatchers(after) : undefined);
}

/**
 * Finds the children that every alternative of a brace group starts with, and ends with.
 *
 * @param nodes the alternatives.
 * @returns the common leading and trailing children.
 */
function commonChildren(nodes: Node[]): [Node[], Node[]] {
	if (nodes.length <= 1) return [[], []];
	let least = -1;
	let fewest = -1;
	nodes.forEach((candidate, index) => {
		if (least === -1 || candidate.children.length < fewest) {
			fewest = candidate.children.length;
			least = index;
		}
	});
	const tree = nodes[least];
	const length = tree.children.length;
	const commonLeft: Node[] = [];
	const commonRight = new Array<Node>(length);
	let lastRight = length;
	let breakLeft = false;
	let breakRight = false;
	let total = 0;
	for (let i = 0, j = length - 1; total < length && j >= 0 && !(breakLeft && breakRight); i++, j--) {
		const treeLeft = tree.children[i];
		const treeRight = tree.children[j];
		for (let k = 0; k < nodes.length && !(breakLeft && breakRight); k++) {
			if (k === least) continue;
			const restLeft = nodes[k].children[i];
			const restRight = nodes[k].children[j + nodes[k].children.length - length];
			breakLeft = breakLeft || !sameNode(treeLeft, restLeft);
			// The search from the right stops once the left part has reached it.
			breakRight = breakRight || (!breakLeft && j <= i);
			breakRight = breakRight || !sameNode(treeRight, restRight);
		}
		if (!breakLeft) {
			total++;
			commonLeft.push(treeLeft);
		}
		if (!breakRight) {
			total++;
			lastRight = j;
			commonRight[j] = treeRight;
		}
	}
	return [commonLeft, commonRight.slice(lastRight)];
}

/**
 * Rewrites a brace group whose alternatives share what they start or end with, moving the shared part out.
 *
 * @param tree a brace group.
 * @returns the rewritten tree, or undefined when nothing is shared.
 */
function minimizeAnyOf(tree: Node): Node | undefined {
	if (tree.children.some(child => child.kind !== 'Pattern')) return undefined;
	const [commonLeft, commonRight] = commonChildren(tree.children);
	if (commonLeft.length === 0 && commonRight.length === 0) return undefined;

	const result: Node[] = [];
	if (commonLeft.length > 0) result.push(node('Pattern', {}, commonLeft));
	const alternatives: Node[] = [];
	for (const child of tree.children) {
		const reuse = child.children.slice(commonLeft.length, child.children.length - commonRight.length);
		const alternative = reuse.length === 0 ? node('Nothing') : node('Pattern', {}, reuse);
		if (!alternatives.some(existing => sameNode(existing, alternative))) alternatives.push(alternative);
	}
	if (alternatives.length === 1 && alternatives[0].kind !== 'Nothing') result.push(alternatives[0]);
	else if (alternatives.length > 1) result.push(node('AnyOf', {}, alternatives));
	if (commonRight.length > 0) result.push(node('Pattern', {}, commonRight));
	return node('Pattern', {}, result);
}

/**
 * Compiles a tree into a matcher.
 *
 * @param tree the tree.
 * @param separators the runes `*` and `?` do not match.
 * @returns the matcher.
 */
function compile(tree: Node, separators: number[]): Matcher {
	/**
	 * Compiles the children of a node.
	 *
	 * @param parent the node.
	 * @returns a matcher for each child.
	 */
	const children = (parent: Node) => parent.children.map(child => optimize(compile(child, separators)));
	switch (tree.kind) {
		case 'AnyOf': {
			const minimized = minimizeAnyOf(tree);
			return minimized ? compile(minimized, separators) : new AnyOf(children(tree));
		}
		case 'Pattern':
			return optimize(tree.children.length === 0 ? new Nothing() : compileMatchers(minimize(children(tree))));
		case 'Any':
			return optimize(new Any(separators));
		case 'Super':
			return new Super();
		case 'Single':
			return new Single(separators);
		case 'Nothing':
			return new Nothing();
		case 'List':
			return optimize(new List(tree.chars!, tree.not!));
		case 'Range':
			return new Range(tree.low!, tree.high!, tree.not!);
		case 'Text':
			return new Text(tree.text!);
	}
}

/**
 * Tells whether a matcher holds a row with a part of no length, which the row cannot match correctly. Some empty
 * or unclosed brace groups compile to one.
 *
 * @param matcher the compiled matcher.
 * @returns true when it does.
 */
function hasZeroLengthRowPart(matcher: Matcher): boolean {
	const stack: (Matcher | undefined)[] = [matcher];
	while (stack.length > 0) {
		const next = stack.pop();
		if (next instanceof Row) {
			if (next.matchers.some(part => part.len() <= 0)) return true;
			stack.push(...next.matchers);
		} else if (next instanceof AnyOf || next instanceof EveryOf) {
			stack.push(...next.matchers);
		} else if (next instanceof BTree) {
			stack.push(next.value, next.left, next.right);
		}
	}
	return false;
}

/** A compiled glob pattern. */
export interface Glob {
	/**
	 * Tests a path.
	 *
	 * @param path a `/`-separated path.
	 * @returns true when the whole path matches the pattern.
	 */
	match(path: string): boolean;
}

/**
 * Compiles a glob pattern as Terragrunt does for the paths of filters. `*` matches within one path segment, `**`
 * across segments, `?` one character that is not `/`, `[...]` a character class, `{a,b}` any of the alternatives,
 * and a backslash takes the next character literally.
 *
 * @param pattern the pattern, `/`-separated.
 * @returns the compiled pattern.
 * @throws when the pattern is malformed, or has an empty or unclosed brace group that cannot be matched.
 */
export function compileGlob(pattern: string): Glob {
	const matcher = compile(parseGlob(pattern), [0x2F]);
	if (hasZeroLengthRowPart(matcher)) throw new Error('unsupported empty or unclosed {} group in glob pattern');
	return { match: path => matcher.match(toBytes(path)) };
}
