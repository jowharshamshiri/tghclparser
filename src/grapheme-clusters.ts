/*
 * A TypeScript port of the grapheme cluster segmentation in github.com/apparentlymart/go-textseg v17.0.1
 * (Copyright (c) 2017 Martin Atkins, MIT licence), which follows UAX #29 for Unicode 17.0.0.
 *
 * The HCL formatter measures the width of text in grapheme clusters, using that library. The JavaScript runtime
 * has a segmenter of its own, but it follows whichever Unicode version the runtime was built with, so it disagrees
 * with the formatter for some text and would give different layouts on different runtimes. This one gives the
 * same answer everywhere.
 */

import { graphemeRunProperties, graphemeRunStarts } from './grapheme-table';

// Grapheme_Cluster_Break values, in the low four bits of a character's properties.
const CR = 0x01;
const CONTROL = 0x02;
const EXTEND = 0x03;
const EXTENDED_PICTOGRAPHIC = 0x04;
const L = 0x05;
const LF = 0x06;
const LV = 0x07;
const LVT = 0x08;
const PREPEND = 0x09;
const REGIONAL_INDICATOR = 0x0a;
const SPACING_MARK = 0x0b;
const T = 0x0c;
const V = 0x0d;
const ZWJ = 0x0e;

// Indic_Conjunct_Break values, in the high four bits.
const INCB_CONSONANT = 0x10;
const INCB_EXTEND = 0x20;
const INCB_LINKER = 0x30;

/** What the characters before the current one amount to, as far as the rules that look back more than one go. */
const enum State {
	/** Nothing that matters: the start of text, or after a character that begins no sequence. */
	Base,
	/** One regional indicator, which a second would join into a flag. */
	AwaitEmojiFlag,
	/** A pictographic character and any extenders after it, which a joiner may follow. */
	BeforeZwj,
	/** A joiner after such a run, which a pictographic character may follow. */
	AfterZwj,
	/** An Indic consonant and any extenders after it, with no linker yet. */
	Consonant,
	/** An Indic consonant followed by at least one linker, which another consonant may follow. */
	Linker
}

/**
 * Looks up the segmentation properties of a code point.
 *
 * @param codePoint the code point.
 * @returns its Grapheme_Cluster_Break and Indic_Conjunct_Break values, packed into one number.
 */
function propertiesOf(codePoint: number): number {
	let low = 0;
	let high = graphemeRunStarts.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >>> 1;
		if (graphemeRunStarts[middle] <= codePoint) low = middle;
		else high = middle - 1;
	}
	return graphemeRunProperties[low];
}

/**
 * The state after a character.
 *
 * @param state the state before it.
 * @param properties the character's properties.
 * @returns the state after it.
 */
function nextState(state: State, properties: number): State {
	const breakValue = properties & 0x0f;
	const conjunctValue = properties & 0xf0;
	// These two sequences can begin after anything.
	if (breakValue === EXTENDED_PICTOGRAPHIC) return State.BeforeZwj;
	if (conjunctValue === INCB_CONSONANT) return State.Consonant;
	switch (state) {
		case State.Base:
			return breakValue === REGIONAL_INDICATOR ? State.AwaitEmojiFlag : State.Base;
		case State.BeforeZwj:
			return breakValue === ZWJ ? State.AfterZwj : breakValue === EXTEND ? State.BeforeZwj : State.Base;
		case State.Consonant:
			return conjunctValue === INCB_LINKER ? State.Linker : conjunctValue === INCB_EXTEND ? State.Consonant : State.Base;
		case State.Linker:
			return conjunctValue === INCB_LINKER || conjunctValue === INCB_EXTEND ? State.Linker : State.Base;
		default:
			return State.Base;
	}
}

/**
 * Decides whether a grapheme cluster ends between two characters.
 *
 * @param state the state before `next`, which summarises everything up to and including `previous`.
 * @param previous the properties of the character before the boundary.
 * @param next the properties of the character after it.
 * @returns true when a cluster ends there.
 */
function breaksBetween(state: State, previous: number, next: number): boolean {
	const before = previous & 0x0f;
	const after = next & 0x0f;
	const isControl = (value: number) => value === LF || value === CR || value === CONTROL;
	// GB3: not between a carriage return and a line feed. GB4, GB5: otherwise around any control.
	if (before === CR && after === LF) return false;
	if (isControl(before) || isControl(after)) return true;
	// GB6 to GB8: not inside a Hangul syllable.
	if (before === L && (after === L || after === V || after === LV || after === LVT)) return false;
	if ((before === LV || before === V) && (after === V || after === T)) return false;
	if ((before === LVT || before === T) && after === T) return false;
	// GB9, GB9a, GB9b: not before an extender, a joiner or a spacing mark, nor after a prepended character.
	if (after === EXTEND || after === ZWJ) return false;
	if (after === SPACING_MARK) return false;
	if (before === PREPEND) return false;
	// GB9c: not inside an Indic conjunct.
	if (state === State.Linker) {
		const conjunctBefore = previous & 0xf0;
		if ((conjunctBefore === INCB_LINKER || conjunctBefore === INCB_EXTEND) && (next & 0xf0) === INCB_CONSONANT) return false;
	}
	// GB11: not inside an emoji joined by a zero-width joiner.
	if (state === State.AfterZwj && before === ZWJ && after === EXTENDED_PICTOGRAPHIC) return false;
	// GB12, GB13: not inside a flag.
	if (state === State.AwaitEmojiFlag && before === REGIONAL_INDICATOR && after === REGIONAL_INDICATOR) return false;
	return true;
}

/**
 * Counts the grapheme clusters in text: what a reader takes for its characters, where a letter with its accents,
 * an emoji with its modifiers, or a flag counts once.
 *
 * @param text the text.
 * @returns the number of grapheme clusters.
 */
export function graphemeCount(text: string): number {
	let count = 0;
	forEachCluster(text, () => { count++; });
	return count;
}

/**
 * Splits text into its grapheme clusters.
 *
 * @param text the text.
 * @returns the clusters, in order; joined, they are the text.
 */
export function graphemeClusters(text: string): string[] {
	const starts: number[] = [];
	forEachCluster(text, start => { starts.push(start); });
	return starts.map((start, index) => text.slice(start, starts[index + 1]));
}

/**
 * Finds where each grapheme cluster of text starts.
 *
 * @param text the text.
 * @param found called with the offset each cluster starts at, in order.
 */
function forEachCluster(text: string, found: (start: number) => void): void {
	let state = State.Base;
	let previous = 0;
	let offset = 0;
	for (const character of text) {
		const properties = propertiesOf(character.codePointAt(0)!);
		if (offset === 0 || breaksBetween(state, previous, properties)) {
			// Each cluster is scanned on its own, so what came before it is forgotten.
			found(offset);
			state = nextState(State.Base, properties);
		} else {
			state = nextState(state, properties);
		}
		previous = properties;
		offset += character.length;
	}
}
