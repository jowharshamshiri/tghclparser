/*
 * A TypeScript port of Terragrunt's internal/gzipcompat and the DEFLATE compressor it vendors in
 * internal/vendored/compress/flate, itself the default level of Go's compress/flate (Copyright 2009 The Go Authors,
 * BSD-style licence), as Terragrunt v1.2.2 carries them.
 *
 * Terragrunt's base64gzip_compat writes the gzip stream that base64gzip wrote in Terragrunt v1.1.3 and earlier, so a
 * configuration that compares or stores that output keeps it. The bytes are what matters, so this follows the Go
 * compressor step for step: its match finder, its block choice and its Huffman code construction.
 */

const logWindowSize = 15;
const windowSize = 1 << logWindowSize;
const windowMask = windowSize - 1;

const baseMatchLength = 3;
const minMatchLength = 4;
const maxMatchLength = 258;
const baseMatchOffset = 1;

const maxFlateBlockTokens = 1 << 14;
const maxStoreBlockSize = 65535;
const hashBits = 17;
const hashSize = 1 << hashBits;
const hashMask = (1 << hashBits) - 1;
const maxHashOffset = 1 << 24;
const hashShift = 32 - hashBits;
const windowBufferSize = 2 * windowSize;

const goodLength = 8;
const lazyLength = 16;
const niceLength = 128;
const chainLength = 128;

const maxNumLit = 286;
const offsetCodeCount = 30;
const endBlockMarker = 256;
const lengthCodesStart = 257;
const codegenCodeCount = 19;
const badCode = 255;

const blockTypeBits = 3;
const storedLenBits = 16;
const storedOverhead = 5;
const hlitBits = 5;
const hdistBits = 5;
const hclenBits = 4;
const minCodegens = 4;
const codeLenBits = 3;
const maxCodeBits = 15;
const maxCodegenBits = 7;

const codeRepeatPrev = 16;
const codeRepeatZeroShort = 17;
const codeRepeatZeroLong = 18;
const repeatPrevMin = 3;
const repeatPrevMax = 6;
const repeatPrevExtraBits = 2;
const repeatZeroShortMin = 3;
const repeatZeroShortExtraBits = 3;
const repeatZeroLongMin = 11;
const repeatZeroLongMax = 138;
const repeatZeroLongExtraBits = 7;

const lengthCodesNoExtra = 8;
const offsetCodesNoExtra = 4;
const fixedOffsetBits = 5;

const maxBitsLimit = 16;
const maxInt32 = 0x7fffffff;
const maxUint16 = 0xffff;

const lengthShift = 22;
const offsetMask = (1 << lengthShift) - 1;
const matchType = 1 << 30;

const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const lengthBase = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 255];
const offsetExtraBits = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const offsetBase = [
	0x000000, 0x000001, 0x000002, 0x000003, 0x000004, 0x000006, 0x000008, 0x00000c, 0x000010, 0x000018,
	0x000020, 0x000030, 0x000040, 0x000060, 0x000080, 0x0000c0, 0x000100, 0x000180, 0x000200, 0x000300,
	0x000400, 0x000600, 0x000800, 0x000c00, 0x001000, 0x001800, 0x002000, 0x003000, 0x004000, 0x006000
];
const codegenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function codeTable(base: number[], extraBits: number[]): Uint32Array {
	const table = new Uint32Array(256);
	base.forEach((start, code) => {
		let end = Math.min(start + (1 << extraBits[code]), 256);
		if (code + 1 < base.length) end = Math.min(end, base[code + 1]);
		for (let index = start; index < end; index++) table[index] = code;
	});
	return table;
}

const lengthCodes = codeTable(lengthBase, lengthExtraBits);
const offsetCodes = codeTable(offsetBase, offsetExtraBits);

const literalToken = (literal: number): number => literal;
const matchToken = (length: number, offset: number): number => matchType + length * (1 << lengthShift) + offset;
const tokenLength = (token: number): number => Math.floor((token - matchType) / (1 << lengthShift));
const tokenOffset = (token: number): number => token & offsetMask;

function offsetCode(offset: number): number {
	if (offset < 256) return offsetCodes[offset];
	if (offset >> 7 < 256) return offsetCodes[offset >> 7] + 14;
	return offsetCodes[offset >> 14] + 28;
}

function reverseBits(number: number, bitLength: number): number {
	let reversed = 0;
	for (let bit = 0; bit < bitLength; bit++) reversed |= ((number >> bit) & 1) << (bitLength - 1 - bit);
	return reversed;
}

interface Code {
	code: number;
	len: number;
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
	readonly codes: Code[];

	constructor(size: number) {
		this.codes = Array.from({ length: size }, () => ({ code: 0, len: 0 }));
	}

	bitLength(freq: Int32Array): number {
		let total = 0;
		freq.forEach((count, index) => {
			if (count !== 0) total += count * this.codes[index].len;
		});
		return total;
	}

	private bitCounts(list: LiteralNode[], maxBits: number): number[] {
		const n = list.length;
		list.push({ literal: maxUint16, freq: maxInt32 });
		if (maxBits > n - 1) maxBits = n - 1;

		const levels: LevelInfo[] = Array.from({ length: maxBitsLimit }, () => ({ level: 0, lastFreq: 0, nextCharFreq: 0, nextPairFreq: 0, needed: 0 }));
		const leafCounts: number[][] = Array.from({ length: maxBitsLimit }, () => new Array<number>(maxBitsLimit).fill(0));

		for (let level = 1; level <= maxBits; level++) {
			levels[level] = {
				level,
				lastFreq: list[1].freq,
				nextCharFreq: list[2].freq,
				nextPairFreq: list[0].freq + list[1].freq,
				needed: 0
			};
			leafCounts[level][level] = 2;
			if (level === 1) levels[level].nextPairFreq = maxInt32;
		}
		levels[maxBits].needed = 2 * n - 4;

		let level = maxBits;
		for (;;) {
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
				current.nextCharFreq = list[count].freq;
			} else {
				current.lastFreq = current.nextPairFreq;
				for (let index = 0; index < level; index++) leafCounts[level][index] = leafCounts[level - 1][index];
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
		let remaining = list;
		bitCount.forEach((bits, n) => {
			code = (code << 1) & 0xffff;
			if (n === 0 || bits === 0) return;
			const chunk = remaining.slice(remaining.length - bits).sort((left, right) => left.literal - right.literal);
			for (const node of chunk) {
				this.codes[node.literal] = { code: reverseBits(code, n), len: n };
				code = (code + 1) & 0xffff;
			}
			remaining = remaining.slice(0, remaining.length - bits);
		});
	}

	generate(freq: Int32Array, maxBits: number): void {
		const list: LiteralNode[] = [];
		freq.forEach((count, index) => {
			if (count !== 0) list.push({ literal: index, freq: count });
			else this.codes[index].len = 0;
		});
		if (list.length <= 2) {
			list.forEach((node, index) => {
				this.codes[node.literal] = { code: index, len: 1 };
			});
			return;
		}
		list.sort((left, right) => left.freq - right.freq || left.literal - right.literal);
		this.assignEncodingAndSize(this.bitCounts(list, maxBits), list);
	}
}

function fixedLiteralEncoding(): HuffmanEncoder {
	const encoder = new HuffmanEncoder(maxNumLit);
	for (let ch = 0; ch < maxNumLit; ch++) {
		let bits: number;
		let size: number;
		if (ch < 144) {
			bits = ch + 0x30;
			size = 8;
		} else if (ch < 256) {
			bits = ch - 144 + 0x190;
			size = 9;
		} else if (ch < 280) {
			bits = ch - 256;
			size = 7;
		} else {
			bits = ch - 280 + 0xc0;
			size = 8;
		}
		encoder.codes[ch] = { code: reverseBits(bits, size), len: size };
	}
	return encoder;
}

function fixedOffsetEncoding(): HuffmanEncoder {
	const encoder = new HuffmanEncoder(offsetCodeCount);
	for (let ch = 0; ch < offsetCodeCount; ch++) encoder.codes[ch] = { code: reverseBits(ch, fixedOffsetBits), len: fixedOffsetBits };
	return encoder;
}

const fixedLiterals = fixedLiteralEncoding();
const fixedOffsets = fixedOffsetEncoding();

/**
 * The Go writer gathers bits least significant first and writes them out a byte at a time, padding a partial byte
 * with zeros when flushed. Which bytes reach the stream, and when, is the same here.
 */
class HuffmanBitWriter {
	private readonly out: number[] = [];
	private bits = 0;
	private nbits = 0;
	private readonly literalFreq = new Int32Array(maxNumLit);
	private readonly offsetFreq = new Int32Array(offsetCodeCount);
	private readonly codegen = new Uint8Array(maxNumLit + offsetCodeCount + 1);
	private readonly codegenFreq = new Int32Array(codegenCodeCount);
	private readonly literalEncoding = new HuffmanEncoder(maxNumLit);
	private readonly offsetEncoding = new HuffmanEncoder(offsetCodeCount);
	private readonly codegenEncoding = new HuffmanEncoder(codegenCodeCount);

	bytes(): Uint8Array {
		return Uint8Array.from(this.out);
	}

	flush(): void {
		while (this.nbits > 0) {
			this.out.push(this.bits & 0xff);
			this.bits >>>= 8;
			this.nbits = Math.max(this.nbits - 8, 0);
		}
		this.bits = 0;
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

	private writeBytes(bytes: Uint8Array): void {
		if (this.nbits !== 0) throw new Error('write of stored block with unfinished bits');
		for (const byte of bytes) this.out.push(byte);
	}

	private writeCode(code: Code): void {
		this.writeBits(code.code, code.len);
	}

	private generateCodegen(numLiterals: number, numOffsets: number): void {
		this.codegenFreq.fill(0);
		const codegen = this.codegen;
		for (let index = 0; index < numLiterals; index++) codegen[index] = this.literalEncoding.codes[index].len;
		for (let index = 0; index < numOffsets; index++) codegen[numLiterals + index] = this.offsetEncoding.codes[index].len;
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
				while (count >= repeatPrevMin) {
					const n = Math.min(repeatPrevMax, count);
					codegen[outIndex++] = codeRepeatPrev;
					codegen[outIndex++] = n - repeatPrevMin;
					this.codegenFreq[codeRepeatPrev]++;
					count -= n;
				}
			} else {
				while (count >= repeatZeroLongMin) {
					const n = Math.min(repeatZeroLongMax, count);
					codegen[outIndex++] = codeRepeatZeroLong;
					codegen[outIndex++] = n - repeatZeroLongMin;
					this.codegenFreq[codeRepeatZeroLong]++;
					count -= n;
				}
				if (count >= repeatZeroShortMin) {
					codegen[outIndex++] = codeRepeatZeroShort;
					codegen[outIndex++] = count - repeatZeroShortMin;
					this.codegenFreq[codeRepeatZeroShort]++;
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

	private dynamicSize(extraBits: number): { size: number; numCodegens: number } {
		let numCodegens = this.codegenFreq.length;
		while (numCodegens > minCodegens && this.codegenFreq[codegenOrder[numCodegens - 1]] === 0) numCodegens--;
		const header = blockTypeBits + hlitBits + hdistBits + hclenBits + codeLenBits * numCodegens
			+ this.codegenEncoding.bitLength(this.codegenFreq)
			+ this.codegenFreq[codeRepeatPrev] * repeatPrevExtraBits
			+ this.codegenFreq[codeRepeatZeroShort] * repeatZeroShortExtraBits
			+ this.codegenFreq[codeRepeatZeroLong] * repeatZeroLongExtraBits;
		const size = header + this.literalEncoding.bitLength(this.literalFreq) + this.offsetEncoding.bitLength(this.offsetFreq) + extraBits;
		return { size, numCodegens };
	}

	private fixedSize(extraBits: number): number {
		return blockTypeBits + fixedLiterals.bitLength(this.literalFreq) + fixedOffsets.bitLength(this.offsetFreq) + extraBits;
	}

	private writeDynamicHeader(numLiterals: number, numOffsets: number, numCodegens: number, eof: boolean): void {
		this.writeBits(eof ? 5 : 4, blockTypeBits);
		this.writeBits(numLiterals - lengthCodesStart, hlitBits);
		this.writeBits(numOffsets - 1, hdistBits);
		this.writeBits(numCodegens - minCodegens, hclenBits);
		for (let index = 0; index < numCodegens; index++) {
			this.writeBits(this.codegenEncoding.codes[codegenOrder[index]].len, codeLenBits);
		}
		let index = 0;
		for (;;) {
			const codeWord = this.codegen[index++];
			if (codeWord === badCode) break;
			this.writeCode(this.codegenEncoding.codes[codeWord]);
			switch (codeWord) {
				case codeRepeatPrev:
					this.writeBits(this.codegen[index++], repeatPrevExtraBits);
					break;
				case codeRepeatZeroShort:
					this.writeBits(this.codegen[index++], repeatZeroShortExtraBits);
					break;
				case codeRepeatZeroLong:
					this.writeBits(this.codegen[index++], repeatZeroLongExtraBits);
					break;
			}
		}
	}

	writeStoredHeader(length: number, eof: boolean): void {
		this.writeBits(eof ? 1 : 0, blockTypeBits);
		this.flush();
		this.writeBits(length, storedLenBits);
		this.writeBits(~length & 0xffff, storedLenBits);
	}

	private indexTokens(tokens: number[]): { numLiterals: number; numOffsets: number } {
		this.literalFreq.fill(0);
		this.offsetFreq.fill(0);
		for (const token of tokens) {
			if (token < matchType) {
				this.literalFreq[token]++;
				continue;
			}
			this.literalFreq[lengthCodesStart + lengthCodes[tokenLength(token)]]++;
			this.offsetFreq[offsetCode(tokenOffset(token))]++;
		}
		let numLiterals = this.literalFreq.length;
		while (this.literalFreq[numLiterals - 1] === 0) numLiterals--;
		let numOffsets = this.offsetFreq.length;
		while (numOffsets > 0 && this.offsetFreq[numOffsets - 1] === 0) numOffsets--;
		if (numOffsets === 0) {
			this.offsetFreq[0] = 1;
			numOffsets = 1;
		}
		this.literalEncoding.generate(this.literalFreq, maxCodeBits);
		this.offsetEncoding.generate(this.offsetFreq, maxCodeBits);
		return { numLiterals, numOffsets };
	}

	private writeTokens(tokens: number[], literalCodes: Code[], offsetCodesUsed: Code[]): void {
		for (const token of tokens) {
			if (token < matchType) {
				this.writeCode(literalCodes[token]);
				continue;
			}
			const length = tokenLength(token);
			const lengthCode = lengthCodes[length];
			this.writeCode(literalCodes[lengthCode + lengthCodesStart]);
			if (lengthExtraBits[lengthCode] > 0) this.writeBits(length - lengthBase[lengthCode], lengthExtraBits[lengthCode]);
			const offset = tokenOffset(token);
			const code = offsetCode(offset);
			this.writeCode(offsetCodesUsed[code]);
			if (offsetExtraBits[code] > 0) this.writeBits(offset - offsetBase[code], offsetExtraBits[code]);
		}
	}

	/** Writes one block of tokens, as stored bytes when that is smallest, else with fixed or dynamic codes. */
	writeBlock(blockTokens: number[], eof: boolean, input: Uint8Array | undefined): void {
		const tokens = [...blockTokens, endBlockMarker];
		const { numLiterals, numOffsets } = this.indexTokens(tokens);

		let extraBits = 0;
		const storable = input !== undefined && input.length <= maxStoreBlockSize;
		const storedSize = storable ? (input.length + storedOverhead) * 8 : 0;
		if (storable) {
			for (let lengthCode = lengthCodesStart + lengthCodesNoExtra; lengthCode < numLiterals; lengthCode++) {
				extraBits += this.literalFreq[lengthCode] * lengthExtraBits[lengthCode - lengthCodesStart];
			}
			for (let code = offsetCodesNoExtra; code < numOffsets; code++) {
				extraBits += this.offsetFreq[code] * offsetExtraBits[code];
			}
		}

		let literals = fixedLiterals;
		let offsets = fixedOffsets;
		let size = this.fixedSize(extraBits);

		this.generateCodegen(numLiterals, numOffsets);
		this.codegenEncoding.generate(this.codegenFreq, maxCodegenBits);
		const dynamic = this.dynamicSize(extraBits);
		if (dynamic.size < size) {
			size = dynamic.size;
			literals = this.literalEncoding;
			offsets = this.offsetEncoding;
		}

		if (storable && storedSize < size) {
			this.writeStoredHeader(input.length, eof);
			this.writeBytes(input);
			return;
		}

		if (literals === fixedLiterals) this.writeBits(eof ? 3 : 2, blockTypeBits);
		else this.writeDynamicHeader(numLiterals, numOffsets, dynamic.numCodegens, eof);
		this.writeTokens(tokens, literals.codes, offsets.codes);
	}
}

function hash4(window: Uint8Array, at: number): number {
	const word = (window[at + 3] | (window[at + 2] << 8) | (window[at + 1] << 16) | (window[at] << 24)) >>> 0;
	return Math.imul(word, 0x1e35a7bd) >>> hashShift;
}

function matchLen(window: Uint8Array, left: number, right: number, max: number): number {
	for (let index = 0; index < max; index++) {
		if (window[left + index] !== window[right + index]) return index;
	}
	return max;
}

class Compressor {
	readonly writer = new HuffmanBitWriter();
	private tokens: number[] = [];
	private readonly window = new Uint8Array(windowBufferSize);
	private index = 0;
	private blockStart = 0;
	private length = minMatchLength - 1;
	private offset = 0;
	private maxInsertIndex = 0;
	private windowEnd = 0;
	private chainHead = -1;
	private hashOffset = 1;
	private readonly hashHead = new Uint32Array(hashSize);
	private readonly hashPrev = new Uint32Array(windowSize);
	private byteAvailable = false;
	private sync = false;

	private fillDeflate(data: Uint8Array): number {
		if (this.index >= windowBufferSize - (minMatchLength + maxMatchLength)) {
			this.window.copyWithin(0, windowSize, windowBufferSize);
			this.index -= windowSize;
			this.windowEnd -= windowSize;
			if (this.blockStart >= windowSize) this.blockStart -= windowSize;
			else this.blockStart = maxInt32;
			this.hashOffset += windowSize;
			if (this.hashOffset > maxHashOffset) {
				const delta = this.hashOffset - 1;
				this.hashOffset -= delta;
				this.chainHead -= delta;
				for (const table of [this.hashPrev, this.hashHead]) {
					table.forEach((value, at) => {
						table[at] = value > delta ? value - delta : 0;
					});
				}
			}
		}
		const count = Math.min(data.length, this.window.length - this.windowEnd);
		this.window.set(data.subarray(0, count), this.windowEnd);
		this.windowEnd += count;
		return count;
	}

	private writeBlock(tokens: number[], index: number): void {
		if (index <= 0) return;
		const window = this.blockStart <= index ? this.window.subarray(this.blockStart, index) : undefined;
		this.blockStart = index;
		this.writer.writeBlock(tokens, false, window);
	}

	private findMatch(pos: number, prevHead: number, prevLength: number, lookahead: number): { length: number; offset: number; ok: boolean } {
		const minMatchLook = Math.min(lookahead, maxMatchLength);
		const winLength = pos + minMatchLook;
		const nice = Math.min(niceLength, winLength - pos);
		let tries = chainLength;
		let length = prevLength;
		let offset = 0;
		let ok = false;
		if (length >= goodLength) tries >>= 2;

		let wEnd = this.window[pos + length];
		const minIndex = pos - windowSize;
		for (let at = prevHead; tries > 0; tries--) {
			if (wEnd === this.window[at + length]) {
				const n = matchLen(this.window, at, pos, minMatchLook);
				if (n > length && (n > minMatchLength || pos - at <= 4096)) {
					length = n;
					offset = pos - at;
					ok = true;
					if (n >= nice) break;
					wEnd = this.window[pos + n];
				}
			}
			if (at === minIndex) break;
			at = this.hashPrev[at & windowMask] - this.hashOffset;
			if (at < minIndex || at < 0) break;
		}
		return { length, offset, ok };
	}

	private flushTokensIfFull(index: number): void {
		if (this.tokens.length === maxFlateBlockTokens) {
			this.writeBlock(this.tokens, index);
			this.tokens = [];
		}
	}

	deflate(): void {
		if (this.windowEnd - this.index < minMatchLength + maxMatchLength && !this.sync) return;
		this.maxInsertIndex = this.windowEnd - (minMatchLength - 1);

		for (;;) {
			const lookahead = this.windowEnd - this.index;
			if (lookahead < minMatchLength + maxMatchLength) {
				if (!this.sync) break;
				if (lookahead === 0) {
					if (this.byteAvailable) {
						this.tokens.push(literalToken(this.window[this.index - 1]));
						this.byteAvailable = false;
					}
					if (this.tokens.length > 0) {
						this.writeBlock(this.tokens, this.index);
						this.tokens = [];
					}
					break;
				}
			}

			if (this.index < this.maxInsertIndex) {
				const hash = hash4(this.window, this.index) & hashMask;
				this.chainHead = this.hashHead[hash];
				this.hashPrev[this.index & windowMask] = this.chainHead;
				this.hashHead[hash] = this.index + this.hashOffset;
			}

			const prevLength = this.length;
			const prevOffset = this.offset;
			this.length = minMatchLength - 1;
			this.offset = 0;
			const minIndex = Math.max(this.index - windowSize, 0);

			if (this.chainHead - this.hashOffset >= minIndex && lookahead > prevLength && prevLength < lazyLength) {
				const match = this.findMatch(this.index, this.chainHead - this.hashOffset, minMatchLength - 1, lookahead);
				if (match.ok) {
					this.length = match.length;
					this.offset = match.offset;
				}
			}

			if (prevLength >= minMatchLength && this.length <= prevLength) {
				this.tokens.push(matchToken(prevLength - baseMatchLength, prevOffset - baseMatchOffset));
				const newIndex = this.index + prevLength - 1;
				let index = this.index + 1;
				for (; index < newIndex; index++) {
					if (index < this.maxInsertIndex) {
						const hash = hash4(this.window, index) & hashMask;
						this.hashPrev[index & windowMask] = this.hashHead[hash];
						this.hashHead[hash] = index + this.hashOffset;
					}
				}
				this.index = index;
				this.byteAvailable = false;
				this.length = minMatchLength - 1;
				this.flushTokensIfFull(this.index);
			} else {
				if (this.byteAvailable) {
					const at = this.index - 1;
					this.tokens.push(literalToken(this.window[at]));
					this.flushTokensIfFull(at + 1);
				}
				this.index++;
				this.byteAvailable = true;
			}
		}
	}

	write(data: Uint8Array): void {
		let rest = data;
		while (rest.length > 0) {
			this.deflate();
			rest = rest.subarray(this.fillDeflate(rest));
		}
	}

	finish(eof: boolean): void {
		this.sync = true;
		this.deflate();
		this.writer.writeStoredHeader(0, eof);
		this.writer.flush();
		this.sync = false;
	}
}

/** The DEFLATE stream the vendored compressor writes for data: its Write, then Flush, then Close. */
function compress(data: Uint8Array): Uint8Array {
	const compressor = new Compressor();
	compressor.write(data);
	compressor.finish(false);
	compressor.finish(true);
	return compressor.writer.bytes();
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

const gzipHeader = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff];

/** The gzip stream Terragrunt v1.1.3's base64gzip wrote for input, base64 encoded. */
export function base64GzipCompat(input: string): string {
	const data = Buffer.from(input, 'utf8');
	const trailer = Buffer.alloc(8);
	trailer.writeUInt32LE(crc32(data), 0);
	trailer.writeUInt32LE(data.length >>> 0, 4);
	return Buffer.concat([Buffer.from(gzipHeader), compress(data), trailer]).toString('base64');
}
