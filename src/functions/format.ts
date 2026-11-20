import type { CtyNumber, FormatSpec } from '../cty-number';
import { graphemeClusters } from '../grapheme-clusters';
import type { RuntimeValue, ValueType } from '../model';
import { convertToNumber } from '../cty-operations';
import { friendlyTypeName, unwrapSensitive } from './utils';

/**
 * The format and formatlist functions as go-cty's stdlib defines them: its formatFSM reads the format string, and
 * each verb formats its argument as formatAppend does, leaning on Go's math/big formatting for numbers, which
 * {@link CtyNumber} reproduces.
 */

/** A formatting verb, as formatFSM reads it. */
interface Verb {
	raw: string;
	offset: number;
	argNum: number;
	mode: string;
	zero: boolean;
	sharp: boolean;
	plus: boolean;
	minus: boolean;
	space: boolean;
	/** The precision, or -1 when none is given; `.` alone gives 0. */
	prec: number;
	/** The width, or -1 when none is given. */
	width: number;
}

/**
 * Formats the arguments as go-cty's format function does.
 *
 * @param format the format string.
 * @param args the values its verbs format.
 * @returns the formatted string.
 * @throws {Error} with go-cty's message for a malformed format string, a verb with no argument or a value it
 *   cannot format, and for an argument no verb uses.
 */
export function formatFunction(format: string, args: RuntimeValue<ValueType>[]): string {
	const data = Buffer.from(format, 'utf8');
	let output = '';
	let nextArg = 1;
	let highestArg = 0;
	let literalStart = 0;
	let p = 0;
	const isDigit = (at: number) => at < data.length && data[at] >= 0x30 && data[at] <= 0x39;
	const unrecognized = (at: number) => new Error(
		`unrecognized format character ${quoteRune(data.subarray(at).toString('utf8').codePointAt(0)!)} at offset ${at}`
	);
	const endedEarly = () => new Error(`invalid format string starting at offset ${data.length}`);
	while (p < data.length) {
		if (data[p] !== 0x25) {
			p++;
			continue;
		}
		output += data.subarray(literalStart, p).toString('utf8');
		const start = p++;
		if (p === data.length) throw endedEarly();
		if (data[p] === 0x25) {
			output += '%';
			literalStart = ++p;
			continue;
		}
		const verb: Verb = {
			raw: '', offset: start, argNum: nextArg, mode: '',
			zero: false, sharp: false, plus: false, minus: false, space: false,
			prec: -1, width: -1
		};
		for (; p < data.length && '0#-+ '.includes(String.fromCharCode(data[p])); p++) {
			switch (data[p]) {
				case 0x30: verb.zero = true; break;
				case 0x23: verb.sharp = true; break;
				case 0x2d: verb.minus = true; break;
				case 0x2b: verb.plus = true; break;
				default: verb.space = true;
			}
		}
		if (isDigit(p)) {
			verb.width = 0;
			for (; isDigit(p); p++) verb.width = 10 * verb.width + data[p] - 0x30;
		}
		if (p < data.length && data[p] === 0x2e) {
			verb.prec = 0;
			for (p++; isDigit(p); p++) verb.prec = 10 * verb.prec + data[p] - 0x30;
		}
		if (p < data.length && data[p] === 0x5b) {
			p++;
			if (p === data.length) throw endedEarly();
			if (!isDigit(p) || data[p] === 0x30) throw unrecognized(p);
			verb.argNum = 0;
			for (; isDigit(p); p++) verb.argNum = 10 * verb.argNum + data[p] - 0x30;
			if (p === data.length) throw endedEarly();
			if (data[p] !== 0x5d) throw unrecognized(p);
			p++;
		}
		if (p === data.length) throw endedEarly();
		if (!/^[a-zA-Z]$/u.test(String.fromCharCode(data[p]))) throw unrecognized(p);
		verb.mode = String.fromCharCode(data[p]);
		literalStart = ++p;
		verb.raw = data.subarray(start, p).toString('utf8');
		highestArg = Math.max(highestArg, verb.argNum);
		output += formatVerb(verb, args);
		nextArg = verb.argNum + 1;
	}
	output += data.subarray(literalStart).toString('utf8');
	if (highestArg < args.length) {
		throw new Error(highestArg === 0
			? 'too many arguments; no verbs in format string'
			: `too many arguments; only ${highestArg} used by format string`);
	}
	return output;
}

/**
 * Formats a list of strings as go-cty's formatlist function does: each list argument gives its elements in turn,
 * every other argument is used as it is in each string, and the lists must be of one length.
 *
 * @param format the format string.
 * @param args the values its verbs format.
 * @returns the formatted strings.
 */
export function formatListFunction(format: string, args: RuntimeValue<ValueType>[]): string[] {
	if (args.length === 0) return [formatFunction(format, [])];
	let length = -1;
	let lengthFrom = -1;
	args.forEach((arg, index) => {
		const value = unwrapSensitive(arg);
		if (value.type !== 'array') return;
		const thisLength = (value.value as RuntimeValue<ValueType>[]).length;
		if (length === -1) {
			length = thisLength;
			lengthFrom = index;
		} else if (thisLength !== length) {
			throw new Error(`argument ${index + 1} has length ${thisLength}, which is inconsistent with argument ${lengthFrom + 1} of length ${length}`);
		}
	});
	const results: string[] = [];
	for (let iteration = 0; iteration < (length === -1 ? 1 : length); iteration++) {
		const row = args.map(arg => {
			const value = unwrapSensitive(arg);
			return value.type === 'array' ? (value.value as RuntimeValue<ValueType>[])[iteration] : arg;
		});
		try {
			results.push(formatFunction(format, row));
		} catch (error) {
			throw new Error(`error on format iteration ${iteration}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return results;
}

/** Formats one verb's argument, as go-cty's formatAppend does. */
function formatVerb(verb: Verb, args: RuntimeValue<ValueType>[]): string {
	if (verb.argNum > args.length) {
		throw new Error(`not enough arguments for "${verb.raw}" at ${verb.offset}: need index ${verb.argNum} but have ${args.length} total`);
	}
	const arg = unwrapSensitive(args[verb.argNum - 1]);
	const unsupported = (reason: string) => new Error(`unsupported value for "${verb.raw}" at ${verb.offset}: ${reason}`);
	if (verb.mode !== 'v' && arg.type === 'null') throw unsupported('null value cannot be formatted');
	switch (verb.mode) {
		case 'v':
			if (!verb.sharp && arg.type === 'string') return padWidth(verb, String(arg.value));
			if (!verb.sharp && arg.type === 'number') return padWidth(verb, (arg.value as CtyNumber).text('g', -1));
			return padWidth(verb, ctyJson(arg));
		case 't':
			return toBool(arg, unsupported) ? 'true' : 'false';
		case 'b': case 'd': case 'o': case 'x': case 'X': {
			const number = toNumber(arg, unsupported);
			if (!number.isInteger()) throw unsupported('an integer is required');
			return number.formatInteger(verb.mode as 'b' | 'd' | 'o' | 'x' | 'X', formatSpec(verb));
		}
		case 'e': case 'E': case 'f': case 'g': case 'G':
			return toNumber(arg, unsupported).format(verb.mode as 'e' | 'E' | 'f' | 'g' | 'G', formatSpec(verb));
		case 's': case 'q': {
			let text = toText(arg, unsupported);
			if (verb.prec > 0) text = graphemeClusters(text).slice(0, verb.prec).join('');
			return padWidth(verb, verb.mode === 's' ? text : jsonString(text));
		}
		default:
			throw new Error(`unsupported format verb ${quoteRune(verb.mode.codePointAt(0)!)} in "${verb.raw}" at offset ${verb.offset}`);
	}
}

/** Pads to the verb's width in grapheme clusters, with zeros for the `0` flag, on the right for `-`. */
function padWidth(verb: Verb, text: string): string {
	const pad = verb.width - graphemeClusters(text).length;
	if (verb.width < 0 || pad <= 0) return text;
	const padding = (verb.zero ? '0' : ' ').repeat(pad);
	return verb.minus ? text + padding : padding + text;
}

/** go-cty's conversion of a value to a bool. */
function toBool(arg: RuntimeValue<ValueType>, unsupported: (reason: string) => Error): boolean {
	if (arg.type === 'boolean') return Boolean(arg.value);
	if (arg.type !== 'string') throw unsupported(`bool required, but have ${friendlyTypeName(arg)}`);
	const text = String(arg.value);
	if (text === 'true' || text === '1') return true;
	if (text === 'false' || text === '0') return false;
	const lower = text.toLowerCase();
	if (lower === 'true' || lower === 'false') {
		throw unsupported(`a bool is required; to convert from string, use lowercase "${lower}"`);
	}
	throw unsupported('a bool is required');
}

/** go-cty's conversion of a value to a number, reading a string as go-cty's ParseNumberVal reads it. */
function toNumber(arg: RuntimeValue<ValueType>, unsupported: (reason: string) => Error): CtyNumber {
	try {
		return convertToNumber(arg);
	} catch (error) {
		throw unsupported((error as Error).message);
	}
}

/** go-cty's conversion of a value to a string: a number in decimal with no exponent. */
function toText(arg: RuntimeValue<ValueType>, unsupported: (reason: string) => Error): string {
	if (arg.type === 'string') return String(arg.value);
	if (arg.type === 'number') return (arg.value as CtyNumber).toString();
	if (arg.type === 'boolean') return arg.value ? 'true' : 'false';
	throw unsupported(`string required, but have ${friendlyTypeName(arg)}`);
}

/** A verb's flags, width and precision, as Go's fmt.State gives them to math/big's formatters. */
function formatSpec(verb: Verb): FormatSpec {
	return {
		zero: verb.zero,
		sharp: verb.sharp,
		plus: verb.plus,
		minus: verb.minus,
		space: verb.space,
		width: verb.width < 0 ? undefined : verb.width,
		precision: verb.prec < 0 ? undefined : verb.prec
	};
}

/** A value as go-cty's JSON marshalling writes it: a number in decimal, an object's attributes in sorted order. */
function ctyJson(value: RuntimeValue<ValueType>): string {
	const plain = unwrapSensitive(value);
	switch (plain.type) {
		case 'null':
			return 'null';
		case 'string':
			return jsonString(String(plain.value));
		case 'number':
			return (plain.value as CtyNumber).toString();
		case 'boolean':
			return plain.value ? 'true' : 'false';
		case 'array':
			return `[${(plain.value as RuntimeValue<ValueType>[]).map(ctyJson).join(',')}]`;
		case 'object':
		case 'block': {
			const entries = [...(plain.value as Map<string, RuntimeValue<ValueType>>)]
				.sort(([left], [right]) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
			return `{${entries.map(([key, entry]) => `${jsonString(key)}:${ctyJson(entry)}`).join(',')}}`;
		}
		default:
			throw new Error(`Value of type ${String(plain.type)} has no JSON form`);
	}
}

/** A string as Go's encoding/json writes it, escaping HTML's special characters and the line separators. */
function jsonString(text: string): string {
	const named: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
	let out = '"';
	for (const character of text) {
		const code = character.codePointAt(0)!;
		if (named[character] !== undefined) out += named[character];
		else if (code < 0x20 || character === '<' || character === '>' || character === '&' || code === 0x2028 || code === 0x2029) {
			out += `\\u${code.toString(16).padStart(4, '0')}`;
		} else if (code >= 0xd800 && code <= 0xdfff) out += '\\ufffd';
		else out += character;
	}
	return `${out}"`;
}

/** A character as Go's %q writes a rune. */
function quoteRune(code: number): string {
	const named: Record<number, string> = { 0x07: '\\a', 0x08: '\\b', 0x0c: '\\f', 0x0a: '\\n', 0x0d: '\\r', 0x09: '\\t', 0x0b: '\\v', 0x27: "\\'", 0x5c: '\\\\' };
	if (named[code] !== undefined) return `'${named[code]}'`;
	const character = String.fromCodePoint(code);
	if (/^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u.test(character)) return `'${character}'`;
	if (code < 0x80) return `'\\x${code.toString(16).padStart(2, '0')}'`;
	if (code < 0x10000) return `'\\u${code.toString(16).padStart(4, '0')}'`;
	return `'\\U${code.toString(16).padStart(8, '0')}'`;
}
