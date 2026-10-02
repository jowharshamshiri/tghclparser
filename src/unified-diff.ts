/*
 * A TypeScript port of the anchored diff in github.com/rogpeppe/go-internal/diff, itself taken from the Go
 * project's internal/diff.
 *
 * Copyright 2022 The Go Authors. All rights reserved. Use of this source code is governed by a BSD-style license
 * that can be found at https://go.dev/LICENSE.
 *
 * `terragrunt hcl format --diff` prints this diff, so printing the same text means choosing the same hunks, which
 * a diff found any other way would not always do.
 */

/** A pair of line indexes, one into the old text and one into the new. */
interface Pair {
	x: number;
	y: number;
}

/** The lines of context kept around each change. */
const contextLines = 3;

/**
 * Compares two texts line by line and describes the difference in the unified format.
 *
 * The diff is anchored on the lines that appear exactly once in each text: the longest run of those in common
 * order is kept, and everything between them is expanded outwards while lines still match. Unlike a diff that
 * minimises the lines changed, this never pairs up unrelated blank lines or closing braces.
 *
 * @param oldName how the header names the old text.
 * @param oldText the old text.
 * @param newName how the header names the new text.
 * @param newText the new text.
 * @returns the diff, or an empty string when the texts are the same.
 */
export function unifiedDiff(oldName: string, oldText: string, newName: string, newText: string): string {
	if (oldText === newText) return '';
	const x = diffLines(oldText);
	const y = diffLines(newText);
	let out = `diff ${oldName} ${newName}\n--- ${oldName}\n+++ ${newName}\n`;

	// Printed up to x[:done.x] and y[:done.y].
	let done: Pair = { x: 0, y: 0 };
	// The lines the current chunk starts at, and how many it holds from each side.
	let chunk: Pair = { x: 0, y: 0 };
	const count: Pair = { x: 0, y: 0 };
	let text: string[] = [];

	for (const match of anchors(x, y)) {
		// Already covered while scanning forward from an earlier match.
		if (match.x < done.x) continue;

		// Widen the match while the lines on either side of it agree.
		const start = { ...match };
		while (start.x > done.x && start.y > done.y && x[start.x - 1] === y[start.y - 1]) {
			start.x--;
			start.y--;
		}
		const end = { ...match };
		while (end.x < x.length && end.y < y.length && x[end.x] === y[end.y]) {
			end.x++;
			end.y++;
		}

		for (const line of x.slice(done.x, start.x)) {
			text.push(`-${line}`);
			count.x++;
		}
		for (const line of y.slice(done.y, start.y)) {
			text.push(`+${line}`);
			count.y++;
		}

		// Too few common lines to end the chunk, unless this is the end of both texts: they join the chunk.
		const common = end.x - start.x;
		if ((end.x < x.length || end.y < y.length) && (common < contextLines || (text.length > 0 && common < 2 * contextLines))) {
			for (const line of x.slice(start.x, end.x)) {
				text.push(` ${line}`);
				count.x++;
				count.y++;
			}
			done = end;
			continue;
		}

		if (text.length > 0) {
			const trailing = Math.min(common, contextLines);
			for (const line of x.slice(start.x, start.x + trailing)) {
				text.push(` ${line}`);
				count.x++;
				count.y++;
			}
			done = { x: start.x + trailing, y: start.y + trailing };
			// Line numbers count from one, except that an empty side is 0,0.
			if (count.x > 0) chunk.x++;
			if (count.y > 0) chunk.y++;
			out += `@@ -${chunk.x},${count.x} +${chunk.y},${count.y} @@\n${text.join('')}`;
			count.x = 0;
			count.y = 0;
			text = [];
		}

		if (end.x >= x.length && end.y >= y.length) break;

		chunk = { x: end.x - contextLines, y: end.y - contextLines };
		for (const line of x.slice(chunk.x, end.x)) {
			text.push(` ${line}`);
			count.x++;
			count.y++;
		}
		done = end;
	}
	return out;
}

/**
 * Splits a text into lines that keep their line breaks. A last line without one is given one, with the note that
 * BSD and GNU diff print.
 *
 * @param text the text.
 * @returns its lines.
 */
function diffLines(text: string): string[] {
	const lines = text.split(/(?<=\n)/);
	if (lines[lines.length - 1] === '') lines.pop();
	else if (!lines[lines.length - 1].endsWith('\n')) lines[lines.length - 1] += '\n\\ No newline at end of file\n';
	return lines;
}

/**
 * Finds the longest common subsequence of the lines that appear once in each text, by Szymanski's algorithm.
 *
 * @param x the old lines.
 * @param y the new lines.
 * @returns the index pairs of that subsequence, between a leading `{0, 0}` and a trailing `{x.length, y.length}`.
 */
function anchors(x: string[], y: string[]): Pair[] {
	// How often each line appears: 0, 1 or many on each side, as 0, -1, -2 for x and 0, -4, -8 for y, so that a
	// line unique to both is -5 and line numbers, stored later, are never negative.
	const seen = new Map<string, number>();
	for (const line of x) {
		const times = seen.get(line) ?? 0;
		if (times > -2) seen.set(line, times - 1);
	}
	for (const line of y) {
		const times = seen.get(line) ?? 0;
		if (times > -8) seen.set(line, times - 4);
	}

	const xi: number[] = [];
	const yi: number[] = [];
	const inverse: number[] = [];
	y.forEach((line, index) => {
		if (seen.get(line) === -5) {
			seen.set(line, yi.length);
			yi.push(index);
		}
	});
	x.forEach((line, index) => {
		const position = seen.get(line);
		if (position !== undefined && position >= 0) {
			xi.push(index);
			inverse.push(position);
		}
	});

	const n = xi.length;
	const smallest = new Array<number>(n).fill(n + 1);
	const length = new Array<number>(n).fill(0);
	for (let index = 0; index < n; index++) {
		let low = 0;
		let high = n;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (smallest[middle] >= inverse[index]) high = middle;
			else low = middle + 1;
		}
		smallest[low] = inverse[index];
		length[index] = low + 1;
	}
	let longest = 0;
	for (const value of length) longest = Math.max(longest, value);

	const sequence = new Array<Pair>(longest + 2);
	sequence[longest + 1] = { x: x.length, y: y.length };
	// The Go original compares against a bound it never lowers, so the last line of each length wins.
	const bound = n;
	for (let index = n - 1; index >= 0; index--) {
		if (length[index] === longest && inverse[index] < bound) {
			sequence[longest] = { x: xi[index], y: yi[inverse[index]] };
			longest--;
		}
	}
	sequence[0] = { x: 0, y: 0 };
	return sequence;
}
