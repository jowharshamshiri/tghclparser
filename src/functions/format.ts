import { graphemeClusters } from '../grapheme-clusters';
import type { RuntimeValue, ValueType } from '../model';
import { friendlyTypeName, unwrapSensitive } from './utils';

/**
 * The format and formatlist functions as go-cty's stdlib defines them: its formatFSM reads the format string, and
 * each verb formats its argument as formatAppend does, leaning on Go's math/big formatting for numbers. A number
 * here is a float64 where go-cty holds a 512-bit float; it is taken as the shortest decimal that identifies it,
 * which is the number as it was written, and a tie when rounding that decimal is settled as go-cty's 512-bit value
 * of it settles it.
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
			if (!verb.sharp && arg.type === 'number') return padWidth(verb, numberText(Number(arg.value), 'g'));
			return padWidth(verb, ctyJson(arg));
		case 't':
			return toBool(arg, unsupported) ? 'true' : 'false';
		case 'b': case 'd': case 'o': case 'x': case 'X':
			return formatInteger(verb, toNumber(arg, unsupported), unsupported);
		case 'e': case 'E': case 'f': case 'g': case 'G':
			return formatFloat(verb, toNumber(arg, unsupported));
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

/** go-cty's conversion of a value to a number, reading a string as math/big's ParseFloat reads base 10. */
function toNumber(arg: RuntimeValue<ValueType>, unsupported: (reason: string) => Error): number {
	if (arg.type === 'number') return Number(arg.value);
	if (arg.type !== 'string') throw unsupported(`number required, but have ${friendlyTypeName(arg)}`);
	const match = /^([+-]?)(?:(inf|Inf)|(\d+\.?\d*|\.\d+)(?:([eEpP])([+-]?\d+))?)$/u.exec(String(arg.value));
	if (!match) throw unsupported('a number is required');
	const sign = match[1] === '-' ? -1 : 1;
	if (match[2] !== undefined) return sign * Infinity;
	const mantissa = Number(match[3]);
	if (match[4] === undefined) return sign * mantissa;
	return sign * (/[eE]/u.test(match[4]) ? Number(`${match[3]}e${match[5]}`) : mantissa * 2 ** Number(match[5]));
}

/** go-cty's conversion of a value to a string: a number in decimal with no exponent. */
function toText(arg: RuntimeValue<ValueType>, unsupported: (reason: string) => Error): string {
	if (arg.type === 'string') return String(arg.value);
	if (arg.type === 'number') return numberText(Number(arg.value), 'f');
	if (arg.type === 'boolean') return arg.value ? 'true' : 'false';
	throw unsupported(`string required, but have ${friendlyTypeName(arg)}`);
}

/** An integer verb, as math/big's Int.Format writes it. */
function formatInteger(verb: Verb, value: number, unsupported: (reason: string) => Error): string {
	if (!Number.isInteger(value)) throw unsupported('an integer is required');
	const base = { b: 2, d: 10, o: 8, x: 16, X: 16 }[verb.mode as 'b' | 'd' | 'o' | 'x' | 'X'];
	let digits = BigInt(Math.abs(value)).toString(base);
	if (verb.mode === 'X') digits = digits.toUpperCase();
	const sign = value < 0 ? '-' : verb.plus ? '+' : verb.space ? ' ' : '';
	const prefix = verb.sharp ? { b: '0b', d: '', o: '0', x: '0x', X: '0X' }[verb.mode as 'b' | 'd' | 'o' | 'x' | 'X'] : '';
	let zeros = 0;
	if (verb.prec >= 0) {
		if (digits.length < verb.prec) zeros = verb.prec - digits.length;
		else if (digits === '0' && verb.prec === 0) return '';
	}
	let left = 0;
	let right = 0;
	const length = sign.length + prefix.length + zeros + digits.length;
	if (verb.width > length) {
		const pad = verb.width - length;
		if (verb.minus) right = pad;
		else if (verb.zero && verb.prec < 0) zeros = pad;
		else left = pad;
	}
	return `${' '.repeat(left)}${sign}${prefix}${'0'.repeat(zeros)}${digits}${' '.repeat(right)}`;
}

/** A float verb, as math/big's Float.Format writes it: the `0` flag pads with zeros even beside `-`. */
function formatFloat(verb: Verb, value: number): string {
	const mode = verb.mode as 'e' | 'E' | 'f' | 'g' | 'G';
	const prec = verb.prec >= 0 ? verb.prec : mode === 'g' || mode === 'G' ? -1 : 6;
	const body = Number.isFinite(value) ? decimalText(decimalOf(value), mode, prec) : 'Inf';
	let sign = value < 0 ? '-' : verb.plus ? '+' : verb.space ? ' ' : '';
	if (value === Infinity) sign = verb.space ? ' ' : '+';
	const padding = Math.max(verb.width - sign.length - body.length, 0);
	if (verb.zero && Number.isFinite(value)) return `${sign}${'0'.repeat(padding)}${body}`;
	if (verb.minus) return `${sign}${body}${' '.repeat(padding)}`;
	return `${' '.repeat(padding)}${sign}${body}`;
}

/** math/big's Float.Text of a number, with its sign: `-Inf` and `+Inf` for the infinities. */
function numberText(value: number, format: 'f' | 'g'): string {
	if (!Number.isFinite(value)) return value < 0 ? '-Inf' : '+Inf';
	return `${value < 0 ? '-' : ''}${decimalText(decimalOf(value), format, -1)}`;
}

/**
 * A number's decimal digits as math/big holds them: `mant` the significant digits with no leading or trailing
 * zero, the decimal point `exp` digits into them.
 */
interface Decimal {
	mant: string;
	exp: number;
	/** Whether go-cty's 512-bit value lies above these digits, or undefined where it is exactly them. */
	above: boolean | undefined;
}

/** The shortest decimal of a number's magnitude, with where go-cty's 512-bit value of it lies. */
function decimalOf(value: number): Decimal {
	const magnitude = Math.abs(value);
	if (magnitude === 0) return { mant: '', exp: 0, above: undefined };
	const [digits, exponent] = magnitude.toExponential().split('e');
	const mant = digits.replace('.', '').replace(/0+$/u, '');
	const exp = Number(exponent) + 1;
	return { mant, exp, above: storedAbove(mant, exp) };
}

/**
 * Where the 512-bit float nearest a decimal lies: go-cty reads a number into 512 bits, rounding to the nearest even,
 * so a decimal fraction no binary fraction equals is held a little above or a little below it.
 */
function storedAbove(mant: string, exp: number): boolean | undefined {
	const fractionDigits = mant.length - exp;
	if (fractionDigits <= 0) return undefined;
	const numerator = BigInt(mant);
	const denominator = 10n ** BigInt(fractionDigits);
	if (numerator % 5n ** BigInt(fractionDigits) === 0n) return undefined;
	const bits = (value: bigint) => value.toString(2).length;
	let shift = 512 - (bits(numerator) - bits(denominator));
	const scaled = (by: number) => by >= 0
		? { num: numerator << BigInt(by), den: denominator }
		: { num: numerator, den: denominator << BigInt(-by) };
	while (bits(scaled(shift).num / scaled(shift).den) > 512) shift--;
	while (bits(scaled(shift).num / scaled(shift).den) < 512) shift++;
	const { num, den } = scaled(shift);
	let quotient = num / den;
	const twiceRemainder = 2n * (num - quotient * den);
	if (twiceRemainder > den || (twiceRemainder === den && quotient % 2n === 1n)) quotient++;
	return quotient * den > num;
}

/** Rounds to `n` significant digits as math/big's decimal.round does. */
function round(decimal: Decimal, n: number): Decimal {
	if (n < 0 || n >= decimal.mant.length) return decimal;
	const half = decimal.mant[n] === '5' && n + 1 === decimal.mant.length;
	const up = half
		? decimal.above ?? (n > 0 && Number(decimal.mant[n - 1]) % 2 === 1)
		: decimal.mant[n] >= '5';
	if (!up) {
		const mant = decimal.mant.slice(0, n).replace(/0+$/u, '');
		return { mant, exp: mant === '' ? 0 : decimal.exp, above: undefined };
	}
	let keep = n;
	while (keep > 0 && decimal.mant[keep - 1] === '9') keep--;
	if (keep === 0) return { mant: '1', exp: decimal.exp + 1, above: undefined };
	const mant = decimal.mant.slice(0, keep - 1) + String(Number(decimal.mant[keep - 1]) + 1);
	return { mant, exp: decimal.exp, above: undefined };
}

/** math/big's Float.Append for the `e`, `E`, `f`, `g` and `G` formats, of a magnitude; -1 is the shortest precision. */
function decimalText(decimal: Decimal, format: 'e' | 'E' | 'f' | 'g' | 'G', precision: number): string {
	let d = decimal;
	let prec = precision;
	const shortest = prec < 0;
	if (shortest) {
		prec = format === 'e' || format === 'E' ? d.mant.length - 1 : format === 'f' ? Math.max(d.mant.length - d.exp, 0) : d.mant.length;
	} else if (format === 'e' || format === 'E') {
		d = round(d, 1 + prec);
	} else if (format === 'f') {
		d = round(d, d.exp + prec);
	} else {
		if (prec === 0) prec = 1;
		d = round(d, prec);
	}
	if (format === 'e' || format === 'E') return exponentText(d, format, prec);
	if (format === 'f') return fixedText(d, prec);
	let eprec = prec;
	if (eprec > d.mant.length && d.mant.length >= d.exp) eprec = d.mant.length;
	if (shortest) eprec = 6;
	const exp = d.exp - 1;
	if (exp < -4 || exp >= eprec) {
		if (prec > d.mant.length) prec = d.mant.length;
		return exponentText(d, format === 'g' ? 'e' : 'E', prec - 1);
	}
	if (prec > d.exp) prec = d.mant.length;
	return fixedText(d, Math.max(prec - d.exp, 0));
}

/** math/big's %e: d.ddddde±dd. */
function exponentText(d: Decimal, format: 'e' | 'E', prec: number): string {
	let text = d.mant[0] ?? '0';
	if (prec > 0) text += `.${d.mant.slice(1, prec + 1).padEnd(prec, '0')}`;
	const exp = d.mant.length > 0 ? d.exp - 1 : 0;
	return `${text}${format}${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

/** math/big's %f: ddddd.ddd. */
function fixedText(d: Decimal, prec: number): string {
	const at = (index: number) => (index >= 0 && index < d.mant.length ? d.mant[index] : '0');
	let text = d.exp > 0 ? d.mant.slice(0, d.exp).padEnd(d.exp, '0') : '0';
	if (prec > 0) {
		text += '.';
		for (let index = 0; index < prec; index++) text += at(d.exp + index);
	}
	return text;
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
			return numberText(Number(plain.value), 'f');
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
