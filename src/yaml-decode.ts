/**
 * yamldecode as Terragrunt v1.2.2 computes it, through go-cty-yaml v1.2.0: a single YAML document read into strings,
 * numbers, bools, nulls, tuples and objects. A scalar is resolved from its tag, its text and whether it is quoted, as
 * go-cty-yaml's resolveScalar does, so a number keeps the exact value its text gives at go-cty's 512-bit precision,
 * the YAML 1.1 booleans, nulls, infinities and timestamps are recognised, and a text that only looks like a number stays
 * a string. Mappings, merge keys and anchors are assembled as go-cty-yaml assembles them, and its messages are given
 * where it refuses a document.
 */
import { Composer, isAlias, isMap, isPair, isScalar, isSeq, Parser, Scalar } from 'yaml';
import type { CST, Document, Pair, Node as YamlNode, YAMLMap, YAMLSeq } from 'yaml';

import { CtyNumber } from './cty-number';
import {
	makeArrayValue,
	makeBooleanValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeStringValue
} from './functions/utils';
import { goQuoted } from './go-quote';
import type { RuntimeValue, ValueType } from './model';

const TAG_PREFIX = 'tag:yaml.org,2002:';
const STR_TAG = `${TAG_PREFIX}str`;
const BOOL_TAG = `${TAG_PREFIX}bool`;
const INT_TAG = `${TAG_PREFIX}int`;
const FLOAT_TAG = `${TAG_PREFIX}float`;
const NULL_TAG = `${TAG_PREFIX}null`;
const TIMESTAMP_TAG = `${TAG_PREFIX}timestamp`;
const BINARY_TAG = `${TAG_PREFIX}binary`;
const MAP_TAG = `${TAG_PREFIX}map`;
const SEQ_TAG = `${TAG_PREFIX}seq`;
const MERGE_TAG = `${TAG_PREFIX}merge`;

/** The tags a scalar may carry: go-cty-yaml refuses any other as unsupported. */
const RESOLVABLE_TAGS = new Set(['', STR_TAG, BOOL_TAG, INT_TAG, FLOAT_TAG, NULL_TAG, TIMESTAMP_TAG, BINARY_TAG]);

/** What a scalar's first character hints it might be: a sign, a digit, a word in {@link RESOLVE_MAP}, or a float. */
type Hint = 'S' | 'D' | 'M' | '.';

const HINTS = new Map<string, Hint>([
	['+', 'S'], ['-', 'S'],
	...[...'0123456789'].map((digit): [string, Hint] => [digit, 'D']),
	...[...'yYnNtTfFoO~'].map((letter): [string, Hint] => [letter, 'M']),
	['.', '.']
]);

type Plain = { tag: typeof BOOL_TAG; value: boolean } | { tag: typeof NULL_TAG; value: null } | { tag: typeof FLOAT_TAG; value: CtyNumber };

/** The texts that resolve whatever tag a scalar carries, unless it is a string or binary. */
const RESOLVE_MAP = new Map<string, Plain>();
for (const [plain, texts] of [
	[{ tag: BOOL_TAG, value: true }, ['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON']],
	[{ tag: BOOL_TAG, value: false }, ['n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF']],
	[{ tag: NULL_TAG, value: null }, ['', '~', 'null', 'Null', 'NULL']],
	[{ tag: FLOAT_TAG, value: CtyNumber.parse('+Inf') }, ['.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF']],
	[{ tag: FLOAT_TAG, value: CtyNumber.parse('-Inf') }, ['-.inf', '-.Inf', '-.INF']]
] as Array<[Plain, string[]]>) {
	for (const text of texts) RESOLVE_MAP.set(text, plain);
}

const NAN_TEXTS = new Set(['.nan', '.NaN', '.NAN']);

/** YAML 1.2's integer literals, as go-cty-yaml matches them: decimal with a sign, or 0o octal or 0x hexadecimal. */
const INTEGER_LITERAL = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/u;
const FLOAT_LITERAL = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/u;

/** Base64 as Go's StdEncoding decodes it once its line breaks are dropped: padded, with no other character. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type Style = 'plain' | 'quoted' | 'block';

/**
 * Decodes a YAML document as Terragrunt's yamldecode does.
 *
 * @param source the YAML source.
 * @returns the value the document holds.
 * @throws Error in go-cty-yaml's words when the source is not one document it can read.
 */
export function yamlDecode(source: string): RuntimeValue<ValueType> {
	// go-cty-yaml reads an empty source as a line break.
	const text = source.length === 0 ? '\n' : source;
	// A lone carriage return ends a line, as in libyaml, which reads it into a scalar as a line feed; the parser here
	// takes only a line feed, with or without a carriage return before it, as the end of a line.
	const tokens = [...new Parser().parse(text.replace(/\r(?!\n)/gu, '\n'))];
	// Every scalar is kept as its text, with its tag, for go-cty-yaml's resolution to read; keys may repeat, the last
	// one counting, and a merge key is read here as go-cty-yaml reads it.
	const documents = [...new Composer({ schema: 'failsafe', resolveKnownTags: false, uniqueKeys: false, merge: false }).compose(tokens)];
	const marks = new Marks(text, tokens);
	if (documents.length === 0) throw marks.streamEndError('missing start of document');
	const [document] = documents;
	const [problem] = document.errors;
	if (problem) throw marks.error(problem.pos[0], problem.message);
	const value = new Reader(marks).document(document);
	if (documents.length > 1) throw marks.error(marks.secondDocumentStart(), 'unexpected extra content after value');
	return value;
}

/** Where a node starts, as libyaml marks the event go-cty-yaml cites: at its first property, or at the node. */
class Marks {
	/** The anchor and tag runs in the source, in order, each with the offsets of its first property and its end. */
	private readonly properties: Array<{ start: number; end: number }> = [];

	constructor(private readonly text: string, private readonly tokens: CST.Token[]) {
		let run: { start: number; end: number } | undefined;
		for (const token of flatten(tokens)) {
			if (token.type === 'anchor' || token.type === 'tag') {
				if (run) run.end = token.offset + token.source.length;
				else run = { start: token.offset, end: token.offset + token.source.length };
			} else if (token.type !== 'space' && token.type !== 'newline' && token.type !== 'comment') {
				if (run) this.properties.push(run);
				run = undefined;
			}
		}
		if (run) this.properties.push(run);
	}

	/** The offset libyaml marks a node at. */
	of(node: YamlNode): number {
		const start = node.range![0];
		if (isAlias(node) || (node.tag === undefined && node.anchor === undefined)) return start;
		// A node's properties are the last run before it: only space and comments lie between them.
		let found: { start: number; end: number } | undefined;
		for (const run of this.properties) {
			if (run.end > start) break;
			found = run;
		}
		if (!found) throw new Error(`yamldecode found no properties before the node at offset ${start}`);
		return found.start;
	}

	/** Where the second document starts: at its first directive, or at its `---`. */
	secondDocumentStart(): number {
		let documents = 0;
		for (const token of this.tokens) {
			if (token.type === 'document') {
				documents++;
				if (documents === 2) return token.offset;
			} else if (token.type === 'directive' && documents === 1) {
				return token.offset;
			}
		}
		throw new Error('yamldecode found no second document');
	}

	/** An error at an offset, worded as go-cty-yaml words it: on its line and column, unless on the first line. */
	error(offset: number, message: string): Error {
		const { line, column } = this.position(offset);
		return located(line, column, message);
	}

	/** An error at the end of the stream, where libyaml ends the last line. */
	streamEndError(message: string): Error {
		const { line, column } = this.position(this.text.length);
		return column === 0 ? located(line, 0, message) : located(line + 1, 0, message);
	}

	/** libyaml's mark of an offset: its line from 0, counting every YAML 1.1 line break, and its column in characters. */
	private position(offset: number): { line: number; column: number } {
		let line = 0;
		let lineStart = 0;
		for (let index = 0; index < offset; index++) {
			const character = this.text[index];
			if (character === '\r' && this.text[index + 1] === '\n') continue;
			if (character === '\n' || character === '\r' || character === '\u0085' || character === ' ' || character === ' ') {
				line++;
				lineStart = index + 1;
			}
		}
		return { line, column: [...this.text.slice(lineStart, offset)].length };
	}
}

function located(line: number, column: number, message: string): Error {
	return new Error(line === 0 ? message : `on line ${line}, column ${column + 1}: ${message}`);
}

/** A piece of the source: its kind, where it starts and its text. */
interface Lexeme {
	type: string;
	offset: number;
	source: string;
}

/** Every piece of a CST's source, in the order of the source. */
function* flatten(tokens: Iterable<CST.Token | null | undefined>): Generator<Lexeme> {
	for (const token of tokens) {
		if (!token) continue;
		switch (token.type) {
			case 'document':
				yield* flatten([...token.start, token.value, ...(token.end ?? [])]);
				break;
			case 'block-map':
			case 'block-seq':
			case 'flow-collection': {
				if (token.type === 'flow-collection') yield token.start;
				for (const item of token.items) yield* flatten([...item.start, item.key, ...(item.sep ?? []), item.value]);
				if (token.type === 'flow-collection') yield* flatten(token.end);
				break;
			}
			case 'alias':
			case 'scalar':
			case 'single-quoted-scalar':
			case 'double-quoted-scalar':
				yield token;
				yield* flatten(token.end ?? []);
				break;
			case 'block-scalar':
				yield* flatten(token.props);
				yield token;
				break;
			case 'doc-end':
				yield token;
				yield* flatten(token.end ?? []);
				break;
			default:
				yield token;
		}
	}
}

/**
 * Reads a document's nodes as go-cty-yaml's converter does, tracking its anchors. go-cty-yaml reads a document twice:
 * first for its type, which takes an untagged block scalar as a string without resolving it, then for its value. So
 * a block scalar that fails to resolve is refused only when nothing else in the document is.
 */
class Reader {
	private readonly pending = new Map<string, number>();
	private readonly anchored = new Map<string, RuntimeValue<ValueType>>();
	private deferred: Error | undefined;

	constructor(private readonly marks: Marks) {}

	document(document: Document.Parsed): RuntimeValue<ValueType> {
		const value = document.contents ? this.node(document.contents) : makeNullValue();
		if (this.deferred) throw this.deferred;
		return value;
	}

	private node(node: YamlNode): RuntimeValue<ValueType> {
		if (isAlias(node)) return this.alias(node.source, node);
		const anchor = node.anchor;
		if (anchor !== undefined) this.pending.set(anchor, (this.pending.get(anchor) ?? 0) + 1);
		let value: RuntimeValue<ValueType>;
		if (isScalar(node)) value = this.scalar(node);
		else if (isMap(node)) value = this.mapping(node);
		else if (isSeq(node)) value = this.sequence(node);
		else throw new Error('yamldecode found a node that is neither a scalar, a mapping nor a sequence');
		if (anchor !== undefined) {
			const count = this.pending.get(anchor)! - 1;
			if (count === 0) this.pending.delete(anchor);
			else this.pending.set(anchor, count);
			this.anchored.set(anchor, value);
		}
		return value;
	}

	private alias(name: string, node: YamlNode): RuntimeValue<ValueType> {
		if (this.pending.has(name)) {
			throw this.marks.error(this.marks.of(node), `cannot refer to anchor ${goQuoted(name)} from inside its own definition`);
		}
		const value = this.anchored.get(name);
		if (!value) throw this.marks.error(this.marks.of(node), `reference to undefined anchor ${goQuoted(name)}`);
		return value;
	}

	private scalar(node: Scalar): RuntimeValue<ValueType> {
		const tag = node.tag ?? '';
		const style = scalarStyle(node);
		const implied = tag === '' && style === 'block';
		let value: RuntimeValue<ValueType>;
		try {
			value = resolveScalar(tag, textOf(node), style);
		} catch (error) {
			const located = this.marks.error(this.marks.of(node), (error as Error).message);
			if (!implied) throw located;
			this.deferred ??= located;
			return makeStringValue(textOf(node));
		}
		// An untagged block scalar's implied type is a string, which the value it resolves to is converted to.
		return implied ? asString(value) : value;
	}

	private mapping(node: YAMLMap): RuntimeValue<ValueType> {
		const tag = node.tag ?? '';
		if (tag !== '' && tag !== MAP_TAG) throw this.marks.error(this.marks.of(node), `can't interpret mapping as ${tag}`);
		return this.pairs(node.items);
	}

	private pairs(pairs: Pair[]): RuntimeValue<ValueType> {
		const entries = new Map<string, RuntimeValue<ValueType>>();
		for (const pair of pairs) {
			// The composer gives a missing key as an empty scalar.
			const key = pair.key as YamlNode;
			if (isMergeKey(key)) {
				this.merge(entries, this.valueOf(pair.value), this.marks.of(key));
				continue;
			}
			if (!isScalar(key)) throw this.marks.error(this.marks.of(key), 'only strings are allowed as mapping keys');
			// go-cty-yaml gives a key's resolve error without its position.
			const name = asString(resolveScalar(key.tag ?? '', textOf(key), scalarStyle(key)));
			if (name.type === 'null') throw this.marks.error(this.marks.of(key), 'mapping key cannot be null');
			entries.set(name.value as string, this.valueOf(pair.value));
		}
		return makeObjectValue(entries);
	}

	private merge(entries: Map<string, RuntimeValue<ValueType>>, merged: RuntimeValue<ValueType>, at: number): void {
		if (merged.type === 'object') {
			for (const [name, entry] of merged.value as Map<string, RuntimeValue<ValueType>>) entries.set(name, entry);
			return;
		}
		if (merged.type === 'array') {
			const elements = merged.value as RuntimeValue<ValueType>[];
			const refused = elements.find((element) => element.type !== 'object');
			if (refused) throw this.marks.error(at, `cannot merge ${friendlyName(refused)} (from sequence) into mapping`);
			for (const element of elements) {
				for (const [name, entry] of element.value as Map<string, RuntimeValue<ValueType>>) entries.set(name, entry);
			}
			return;
		}
		throw this.marks.error(at, `cannot merge ${friendlyName(merged)} into mapping`);
	}

	private sequence(node: YAMLSeq): RuntimeValue<ValueType> {
		const tag = node.tag ?? '';
		if (tag !== '' && tag !== SEQ_TAG) throw this.marks.error(this.marks.of(node), `can't interpret sequence as ${tag}`);
		// A `key: value` entry of a flow sequence is a mapping of that one pair.
		return makeArrayValue(node.items.map((item) => (isPair(item) ? this.pairs([item]) : this.valueOf(item))));
	}

	/** A node's value; a value left out, as in `? key`, is libyaml's empty plain scalar, a null. */
	private valueOf(item: unknown): RuntimeValue<ValueType> {
		return item === null ? makeNullValue() : this.node(item as YamlNode);
	}
}

/** go-cty-yaml's merge key: an untagged `<<`, quoted or not, or any scalar tagged !!merge. */
function isMergeKey(key: YamlNode): boolean {
	if (!isScalar(key)) return false;
	return (key.tag === undefined && key.value === '<<') || key.tag === MERGE_TAG;
}

/** A scalar's text, which the failsafe schema leaves unresolved. */
function textOf(node: Scalar): string {
	if (typeof node.value !== 'string') throw new Error(`yamldecode found a scalar resolved to a ${typeof node.value}`);
	return node.value;
}

function scalarStyle(node: Scalar): Style {
	switch (node.type) {
		case Scalar.QUOTE_SINGLE:
		case Scalar.QUOTE_DOUBLE:
			return 'quoted';
		case Scalar.BLOCK_FOLDED:
		case Scalar.BLOCK_LITERAL:
			return 'block';
		default:
			return 'plain';
	}
}

/** The name go-cty gives the type of a value it cannot merge. */
function friendlyName(value: RuntimeValue<ValueType>): string {
	switch (value.type) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'bool';
		case 'null':
			return 'dynamic';
		case 'array':
			return 'tuple';
		default:
			return 'object';
	}
}

/** A resolved scalar converted to a string as go-cty converts it; a null stays null. */
function asString(value: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	switch (value.type) {
		case 'number':
			return makeStringValue((value.value as CtyNumber).toString());
		case 'boolean':
			return makeStringValue(value.value ? 'true' : 'false');
		default:
			return value;
	}
}

/**
 * Resolves a scalar as go-cty-yaml's resolveScalar does: a quoted scalar is a string unless its tag says otherwise and
 * its first character hints at nothing; the YAML 1.1 words for booleans, null and the infinities resolve whatever the
 * tag; a plain scalar shaped as a timestamp becomes its RFC 3339 text, one shaped as a YAML 1.2 integer or float a
 * number read from its text; and anything else a string.
 *
 * @param tag the scalar's tag, or '' when it has none.
 * @param src the scalar's text.
 * @param style whether the scalar is plain, quoted or a block.
 * @throws Error with go-cty-yaml's message when the scalar cannot be what its tag says.
 */
function resolveScalar(tag: string, src: string, style: Style): RuntimeValue<ValueType> {
	if (!RESOLVABLE_TAGS.has(tag)) throw new Error(`unsupported tag ${goQuoted(tag)}`);
	let resolvedTag = tag;
	const hint = src === '' ? 'N' : HINTS.get(src[0]);
	if (hint !== undefined && tag !== STR_TAG && tag !== BINARY_TAG) {
		if (style === 'quoted') return makeStringValue(src);
		const plain = RESOLVE_MAP.get(src);
		if (plain) return plainValue(plain);
		if (tag === '' && NAN_TEXTS.has(src)) throw new Error('floating point NaN is not supported');
		if (hint === '.') {
			const number = CtyNumber.tryParse(src);
			if (number) return makeNumberValue(number);
		} else if (hint === 'D' || hint === 'S') {
			if (tag === '' || tag === TIMESTAMP_TAG) {
				const timestamp = goTimestamp(src);
				if (timestamp !== undefined) return makeStringValue(timestamp);
			}
			if (INTEGER_LITERAL.test(src)) resolvedTag = INT_TAG;
			else if (FLOAT_LITERAL.test(src)) resolvedTag = FLOAT_TAG;
		}
	}
	switch (resolvedTag) {
		case BINARY_TAG:
			if (!BASE64.test(src.replace(/[\r\n]/gu, ''))) throw new Error(`cannot parse ${goQuoted(src)} as ${resolvedTag}: not valid base64`);
			return makeStringValue(src);
		case STR_TAG:
		case '':
			return makeStringValue(src);
		case BOOL_TAG: {
			const plain = RESOLVE_MAP.get(src);
			if (plain?.tag !== BOOL_TAG) throw new Error(`cannot parse ${goQuoted(src)} as ${resolvedTag}`);
			return plainValue(plain);
		}
		case FLOAT_TAG:
		case INT_TAG: {
			const digits = src.replaceAll('_', '');
			const number = CtyNumber.tryParse(digits);
			if (number) return makeNumberValue(number);
			const integer = goParseInt(digits) ?? goParseUint(digits);
			if (integer !== undefined) return makeNumberValue(CtyNumber.fromBigInt(integer));
			throw new Error(`cannot parse ${goQuoted(src)} as ${resolvedTag}`);
		}
		case TIMESTAMP_TAG: {
			const timestamp = goTimestamp(src);
			if (timestamp === undefined) throw new Error(`cannot parse ${goQuoted(src)} as ${resolvedTag}`);
			return makeStringValue(timestamp);
		}
		case NULL_TAG:
			return makeNullValue();
		default:
			throw new Error(`unsupported tag ${goQuoted(resolvedTag)}`);
	}
}

function plainValue(plain: Plain): RuntimeValue<ValueType> {
	if (plain.tag === BOOL_TAG) return makeBooleanValue(plain.value);
	if (plain.tag === NULL_TAG) return makeNullValue();
	return makeNumberValue(plain.value);
}

const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/** Go's strconv.ParseInt(text, 0, 64): an optional sign, then what {@link goParseUint} reads, within an int64. */
function goParseInt(text: string): bigint | undefined {
	const negative = text.startsWith('-');
	const magnitude = goParseUint(negative || text.startsWith('+') ? text.slice(1) : text);
	if (magnitude === undefined) return undefined;
	if (negative) return magnitude <= INT64_MAX + 1n ? -magnitude : undefined;
	return magnitude <= INT64_MAX ? magnitude : undefined;
}

/**
 * Go's strconv.ParseUint(text, 0, 64) with the underscores already dropped: a 0b, 0o or 0x prefix in either case, a
 * leading 0 for octal, or decimal, within a uint64.
 */
function goParseUint(text: string): bigint | undefined {
	if (text === '') return undefined;
	let base = 10;
	let digits = text;
	if (text[0] === '0') {
		const prefix = text.length >= 3 ? text[1].toLowerCase() : '';
		if (prefix === 'b' || prefix === 'o' || prefix === 'x') {
			base = prefix === 'b' ? 2 : prefix === 'o' ? 8 : 16;
			digits = text.slice(2);
		} else {
			base = 8;
			digits = text.slice(1);
		}
	}
	let value = 0n;
	for (const character of digits) {
		const digit = Number.parseInt(character, 36);
		if (Number.isNaN(digit) || digit >= base) return undefined;
		value = value * BigInt(base) + BigInt(digit);
		if (value > UINT64_MAX) return undefined;
	}
	return value;
}

/** The layouts go-cty-yaml tries a timestamp with, in Go's time.Parse notation. */
const TIMESTAMP_LAYOUTS: Array<{ separator?: 'T' | 't' | ' '; zone: boolean }> = [
	{ separator: 'T', zone: true },
	{ separator: 't', zone: true },
	{ separator: ' ', zone: false },
	{ zone: false }
];

/**
 * Reads a timestamp as go-cty-yaml's parseTimestamp does, with Go's time.Parse and the layouts
 * `2006-1-2T15:4:5.999999999Z07:00`, its lower case `t`, `2006-1-2 15:4:5.999999999` and `2006-1-2`, and writes it as
 * Go's RFC 3339 layout does: without its fraction of a second, and in the zone it was given.
 *
 * @returns the timestamp in RFC 3339, or undefined when the text is not one.
 */
function goTimestamp(text: string): string | undefined {
	let digits = 0;
	while (digits < text.length && text[digits] >= '0' && text[digits] <= '9') digits++;
	if (digits !== 4 || text[4] !== '-') return undefined;
	for (const layout of TIMESTAMP_LAYOUTS) {
		const parsed = parseTimestampLayout(text, layout);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

function parseTimestampLayout(text: string, layout: { separator?: 'T' | 't' | ' '; zone: boolean }): string | undefined {
	const reader = new GoTimeReader(text.slice(4));
	const year = Number(text.slice(0, 4));
	if (!reader.literal('-')) return undefined;
	const month = reader.number();
	if (month === undefined || month < 1 || month > 12 || !reader.literal('-')) return undefined;
	const day = reader.number();
	if (day === undefined) return undefined;
	let hour = 0;
	let minute = 0;
	let second = 0;
	let offset = 0;
	if (layout.separator !== undefined) {
		if (!reader.literal(layout.separator)) return undefined;
		const parsedHour = reader.number();
		if (parsedHour === undefined || parsedHour >= 24 || !reader.literal(':')) return undefined;
		const parsedMinute = reader.number();
		if (parsedMinute === undefined || parsedMinute >= 60 || !reader.literal(':')) return undefined;
		const parsedSecond = reader.number();
		if (parsedSecond === undefined || parsedSecond >= 60) return undefined;
		[hour, minute, second] = [parsedHour, parsedMinute, parsedSecond];
		reader.fraction();
		if (layout.zone) {
			const zone = reader.zone();
			if (zone === undefined) return undefined;
			offset = zone;
		}
	}
	if (!reader.done() || day < 1 || day > daysIn(month, year)) return undefined;
	const two = (value: number) => String(value).padStart(2, '0');
	const date = `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}`;
	if (offset === 0) return `${date}Z`;
	const minutes = Math.abs(offset) / 60;
	return `${date}${offset < 0 ? '-' : '+'}${two(Math.trunc(minutes / 60))}:${two(minutes % 60)}`;
}

function daysIn(month: number, year: number): number {
	if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The pieces of Go's time.Parse the timestamp layouts use, reading a value from its start. */
class GoTimeReader {
	constructor(private rest: string) {}

	/** A literal of the layout; a space matches one or more spaces, as Go's skip does. */
	literal(character: string): boolean {
		if (character === ' ') {
			if (this.rest.length > 0 && this.rest[0] !== ' ') return false;
			this.rest = this.rest.replace(/^ +/u, '');
			return true;
		}
		if (this.rest[0] !== character) return false;
		this.rest = this.rest.slice(1);
		return true;
	}

	/** Go's getnum with a field that is not zero-padded: one digit, or two. */
	number(): number | undefined {
		if (!isDigit(this.rest[0])) return undefined;
		const length = isDigit(this.rest[1]) ? 2 : 1;
		const value = Number(this.rest.slice(0, length));
		this.rest = this.rest.slice(length);
		return value;
	}

	/** An optional fraction of a second: a point or comma and every digit after it. */
	fraction(): void {
		if (this.rest.length < 2 || (this.rest[0] !== '.' && this.rest[0] !== ',') || !isDigit(this.rest[1])) return;
		let end = 1;
		while (isDigit(this.rest[end])) end++;
		this.rest = this.rest.slice(end);
	}

	/** Go's Z07:00: Z, or a sign with two-digit hours and minutes; hours to 24 and minutes to 60, as Go allows. */
	zone(): number | undefined {
		if (this.rest[0] === 'Z') {
			this.rest = this.rest.slice(1);
			return 0;
		}
		if (this.rest.length < 6 || this.rest[3] !== ':') return undefined;
		const sign = this.rest[0];
		if (!isDigit(this.rest[1]) || !isDigit(this.rest[2]) || !isDigit(this.rest[4]) || !isDigit(this.rest[5])) return undefined;
		const hours = Number(this.rest.slice(1, 3));
		const minutes = Number(this.rest.slice(4, 6));
		if (hours > 24 || minutes > 60 || (sign !== '+' && sign !== '-')) return undefined;
		this.rest = this.rest.slice(6);
		const offset = (hours * 60 + minutes) * 60;
		return sign === '-' ? -offset : offset;
	}

	done(): boolean {
		return this.rest.length === 0;
	}
}

function isDigit(character: string | undefined): boolean {
	return character !== undefined && character >= '0' && character <= '9';
}
