import { constants, createHash, privateDecrypt, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import bcrypt from 'bcryptjs';

import { formatDate, instant, parseTimestamp } from '../cty-datetime';
import { CtyNumber, parseGoInteger } from '../cty-number';
import { CorruptInputError, decodeStdBase64 } from '../go-base64';
import { goQuoted } from '../go-quote';
import { graphemeClusters } from '../grapheme-clusters';
import { ianaEncoding, textEncoding } from '../text-encodings';
import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { type CtyType, ctyNumber, ctyString, friendlyName, objectOf, tupleOf } from '../cty-types';
import { ArgumentError } from '../function-signature';
import { assumeFunctions, markedLike } from './assume_functions';
import { collectionFunctions } from './collection_functions';
import { addressRange, contains, type IP, type IPNet, ipNetString, maskOnes, nextSubnet, parseCIDR, parseIP, previousSubnet, to4 } from './ipaddr';
import { renderTemplate } from './template';
import { fileset } from './fileset';
import { expandTerragruntGlob } from './terragrunt_glob';
import { formatFunction, formatListFunction } from './format';
import {
	compareStrings,
	convertToRuntimeValue,
	expectParams,
	makeArrayValue,
	makeListValue,
	makeNullValue,
	makeObjectValue,
	makeSetValue,
	makeSensitiveValue,
	makeStringValue,
	markEncrypted,
	parseJsonDocument,
	unwrapSensitive,
	valueType,
} from './utils';

function requireArgument(args: RuntimeValue<ValueType>[], index: number, name: string): RuntimeValue<ValueType> {
	const argument = args[index];
	if (!argument) throw new Error(`${name} requires argument ${index + 1}`);
	return argument;
}

function stringArgument(args: RuntimeValue<ValueType>[], index: number, name: string): string {
	const argument = requireArgument(args, index, name);
	if (argument.type !== 'string') throw new Error(`${name} argument ${index + 1} must be a string`);
	return String(argument.value);
}

/**
 * The number HCL converted an argument for a go-cty number parameter to. A sensitive argument gives its number; the
 * caller marks the result.
 *
 * @param args the call's arguments.
 * @param index the argument's position.
 */
function numberArgument(args: RuntimeValue<ValueType>[], index: number): CtyNumber {
	return unwrapSensitive(args[index]).value as CtyNumber;
}

/**
 * An argument for a go-cty number parameter that the function reads into a Go int, which go-cty refuses unless the
 * number is whole and fits an int64, as a failed call.
 */
function integerArgument(args: RuntimeValue<ValueType>[], index: number): number {
	return Number(numberArgument(args, index).toGoInt64());
}

/**
 * The float64 results of go-cty's log and pow, held as NumberFloatVal holds them. A NaN, which Go's big.Float refuses,
 * fails the call as go-cty reports the panic it causes.
 */
function float64Value(value: number): RuntimeValue<'number'> {
	if (Number.isNaN(value)) throw new Error('panic in function implementation: Float.SetFloat64(NaN)');
	return numberValue(CtyNumber.fromFloat64(value));
}

/**
 * go-cty's min (direction -1) and max (direction 1): starting from the opposite infinity, each argument that lies
 * beyond the one kept so far replaces it, so the first of equal extremes is the one given.
 */
function extreme(args: RuntimeValue<ValueType>[], direction: 1 | -1): CtyNumber {
	if (args.length === 0) throw new Error('must pass at least one number');
	const numbers = args.map((_, index) => numberArgument(args, index));
	let kept = CtyNumber.fromFloat64(direction > 0 ? -Infinity : Infinity);
	for (const number of numbers) if (number.compare(kept) * direction > 0) kept = number;
	return kept;
}

/** Go's math.Frexp: x as a fraction in [0.5, 1) times a power of two. */
function frexp(x: number): [number, number] {
	if (x === 0 || !Number.isFinite(x)) return [x, 0];
	const view = new DataView(new ArrayBuffer(8));
	let value = x;
	let exponent = 0;
	if (Math.abs(value) < 2.2250738585072014e-308) {
		value *= 2 ** 52;
		exponent = -52;
	}
	view.setFloat64(0, value);
	const high = view.getUint32(0);
	exponent += ((high >>> 20) & 0x7ff) - 1022;
	view.setUint32(0, (high & ~(0x7ff << 20)) | (1022 << 20));
	return [view.getFloat64(0), exponent];
}

/** Go's math.Ldexp: frac × 2^exp, rounded once into a float64. */
function ldexp(fraction: number, power: number): number {
	if (fraction === 0 || !Number.isFinite(fraction)) return fraction;
	const [normal, shift] = frexp(fraction);
	let exponent = power + shift;
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, normal);
	const high = view.getUint32(0);
	exponent += ((high >>> 20) & 0x7ff) - 1023;
	if (exponent < -1075) return normal < 0 ? -0 : 0;
	if (exponent > 1023) return normal < 0 ? -Infinity : Infinity;
	let scale = 1;
	if (exponent < -1022) {
		exponent += 53;
		scale = 2 ** -53;
	}
	view.setUint32(0, (high & ~(0x7ff << 20)) | ((exponent + 1023) << 20));
	return scale * view.getFloat64(0);
}

function isOddInteger(x: number): boolean {
	if (Math.abs(x) >= 2 ** 53) return false;
	return Number.isInteger(x) && Math.abs(x % 2) === 1;
}

/**
 * Go's math.Pow, which go-cty's pow calls: an integer power by repeated squaring, rounding at each step as Go does,
 * and the fractional part of a power through exp and log.
 */
function goPow(x: number, y: number): number {
	if (y === 0 || x === 1) return 1;
	if (y === 1) return x;
	if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
	if (x === 0) {
		if (y < 0) return Object.is(x, -0) && isOddInteger(y) ? -Infinity : Infinity;
		if (y > 0) return Object.is(x, -0) && isOddInteger(y) ? x : 0;
	}
	if (!Number.isFinite(y)) {
		if (x === -1) return 1;
		return (Math.abs(x) < 1) === (y > 0) ? 0 : Infinity;
	}
	if (!Number.isFinite(x)) {
		if (x < 0) return goPow(1 / x, -y);
		if (y < 0) return 0;
		if (y > 0) return Infinity;
	}
	if (y === 0.5) return Math.sqrt(x);
	if (y === -0.5) return 1 / Math.sqrt(x);

	let yi = Math.trunc(Math.abs(y));
	let yf = Math.abs(y) - yi;
	if (yf !== 0 && x < 0) return NaN;
	if (yi >= 2 ** 63) {
		if (x === -1) return 1;
		return (Math.abs(x) < 1) === (y > 0) ? 0 : Infinity;
	}
	let a1 = 1;
	let ae = 0;
	if (yf !== 0) {
		if (yf > 0.5) {
			yf--;
			yi++;
		}
		a1 = Math.exp(yf * Math.log(x));
	}
	let [x1, xe] = frexp(x);
	for (let i = BigInt(yi); i !== 0n; i >>= 1n) {
		if (xe < -(1 << 12) || 1 << 12 < xe) {
			ae += xe;
			break;
		}
		if ((i & 1n) === 1n) {
			a1 *= x1;
			ae += xe;
		}
		x1 *= x1;
		xe *= 2;
		if (x1 < 0.5) {
			x1 += x1;
			xe--;
		}
	}
	if (y < 0) {
		a1 = 1 / a1;
		ae = -ae;
	}
	return ldexp(a1, ae);
}

function arrayArgument(args: RuntimeValue<ValueType>[], index: number, name: string): RuntimeValue<ValueType>[] {
	const argument = requireArgument(args, index, name);
	if (argument.type !== 'array' || !Array.isArray(argument.value)) throw new Error(`${name} argument ${index + 1} must be a list`);
	return argument.value;
}


const stringValue = makeStringValue;
const numberValue = (value: CtyNumber): RuntimeValue<'number'> => ({ type: 'number', value });
/** A count or position a function gives as go-cty's NumberIntVal holds it. */
const integerValue = (value: number): RuntimeValue<'number'> => numberValue(CtyNumber.fromInt64(value));
const booleanValue = (value: boolean): RuntimeValue<'boolean'> => ({ type: 'boolean', value });
const objectValue = makeObjectValue;

function hash(name: 'md5' | 'sha1' | 'sha256' | 'sha512', value: string): RuntimeValue<'string'> {
	return stringValue(createHash(name).update(value, 'utf8').digest('hex'));
}


function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidv5(namespace: string, name: string): string {
	const namespaces: Record<string, string> = {
		dns: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
		url: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
		oid: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
		x500: '6ba7b814-9dad-11d1-80b4-00c04fd430c8'
	};
	const namespaceBytes = (namespaces[namespace] ?? namespace).replace(/-/g, '');
	const source = Buffer.from(namespaceBytes, 'hex');
	const digest = createHash('sha1').update(source).update(name, 'utf8').digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ipToInteger(ip: string): number {
	const octets = ip.split('.').map(octet => Number.parseInt(octet, 10));
	if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet) || octet < 0 || octet > 255)) {
		throw new Error(`Invalid IPv4 address: ${ip}`);
	}
	return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipFromInteger(value: number): string {
	const unsigned = value >>> 0;
	return `${(unsigned >>> 24) & 0xff}.${(unsigned >>> 16) & 0xff}.${(unsigned >>> 8) & 0xff}.${unsigned & 0xff}`;
}

function parseCidr(cidr: string): { network: number; prefix: number } {
	const [ip, prefixText] = cidr.split('/');
	const prefix = Number.parseInt(prefixText, 10);
	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid CIDR prefix: ${cidr}`);
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return { network: ipToInteger(ip) & mask, prefix };
}

function convertPatternGroups(pattern: string): string {
	return pattern.replace(/\(\?P<([a-zA-Z0-9_]+)>/g, '(?<$1>');
}

function groupNames(pattern: string): string[] {
	const names: string[] = [];
	const converted = convertPatternGroups(pattern);
	const source = converted.replace(/\\\(/g, '');
	const regex = /\(\?<([a-zA-Z0-9_]+)>/gu;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(source)) !== null) names.push(match[1]);
	return names;
}

/**
 * The type go-cty's regex gives a match of a pattern, from its capture groups: the matched string when it has none, a
 * tuple of strings for unnamed groups and an object of strings for named ones.
 *
 * @throws Error in go-cty's words when the pattern mixes named and unnamed groups.
 */
function regexResultType(expression: RegExp): CtyType {
	const groups = (new RegExp(`${expression.source}|`).exec('')?.length ?? 1) - 1;
	const names = groupNames(expression.source);
	if (groups === 0) return ctyString;
	if (names.length > 0 && names.length < groups) {
		throw new ArgumentError(0, 'invalid regexp pattern: cannot mix both named and unnamed capture groups');
	}
	if (names.length === 0) return tupleOf(Array.from({ length: groups }, () => ctyString));
	return objectOf(new Map(names.map(name => [name, ctyString])));
}

/** A match as go-cty's regex gives it, as of its type: a group that took no part in the match is a null string. */
function regexResult(match: RegExpExecArray, type: CtyType): RuntimeValue<ValueType> {
	const group = (text: string | undefined) => (text === undefined ? makeNullValue(ctyString) : stringValue(text));
	if (type.kind === 'string') return stringValue(match[0]);
	if (type.kind === 'tuple') return makeArrayValue(match.slice(1).map(group));
	return objectValue(new Map([...(type as Extract<CtyType, { kind: 'object' }>).attributes.keys()].map(name => [name, group(match.groups?.[name])])));
}

/**
 * A pattern compiled, refused as go-cty refuses one it cannot compile: an argument error on the pattern. The reason is
 * JavaScript's, not RE2's.
 */
function compilePattern(pattern: string, flags = ''): RegExp {
	try {
		return new RegExp(convertPatternGroups(pattern), flags);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new ArgumentError(0, `invalid regexp pattern: ${error.message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /su, '')}`);
	}
}

function regexMatch(pattern: string, value: string): RuntimeValue<ValueType> {
	const expression = compilePattern(pattern);
	const type = regexResultType(expression);
	const match = expression.exec(value);
	if (!match) throw new Error('pattern did not match any part of the given string');
	return regexResult(match, type);
}

function regexAll(pattern: string, value: string): RuntimeValue<'array'> {
	const expression = compilePattern(pattern, 'g');
	const type = regexResultType(expression);
	const results: RuntimeValue<ValueType>[] = [];
	let match: RegExpExecArray | null;
	while ((match = expression.exec(value)) !== null) {
		if (match[0] === '') expression.lastIndex++;
		results.push(regexResult(match, type));
	}
	return makeListValue(type, results);
}

/** go-cty's csvdecode: a list of objects, one per row after the header, each with a string attribute per column. */
function csvDecode(content: string): RuntimeValue<'array'> {
	const rows = content.replace(/\r\n/g, '\n').split('\n');
	const header: string[] = [];
	const body: string[] = [];
	let parsingHeader = true;
	for (const rawRow of rows) {
		if (parsingHeader) {
			const cells = parseCsvRow(rawRow);
			if (cells.length === 0 || cells.every(cell => cell === '')) continue;
			header.push(...cells);
			parsingHeader = false;
			continue;
		}
		body.push(rawRow);
	}
	if (header.length === 0) throw new Error('missing header line');
	const duplicate = header.find((name, index) => header.indexOf(name) !== index);
	if (duplicate !== undefined) throw new Error(`duplicate column name ${goQuoted(duplicate)}`);
	const records: RuntimeValue<ValueType>[] = [];
	for (const rawRow of body) {
		if (rawRow.trim() === '') continue;
		const cells = parseCsvRow(rawRow);
		const map = new Map<string, RuntimeValue<ValueType>>();
		header.forEach((key, index) => {
			map.set(key, stringValue(cells[index] ?? ''));
		});
		records.push(objectValue(map));
	}
	return makeListValue(objectOf(new Map(header.map(name => [name, ctyString]))), records);
}

/** A string as Go's encoding/json writes it for go-cty: as JSON does, and with <, >, &, U+2028 and U+2029 escaped. */
function jsonString(text: string): string {
	return JSON.stringify(text).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A number as go-cty writes it into JSON: its decimal text, and an infinity refused. */
function jsonNumber(value: CtyNumber): string {
	if (value.isInfinite()) throw new Error('cannot serialize infinity as JSON');
	return value.toString();
}

/** A value as go-cty's jsonencode writes it: with no spaces, and an object's keys in the order of their bytes. */
function jsonEncode(value: RuntimeValue<ValueType>): string {
	const current = unwrapSensitive(value);
	switch (current.type) {
		case 'null':
			return 'null';
		case 'boolean':
			return current.value ? 'true' : 'false';
		case 'number':
			return jsonNumber(current.value as CtyNumber);
		case 'string':
			return jsonString(String(current.value));
		case 'array':
			return `[${(current.value as RuntimeValue<ValueType>[]).map(jsonEncode).join(',')}]`;
		case 'object':
		case 'block': {
			const map = current.value as Map<string, RuntimeValue<ValueType>>;
			return `{${[...map.keys()].sort(compareStrings).map(key => `${jsonString(key)}:${jsonEncode(map.get(key)!)}`).join(',')}}`;
		}
		default:
			throw new Error(`jsonencode cannot encode ${current.type}`);
	}
}

/** How far libyaml indents each level, and the column past which it folds a double-quoted scalar at a space. */
const yamlIndent = 2;
const yamlWidth = 80;

/** The escapes libyaml writes in a double-quoted scalar by name rather than by number. */
const yamlNamedEscapes = new Map<number, string>([
	[0x00, '0'], [0x07, 'a'], [0x08, 'b'], [0x09, 't'], [0x0a, 'n'], [0x0b, 'v'], [0x0c, 'f'], [0x0d, 'r'], [0x1b, 'e'],
	[0x22, '"'], [0x5c, '\\'], [0x85, 'N'], [0xa0, '_'], [0x2028, 'L'], [0x2029, 'P']
]);

/** Whether libyaml writes a character unescaped: a line feed, printable ASCII, and the Basic Multilingual Plane from U+00A0 up but for the surrogates, U+FEFF, U+FFFE and U+FFFF. */
function yamlPrintable(code: number): boolean {
	return code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd && code !== 0xfeff);
}

/** Whether libyaml takes a character as a line break: CR, LF, NEL, LS or PS. */
function yamlBreak(code: number): boolean {
	return code === 0x0d || code === 0x0a || code === 0x85 || code === 0x2028 || code === 0x2029;
}

/**
 * A value as go-cty-yaml's Marshal writes it, which yamlencode returns: the events it sends through its port of
 * libyaml's emitter, written as that emitter writes them. A null, bool or number is a plain scalar, written as
 * big.Float's Text('f', -1) writes the number; a string is double-quoted, or a literal block when it holds a line
 * feed and the emitter allows one there; a list, set or tuple is a block sequence and an object or map a block
 * mapping with its keys in the order of their bytes, either written in flow style when it is empty.
 */
class YamlEmitter {
	private output = '';
	private column = 0;
	private whitespace = true;
	private indention = true;
	private openEnded = false;
	private indent = -1;
	private readonly indents: number[] = [];

	static encode(value: RuntimeValue<ValueType>): string {
		const emitter = new YamlEmitter();
		emitter.node(value, true, false, false);
		// DOCUMENT-END, implicit.
		emitter.writeIndent();
		// STREAM-END: a plain scalar at the root leaves the stream open-ended, and libyaml closes it with `...`.
		if (emitter.openEnded) {
			emitter.writeIndicator('...', true, false, false);
			emitter.writeIndent();
		}
		return emitter.output;
	}

	private node(value: RuntimeValue<ValueType>, root: boolean, mapping: boolean, simpleKey: boolean): void {
		const current = unwrapSensitive(value);
		switch (current.type) {
			case 'null':
				return this.plainScalar('null', root);
			case 'boolean':
				return this.plainScalar(current.value ? 'true' : 'false', root);
			case 'number':
				return this.plainScalar((current.value as CtyNumber).toString(), root);
			case 'string':
				return this.stringScalar(String(current.value), simpleKey);
			case 'array': {
				const items = current.value as RuntimeValue<ValueType>[];
				if (items.length === 0) return this.emptyCollection('[', ']');
				return this.blockSequence(items, mapping);
			}
			case 'object':
			case 'block': {
				const map = current.value as Map<string, RuntimeValue<ValueType>>;
				if (map.size === 0) return this.emptyCollection('{', '}');
				return this.blockMapping([...map.entries()].sort(([left], [right]) => compareStrings(left, right)));
			}
			default:
				throw new Error(`yamlencode cannot encode ${current.type}`);
		}
	}

	private blockSequence(items: RuntimeValue<ValueType>[], mapping: boolean): void {
		// A sequence that is a mapping's value, on the line after its key, is not indented further than the key.
		this.increaseIndent(false, mapping && !this.indention);
		for (const item of items) {
			this.writeIndent();
			this.writeIndicator('-', true, false, true);
			this.node(item, false, false, false);
		}
		this.indent = this.indents.pop()!;
	}

	private blockMapping(entries: Array<[string, RuntimeValue<ValueType>]>): void {
		this.increaseIndent(false, false);
		for (const [key, item] of entries) {
			this.writeIndent();
			// A key on more than one line, or longer than 128 bytes, cannot be a simple key and is written after `?`.
			if (!yamlMultiline(key) && Buffer.byteLength(key, 'utf8') <= 128) {
				this.stringScalar(key, true);
				this.writeIndicator(':', false, false, false);
			} else {
				this.writeIndicator('?', true, false, true);
				this.stringScalar(key, false);
				this.writeIndent();
				this.writeIndicator(':', true, false, true);
			}
			this.node(item, false, true, false);
		}
		this.indent = this.indents.pop()!;
	}

	private emptyCollection(open: string, close: string): void {
		this.writeIndicator(open, true, true, false);
		this.writeIndicator(close, false, false, false);
	}

	/** A null, bool or number, whose text holds no space, line break or indicator. */
	private plainScalar(text: string, root: boolean): void {
		if (!this.whitespace) this.put(' ');
		this.write(text);
		this.whitespace = false;
		this.indention = false;
		if (root) this.openEnded = true;
	}

	private stringScalar(text: string, simpleKey: boolean): void {
		const codes = Array.from(text, character => character.codePointAt(0)!);
		// go-cty-yaml asks for a literal block when the string holds a line feed; libyaml writes it double-quoted
		// instead where a block is not allowed: in a simple key, or for a string with a space at its end or before a
		// line break, or a character it must escape.
		const literal = text.includes('\n') && !simpleKey && codes[codes.length - 1] !== 0x20
			&& !codes.some((code, index) => !yamlPrintable(code) || (yamlBreak(code) && codes[index - 1] === 0x20));
		this.increaseIndent(true, false);
		if (literal) this.writeLiteral(codes);
		else this.writeDoubleQuoted(codes, !simpleKey);
		this.indent = this.indents.pop()!;
	}

	private writeDoubleQuoted(codes: number[], allowBreaks: boolean): void {
		this.writeIndicator('"', true, false, false);
		// libyaml tests for a byte order mark at the start of the string rather than at each character, so a string
		// that begins with one has every character escaped.
		const bom = codes[0] === 0xfeff;
		let spaces = false;
		for (let index = 0; index < codes.length; index++) {
			const code = codes[index];
			if (bom || !yamlPrintable(code) || yamlBreak(code) || code === 0x22 || code === 0x5c) {
				this.put('\\');
				const named = yamlNamedEscapes.get(code);
				if (named !== undefined) this.put(named);
				else if (code <= 0xff) this.write(`x${yamlHex(code, 2)}`);
				else if (code <= 0xffff) this.write(`u${yamlHex(code, 4)}`);
				else this.write(`U${yamlHex(code, 8)}`);
				spaces = false;
			} else if (code === 0x20) {
				// A space past the width, after something other than a space and before the last character, becomes
				// the fold; a space after it is escaped so that the fold does not swallow it.
				if (allowBreaks && !spaces && this.column > yamlWidth && index > 0 && index < codes.length - 1) {
					this.writeIndent();
					if (codes[index + 1] === 0x20) this.put('\\');
				} else {
					this.put(' ');
				}
				spaces = true;
			} else {
				this.put(String.fromCodePoint(code));
				spaces = false;
			}
		}
		this.writeIndicator('"', false, false, false);
		this.whitespace = false;
		this.indention = false;
	}

	private writeLiteral(codes: number[]): void {
		this.writeIndicator('|', true, false, false);
		// The indentation indicator, when the first line begins with a space or is empty.
		if (codes[0] === 0x20 || yamlBreak(codes[0])) this.writeIndicator(String(yamlIndent), false, false, false);
		// Chomping: strip the final line break when there is none, keep every one when there is more than one.
		// libyaml marks the stream open-ended for `+`, and writing the indicator clears the mark again.
		const last = codes.length - 1;
		if (!yamlBreak(codes[last])) this.writeIndicator('-', false, false, false);
		else if (last === 0 || yamlBreak(codes[last - 1])) this.writeIndicator('+', false, false, false);
		this.putBreak();
		this.indention = true;
		this.whitespace = true;
		let breaks = true;
		for (const code of codes) {
			if (yamlBreak(code)) {
				if (code === 0x0a) this.putBreak();
				else {
					this.output += String.fromCodePoint(code);
					this.column = 0;
				}
				this.indention = true;
				breaks = true;
			} else {
				if (breaks) this.writeIndent();
				this.put(String.fromCodePoint(code));
				this.indention = false;
				breaks = false;
			}
		}
	}

	private increaseIndent(flow: boolean, indentless: boolean): void {
		this.indents.push(this.indent);
		if (this.indent < 0) this.indent = flow ? yamlIndent : 0;
		else if (!indentless) this.indent += yamlIndent;
	}

	private writeIndent(): void {
		const indent = Math.max(this.indent, 0);
		if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) this.putBreak();
		while (this.column < indent) this.put(' ');
		this.whitespace = true;
		this.indention = true;
	}

	private writeIndicator(indicator: string, needWhitespace: boolean, isWhitespace: boolean, isIndention: boolean): void {
		if (needWhitespace && !this.whitespace) this.put(' ');
		this.write(indicator);
		this.whitespace = isWhitespace;
		this.indention = this.indention && isIndention;
		this.openEnded = false;
	}

	/** Writes characters, each one column wide whatever its encoded length. */
	private write(text: string): void {
		for (const character of text) this.put(character);
	}

	private put(character: string): void {
		this.output += character;
		this.column++;
	}

	private putBreak(): void {
		this.output += '\n';
		this.column = 0;
	}
}

function yamlMultiline(text: string): boolean {
	return /[\r\n\u0085\u2028\u2029]/.test(text);
}

function yamlHex(code: number, digits: number): string {
	return code.toString(16).toUpperCase().padStart(digits, '0');
}

function parseCsvRow(row: string): string[] {
	const cells: string[] = [];
	let current = '';
	let quoted = false;
	for (let index = 0; index < row.length; index++) {
		const char = row[index];
		if (quoted) {
			if (char === '"') {
				if (row[index + 1] === '"') {
					current += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			cells.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	cells.push(current);
	return cells;
}

/** The string HCL converted an argument for a go-cty string parameter to, a sensitive one's unwrapped. */
function convertedString(argument: RuntimeValue<ValueType>): string {
	return String(unwrapSensitive(argument).value);
}

/** Go's base64.StdEncoding.DecodeString, or undefined for text it refuses. */
function decodeStandardBase64(text: string): Buffer | undefined {
	try {
		return decodeStdBase64(text);
	} catch (error) {
		if (error instanceof CorruptInputError) return undefined;
		throw error;
	}
}

/** The IANA name of the encoding OpenTofu's text functions are given, refused as they refuse a name x/text lacks. */
function namedEncoding(name: string): string {
	const encoding = ianaEncoding(name);
	if (encoding === undefined) throw new ArgumentError(1, `${goQuoted(name)} is not a supported IANA encoding name or alias in this OpenTofu version`);
	return encoding;
}

const isHex = (character: string | undefined): boolean => character !== undefined && /^[0-9A-Fa-f]$/u.test(character);

/** Go's url.QueryUnescape: "+" is a space and each "%XX" a byte, and a malformed escape is refused. */
function queryUnescape(text: string): string {
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== '%') continue;
		if (index + 2 >= text.length || !isHex(text[index + 1]) || !isHex(text[index + 2])) {
			const escape = text.slice(index, index + 3);
			throw new Error(`failed to decode URL '': invalid URL escape ${JSON.stringify(escape)}`);
		}
		index += 2;
	}
	const bytes: number[] = [];
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '%') {
			bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
			index += 2;
		} else if (character === '+') {
			bytes.push(0x20);
		} else {
			const codePoint = text.codePointAt(index)!;
			const encoded = String.fromCodePoint(codePoint);
			bytes.push(...Buffer.from(encoded, 'utf8'));
			index += encoded.length - 1;
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

export const builtinFunctionGroup = {
	namespace: 'opentofu',
	functions: {
		...assumeFunctions,
		...collectionFunctions,
		base64gunzip: async (args: RuntimeValue<ValueType>[]) => {
			const text = convertedString(args[0]);
			const sensitive = (args[0].type as string) === 'sensitive';
			const compressed = decodeStandardBase64(text);
			if (!compressed) throw new Error(`failed to decode base64 data ${sensitive ? '(sensitive value)' : text}`);
			let decompressed: Buffer;
			try {
				decompressed = gunzipSync(compressed);
			} catch (error) {
				throw new Error(`failed to gunzip bytestream: ${error instanceof Error ? error.message : String(error)}`);
			}
			return markedLike(stringValue(decompressed.toString('utf8')), args.slice(0, 1));
		},
		cidrcontains: async (args: RuntimeValue<ValueType>[]) => {
			const prefix = convertedString(args[0]);
			const address = convertedString(args[1]);
			const containing = parseCIDR(prefix);
			let start = parseIP(address);
			let end: IP | undefined;
			if (!start) {
				let contained: IPNet;
				try {
					contained = parseCIDR(address);
				} catch {
					throw new Error(`invalid IP address or prefix: ${address}`);
				}
				[start, end] = addressRange(contained);
			}
			if ((to4(start) === undefined) !== (to4(containing.ip) === undefined)) {
				throw new Error(`address family mismatch: ${prefix} vs. ${address}`);
			}
			const result = contains(containing, start) && (end === undefined || contains(containing, end));
			return markedLike(booleanValue(result), args);
		},
		templatestring: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => {
			const rendered = await renderTemplate(convertedString(args[0]), args[1], context);
			return (rendered.type as string) === 'sensitive' ? rendered : markedLike(rendered, args);
		},
		urldecode: async (args: RuntimeValue<ValueType>[]) => markedLike(stringValue(queryUnescape(convertedString(args[0]))), args),
		abspath: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => stringValue(path.resolve(context.workingDirectory, stringArgument(args, 0, 'abspath'))),
		abs: async (args: RuntimeValue<ValueType>[]) => markedLike(numberValue(numberArgument(args, 0).absolute()), args),
		basename: async (args: RuntimeValue<ValueType>[]) => stringValue(path.basename(stringArgument(args, 0, 'basename'))),
		base64decode: async (args: RuntimeValue<ValueType>[]) => stringValue(Buffer.from(stringArgument(args, 0, 'base64decode'), 'base64').toString('utf8')),
		base64encode: async (args: RuntimeValue<ValueType>[]) => stringValue(Buffer.from(stringArgument(args, 0, 'base64encode'), 'utf8').toString('base64')),
		base64gzip: async (args: RuntimeValue<ValueType>[]) => stringValue(gzipSync(Buffer.from(stringArgument(args, 0, 'base64gzip'))).toString('base64')),
		base64sha256: async (args: RuntimeValue<ValueType>[]) => stringValue(createHash('sha256').update(stringArgument(args, 0, 'base64sha256'), 'utf8').digest('base64')),
		base64sha512: async (args: RuntimeValue<ValueType>[]) => stringValue(createHash('sha512').update(stringArgument(args, 0, 'base64sha512'), 'utf8').digest('base64')),
		can: async (args: RuntimeValue<ValueType>[]) => booleanValue(args.length > 0),
		ceil: async (args: RuntimeValue<ValueType>[]) => markedLike(numberValue(numberArgument(args, 0).ceil()), args),
		chomp: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'chomp');
			return stringValue(value.replace(/(?:\r?\n)+$/u, ''));
		},
		cidrhost: async (args: RuntimeValue<ValueType>[]) => {
			const { network, prefix } = parseCidr(stringArgument(args, 0, 'cidrhost'));
			let host = integerArgument(args, 1);
			const hostBits = 32 - prefix;
			const maxHost = (1 << hostBits) - 2;
			if (host === -1) host = (1 << hostBits) - 1;
			if (host < 0 || host > maxHost) throw new Error(`cidrhost host ${host} exceeds network capacity`);
			return stringValue(ipFromInteger((network | host) >>> 0));
		},
		cidrnetmask: async (args: RuntimeValue<ValueType>[]) => {
			const { prefix } = parseCidr(stringArgument(args, 0, 'cidrnetmask'));
			const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
			return stringValue(ipFromInteger(mask));
		},
		cidrsubnet: async (args: RuntimeValue<ValueType>[]) => {
			const { network, prefix } = parseCidr(stringArgument(args, 0, 'cidrsubnet'));
			const newBits = integerArgument(args, 1);
			const netNumber = integerArgument(args, 2);
			if (newBits < 0 || newBits > 32) throw new Error('cidrsubnet newbits out of range');
			const resultPrefix = prefix + newBits;
			if (resultPrefix > 32) throw new Error('cidrsubnet prefix exceeds 32 bits');
			const maxNet = (1 << newBits) - 1;
			if (netNumber < 0 || netNumber > maxNet) throw new Error(`cidrsubnet netnum ${netNumber} exceeds subnet capacity`);
			const subnetwork = (network | (netNumber << (32 - resultPrefix))) >>> 0;
			return stringValue(`${ipFromInteger(subnetwork)}/${resultPrefix}`);
		},
		// OpenTofu's cidrsubnets: consecutive subnets of the prefix, each extending it by its number of bits, every refusal
		// an argument error on the argument it is about.
		cidrsubnets: async (args: RuntimeValue<ValueType>[]) => {
			let network: IPNet;
			try {
				network = parseCIDR(convertedString(args[0]));
			} catch (error) {
				throw new ArgumentError(0, `invalid CIDR expression: ${(error as Error).message}`);
			}
			const startPrefix = maskOnes(network.mask);
			const bits = network.ip.length * 8;
			const extension = (index: number): number => {
				try {
					return integerArgument(args, index);
				} catch (error) {
					throw new ArgumentError(index, (error as Error).message);
				}
			};
			if (args.length === 1) return makeListValue(ctyString, []);
			let [current] = previousSubnet(network, extension(1) + startPrefix);
			const results: RuntimeValue<ValueType>[] = [];
			for (let index = 1; index < args.length; index++) {
				const newBits = extension(index);
				if (newBits < 1) throw new ArgumentError(index, 'must extend prefix by at least one bit');
				const length = newBits + startPrefix;
				if (length > bits) {
					const protocol = bits === 32 ? 'IPv4' : bits === 128 ? 'IPv6' : 'IP';
					throw new ArgumentError(index, `would extend prefix to ${length} bits, which is too long for an ${protocol} address`);
				}
				const [next, rollover] = nextSubnet(current, length);
				if (rollover || !contains(network, next.ip)) {
					throw new ArgumentError(index, `not enough remaining address space for a subnet with a prefix of ${length} bits after ${ipNetString(current)}`);
				}
				current = next;
				results.push(stringValue(ipNetString(current)));
			}
			return makeListValue(ctyString, results);
		},
		csvdecode: async (args: RuntimeValue<ValueType>[]) => csvDecode(stringArgument(args, 0, 'csvdecode')),
		dirname: async (args: RuntimeValue<ValueType>[]) => stringValue(path.dirname(stringArgument(args, 0, 'dirname'))),
		fileset: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => {
			// Terragrunt takes a sensitive directory or pattern, and marks the files it answers sensitive.
			const sensitive = args.some(argument => (argument.type as string) === 'sensitive');
			const plain = args.map(unwrapSensitive);
			const files = makeSetValue(ctyString, (await fileset(
				stringArgument(plain, 0, 'fileset'),
				stringArgument(plain, 1, 'fileset'),
				context.workingDirectory,
				sensitive
			)).map(stringValue));
			return sensitive ? makeSensitiveValue(files) : files;
		},
		endswith: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'endswith').endsWith(stringArgument(args, 1, 'endswith'))),
		floor: async (args: RuntimeValue<ValueType>[]) => markedLike(numberValue(numberArgument(args, 0).floor()), args),
		format: async (args: RuntimeValue<ValueType>[]) => stringValue(formatFunction(stringArgument(args, 0, 'format'), args.slice(1))),
		formatlist: async (args: RuntimeValue<ValueType>[]) => makeListValue(ctyString, formatListFunction(stringArgument(args, 0, 'formatlist'), args.slice(1)).map(stringValue)),
		indent: async (args: RuntimeValue<ValueType>[]) => {
			const spaces = ' '.repeat(integerArgument(args, 0));
			const lines = stringArgument(args, 1, 'indent').split('\n');
			return stringValue(lines.map((line, index) => (index === 0 ? line : spaces + line)).join('\n'));
		},
		join: async (args: RuntimeValue<ValueType>[]) => {
			const separator = stringArgument(args, 0, 'join');
			if (args.length < 2) throw new Error('at least one list is required');
			const lists = args.length - 1;
			// HCL has converted each list to a list of strings, so an element that is not a string is a null.
			return stringValue(args.slice(1).flatMap((_, list) => arrayArgument(args, list + 1, 'join').map((value, index) => {
				if (value.type === 'null') {
					throw new ArgumentError(list + 1, `element ${index}${lists > 1 ? ` of list ${list + 1}` : ''} is null; cannot concatenate null values`);
				}
				return String(value.value);
			})).join(separator));
		},
		jsondecode: async (args: RuntimeValue<ValueType>[]) => {
			let parsed: unknown;
			try {
				parsed = parseJsonDocument(stringArgument(args, 0, 'jsondecode'));
			} catch (error) {
				throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : error}`);
			}
			const decoded = convertToRuntimeValue(parsed);
			return args[0].encrypted ? markEncrypted(decoded) : decoded;
		},
		jsonencode: async (args: RuntimeValue<ValueType>[]) => stringValue(jsonEncode(requireArgument(args, 0, 'jsonencode'))),
		log: async (args: RuntimeValue<ValueType>[]) => {
			const number = numberArgument(args, 0).toGoFloat64();
			const base = numberArgument(args, 1).toGoFloat64();
			return markedLike(float64Value(Math.log(number) / Math.log(base)), args);
		},
		lower: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'lower').toLocaleLowerCase()),
		mark_as_read: async (args: RuntimeValue<ValueType>[]) => {
			expectParams(args, [1], 'mark_as_read');
			const value = stringArgument(args, 0, 'mark_as_read');
			return stringValue(value);
		},
		mark_glob_as_read: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => makeListValue(ctyString, (await expandTerragruntGlob(
			args.map((_, index) => stringArgument(args, index, 'mark_glob_as_read')),
			context.workingDirectory,
			context.environmentVariables,
			context.repoRoots
		)).map(stringValue)),
		max: async (args: RuntimeValue<ValueType>[]) => markedLike(numberValue(extreme(args, 1)), args),
		md5: async (args: RuntimeValue<ValueType>[]) => hash('md5', stringArgument(args, 0, 'md5')),
		min: async (args: RuntimeValue<ValueType>[]) => markedLike(numberValue(extreme(args, -1)), args),
		nonsensitive: async (args: RuntimeValue<ValueType>[]) => unwrapSensitive(requireArgument(args, 0, 'nonsensitive')),
		parseint: async (args: RuntimeValue<ValueType>[]) => {
			const text = args[0];
			const type = valueType(text);
			if (type.kind !== 'string') throw new ArgumentError(0, `first argument must be a string, not ${friendlyName(type)}`);
			let base: number;
			try {
				base = integerArgument(args, 1);
			} catch (error) {
				throw new ArgumentError(1, (error as Error).message);
			}
			if (base < 2 || base > 62) throw new ArgumentError(1, 'base must be a whole number between 2 and 62 inclusive');
			const parsed = parseGoInteger(String(text.value), base);
			if (parsed === undefined) throw new ArgumentError(0, `cannot parse ${goQuoted(String(text.value))} as a base ${base} integer`);
			return markedLike(numberValue(CtyNumber.fromBigInt(parsed)), args);
		},
		pathexpand: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'pathexpand');
			if (value === '~') {
				const home = process.env.HOME;
				if (!home) throw new Error('pathexpand requires HOME for the ~ path');
				return stringValue(home);
			}
			if (value.startsWith('~/')) {
				const home = process.env.HOME;
				if (!home) throw new Error('pathexpand requires HOME for a path beginning with ~/');
				return stringValue(path.join(home, value.slice(2)));
			}
			return stringValue(value);
		},
		pow: async (args: RuntimeValue<ValueType>[]) => {
			const number = numberArgument(args, 0).toGoFloat64();
			const power = numberArgument(args, 1).toGoFloat64();
			return markedLike(float64Value(goPow(number, power)), args);
		},
		// As go-cty's RangeFunc: without a step it counts by 1, or by -1 towards a lower limit, from zero when only the
		// limit is given. A zero step is not refused, since go-cty compares it to zero by identity; it counts upwards
		// and meets the 1024 limit. Each value is the one before plus the step, and the limit is reached when a value
		// passes it or equals it as go-cty's equality decides.
		range: async (args: RuntimeValue<ValueType>[]) => {
			if (args.length < 1 || args.length > 3) throw new Error('range must have one, two, or three arguments');
			const numbers = args.map((_, index) => numberArgument(args, index));
			const zero = CtyNumber.fromInt64(0);
			const [start, limit] = numbers.length === 1 ? [zero, numbers[0]] : [numbers[0], numbers[1]];
			const step = numbers.length === 3 ? numbers[2] : CtyNumber.fromInt64(limit.compare(start) < 0 ? -1 : 1);
			const down = step.compare(zero) < 0;
			if (down && limit.compare(start) > 0) throw new ArgumentError(1, 'end must be less than start when step is negative');
			if (!down && limit.compare(start) < 0) throw new ArgumentError(1, 'end must be greater than start when step is positive');
			const values: RuntimeValue<ValueType>[] = [];
			for (let value = start; ; value = value.add(step)) {
				const order = value.compare(limit);
				if (down ? order < 0 || value.equals(limit) : order > 0 || value.equals(limit)) break;
				if (values.length >= 1024) {
					throw new Error('range failed: more than 1024 values were generated; either decrease the difference between start and end or use a smaller step');
				}
				values.push(numberValue(value));
			}
			return markedLike(makeListValue(ctyNumber, values), args);
		},
		regex: async (args: RuntimeValue<ValueType>[]) => regexMatch(stringArgument(args, 0, 'regex'), stringArgument(args, 1, 'regex')),
		regexall: async (args: RuntimeValue<ValueType>[]) => regexAll(stringArgument(args, 0, 'regexall'), stringArgument(args, 1, 'regexall')),
		replace: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'replace').split(stringArgument(args, 1, 'replace')).join(stringArgument(args, 2, 'replace'))),
		sensitive: async (args: RuntimeValue<ValueType>[]) => makeSensitiveValue(requireArgument(args, 0, 'sensitive')),
		bcrypt: async (args: RuntimeValue<ValueType>[]) => {
			if (args.length > 2) throw new Error('bcrypt() takes no more than two arguments');
			const password = stringArgument(args, 0, 'bcrypt');
			const cost = args[1] ? integerArgument(args, 1) : 10;
			if (!Number.isInteger(cost) || cost < 4 || cost > 31) throw new Error('bcrypt cost must be an integer between 4 and 31');
			return stringValue(bcrypt.hashSync(password, cost));
		},
		rsadecrypt: async (args: RuntimeValue<ValueType>[]) => {
			const ciphertext = stringArgument(args, 0, 'rsadecrypt');
			const privateKey = stringArgument(args, 1, 'rsadecrypt');
			const encrypted = decodeStandardBase64(ciphertext);
			if (!encrypted) throw new ArgumentError(0, `failed to decode input ${goQuoted(ciphertext)}: cipher text must be base64-encoded`);
			// As golang.org/x/crypto's ssh.ParseRawPrivateKey: the first PEM block, of a type it reads.
			const block = /(?:^|\n)-----BEGIN ([^\n]*?)-----\r?\n[\s\S]*?\n-----END \1-----/u.exec(privateKey);
			if (!block) throw new ArgumentError(1, 'invalid private key: ssh: no key found');
			if (!['RSA PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY'].includes(block[1])) {
				throw new ArgumentError(1, `invalid private key: ssh: unsupported key type ${goQuoted(block[1])}`);
			}
			try {
				const plaintext = privateDecrypt({
					key: privateKey,
					padding: constants.RSA_PKCS1_OAEP_PADDING,
					oaepHash: 'sha1'
				}, encrypted);
				return stringValue(plaintext.toString('utf8'));
			} catch (error) {
				throw new Error(`rsadecrypt failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		timestamp: async () => stringValue(new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')),
		sha1: async (args: RuntimeValue<ValueType>[]) => hash('sha1', stringArgument(args, 0, 'sha1')),
		sha256: async (args: RuntimeValue<ValueType>[]) => hash('sha256', stringArgument(args, 0, 'sha256')),
		sha512: async (args: RuntimeValue<ValueType>[]) => hash('sha512', stringArgument(args, 0, 'sha512')),
		// go-cty's signum reads its number into a Go int, so it refuses a fraction.
		signum: async (args: RuntimeValue<ValueType>[]) => markedLike(integerValue(Math.sign(Number(numberArgument(args, 0).toGoInt64()))), args),
		split: async (args: RuntimeValue<ValueType>[]) => makeListValue(ctyString, stringArgument(args, 1, 'split').split(stringArgument(args, 0, 'split')).map(stringValue)),
		startswith: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'startswith').startsWith(stringArgument(args, 1, 'startswith'))),
		strcontains: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'strcontains').includes(stringArgument(args, 1, 'strcontains'))),
		strrev: async (args: RuntimeValue<ValueType>[]) => stringValue([...stringArgument(args, 0, 'strrev')].reverse().join('')),
		substr: async (args: RuntimeValue<ValueType>[]) => {
			const clusters = graphemeClusters(stringArgument(args, 0, 'substr'));
			const offset = integerArgument(args, 1);
			const length = integerArgument(args, 2);
			if (offset >= 0 && length === 0) return stringValue('');
			const rest = clusters.slice(Math.max(offset < 0 ? offset + clusters.length : offset, 0));
			return stringValue((length > 0 ? rest.slice(0, length) : rest).join(''));
		},
		textdecodebase64: async (args: RuntimeValue<ValueType>[]) => {
			const name = namedEncoding(stringArgument(args, 1, 'textdecodebase64'));
			let bytes: Buffer;
			try {
				bytes = decodeStdBase64(stringArgument(args, 0, 'textdecodebase64'));
			} catch (error) {
				if (!(error instanceof CorruptInputError)) throw error;
				throw new ArgumentError(0, `the given value is has an invalid base64 symbol at offset ${error.offset}`);
			}
			const decoded = textEncoding(name).decode(bytes);
			if (decoded.includes('\ufffd')) throw new ArgumentError(0, `the given string contains symbols that are not defined for ${name}`);
			return stringValue(decoded);
		},
		textencodebase64: async (args: RuntimeValue<ValueType>[]) => {
			const name = namedEncoding(stringArgument(args, 1, 'textencodebase64'));
			const encoded = textEncoding(name).encode(stringArgument(args, 0, 'textencodebase64'));
			if (!encoded) throw new ArgumentError(0, `the given string contains characters that cannot be represented in ${name}`);
			return stringValue(encoded.toString('base64'));
		},
		title: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'title').replace(/\p{L}[\p{L}\p{N}]*/gu, word => word[0].toLocaleUpperCase() + word.slice(1))),
		trim: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trim');
			const cutset = stringArgument(args, 1, 'trim');
			if (cutset === '') return stringValue(value);
			const pattern = new RegExp(`^[${escapeRegExp(cutset)}]+|[${escapeRegExp(cutset)}]+$`, 'gu');
			return stringValue(value.replace(pattern, ''));
		},
		trimprefix: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trimprefix');
			const prefix = stringArgument(args, 1, 'trimprefix');
			return stringValue(value.startsWith(prefix) ? value.slice(prefix.length) : value);
		},
		try: async (args: RuntimeValue<ValueType>[]) => {
			if (args.length === 0) throw new Error('try requires at least one argument');
			return args[0];
		},
		trimspace: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'trimspace').trim()),
		trimsuffix: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trimsuffix');
			const suffix = stringArgument(args, 1, 'trimsuffix');
			return stringValue(suffix && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value);
		},
		upper: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'upper').toLocaleUpperCase()),
		urlencode: async (args: RuntimeValue<ValueType>[]) => stringValue(encodeURIComponent(stringArgument(args, 0, 'urlencode')).replace(/%20/g, '+')),
		uuid: async () => stringValue(cryptoRandomUuid()),
		uuidv5: async (args: RuntimeValue<ValueType>[]) => stringValue(uuidv5(stringArgument(args, 0, 'uuidv5'), stringArgument(args, 1, 'uuidv5'))),
		yamlencode: async (args: RuntimeValue<ValueType>[]) => stringValue(YamlEmitter.encode(requireArgument(args, 0, 'yamlencode'))),
		formatdate: async (args: RuntimeValue<ValueType>[]) => stringValue(formatDate(stringArgument(args, 0, 'formatdate'), stringArgument(args, 1, 'formatdate'))),
		timeadd: async (args: RuntimeValue<ValueType>[]) => {
			const time = stringArgument(args, 0, 'timeadd');
			const duration = stringArgument(args, 1, 'timeadd');
			const timestamp = Date.parse(time);
			if (Number.isNaN(timestamp)) throw new Error(`Invalid time ${JSON.stringify(time)} for timeadd`);
			return stringValue(formatUtcTimestamp(new Date(timestamp + goDurationMilliseconds(duration))));
		},
		// OpenTofu's timecmp: the instants two timestamps name, each read as Go's time.Parse reads RFC 3339.
		timecmp: async (args: RuntimeValue<ValueType>[]) => {
			const [first, second] = [0, 1].map(index => {
				try {
					return instant(parseTimestamp(stringArgument(args, index, 'timecmp'), false));
				} catch (error) {
					throw new ArgumentError(index, (error as Error).message);
				}
			});
			return integerValue(first < second ? -1 : first > second ? 1 : 0);
		}
	}
};

function formatUtcTimestamp(date: Date): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
	return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function goDurationMilliseconds(duration: string): number {
	const pattern = /^[+-]?((?:\d+(?:\.\d+)?)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
	if (!pattern.test(duration)) throw new Error(`Invalid duration for timeadd: ${JSON.stringify(duration)}`);
	const sign = duration.startsWith('-') ? -1 : 1;
	const body = duration.replace(/^[+-]/u, '');
	const units: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
	const parts = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gu;
	let total = 0;
	let match: RegExpExecArray | null;
	while ((match = parts.exec(body)) !== null) total += Number(match[1]) * units[match[2]]!;
	return sign * total;
}

function cryptoRandomUuid(): string {
	return randomUUID();
}

void uuidRegex;
