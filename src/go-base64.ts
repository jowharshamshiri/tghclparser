/*
 * Go's encoding/base64 StdEncoding decoder, as Terragrunt v1.2.2's functions decode with it: padded standard base64,
 * where a line break is skipped wherever it falls, and the first byte it cannot take refused by its offset.
 */

/** Go's base64.CorruptInputError: the offset of the byte of the input that could not be decoded. */
export class CorruptInputError extends Error {
	constructor(readonly offset: number) {
		super(`illegal base64 data at input byte ${offset}`);
		this.name = 'CorruptInputError';
	}
}

const PAD = 0x3d;
const isLineBreak = (byte: number): boolean => byte === 0x0a || byte === 0x0d;

const decodeMap = new Uint8Array(256).fill(0xff);
for (const [index, character] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].entries()) {
	decodeMap[character.charCodeAt(0)] = index;
}

/**
 * Decodes text as Go's base64.StdEncoding.DecodeString does, quantum by quantum (decodeQuantum).
 *
 * @param text the text, decoded from its UTF-8 bytes.
 * @returns the bytes it holds.
 * @throws CorruptInputError at the offset Go reports, for a byte outside the alphabet, padding out of place, missing
 *   padding, or anything after the padding.
 */
export function decodeStdBase64(text: string): Buffer {
	const source = Buffer.from(text, 'utf8');
	const output: number[] = [];
	let at = 0;
	while (at < source.length) {
		const quantum = [0, 0, 0, 0];
		let length = 4;
		let trailing: CorruptInputError | undefined;
		for (let index = 0; index < 4; index++) {
			if (at === source.length) {
				if (index === 0) return Buffer.from(output);
				throw new CorruptInputError(at - index);
			}
			const byte = source[at++];
			if (decodeMap[byte] !== 0xff) {
				quantum[index] = decodeMap[byte];
				continue;
			}
			if (isLineBreak(byte)) {
				index--;
				continue;
			}
			if (byte !== PAD || index < 2) throw new CorruptInputError(at - 1);
			if (index === 2) {
				while (at < source.length && isLineBreak(source[at])) at++;
				if (at === source.length) throw new CorruptInputError(source.length);
				if (source[at] !== PAD) throw new CorruptInputError(at - 1);
				at++;
			}
			while (at < source.length && isLineBreak(source[at])) at++;
			if (at < source.length) trailing = new CorruptInputError(at);
			length = index;
			break;
		}
		const value = (quantum[0] << 18) | (quantum[1] << 12) | (quantum[2] << 6) | quantum[3];
		output.push(...[(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].slice(0, length - 1));
		if (trailing) throw trailing;
	}
	return Buffer.from(output);
}
