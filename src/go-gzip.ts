/*
 * A TypeScript port of the gzip writer of Go 1.27's compress/gzip and the default level of its compress/flate
 * (Copyright 2009 The Go Authors, BSD-style licence), the Go Terragrunt v1.2.2 is built with.
 *
 * Terragrunt's base64gzip writes its input to that writer, flushes it and closes it, so its bytes are whatever the Go
 * compressor chooses: the level 6 match finder, whether a block is stored, Huffman coded alone, coded with matches or
 * coded with the previous block's table, and how each Huffman code is built. This follows it step for step, down to
 * the float32 arithmetic of its size estimate. Only the path the default level takes is carried. The Go encoder also
 * resets its history offsets once 2 GiB have passed through it; no JavaScript string is that long, so that is not.
 */

const maxStoreBlockSize = 65535;
const maxMatchOffset = 1 << 15;
const maxMatchLength = 258;
const baseMatchLength = 3;
const baseMatchOffset = 1;
const tableBits = 15;
const tableSize = 1 << tableBits;
const allocHistory = maxStoreBlockSize * 5;

const literalCount = 286;
const offsetCodeCount = 30;
const endBlockMarker = 256;
const lengthCodesStart = 257;
const codegenCodeCount = 19;
const badCode = 255;
const maxPredefinedTokens = 250;
const maxCodeBits = 15;
const maxCodegenBits = 7;
const maxBitsLimit = 16;
const maxInt32 = 0x7fffffff;
const maxUint16 = 0xffff;

// The default level's penalty for building a new Huffman table, as a power of two.
const logNewTablePenalty = 7;

const lengthShift = 22;
const offsetMask = (1 << lengthShift) - 1;
const matchType = 1 << 30;
const matchOffsetOnlyMask = 0xffff;
const lengthExtraBitsMinCode = 8;
const offsetExtraBitsMinCode = 4;

const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0];
const lengthBase = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 255, 0, 0, 0];
const offsetExtraBits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
// Each offset code's extra bit count, with its first offset above it.
const offsetCombined = [
	0x0, 0x0, 0x0, 0x0, 0x401, 0x601, 0x802, 0xc02, 0x1003, 0x1803, 0x2004, 0x3004, 0x4005, 0x6005, 0x8006, 0xc006,
	0x10007, 0x18007, 0x20008, 0x30008, 0x40009, 0x60009, 0x8000a, 0xc000a, 0x10000b, 0x18000b, 0x20000c, 0x30000c,
	0x40000d, 0x60000d, 0x0, 0x0
];
const codegenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// lengthCodes[length - 3] is the code of a match length; offsetCodes[offset] the code of an offset below 256.
const lengthCodes = new Uint8Array(256);
for (let code = 0; code <= 28; code++) {
	const end = code < 28 ? lengthBase[code + 1] : 256;
	for (let length = lengthBase[code]; length < end; length++) lengthCodes[length] = code;
}
const offsetCodes = new Uint8Array(256);
for (let code = 0; code < 16; code++) {
	const start = code < offsetExtraBitsMinCode ? code : offsetCombined[code] >>> 8;
	offsetCodes.fill(code, start);
}

function offsetCode(offset: number): number {
	if (offset < 256) return offsetCodes[offset];
	return offsetCodes[(offset >>> 7) & 0xff] + 14;
}

// A Huffman code is its bits above its length: the length in the low byte. Zero is a symbol with no code.
const hcode = (bits: number, length: number): number => ((bits << 8) | length) >>> 0;
const codeLength = (code: number): number => code & 0xff;
const codeBits = (code: number): number => code >>> 8;

function reverseBits(value: number, length: number): number {
	let shifted = (value << ((16 - length) & 15)) & 0xffff;
	let reversed = 0;
	for (let bit = 0; bit < 16; bit++) {
		reversed = (reversed << 1) | (shifted & 1);
		shifted >>>= 1;
	}
	return reversed;
}

interface LiteralNode {
	literal: number;
	freq: number;
}

interface LevelInfo {
	level: number;
	lastFreq: number;
	nextCharFreq: number;
	nextPairFreq: number;
	needed: number;
}

class HuffmanEncoder {
	readonly codes: Uint32Array;

	constructor(size: number) {
		this.codes = new Uint32Array(size);
	}

	bitLength(freq: Uint16Array): number {
		let total = 0;
		for (let index = 0; index < freq.length; index++) {
			if (freq[index] !== 0) total += freq[index] * codeLength(this.codes[index]);
		}
		return total;
	}

	/** The bits freq takes in these codes, or maxInt32 when a symbol it counts has none. */
	canEncodeLen(freq: Uint16Array): number {
		let total = 0;
		for (let index = 0; index < freq.length; index++) {
			if (freq[index] === 0) continue;
			const code = this.codes[index];
			if (code === 0) return maxInt32;
			total += freq[index] * codeLength(code);
		}
		return total;
	}

	private bitCounts(list: LiteralNode[], maxBits: number): number[] {
		const n = list.length;
		list.push({ literal: maxUint16, freq: maxUint16 });
		if (maxBits > n - 1) maxBits = n - 1;

		const levels: LevelInfo[] = Array.from({ length: maxBitsLimit + 1 }, () => ({ level: 0, lastFreq: 0, nextCharFreq: 0, nextPairFreq: 0, needed: 0 }));
		const leafCounts: number[][] = Array.from({ length: maxBitsLimit }, () => new Array<number>(maxBitsLimit).fill(0));

		for (let level = 1; level <= maxBits; level++) {
			levels[level] = {
				level,
				lastFreq: list[1].freq,
				nextCharFreq: list[2].freq,
				nextPairFreq: level === 1 ? maxInt32 : list[0].freq + list[1].freq,
				needed: 0
			};
			leafCounts[level][level] = 2;
		}
		levels[maxBits].needed = 2 * n - 4;

		let level = maxBits;
		while (level < 16) {
			const current = levels[level];
			if (current.nextPairFreq === maxInt32 && current.nextCharFreq === maxInt32) {
				current.needed = 0;
				levels[level + 1].nextPairFreq = maxInt32;
				level++;
				continue;
			}

			const prevFreq = current.lastFreq;
			if (current.nextCharFreq < current.nextPairFreq) {
				const count = leafCounts[level][level] + 1;
				current.lastFreq = current.nextCharFreq;
				leafCounts[level][level] = count;
				const node = list[count];
				current.nextCharFreq = node.literal < maxUint16 ? node.freq : maxInt32;
			} else {
				current.lastFreq = current.nextPairFreq;
				const save = leafCounts[level][level];
				leafCounts[level] = leafCounts[level - 1].slice();
				leafCounts[level][level] = save;
				levels[current.level - 1].needed = 2;
			}

			current.needed--;
			if (current.needed === 0) {
				if (current.level === maxBits) break;
				levels[current.level + 1].nextPairFreq = prevFreq + current.lastFreq;
				level++;
			} else {
				while (levels[level - 1].needed > 0) level--;
			}
		}

		if (leafCounts[maxBits][maxBits] !== n) throw new Error('leafCounts[maxBits][maxBits] != n');
		list.pop();

		const bitCount = new Array<number>(maxBits + 1).fill(0);
		let bits = 1;
		const counts = leafCounts[maxBits];
		for (let at = maxBits; at > 0; at--) {
			bitCount[bits] = counts[at] - counts[at - 1];
			bits++;
		}
		return bitCount;
	}

	private assignEncodingAndSize(bitCount: number[], list: LiteralNode[]): void {
		let code = 0;
		let remaining = list.length;
		for (let n = 0; n < bitCount.length; n++) {
			code = (code << 1) & 0xffff;
			const bits = bitCount[n];
			if (n === 0 || bits === 0) continue;
			const chunk = list.slice(remaining - bits, remaining).sort((left, right) => left.literal - right.literal);
			for (const node of chunk) {
				this.codes[node.literal] = hcode(reverseBits(code, n), n);
				code = (code + 1) & 0xffff;
			}
			remaining -= bits;
		}
	}

	/** Builds the code for freq, clearing the codes of the symbols it does not count; codes past it are kept. */
	generate(freq: Uint16Array, maxBits: number): void {
		const list: LiteralNode[] = [];
		for (let index = 0; index < freq.length; index++) {
			if (freq[index] !== 0) list.push({ literal: index, freq: freq[index] });
			else this.codes[index] = 0;
		}
		if (list.length <= 2) {
			list.forEach((node, index) => {
				this.codes[node.literal] = hcode(index, 1);
			});
			return;
		}
		list.sort((left, right) => left.freq - right.freq || left.literal - right.literal);
		this.assignEncodingAndSize(this.bitCounts(list, maxBits), list);
	}
}

function fixedLiteralEncoding(): HuffmanEncoder {
	const encoder = new HuffmanEncoder(literalCount);
	for (let ch = 0; ch < literalCount; ch++) {
		let bits: number;
		let size: number;
		if (ch < 144) {
			bits = ch + 48;
			size = 8;
		} else if (ch < 256) {
			bits = ch + 400 - 144;
			size = 9;
		} else if (ch < 280) {
			bits = ch - 256;
			size = 7;
		} else {
			bits = ch + 192 - 280;
			size = 8;
		}
		encoder.codes[ch] = hcode(reverseBits(bits, size), size);
	}
	return encoder;
}

function fixedOffsetEncoding(): HuffmanEncoder {
	const encoder = new HuffmanEncoder(offsetCodeCount);
	for (let ch = 0; ch < offsetCodeCount; ch++) encoder.codes[ch] = hcode(reverseBits(ch, 5), 5);
	return encoder;
}

const fixedLiterals = fixedLiteralEncoding();
const fixedOffsets = fixedOffsetEncoding();

// The offset code a literal-only block declares, which no symbol uses.
const huffOffset = (() => {
	const freq = new Uint16Array(offsetCodeCount);
	freq[0] = 1;
	const encoder = new HuffmanEncoder(offsetCodeCount);
	encoder.generate(freq, maxCodeBits);
	return encoder;
})();

// Go computes the size estimate in float32; every step here is rounded to float32 as it is there.
const float32 = Math.fround;
const log2Bits = new DataView(new ArrayBuffer(4));
const log2Square = float32(-0.34484843);
const log2Linear = float32(2.02466578);
const log2Constant = float32(0.67487759);

/** Go's mFastLog2: an approximation of log2(value), from its float32 bits. */
function fastLog2(value: number): number {
	log2Bits.setFloat32(0, value);
	let bits = log2Bits.getInt32(0);
	const exponent = ((bits >> 23) & 255) - 128;
	bits &= -0x7f800001;
	bits = (bits + (127 << 23)) | 0;
	log2Bits.setInt32(0, bits);
	const mantissa = log2Bits.getFloat32(0);
	return float32(exponent + float32(float32(float32(float32(log2Square * mantissa) + log2Linear) * mantissa) - log2Constant));
}

/** A block's tokens, with the histograms of their symbols kept as they are added. */
class Tokens {
	readonly litHist = new Uint16Array(256);
	readonly extraHist = new Uint16Array(32);
	readonly offHist = new Uint16Array(32);
	readonly tokens = new Uint32Array(maxStoreBlockSize + 1);
	n = 0;

	reset(): void {
		if (this.n === 0) return;
		this.n = 0;
		this.litHist.fill(0);
		this.extraHist.fill(0);
		this.offHist.fill(0);
	}

	addLiteral(literal: number): void {
		this.tokens[this.n++] = literal;
		this.litHist[literal]++;
	}

	/** Adds a match of length bytes, split into matches of at most 258; offset is less baseMatchOffset. */
	addMatchLong(length: number, offset: number): void {
		const code = offsetCode(offset);
		const xoffset = offset | (code << 16);
		while (length > 0) {
			let xl = length;
			if (xl > maxMatchLength) xl = xl > maxMatchLength + baseMatchLength ? maxMatchLength : maxMatchLength - baseMatchLength;
			length -= xl;
			xl -= baseMatchLength;
			this.extraHist[lengthCodes[xl] + 1]++;
			this.offHist[code & 31]++;
			this.tokens[this.n++] = (matchType | (xl << lengthShift) | xoffset) >>> 0;
		}
	}

	addEOB(): void {
		this.tokens[this.n++] = endBlockMarker;
		this.extraHist[0]++;
	}

	/** An estimate of the fewest bits the tokens could be coded in, at least one and at most 15 a symbol. */
	estimatedBits(): number {
		let shannon = 0;
		let bits = 0;
		let nMatches = 0;
		const total = this.n;
		const add = (count: number, invTotal: number) => {
			const n = float32(count);
			shannon = float32(shannon + float32(Math.min(15, Math.max(1, -fastLog2(float32(n * invTotal)))) * n));
		};
		if (total > 0) {
			const invTotal = float32(1 / total);
			for (const count of this.litHist) {
				if (count > 0) add(count, invTotal);
			}
			shannon = float32(shannon + 15);
			for (let index = 0; index < literalCount - 257; index++) {
				const count = this.extraHist[index + 1];
				if (count === 0) continue;
				add(count, invTotal);
				bits += lengthExtraBits[index] * count;
				nMatches += count;
			}
		}
		if (nMatches > 0) {
			const invTotal = float32(1 / nMatches);
			for (let index = 0; index < offsetCodeCount; index++) {
				const count = this.offHist[index];
				if (count === 0) continue;
				add(count, invTotal);
				bits += offsetExtraBits[index] * count;
			}
		}
		return Math.trunc(shannon) + bits;
	}
}

/** Bytes written, in a buffer that grows as they come. */
class ByteSink {
	private buffer = new Uint8Array(1024);
	private length = 0;

	private reserve(count: number): void {
		if (this.length + count <= this.buffer.length) return;
		let size = this.buffer.length * 2;
		while (size < this.length + count) size *= 2;
		const grown = new Uint8Array(size);
		grown.set(this.buffer.subarray(0, this.length));
		this.buffer = grown;
	}

	push(byte: number): void {
		this.reserve(1);
		this.buffer[this.length++] = byte;
	}

	append(bytes: Uint8Array): void {
		this.reserve(bytes.length);
		this.buffer.set(bytes, this.length);
		this.length += bytes.length;
	}

	bytes(): Uint8Array {
		return this.buffer.slice(0, this.length);
	}
}

/**
 * The Go writer of DEFLATE blocks. It gathers bits least significant first and writes whole bytes; a flush pads the
 * last byte with zeros. A block coded with a dynamic table and not flushed leaves its end-of-block code owed, so the
 * next block can carry on with the same table.
 */
class HuffmanBitWriter {
	private readonly out = new ByteSink();
	private bits = 0;
	private nbits = 0;

	// Set while the table in literalEncoding was built for literals alone, and its offsets are not usable.
	private wroteHuffman = false;
	private literalEncoding = new HuffmanEncoder(literalCount);
	private tmpLitEncoding = new HuffmanEncoder(literalCount);
	private readonly offsetEncoding = new HuffmanEncoder(offsetCodeCount);
	private readonly codegenEncoding = new HuffmanEncoder(codegenCodeCount);
	// The size of the current table's header while its block is open, so its end-of-block code is owed; else 0.
	private prevHeader = 0;
	private readonly literalFreq = new Uint16Array(lengthCodesStart + 32);
	private readonly offsetFreq = new Uint16Array(32);
	private readonly codegenFreq = new Uint16Array(codegenCodeCount);
	private readonly codegen = new Uint8Array(literalCount + offsetCodeCount + 1);

	bytes(): Uint8Array {
		return this.out.bytes();
	}

	private writeBits(value: number, count: number): void {
		this.bits |= value << this.nbits;
		this.nbits += count;
		while (this.nbits >= 8) {
			this.out.push(this.bits & 0xff);
			this.bits >>>= 8;
			this.nbits -= 8;
		}
	}

	private writeCode(code: number): void {
		this.writeBits(codeBits(code), codeLength(code));
	}

	/** Writes the end-of-block code owed, if any, then pads to a whole byte. */
	flush(): void {
		if (this.prevHeader > 0) {
			this.writeCode(this.literalEncoding.codes[endBlockMarker]);
			this.prevHeader = 0;
		}
		if (this.nbits > 0) this.out.push(this.bits & 0xff);
		this.bits = 0;
		this.nbits = 0;
	}

	writeBytes(bytes: Uint8Array): void {
		if (this.nbits !== 0) throw new Error('writeBytes with unfinished bits');
		this.out.append(bytes);
	}

	private canReuse(tokens: Tokens): boolean {
		for (let index = 0; index < offsetCodeCount; index++) {
			if (tokens.offHist[index] !== 0 && this.offsetEncoding.codes[index] === 0) return false;
		}
		for (let index = 0; index < literalCount - 256; index++) {
			if (tokens.extraHist[index] !== 0 && this.literalEncoding.codes[256 + index] === 0) return false;
		}
		for (let index = 0; index < 256; index++) {
			if (tokens.litHist[index] !== 0 && this.literalEncoding.codes[index] === 0) return false;
		}
		return true;
	}

	/** The run-length coding of the literal and offset code lengths a dynamic header carries, and its histogram. */
	private generateCodegen(numLiterals: number, numOffsets: number, literals: HuffmanEncoder, offsets: HuffmanEncoder): void {
		this.codegenFreq.fill(0);
		const codegen = this.codegen;
		for (let index = 0; index < numLiterals; index++) codegen[index] = codeLength(literals.codes[index]);
		for (let index = 0; index < numOffsets; index++) codegen[numLiterals + index] = codeLength(offsets.codes[index]);
		codegen[numLiterals + numOffsets] = badCode;

		let size = codegen[0];
		let count = 1;
		let outIndex = 0;
		for (let inIndex = 1; size !== badCode; inIndex++) {
			const nextSize = codegen[inIndex];
			if (nextSize === size) {
				count++;
				continue;
			}
			if (size !== 0) {
				codegen[outIndex++] = size;
				this.codegenFreq[size]++;
				count--;
				while (count >= 3) {
					const n = Math.min(6, count);
					codegen[outIndex++] = 16;
					codegen[outIndex++] = n - 3;
					this.codegenFreq[16]++;
					count -= n;
				}
			} else {
				while (count >= 11) {
					const n = Math.min(138, count);
					codegen[outIndex++] = 18;
					codegen[outIndex++] = n - 11;
					this.codegenFreq[18]++;
					count -= n;
				}
				if (count >= 3) {
					codegen[outIndex++] = 17;
					codegen[outIndex++] = count - 3;
					this.codegenFreq[17]++;
					count = 0;
				}
			}
			count--;
			for (; count >= 0; count--) {
				codegen[outIndex++] = size;
				this.codegenFreq[size]++;
			}
			size = nextSize;
			count = 1;
		}
		codegen[outIndex] = badCode;
	}

	private codegens(): number {
		let numCodegens = this.codegenFreq.length;
		while (numCodegens > 4 && this.codegenFreq[codegenOrder[numCodegens - 1]] === 0) numCodegens--;
		return numCodegens;
	}

	private headerSize(): { size: number; numCodegens: number } {
		const numCodegens = this.codegens();
		const size = 3 + 5 + 5 + 4 + 3 * numCodegens
			+ this.codegenEncoding.bitLength(this.codegenFreq)
			+ this.codegenFreq[16] * 2
			+ this.codegenFreq[17] * 3
			+ this.codegenFreq[18] * 7;
		return { size, numCodegens };
	}

	private dynamicReuseSize(): number {
		return this.literalEncoding.bitLength(this.literalFreq) + this.offsetEncoding.bitLength(this.offsetFreq);
	}

	private dynamicSize(extraBits: number): { size: number; numCodegens: number } {
		const header = this.headerSize();
		return { size: header.size + this.dynamicReuseSize() + extraBits, numCodegens: header.numCodegens };
	}

	private extraBitSize(): number {
		let total = 0;
		for (let index = 0; index < literalCount - lengthCodesStart; index++) total += this.literalFreq[lengthCodesStart + index] * lengthExtraBits[index];
		for (let index = 0; index < offsetCodeCount; index++) total += this.offsetFreq[index] * offsetExtraBits[index];
		return total;
	}

	private fixedSize(extraBits: number): number {
		return 3 + fixedLiterals.bitLength(this.literalFreq) + fixedOffsets.bitLength(this.offsetFreq) + extraBits;
	}

	private writeDynamicHeader(numLiterals: number, numOffsets: number, numCodegens: number, eof: boolean): void {
		this.writeBits(eof ? 5 : 4, 3);
		this.writeBits(numLiterals - 257, 5);
		this.writeBits(numOffsets - 1, 5);
		this.writeBits(numCodegens - 4, 4);
		for (let index = 0; index < numCodegens; index++) this.writeBits(codeLength(this.codegenEncoding.codes[codegenOrder[index]]), 3);

		let index = 0;
		for (;;) {
			const codeWord = this.codegen[index++];
			if (codeWord === badCode) break;
			this.writeCode(this.codegenEncoding.codes[codeWord]);
			switch (codeWord) {
				case 16:
					this.writeBits(this.codegen[index++], 2);
					break;
				case 17:
					this.writeBits(this.codegen[index++], 3);
					break;
				case 18:
					this.writeBits(this.codegen[index++], 7);
					break;
			}
		}
	}

	/** Writes a stored block's header; an empty last block is written as a fixed block instead, ten bits for five bytes. */
	writeStoredHeader(length: number, eof: boolean): void {
		if (this.prevHeader > 0) {
			this.writeCode(this.literalEncoding.codes[endBlockMarker]);
			this.prevHeader = 0;
		}
		if (length === 0 && eof) {
			this.writeFixedHeader(eof);
			this.writeBits(0, 7);
			this.flush();
			return;
		}
		this.writeBits(eof ? 1 : 0, 3);
		this.flush();
		this.writeBits(length, 16);
		this.writeBits(~length & 0xffff, 16);
	}

	private writeFixedHeader(eof: boolean): void {
		if (this.prevHeader > 0) {
			this.writeCode(this.literalEncoding.codes[endBlockMarker]);
			this.prevHeader = 0;
		}
		this.writeBits(eof ? 3 : 2, 3);
	}

	private writeStored(input: Uint8Array, eof: boolean): void {
		this.writeStoredHeader(input.length, eof);
		this.writeBytes(input);
	}

	private writeFixed(tokens: Tokens, eof: boolean, sync: boolean): void {
		this.writeFixedHeader(eof);
		if (!sync) tokens.addEOB();
		this.writeTokens(tokens, fixedLiterals.codes, fixedOffsets.codes);
	}

	/**
	 * Writes a block of tokens with a dynamic table: the previous block's while it is open and coding with it costs
	 * less than a new one, else a new one, unless fixed codes or stored bytes would be no larger. Unless sync, the block
	 * is left open.
	 */
	writeBlockDynamic(tokens: Tokens, eof: boolean, input: Uint8Array, sync: boolean): void {
		sync = sync || eof;
		if (sync) tokens.addEOB();
		else tokens.extraHist[0] = 1;

		if ((this.wroteHuffman || eof) && this.prevHeader > 0) {
			this.writeCode(this.literalEncoding.codes[endBlockMarker]);
			this.prevHeader = 0;
			this.wroteHuffman = false;
		}
		if (this.prevHeader > 0 && !this.canReuse(tokens)) {
			this.writeCode(this.literalEncoding.codes[endBlockMarker]);
			this.prevHeader = 0;
		}

		const { numLiterals, numOffsets } = this.indexTokens(tokens);
		const storable = input.length <= maxStoreBlockSize;
		const storedSize = (input.length + 5) * 8;
		const extraBits = storable || this.prevHeader > 0 ? this.extraBitSize() : 0;

		let size = 0;
		if (this.prevHeader > 0) {
			let newSize = this.prevHeader + tokens.estimatedBits();
			newSize += codeLength(this.literalEncoding.codes[endBlockMarker]) + (newSize >> logNewTablePenalty);
			const reuseSize = this.dynamicReuseSize() + extraBits;
			if (newSize < reuseSize) {
				this.writeCode(this.literalEncoding.codes[endBlockMarker]);
				size = newSize;
				this.prevHeader = 0;
			} else {
				size = reuseSize;
			}

			if (tokens.n < maxPredefinedTokens && this.fixedSize(extraBits) + 7 < size) {
				if (storable && storedSize <= size) this.writeStored(input, eof);
				else this.writeFixed(tokens, eof, sync);
				return;
			}
			if (storable && storedSize <= size) {
				this.writeStored(input, eof);
				return;
			}
		}

		if (this.prevHeader === 0) {
			this.literalFreq[endBlockMarker] = 1;
			this.generate();
			this.generateCodegen(numLiterals, numOffsets, this.literalEncoding, this.offsetEncoding);
			this.codegenEncoding.generate(this.codegenFreq, maxCodegenBits);
			const dynamic = this.dynamicSize(extraBits);
			size = dynamic.size;

			if (tokens.n < maxPredefinedTokens) {
				const fixedSize = this.fixedSize(extraBits);
				if (fixedSize <= size) {
					if (storable && storedSize <= fixedSize) this.writeStored(input, eof);
					else this.writeFixed(tokens, eof, sync);
					return;
				}
			}
			if (storable && storedSize <= size) {
				this.writeStored(input, eof);
				return;
			}

			this.writeDynamicHeader(numLiterals, numOffsets, dynamic.numCodegens, eof);
			if (!sync) this.prevHeader = this.headerSize().size;
			this.wroteHuffman = false;
		}

		if (sync) this.prevHeader = 0;
		this.writeTokens(tokens, this.literalEncoding.codes, this.offsetEncoding.codes);
	}

	private indexTokens(tokens: Tokens): { numLiterals: number; numOffsets: number } {
		this.literalFreq.set(tokens.litHist, 0);
		this.literalFreq.set(tokens.extraHist, 256);
		this.offsetFreq.set(tokens.offHist);
		if (tokens.n === 0) return { numLiterals: 0, numOffsets: 0 };

		let numLiterals = this.literalFreq.length;
		while (this.literalFreq[numLiterals - 1] === 0) numLiterals--;
		let numOffsets = this.offsetFreq.length;
		while (numOffsets > 0 && this.offsetFreq[numOffsets - 1] === 0) numOffsets--;
		if (numOffsets === 0) {
			// A dynamic table must declare at least one offset code.
			this.offsetFreq[0] = 1;
			numOffsets = 1;
		}
		return { numLiterals, numOffsets };
	}

	private generate(): void {
		this.literalEncoding.generate(this.literalFreq.subarray(0, literalCount), maxCodeBits);
		this.offsetEncoding.generate(this.offsetFreq.subarray(0, offsetCodeCount), maxCodeBits);
	}

	private writeTokens(tokens: Tokens, literalCodes: Uint32Array, offsetCodesUsed: Uint32Array): void {
		let count = tokens.n;
		if (count === 0) return;
		const deferEOB = tokens.tokens[count - 1] === endBlockMarker;
		if (deferEOB) count--;

		for (let index = 0; index < count; index++) {
			const token = tokens.tokens[index];
			if (token < 256) {
				this.writeCode(literalCodes[token]);
				continue;
			}
			const length = (token >>> lengthShift) & 0xff;
			const lengthCode = lengthCodes[length] & 31;
			this.writeCode(literalCodes[lengthCodesStart + lengthCode]);
			if (lengthCode >= lengthExtraBitsMinCode) this.writeBits(length - lengthBase[lengthCode], lengthExtraBits[lengthCode]);
			const offset = token & offsetMask;
			const code = (offset >>> 16) & 31;
			this.writeCode(offsetCodesUsed[code]);
			if (code >= offsetExtraBitsMinCode) {
				const combined = offsetCombined[code];
				this.writeBits((offset - (combined >>> 8)) & matchOffsetOnlyMask, combined & 0xff);
			}
		}
		if (deferEOB) this.writeCode(literalCodes[endBlockMarker]);
	}

	/**
	 * Writes input as literals alone, with the open literal table when that costs no more than a new one, or stored
	 * when coding would not save enough. Unless sync or eof, the block is left open.
	 */
	writeBlockHuff(eof: boolean, input: Uint8Array, sync: boolean): void {
		this.literalFreq.fill(0);
		if (!this.wroteHuffman) this.offsetFreq.fill(0);

		const numLiterals = endBlockMarker + 1;
		const numOffsets = 1;
		// About 70 bytes; see https://stackoverflow.com/a/25454430.
		const guessHeaderSizeBits = 70 * 8;
		for (const byte of input) this.literalFreq[byte]++;
		const storable = input.length <= maxStoreBlockSize;
		const storedSize = (input.length + 5) * 8;
		if (storable && input.length > 1024) {
			// Input whose byte counts all lie close to the average will not compress: store it.
			let abs = 0;
			const avg = input.length / 256;
			const max = input.length * 2;
			for (let index = 0; index < 256; index++) {
				const diff = this.literalFreq[index] - avg;
				abs += diff * diff;
				if (abs >= max) break;
			}
			if (abs < max) {
				this.writeStored(input, eof);
				return;
			}
		}
		this.literalFreq[endBlockMarker] = 1;
		const literalFreq = this.literalFreq.subarray(0, numLiterals);
		this.tmpLitEncoding.generate(literalFreq, maxCodeBits);
		let estBits = this.tmpLitEncoding.canEncodeLen(literalFreq);
		if (estBits < maxInt32) {
			estBits += this.prevHeader;
			if (this.prevHeader === 0) estBits += guessHeaderSizeBits;
			estBits += estBits >> logNewTablePenalty;
		}

		if (storable && storedSize <= estBits) {
			this.writeStored(input, eof);
			return;
		}

		if (this.prevHeader > 0) {
			const reuseSize = this.literalEncoding.canEncodeLen(this.literalFreq.subarray(0, 256));
			if (estBits < reuseSize) {
				this.writeCode(this.literalEncoding.codes[endBlockMarker]);
				this.prevHeader = 0;
			}
		}

		if (this.prevHeader === 0) {
			[this.literalEncoding, this.tmpLitEncoding] = [this.tmpLitEncoding, this.literalEncoding];
			this.generateCodegen(numLiterals, numOffsets, this.literalEncoding, huffOffset);
			this.codegenEncoding.generate(this.codegenFreq, maxCodegenBits);
			this.writeDynamicHeader(numLiterals, numOffsets, this.codegens(), eof);
			this.wroteHuffman = true;
			this.prevHeader = this.headerSize().size;
		}

		const codes = this.literalEncoding.codes;
		for (const byte of input) this.writeCode(codes[byte]);

		if (eof || sync) {
			this.writeCode(codes[endBlockMarker]);
			this.prevHeader = 0;
			this.wroteHuffman = false;
		}
	}
}

const prime4bytes = 0x9e3779b1;
// The 64-bit prime of Go's 7-byte hash, 58295818150454627, in its two halves.
const prime7High = 0x00cf1bbc;
const prime7Low = 0xdcbfa563;

const load32 = (src: Uint8Array, at: number): number => (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;

/** Go's hashLen of 4 bytes into tableBits bits. */
const hash4 = (src: Uint8Array, at: number): number => Math.imul(load32(src, at), prime4bytes) >>> (32 - tableBits);

/** The high 32 bits of the 64-bit product of two unsigned 32-bit numbers. */
function multiplyHigh(left: number, right: number): number {
	const leftLow = left & 0xffff;
	const leftHigh = left >>> 16;
	const rightLow = right & 0xffff;
	const rightHigh = right >>> 16;
	const lowLow = leftLow * rightLow;
	const lowHigh = leftLow * rightHigh;
	const highLow = leftHigh * rightLow;
	const middle = (lowLow >>> 16) + (lowHigh & 0xffff) + (highLow & 0xffff);
	return (leftHigh * rightHigh + (lowHigh >>> 16) + (highLow >>> 16) + Math.floor(middle / 0x10000)) >>> 0;
}

/** Go's hashLen of 7 bytes into tableBits bits: the top bits of the 64-bit product of the bytes, shifted up a byte, and a prime. */
function hash7(src: Uint8Array, at: number): number {
	const low = ((src[at] << 8) | (src[at + 1] << 16) | (src[at + 2] << 24)) >>> 0;
	const high = (src[at + 3] | (src[at + 4] << 8) | (src[at + 5] << 16) | (src[at + 6] << 24)) >>> 0;
	const productHigh = (multiplyHigh(low, prime7Low) + Math.imul(low, prime7High) + Math.imul(high, prime7Low)) >>> 0;
	return productHigh >>> (32 - tableBits);
}

/**
 * Go's level 6 encoder: a table of the last position of each 4-byte hash, and one of the last two positions of each
 * 7-byte hash, every position indexed, with a check for a repeat of the last match's offset and for a longer match
 * found from the end of the one at hand. It matches against the last 32 KiB of what it has seen, in earlier blocks too.
 */
class FastEncoderL6 {
	private readonly hist = new Uint8Array(allocHistory);
	private histLength = 0;
	// Table entries hold positions plus cur, so moving the history down and resetting leave old entries out of reach.
	private cur = maxStoreBlockSize;
	private readonly table = new Int32Array(tableSize);
	private readonly longCur = new Int32Array(tableSize);
	private readonly longPrev = new Int32Array(tableSize);

	private addBlock(src: Uint8Array): number {
		if (this.histLength + src.length > this.hist.length) {
			const offset = this.histLength - maxMatchOffset;
			this.hist.copyWithin(0, offset, offset + maxMatchOffset);
			this.cur += offset;
			this.histLength = maxMatchOffset;
		}
		const start = this.histLength;
		this.hist.set(src, start);
		this.histLength += src.length;
		return start;
	}

	/** Forgets what has been seen, so no later match reaches it. */
	reset(): void {
		this.cur += maxMatchOffset + this.histLength;
		this.histLength = 0;
	}

	private storeLong(hash: number, entry: number): void {
		this.longPrev[hash] = this.longCur[hash];
		this.longCur[hash] = entry;
	}

	private matchLenLimited(s: number, t: number): number {
		const src = this.hist;
		const end = Math.min(s + maxMatchLength - 4, this.histLength);
		let n = 0;
		while (s + n < end && src[s + n] === src[t + n]) n++;
		return n;
	}

	private matchLenLong(s: number, t: number): number {
		const src = this.hist;
		const end = this.histLength;
		let n = 0;
		while (s + n < end && src[s + n] === src[t + n]) n++;
		return n;
	}

	encode(dst: Tokens, block: Uint8Array): void {
		const inputMargin = 12 - 1;
		const skipLog = 7;
		const doEvery = 1;
		const skipBeginning = 2;

		let s = this.addBlock(block);
		const src = this.hist;
		const srcLength = this.histLength;
		const cur = this.cur;
		let nextEmit = s;
		const sLimit = srcLength - inputMargin;
		let repeat = 1;

		for (;;) {
			let nextS = s;
			let l = 0;
			let t = 0;
			for (;;) {
				s = nextS;
				const hashS = hash4(src, s);
				const hashL = hash7(src, s);
				nextS = s + doEvery + ((s - nextEmit) >> skipLog);
				if (nextS > sLimit) {
					this.emitRemainder(dst, nextEmit);
					return;
				}
				const sCandidate = this.table[hashS];
				const lCandidateCur = this.longCur[hashL];
				const lCandidatePrev = this.longPrev[hashL];
				const entry = s + cur;
				this.table[hashS] = entry;
				this.storeLong(hashL, entry);

				const nextHashS = hash4(src, nextS);
				const nextHashL = hash7(src, nextS);
				const value = load32(src, s);
				const storeNext = () => {
					this.table[nextHashS] = nextS + cur;
					this.storeLong(nextHashL, nextS + cur);
				};

				t = lCandidateCur - cur;
				if (s - t < maxMatchOffset) {
					if (value === load32(src, t)) {
						storeNext();
						// Check the previous long candidate as well.
						const t2 = lCandidatePrev - cur;
						if (s - t2 < maxMatchOffset && value === load32(src, t2)) {
							l = this.matchLenLimited(s + 4, t + 4) + 4;
							const ml1 = this.matchLenLimited(s + 4, t2 + 4) + 4;
							if (ml1 > l) {
								t = t2;
								l = ml1;
							}
						}
						break;
					}
					t = lCandidatePrev - cur;
					if (s - t < maxMatchOffset && value === load32(src, t)) {
						storeNext();
						break;
					}
				}

				t = sCandidate - cur;
				if (s - t < maxMatchOffset && value === load32(src, t)) {
					l = this.matchLenLimited(s + 4, t + 4) + 4;
					const nextLongCur = this.longCur[nextHashL];
					const nextLongPrev = this.longPrev[nextHashL];
					storeNext();

					// A repeat of the last match's offset, a byte on.
					let t2 = s - repeat + 1;
					if (load32(src, t2) === load32(src, s + 1)) {
						const ml = this.matchLenLimited(s + 5, t2 + 4) + 4;
						if (ml > l) {
							t = t2;
							l = ml;
							s += 1;
							break;
						}
					}

					// The long candidates of the next position.
					t2 = nextLongCur - cur;
					if (nextS - t2 < maxMatchOffset) {
						const next = load32(src, nextS);
						if (load32(src, t2) === next) {
							const ml = this.matchLenLimited(nextS + 4, t2 + 4) + 4;
							if (ml > l) {
								t = t2;
								s = nextS;
								l = ml;
							}
						}
						t2 = nextLongPrev - cur;
						if (nextS - t2 < maxMatchOffset && load32(src, t2) === next) {
							const ml = this.matchLenLimited(nextS + 4, t2 + 4) + 4;
							if (ml > l) {
								t = t2;
								s = nextS;
								l = ml;
							}
						}
					}
					break;
				}
			}

			// Extend the match as far as it goes.
			if (l === 0) l = this.matchLenLong(s + 4, t + 4) + 4;
			else if (l === maxMatchLength) l += this.matchLenLong(s + l, t + l);

			// A longer match may be found through the long hash at the end of this one, allowing its first bytes to differ.
			const sAt = s + l;
			if (sAt < sLimit) {
				const hash = hash7(src, sAt);
				const s2 = s + skipBeginning;
				let t2 = this.longCur[hash] - cur - l + skipBeginning;
				if (s2 - t2 < maxMatchOffset) {
					if (s2 - t2 > 0 && t2 >= 0) {
						const l2 = this.matchLenLong(s2, t2);
						if (l2 > l) {
							t = t2;
							l = l2;
							s = s2;
						}
					}
					t2 = this.longPrev[hash] - cur - l + skipBeginning;
					const off = s2 - t2;
					if (off > 0 && off < maxMatchOffset && t2 >= 0) {
						const l2 = this.matchLenLong(s2, t2);
						if (l2 > l) {
							t = t2;
							l = l2;
							s = s2;
						}
					}
				}
			}

			// Extend backwards.
			while (t > 0 && s > nextEmit && src[t - 1] === src[s - 1]) {
				s--;
				t--;
				l++;
			}
			for (let at = nextEmit; at < s; at++) dst.addLiteral(src[at]);

			dst.addMatchLong(l, s - t - baseMatchOffset);
			repeat = s - t;
			s += l;
			nextEmit = s;
			if (nextS >= s) s = nextS + 1;

			if (s >= sLimit) {
				// Index the rest, after the match.
				for (let at = nextS + 1; at < srcLength - 8; at += 2) {
					this.table[hash4(src, at)] = at + cur;
					this.storeLong(hash7(src, at), at + cur);
				}
				this.emitRemainder(dst, nextEmit);
				return;
			}

			// Index every long hash in the match and every second short one.
			for (let at = nextS + 1; at < s - 1; at += 2) {
				const longHash = hash7(src, at);
				const nextLongHash = hash7(src, at + 1);
				this.table[hash4(src, at)] = at + cur;
				this.storeLong(longHash, at + cur);
				this.storeLong(nextLongHash, at + 1 + cur);
			}
		}
	}

	/** Adds what is left after nextEmit as literals, unless the block found no match at all. */
	private emitRemainder(dst: Tokens, nextEmit: number): void {
		if (nextEmit >= this.histLength || dst.n === 0) return;
		for (let at = nextEmit; at < this.histLength; at++) dst.addLiteral(this.hist[at]);
	}
}

/** Go's compressor at the default level: it codes its window a block at a time, as it fills and as it is flushed. */
class Compressor {
	readonly writer = new HuffmanBitWriter();
	private readonly encoder = new FastEncoderL6();
	private readonly tokens = new Tokens();
	private readonly window = new Uint8Array(maxStoreBlockSize);
	private windowEnd = 0;
	private sync = false;

	private writeStoredBlock(bytes: Uint8Array): void {
		this.writer.writeStoredHeader(bytes.length, false);
		this.writer.writeBytes(bytes);
	}

	/** Codes the window once it is full, or when flushing: stored, as literals alone, or with matches. */
	private deflateFast(): void {
		const window = this.window.subarray(0, this.windowEnd);
		if (this.windowEnd < this.window.length) {
			if (!this.sync) return;
			if (this.windowEnd < 128) {
				if (this.windowEnd === 0) return;
				if (this.windowEnd <= 32) this.writeStoredBlock(window);
				else this.writer.writeBlockHuff(false, window, true);
				this.tokens.reset();
				this.windowEnd = 0;
				this.encoder.reset();
				return;
			}
		}

		this.encoder.encode(this.tokens, window);
		if (this.tokens.n === 0) this.writeStoredBlock(window);
		// Few enough matches that literals alone code it about as well.
		else if (this.tokens.n > this.windowEnd - (this.windowEnd >> 4)) this.writer.writeBlockHuff(false, window, this.sync);
		else this.writer.writeBlockDynamic(this.tokens, false, window, this.sync);
		this.tokens.reset();
		this.windowEnd = 0;
	}

	write(data: Uint8Array): void {
		let rest = data;
		while (rest.length > 0) {
			if (this.windowEnd === this.window.length) this.deflateFast();
			const count = Math.min(rest.length, this.window.length - this.windowEnd);
			this.window.set(rest.subarray(0, count), this.windowEnd);
			this.windowEnd += count;
			rest = rest.subarray(count);
		}
	}

	/** Codes what the window holds and ends on a byte boundary: with an empty stored block, or the empty last block. */
	finish(eof: boolean): void {
		this.sync = true;
		this.deflateFast();
		this.writer.writeStoredHeader(0, eof);
		this.writer.flush();
		this.sync = false;
	}
}

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

// Go's gzip header with no name, comment, extra field or time set, at a level other than the fastest and the best,
// from an unknown operating system.
const gzipHeader = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff];

/** The gzip member Go's gzip.Writer writes around deflated, the DEFLATE stream of data. */
export function gzipMember(data: Uint8Array, deflated: Uint8Array): Buffer {
	const trailer = Buffer.alloc(8);
	trailer.writeUInt32LE(crc32(data), 0);
	trailer.writeUInt32LE(data.length >>> 0, 4);
	return Buffer.concat([Buffer.from(gzipHeader), deflated, trailer]);
}

/** The gzip stream Terragrunt v1.2.2's base64gzip writes for input, base64 encoded: Go's Write, then Flush, then Close. */
export function base64Gzip(input: string): string {
	const data = Buffer.from(input, 'utf8');
	const compressor = new Compressor();
	compressor.write(data);
	compressor.finish(false);
	compressor.finish(true);
	return gzipMember(data, compressor.writer.bytes()).toString('base64');
}
