import { ianaEncodingAliases } from './iana-encodings';

/*
 * The character encodings of OpenTofu's textencodebase64 and textdecodebase64, as Terragrunt v1.2.2 vendors them: an
 * encoding named as golang.org/x/text's ianaindex.IANA names it, encoded and decoded as x/text does.
 */

const aliases = new Map(ianaEncodingAliases);

/** Go's strings.TrimSpace: the text without the Unicode white space around it. */
const trimSpace = (text: string): string => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

/**
 * The IANA name of the encoding a name resolves to, as ianaindex.IANA.Encoding resolves it: the name without the space
 * around it, as written, else lower-cased.
 *
 * @returns the encoding's IANA name, or undefined when x/text has no encoding by that name.
 */
export function ianaEncoding(name: string): string | undefined {
	const trimmed = trimSpace(name);
	return aliases.get(trimmed) ?? aliases.get(trimmed.toLowerCase());
}

/** An encoding as x/text implements it: text to bytes, undefined for text it cannot represent, and bytes to text. */
interface TextEncoding {
	encode(text: string): Buffer | undefined;
	/** The text, a byte sequence the encoding does not define given as U+FFFD, as x/text's decoders give it. */
	decode(bytes: Buffer): string;
}

/** x/text's UTF-16 decoder: by the byte order given, or the one a leading mark states when the encoding reads one. */
function decodeUtf16(bytes: Buffer, bigEndian: boolean, readsMark: boolean): string {
	let at = 0;
	let big = bigEndian;
	if (readsMark && bytes.length >= 2) {
		if (bytes[0] === 0xfe && bytes[1] === 0xff) {
			big = true;
			at = 2;
		} else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
			big = false;
			at = 2;
		}
	}
	const unit = (index: number): number => (big ? (bytes[index] << 8) | bytes[index + 1] : (bytes[index + 1] << 8) | bytes[index]);
	let text = '';
	while (at < bytes.length) {
		if (at + 1 === bytes.length) {
			text += '�';
			break;
		}
		const first = unit(at);
		if (first >= 0xd800 && first <= 0xdbff && at + 3 < bytes.length) {
			const second = unit(at + 2);
			if (second >= 0xdc00 && second <= 0xdfff) {
				text += String.fromCharCode(first, second);
				at += 4;
				continue;
			}
		}
		text += first >= 0xd800 && first <= 0xdfff ? '�' : String.fromCharCode(first);
		at += 2;
	}
	return text;
}

function encodeUtf16(text: string, bigEndian: boolean, writesMark: boolean): Buffer {
	const little = Buffer.from(text, 'utf16le');
	const ordered = bigEndian ? Buffer.from(little).swap16() : little;
	return writesMark ? Buffer.concat([Buffer.from([0xfe, 0xff]), ordered]) : ordered;
}

/** A single-byte encoding whose bytes are the first code points: US-ASCII up to 0x7f, ISO 8859-1 up to 0xff. */
function firstCodePoints(last: number): TextEncoding {
	return {
		encode: text => {
			const codes = [...text].map(character => character.codePointAt(0)!);
			return codes.every(code => code <= last) ? Buffer.from(codes) : undefined;
		},
		decode: bytes => String.fromCharCode(...[...bytes].map(byte => (byte <= last ? byte : 0xfffd)))
	};
}

const implemented = new Map<string, TextEncoding>([
	['UTF-8', { encode: text => Buffer.from(text, 'utf8'), decode: bytes => bytes.toString('utf8') }],
	['UTF-16', { encode: text => encodeUtf16(text, true, true), decode: bytes => decodeUtf16(bytes, true, true) }],
	['UTF-16BE', { encode: text => encodeUtf16(text, true, false), decode: bytes => decodeUtf16(bytes, true, false) }],
	['UTF-16LE', { encode: text => encodeUtf16(text, false, false), decode: bytes => decodeUtf16(bytes, false, false) }],
	['US-ASCII', firstCodePoints(0x7f)],
	['ISO_8859-1:1987', firstCodePoints(0xff)]
]);

/**
 * The implementation of an encoding x/text has, by its IANA name.
 *
 * @throws Error naming the encoding when tghclparser does not implement it.
 */
export function textEncoding(name: string): TextEncoding {
	const encoding = implemented.get(name);
	if (!encoding) throw new Error(`tghclparser does not implement the ${name} encoding`);
	return encoding;
}
