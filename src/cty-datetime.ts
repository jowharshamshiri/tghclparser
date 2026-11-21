import { ArgumentError } from './function-signature';
import { goQuoted } from './go-quote';

/*
 * Timestamps as Terragrunt v1.2.2's functions read and write them: go-cty's formatdate, which reads its timestamp with
 * go-cty's strict RFC 3339 parser, and OpenTofu's timecmp, which reads its with Go's time.Parse and the RFC 3339
 * layout. Both word a timestamp they refuse from the time.ParseError Go's parser gives, so that parser is ported here
 * for that one layout, "2006-01-02T15:04:05Z07:00".
 */

/** A timestamp as Go's time.Time holds a parsed one: its fields in its own fixed zone, and that zone's offset. */
export interface Timestamp {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	nanosecond: number;
	/** The zone's offset east of UTC, in seconds. */
	offset: number;
}

/** Go's time.ParseError, as far as the messages made from it read it. */
class ParseError {
	constructor(readonly layoutElem: string, readonly valueElem: string, readonly message = '') {}
}

const RFC3339 = '2006-01-02T15:04:05Z07:00';

const isDigit = (text: string, index: number): boolean => index < text.length && text[index] >= '0' && text[index] <= '9';

const isLeap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

function daysIn(month: number, year: number): number {
	if (month === 2 && isLeap(year)) return 29;
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Go's time.getnum: one or two leading digits, two when fixed. */
function getnum(text: string, fixed: boolean): [number, string] | undefined {
	if (!isDigit(text, 0)) return undefined;
	if (!isDigit(text, 1)) return fixed ? undefined : [Number(text[0]), text.slice(1)];
	return [Number(text.slice(0, 2)), text.slice(2)];
}

/** Go's time.parseNanoseconds, for a fraction of digits. */
function parseNanoseconds(text: string, length: number): number {
	const digits = text.slice(1, Math.min(length, 10));
	return Number(digits) * 10 ** (10 - Math.min(length, 10));
}

/**
 * Go's time.Parse with the RFC 3339 layout, its value held as one character per byte.
 *
 * @throws ParseError as Go's parser reports where it stopped.
 */
function parseLayout(input: string): Timestamp {
	let value = input;
	const time: Timestamp = { year: 0, month: -1, day: -1, hour: 0, minute: 0, second: 0, nanosecond: 0, offset: 0 };
	const chunks: Array<[prefix: string, std: string]> = [['', '2006'], ['-', '01'], ['-', '02'], ['T', '15'], [':', '04'], [':', '05'], ['', 'Z07:00'], ['', '']];
	for (const [prefix, std] of chunks) {
		for (const character of prefix) {
			if (value[0] !== character) throw new ParseError(prefix, value);
			value = value.slice(1);
		}
		if (std === '') {
			if (value.length !== 0) throw new ParseError('', value, `: extra text: ${value}`);
			break;
		}
		const hold = value;
		let bad = false;
		let range = '';
		switch (std) {
			case '2006': {
				if (value.length < 4 || !isDigit(value, 0) || !/^\d{4}$/u.test(value.slice(0, 4))) {
					bad = true;
					break;
				}
				time.year = Number(value.slice(0, 4));
				value = value.slice(4);
				break;
			}
			case '01':
			case '02':
			case '15':
			case '04': {
				const read = getnum(value, std !== '15');
				if (!read) {
					bad = true;
					break;
				}
				[, value] = read;
				if (std === '01') {
					time.month = read[0];
					if (time.month <= 0 || time.month > 12) range = 'month';
				} else if (std === '02') {
					time.day = read[0];
				} else if (std === '15') {
					time.hour = read[0];
					if (time.hour >= 24) range = 'hour';
				} else {
					time.minute = read[0];
					if (time.minute >= 60) range = 'minute';
				}
				break;
			}
			case '05': {
				const read = getnum(value, true);
				if (!read) {
					bad = true;
					break;
				}
				[time.second, value] = read;
				if (time.second >= 60) {
					range = 'second';
					break;
				}
				// A fraction of a second, which the layout does not write, is read all the same.
				if (value.length >= 2 && (value[0] === '.' || value[0] === ',') && isDigit(value, 1)) {
					let length = 2;
					while (isDigit(value, length)) length++;
					time.nanosecond = parseNanoseconds(value, length);
					value = value.slice(length);
				}
				break;
			}
			default: {
				if (value[0] === 'Z') {
					value = value.slice(1);
					break;
				}
				if (value.length < 6 || value[3] !== ':') {
					bad = true;
					break;
				}
				const [sign, hours, minutes] = [value[0], value.slice(1, 3), value.slice(4, 6)];
				value = value.slice(6);
				// Go reads the minutes only when the hours read, and checks both ranges whatever it read.
				const hour = getnum(hours, true);
				const minute = hour && getnum(minutes, true);
				const [zoneHour, zoneMinute] = [hour?.[0] ?? 0, minute?.[0] ?? 0];
				if (!hour || !minute) bad = true;
				if (zoneHour > 24) range = 'time zone offset hour';
				if (zoneMinute > 60) range = 'time zone offset minute';
				time.offset = (zoneHour * 60 + zoneMinute) * 60 * (sign === '-' ? -1 : 1);
				if (sign !== '+' && sign !== '-') bad = true;
			}
		}
		if (range !== '') throw new ParseError(std, value, `: ${range} out of range`);
		if (bad) throw new ParseError(std, hold);
	}
	if (time.day < 1 || time.day > daysIn(time.month, time.year)) throw new ParseError('', value, ': day out of range');
	return time;
}

/** go-cty's parseRFC3339: a timestamp exactly as RFC 3339 writes one, or undefined. */
function parseStrict(text: string): Timestamp | undefined {
	if (text.length < 19) return undefined;
	const number = (start: number, end: number, min: number, max: number): number | undefined => {
		const digits = text.slice(start, end);
		if (!/^\d+$/u.test(digits)) return undefined;
		const parsed = Number(digits);
		return parsed < min || parsed > max ? undefined : parsed;
	};
	const year = number(0, 4, 0, 9999);
	const month = number(5, 7, 1, 12);
	const day = year === undefined || month === undefined ? undefined : number(8, 10, 1, daysIn(month, year));
	const hour = number(11, 13, 0, 23);
	const minute = number(14, 16, 0, 59);
	const second = number(17, 19, 0, 59);
	if ([year, month, day, hour, minute, second].includes(undefined)) return undefined;
	if (text[4] !== '-' || text[7] !== '-' || text[10] !== 'T' || text[13] !== ':' || text[16] !== ':') return undefined;
	let rest = text.slice(19);
	let nanosecond = 0;
	if (rest.length >= 2 && rest[0] === '.' && isDigit(rest, 1)) {
		let length = 2;
		while (isDigit(rest, length)) length++;
		nanosecond = parseNanoseconds(rest, length);
		rest = rest.slice(length);
	}
	let offset = 0;
	if (rest !== 'Z') {
		if (rest.length !== 6) return undefined;
		const zoneHour = /^\d{2}$/u.test(rest.slice(1, 3)) ? Number(rest.slice(1, 3)) : 99;
		const zoneMinute = /^\d{2}$/u.test(rest.slice(4, 6)) ? Number(rest.slice(4, 6)) : 99;
		if (zoneHour > 23 || zoneMinute > 59 || (rest[0] !== '-' && rest[0] !== '+') || rest[3] !== ':') return undefined;
		offset = (zoneHour * 60 + zoneMinute) * 60 * (rest[0] === '-' ? -1 : 1);
	}
	return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second!, nanosecond, offset };
}

/** go-cty's parseStrictRFC3339: the strict parser, with Go's parser and its own checks saying why it refused. */
function parseStrictRFC3339(text: string): Timestamp {
	const parsed = parseStrict(text);
	if (parsed) return parsed;
	parseLayout(text);
	const twoDigits = (from: string): number => Number(from[0]) * 10 + Number(from[1]);
	if (text[12] === ':') throw new ParseError('15', text.slice(11, 12), ': hour must have two digits');
	if (text[19] === ',') throw new ParseError('.', ',', ': sub-second separator must be a period');
	if (!text.endsWith('Z')) {
		if (twoDigits(text.slice(-5)) >= 24) throw new ParseError('Z07:00', text.slice(-6), ': timezone hour out of range');
		if (twoDigits(text.slice(-2)) >= 60) throw new ParseError('Z07:00', text.slice(-6), ': timezone minute out of range');
		// go-cty falls through here with the zero time its strict parser left.
		return { year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0, nanosecond: 0, offset: 0 };
	}
	throw new ParseError(RFC3339, text);
}

/** Go's time.quote, as ParseError.Error writes a value. */
function timeQuote(bytes: string): string {
	let quoted = '"';
	for (const character of Buffer.from(bytes, 'latin1').toString('utf8')) {
		const code = character.codePointAt(0)!;
		if (code >= 0x80 || code < 0x20) {
			for (const byte of Buffer.from(character, 'utf8')) quoted += `\\x${byte.toString(16).padStart(2, '0')}`;
		} else {
			quoted += character === '"' || character === '\\' ? `\\${character}` : character;
		}
	}
	return `${quoted}"`;
}

const SEGMENTS: Record<string, string> = { 2006: 'year', '01': 'month', '02': 'day of month', 15: 'hour', '04': 'minute', '05': 'second', 'Z07:00': 'UTC offset' };

/**
 * What go-cty's parseTimestamp (strict) or OpenTofu's (not) says of a timestamp Go's parser refused.
 *
 * @param input the timestamp, one character per byte.
 */
function refusal(error: ParseError, input: string, strict: boolean): string {
	const text = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');
	const prefix = 'not a valid RFC3339 timestamp';
	if (error.layoutElem === '' && error.valueElem === '' && error.message !== '') {
		return strict ? `${prefix}${error.message}` : `${prefix}: parsing time ${timeQuote(input)}${error.message}`;
	}
	if (error.layoutElem === 'T') return `${prefix}: missing required time introducer 'T'`;
	if (error.layoutElem === ':' || error.layoutElem === '-') {
		return error.valueElem === ''
			? `${prefix}: end of string where ${goQuoted(error.layoutElem)} is expected`
			: `${prefix}: found ${goQuoted(text(error.valueElem))} where ${goQuoted(error.layoutElem)} is expected`;
	}
	const what = SEGMENTS[error.layoutElem] ?? 'timestamp segment';
	if (error.valueElem === '') return `${prefix}: end of string before ${what}`;
	if (strict && what === 'hour' && error.valueElem.includes(':')) return `${prefix}: hour must be between 0 and 23 inclusive`;
	if (strict && what === 'hour' && error.valueElem.length !== 2) return `${prefix}: hour must have exactly two digits`;
	if (strict && what === 'minute' && error.valueElem.length !== 2) return `${prefix}: minute must have exactly two digits`;
	return `${prefix}: cannot use ${goQuoted(text(error.valueElem))} as ${what}`;
}

/**
 * Reads an RFC 3339 timestamp.
 *
 * @param text the timestamp.
 * @param strict go-cty's strict reading, as formatdate reads; else Go's time.Parse, as OpenTofu's timecmp reads.
 * @throws Error in go-cty's or OpenTofu's words for a timestamp it refuses.
 */
export function parseTimestamp(text: string, strict: boolean): Timestamp {
	const bytes = Buffer.from(text, 'utf8').toString('latin1');
	try {
		return strict ? parseStrictRFC3339(bytes) : parseLayout(bytes);
	} catch (error) {
		if (!(error instanceof ParseError)) throw error;
		throw new Error(refusal(error, bytes, strict));
	}
}

/** The instant a timestamp names, in nanoseconds since 1970 UTC. */
export function instant(time: Timestamp): bigint {
	// Days since 1970-01-01 of the civil date (Howard Hinnant's days_from_civil).
	const year = time.month <= 2 ? time.year - 1 : time.year;
	const era = Math.floor(year / 400);
	const yearOfEra = year - era * 400;
	const dayOfYear = Math.floor((153 * (time.month + (time.month > 2 ? -3 : 9)) + 2) / 5) + time.day - 1;
	const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
	const days = era * 146097 + dayOfEra - 719468;
	const seconds = BigInt(days) * 86400n + BigInt(time.hour * 3600 + time.minute * 60 + time.second - time.offset);
	return seconds * 1_000_000_000n + BigInt(time.nanosecond);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isVerb = (character: string | undefined): boolean => character !== undefined && /^[a-zA-Z]$/u.test(character);

/** go-cty's splitDateFormat: a format's quoted literals, runs of one verb letter, and other literal text. */
function dateFormatTokens(format: string): string[] {
	const tokens: string[] = [];
	let at = 0;
	while (at < format.length) {
		let end = at + 1;
		if (format[at] === "'") {
			if (format[at + 1] === "'") {
				end = at + 2;
			} else {
				end = format.length;
				for (let index = at + 1; index < format.length; index++) {
					if (format[index] !== "'") continue;
					if (format[index + 1] === "'") {
						index++;
						continue;
					}
					end = index + 1;
					break;
				}
			}
		} else if (isVerb(format[at])) {
			while (format[end] === format[at]) end++;
		} else {
			while (end < format.length && format[end] !== "'" && !isVerb(format[end])) end++;
		}
		tokens.push(format.slice(at, end));
		at = end;
	}
	return tokens;
}

/** Go's Time.Format of a zone offset: "-0700", "-07:00", or "Z07:00", which writes UTC as "Z". */
function zone(offset: number, colon: boolean, utcAsZ: boolean): string {
	if (utcAsZ && offset === 0) return 'Z';
	const minutes = Math.abs(offset) / 60;
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}${colon ? ':' : ''}${pad(minutes % 60)}`;
}

/**
 * go-cty's formatdate: the timestamp, read strictly, written by the format's verbs in its own zone.
 *
 * @throws ArgumentError on the time for a timestamp go-cty refuses, and on the format for a verb it does not know or a
 *   literal left open.
 */
export function formatDate(format: string, timeText: string): string {
	let time: Timestamp;
	try {
		time = parseTimestamp(timeText, true);
	} catch (error) {
		throw new ArgumentError(1, (error as Error).message);
	}
	const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
	const weekday = Number(((instant({ ...time, hour: 0, minute: 0, second: 0, nanosecond: 0, offset: 0 }) / 86_400_000_000_000n) % 7n + 11n) % 7n);
	let output = '';
	for (const token of dateFormatTokens(format)) {
		const length = token.length;
		const invalid = (why: string): ArgumentError => new ArgumentError(0, `invalid date format verb ${goQuoted(token)}: ${why}`);
		if (token[0] === "'") {
			if (token.at(-1) !== "'" || length === 1) throw new ArgumentError(0, "unterminated literal '");
			if (length === 2) {
				output += "'";
				continue;
			}
			const raw = token.slice(1, -1);
			for (let index = 0; index < raw.length; index++) {
				output += raw[index];
				if (raw[index] === "'") index++;
			}
			continue;
		}
		if (!isVerb(token[0])) {
			output += token;
			continue;
		}
		const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
		switch (token[0]) {
			case 'Y':
				if (length === 2) output += pad(time.year % 100);
				else if (length === 4) output += pad(time.year, 4);
				else throw invalid('year must either be "YY" or "YYYY"');
				break;
			case 'M':
				if (length > 4) throw invalid('month must be "M", "MM", "MMM", or "MMMM"');
				output += [String(time.month), pad(time.month), MONTHS[time.month - 1].slice(0, 3), MONTHS[time.month - 1]][length - 1];
				break;
			case 'D':
				if (length > 2) throw invalid('day of month must either be "D" or "DD"');
				output += length === 1 ? String(time.day) : pad(time.day);
				break;
			case 'E':
				if (length !== 3 && length !== 4) throw invalid('day of week must either be "EEE" or "EEEE"');
				output += length === 3 ? WEEKDAYS[weekday].slice(0, 3) : WEEKDAYS[weekday];
				break;
			case 'h':
				if (length > 2) throw invalid('24-hour must either be "h" or "hh"');
				output += length === 1 ? String(time.hour) : pad(time.hour);
				break;
			case 'H':
				if (length > 2) throw invalid('12-hour must either be "H" or "HH"');
				output += length === 1 ? String(hour12) : pad(hour12);
				break;
			case 'A':
			case 'a':
				if (length !== 2) throw invalid(`must be "${token[0]}${token[0]}"`);
				output += token[0] === 'A' ? (time.hour < 12 ? 'AM' : 'PM') : (time.hour < 12 ? 'am' : 'pm');
				break;
			case 'm':
				if (length > 2) throw invalid('minute must either be "m" or "mm"');
				output += length === 1 ? String(time.minute) : pad(time.minute);
				break;
			case 's':
				if (length > 2) throw invalid('second must either be "s" or "ss"');
				output += length === 1 ? String(time.second) : pad(time.second);
				break;
			case 'Z':
				if (length === 1) output += zone(time.offset, true, true);
				else if (length === 3) output += time.offset === 0 ? 'UTC' : zone(time.offset, false, false);
				else if (length === 4) output += zone(time.offset, false, false);
				else if (length === 5) output += zone(time.offset, true, false);
				else throw invalid('timezone must be Z, ZZZZ, or ZZZZZ');
				break;
			default:
				throw new ArgumentError(0, `invalid date format verb ${goQuoted(token)}`);
		}
	}
	return output;
}
