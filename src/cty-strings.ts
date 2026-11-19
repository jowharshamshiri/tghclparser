/*
 * A TypeScript port of the known-prefix rules of github.com/zclconf/go-cty v1.19.0's ctystrings package and its
 * RefinementBuilder.StringPrefixFull (Copyright HashiCorp, Inc., MIT licence), with the NFC boundary search of
 * golang.org/x/text/unicode/norm (Copyright The Go Authors, BSD-style licence) it relies on.
 *
 * assumestringprefix is held to these rules: go-cty compares a string only with the part of a prefix that a later
 * character could not change, so a prefix's last character counts only when it is a delimiter.
 */

import { graphemeClusters } from './grapheme-clusters';
import { normalizationRunProperties, normalizationRunStarts } from './normalization-table';

/** x/text's limit on the non-starters it reads in a row before it gives up looking for a boundary. */
const maxNonStarters = 30;

/** The characters go-cty takes to end a grapheme cluster whatever follows them. */
const delimiters = new Set(['-', '_', ':', ';', '/', '\\', ',', '.', '(', ')', '{', '}', '[', ']', '|', '?', '!', '~', ' ', '\t', '@', '#', '$', '%', '^', '&', '*', '+', '"', '\'']);

interface NormalizationProperties {
	inert: boolean;
	leadingNonStarters: number;
	trailingNonStarters: number;
}

function normalizationProperties(codePoint: number): NormalizationProperties {
	let low = 0;
	let high = normalizationRunStarts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >>> 1;
		if (normalizationRunStarts[middle] <= codePoint) low = middle;
		else high = middle - 1;
	}
	const packed = normalizationRunProperties[low];
	return { inert: (packed & 1) !== 0, leadingNonStarters: (packed >> 1) & 3, trailingNonStarters: (packed >> 3) & 3 };
}

/**
 * x/text's NFC LastBoundary over the code points of a normalized string: the index after which nothing written can
 * change what comes before it, or -1 when there is no such place.
 */
function lastBoundary(codePoints: number[]): number {
	if (codePoints.length === 0) return -1;
	let at = codePoints.length - 1;
	const last = normalizationProperties(codePoints[at]);
	if (last.inert) return codePoints.length;

	let nonStarters = 0;
	const backwards = (properties: NormalizationProperties): 'starter' | 'success' | 'overflow' => {
		const count = nonStarters + properties.trailingNonStarters;
		if (count > maxNonStarters) return 'overflow';
		nonStarters = count;
		return properties.leadingNonStarters === 0 ? 'starter' : 'success';
	};

	let state = backwards(last);
	while (state !== 'starter') {
		if (at === 0) return -1;
		state = backwards(normalizationProperties(codePoints[at - 1]));
		if (state === 'overflow') return at;
		at--;
	}
	return at;
}

/**
 * go-cty's SafeKnownPrefix: the part of a prefix that no character written after it could change, under NFC or by
 * joining a grapheme cluster.
 *
 * @param prefix the prefix.
 * @returns the part of it that is safe to compare, normalized.
 */
export function safeKnownPrefix(prefix: string): string {
	const normalized = prefix.normalize('NFC');
	const codePoints = [...normalized].map(character => character.codePointAt(0)!);
	const boundary = lastBoundary(codePoints);
	if (boundary !== -1 && boundary !== codePoints.length) return String.fromCodePoint(...codePoints.slice(0, boundary));

	const clusters = graphemeClusters(normalized);
	const lastCluster = clusters.at(-1);
	if (lastCluster === undefined) return '';
	const single = [...lastCluster];
	if (single.length === 1 && delimiters.has(single[0])) return normalized;
	return clusters.slice(0, -1).join('');
}

/**
 * Whether go-cty lets a known string be refined with a prefix: the two agree over as many bytes as the shorter of the
 * string and the safe part of the prefix has.
 *
 * @param value the string.
 * @param prefix the prefix assumed for it.
 * @returns false when go-cty finds the prefix inconsistent with the string.
 */
export function consistentWithPrefix(value: string, prefix: string): boolean {
	const have = Buffer.from(value.normalize('NFC'), 'utf8');
	const known = Buffer.from(safeKnownPrefix(prefix), 'utf8');
	const length = Math.min(have.length, known.length);
	return have.subarray(0, length).equals(known.subarray(0, length));
}
