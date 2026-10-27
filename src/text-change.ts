import type { Position, Range } from 'vscode-languageserver';

/**
 * The difference between two versions of a text, as the one stretch that changed between the longest common start
 * and the longest common end. Offsets and positions outside that stretch map exactly from one version to the other;
 * those inside it have no counterpart.
 */
export class TextChange {
	/** Offset of the first character that differs, the same in both versions. */
	private readonly start: number;
	/** Offset in the earlier version just past the changed stretch. */
	private readonly beforeEnd: number;
	/** Offset in the later version just past the changed stretch. */
	private readonly afterEnd: number;

	/**
	 * Finds the changed stretch between two versions of a text.
	 *
	 * @param before the earlier version.
	 * @param after the later version.
	 */
	constructor(private readonly before: string, private readonly after: string) {
		const shorter = Math.min(before.length, after.length);
		let start = 0;
		while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start++;
		let common = 0;
		while (common < shorter - start && before.charCodeAt(before.length - 1 - common) === after.charCodeAt(after.length - 1 - common)) common++;
		this.start = start;
		this.beforeEnd = before.length - common;
		this.afterEnd = after.length - common;
	}

	/**
	 * Maps an offset in the earlier version to the later one. Where text was only inserted, the start of something
	 * at the insertion point moves with the text after it and the end of something stays with the text before it.
	 *
	 * @param offset an offset in the earlier version.
	 * @param side whether the offset starts or ends a span, which decides an offset on the edge of an insertion.
	 * @returns the offset in the later version, or undefined when it falls inside the changed stretch.
	 */
	toAfter(offset: number, side: 'start' | 'end'): number | undefined {
		return this.map(offset, side, this.beforeEnd, this.afterEnd - this.beforeEnd);
	}

	/**
	 * Maps an offset in the later version to the earlier one, the reverse of {@link toAfter}.
	 *
	 * @param offset an offset in the later version.
	 * @param side whether the offset starts or ends a span, which decides an offset on the edge of an insertion.
	 * @returns the offset in the earlier version, or undefined when it falls inside the changed stretch.
	 */
	toBefore(offset: number, side: 'start' | 'end'): number | undefined {
		return this.map(offset, side, this.afterEnd, this.beforeEnd - this.afterEnd);
	}

	/**
	 * Maps a position in the later version to the earlier one.
	 *
	 * @param position a position in the later version.
	 * @returns the position in the earlier version, or undefined when it falls inside the changed stretch.
	 */
	positionToBefore(position: Position): Position | undefined {
		const offset = this.toBefore(offsetAt(this.after, position), 'start');
		return offset === undefined ? undefined : positionAt(this.before, offset);
	}

	/**
	 * Maps a range in the earlier version to the later one.
	 *
	 * @param range a range in the earlier version.
	 * @returns the range in the later version, or undefined when either end falls inside the changed stretch.
	 */
	rangeToAfter(range: Range): Range | undefined {
		const start = this.toAfter(offsetAt(this.before, range.start), 'start');
		const end = this.toAfter(offsetAt(this.before, range.end), 'end');
		if (start === undefined || end === undefined) return undefined;
		return { start: positionAt(this.after, start), end: positionAt(this.after, end) };
	}

	/**
	 * Maps an offset across the change in one direction.
	 *
	 * @param offset the offset to map.
	 * @param side whether the offset starts or ends a span.
	 * @param end the offset just past the changed stretch in the version being mapped from.
	 * @param shift how far offsets after the changed stretch move.
	 * @returns the mapped offset, or undefined inside the changed stretch.
	 */
	private map(offset: number, side: 'start' | 'end', end: number, shift: number): number | undefined {
		if (offset < this.start || (offset === this.start && side === 'end')) return offset;
		if (offset > end || (offset === end && side === 'start')) return offset + shift;
		return undefined;
	}
}

/**
 * Converts a zero-based line and UTF-16 character to an offset.
 *
 * @param text the text the position is in.
 * @param position the position.
 * @returns the offset, clamped to the line's end and the text's length.
 */
function offsetAt(text: string, position: Position): number {
	let lineStart = 0;
	for (let line = 0; line < position.line; line++) {
		const next = text.indexOf('\n', lineStart);
		if (next < 0) return text.length;
		lineStart = next + 1;
	}
	const lineEnd = text.indexOf('\n', lineStart);
	return Math.min(lineStart + position.character, lineEnd < 0 ? text.length : lineEnd);
}

/**
 * Converts an offset to a zero-based line and UTF-16 character.
 *
 * @param text the text the offset is in.
 * @param offset the offset.
 * @returns the position.
 */
function positionAt(text: string, offset: number): Position {
	let line = 0;
	let lineStart = 0;
	for (let next = text.indexOf('\n'); next >= 0 && next < offset; next = text.indexOf('\n', next + 1)) {
		line++;
		lineStart = next + 1;
	}
	return { line, character: offset - lineStart };
}
