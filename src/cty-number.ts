/**
 * Numbers as go-cty v1.19.0 holds them: binary floating-point values of arbitrary size, each with its own mantissa
 * precision in bits and rounded to nearest even, as Go's math/big.Float computes them under Go 1.27.4, the runtime
 * Terragrunt v1.2.2 is built with. A number literal or a string converted to a number is read with a 512-bit
 * mantissa, an integer a function counts is held with 64 bits, and a number computed through a float64 with 53, and
 * every result is printed as the fewest decimal digits that read back to it at its own precision. So `1 / 3` prints as
 * many digits as tell its 512-bit value apart and `0.1 + 0.2` prints `0.3`, as Terragrunt prints them.
 */

/** The exponent range of a Go big.Float: a value is 0.mantissa × 2^exponent, with the exponent an int32. */
const MIN_EXP = -2147483648;
const MAX_EXP = 2147483647;

/** The mantissa precision go-cty reads a decimal number with. */
const PARSE_PRECISION = 512;

/** The largest power of 5 Go's math/big keeps in a uint64 table before it computes one by squaring. */
const POW5_TABLE_LIMIT = 27;

type Form = 'zero' | 'finite' | 'inf';

/** How a rounded value relates to the exact one, as Go's big.Accuracy says it. */
export type Accuracy = 'below' | 'exact' | 'above';

/** The flags, width and precision of one formatting verb, as Go's fmt.State gives them to a formatter. */
export interface FormatSpec {
	minus?: boolean;
	plus?: boolean;
	space?: boolean;
	zero?: boolean;
	sharp?: boolean;
	width?: number;
	precision?: number;
}

/** A number as it crosses a JSON boundary: its fields, the mantissa in hexadecimal. */
export interface SerializedCtyNumber {
	negative: boolean;
	form: Form;
	mantissa: string;
	shift: number;
	precision: number;
}

/** A number in decimal: 0.mant × 10^exp, its digits without trailing zeros; zero has no digits and exponent 0. */
interface Decimal {
	mant: string;
	exp: number;
}

function bitLength(value: bigint): number {
	return value === 0n ? 0 : value.toString(2).length;
}

function trailingZeroBits(value: bigint): number {
	let count = 0;
	let rest = value;
	while ((rest & 0xffffffffn) === 0n) {
		rest >>= 32n;
		count += 32;
	}
	const low = Number(rest & 0xffffffffn);
	return count + 31 - Math.clz32(low & -low);
}

function pow2(exponent: number): bigint {
	return 1n << BigInt(exponent);
}

function pow5(exponent: number): bigint {
	return 5n ** BigInt(exponent);
}

/** A failed operation on infinities or zeros, which Go's math/big reports by panicking with ErrNaN. */
class NotANumber extends Error {}

export class CtyNumber {
	/**
	 * @param negative the sign, kept for zero and infinity too.
	 * @param form whether the number is zero, finite and nonzero, or infinite.
	 * @param mantissa for a finite number, an odd positive integer m such that the number is m × 2^shift.
	 * @param shift the power of two the mantissa is scaled by.
	 * @param precision the mantissa precision in bits, kept for zero and infinity too: it sets the precision of what
	 *   is computed from the number.
	 */
	private constructor(
		readonly negative: boolean,
		private readonly form: Form,
		private readonly mantissa: bigint,
		private readonly shift: number,
		readonly precision: number
	) {}

	/**
	 * Reads a decimal number as go-cty's ParseNumberVal does: Go's big.ParseFloat in base 10 with a 512-bit mantissa,
	 * rounding to nearest even. It takes an optional sign, digits with an optional point, and an optional exponent
	 * written `e` (a power of ten) or `p` (a power of two); and `Inf` or `inf`.
	 *
	 * @param text the number.
	 * @throws Error "a number is required" when the text is not a number.
	 */
	static parse(text: string): CtyNumber {
		const parsed = parseFloat(text, PARSE_PRECISION);
		if (!parsed) throw new Error('a number is required');
		return parsed;
	}

	/**
	 * Reads a decimal number as go-cty's ParseNumberVal does.
	 *
	 * @param text the number.
	 * @returns the number, or undefined when the text is not one.
	 */
	static tryParse(text: string): CtyNumber | undefined {
		return parseFloat(text, PARSE_PRECISION);
	}

	/**
	 * An integer as go-cty's NumberIntVal holds it: with a 64-bit mantissa.
	 *
	 * @param value a safe integer.
	 */
	static fromInt64(value: number): CtyNumber {
		if (!Number.isSafeInteger(value)) throw new Error(`${value} is not a safe integer`);
		return fromInteger(BigInt(value), 64);
	}

	/**
	 * An integer as Go's big.Float.SetInt holds it in a new float: with a mantissa of 64 bits, or of its own length when
	 * that is longer, so that it is exact.
	 *
	 * @param value the integer.
	 */
	static fromBigInt(value: bigint): CtyNumber {
		const magnitude = value < 0n ? -value : value;
		return fromInteger(value, Math.max(bitLength(magnitude), 64));
	}

	/**
	 * A float64 as go-cty's NumberFloatVal holds it: exactly, with a 53-bit mantissa.
	 *
	 * @param value the float64; NaN has no number.
	 */
	static fromFloat64(value: number): CtyNumber {
		if (Number.isNaN(value)) throw new Error('NaN is not a number');
		const negative = value < 0 || Object.is(value, -0);
		if (value === 0) return new CtyNumber(negative, 'zero', 0n, 0, 53);
		if (!Number.isFinite(value)) return new CtyNumber(negative, 'inf', 0n, 0, 53);
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, Math.abs(value));
		const bits = view.getBigUint64(0);
		const biased = Number(bits >> 52n);
		const fraction = bits & (pow2(52) - 1n);
		const [mantissa, shift] = biased === 0 ? [fraction, -1074] : [fraction | pow2(52), biased - 1075];
		return finite(negative, mantissa, shift, 53);
	}

	/** Restores a number from {@link CtyNumber.serialize}. */
	static deserialize(serialized: SerializedCtyNumber): CtyNumber {
		const mantissa = BigInt(`0x${serialized.mantissa}`);
		if (serialized.form === 'finite') return finite(serialized.negative, mantissa, serialized.shift, serialized.precision);
		return new CtyNumber(serialized.negative, serialized.form, 0n, 0, serialized.precision);
	}

	/** The number's fields, for a JSON boundary; {@link CtyNumber.deserialize} restores it. */
	serialize(): SerializedCtyNumber {
		return { negative: this.negative, form: this.form, mantissa: this.mantissa.toString(16), shift: this.shift, precision: this.precision };
	}

	isZero(): boolean {
		return this.form === 'zero';
	}

	isInfinite(): boolean {
		return this.form === 'inf';
	}

	/** -1, 0 or +1 by the number's sign; 0 for either zero. */
	sign(): number {
		if (this.form === 'zero') return 0;
		return this.negative ? -1 : 1;
	}

	/** Whether the number is a whole number: zero or a finite integer. */
	isInteger(): boolean {
		return this.form === 'zero' || (this.form === 'finite' && this.shift >= 0);
	}

	/** The sum, as go-cty's Add computes it. */
	add(other: CtyNumber): CtyNumber {
		return nanAs("can't compute sum of opposing infinities", () => addTo(this, other, Math.max(this.precision, other.precision)));
	}

	/** The difference, as go-cty's Subtract computes it: the sum with the other number negated. */
	subtract(other: CtyNumber): CtyNumber {
		return nanAs("can't subtract infinity from itself", () => addTo(this, other.negate(), Math.max(this.precision, other.precision)));
	}

	/**
	 * The product, as go-cty's Multiply computes it: rounded to 512 bits, and then held with the larger of the
	 * operands' precisions, or as many bits as the product needs when that is more.
	 */
	multiply(other: CtyNumber): CtyNumber {
		return nanAs("can't multiply zero by infinity", () => {
			const product = mulTo(this, other, PARSE_PRECISION);
			return setTo(product, Math.max(this.precision, other.precision, product.minimumPrecision()));
		});
	}

	/** The quotient, as go-cty's Divide computes it: a nonzero number divided by zero is an infinity. */
	divide(other: CtyNumber): CtyNumber {
		return nanAs("can't divide zero by zero or infinity by infinity", () => quoTo(this, other, Math.max(this.precision, other.precision)));
	}

	/**
	 * The remainder, as go-cty's Modulo computes it: this number less the other times the truncated quotient, each
	 * step rounded to this number's precision. A number modulo zero is the number itself.
	 */
	modulo(other: CtyNumber): CtyNumber {
		if (this.form === 'inf') throw new Error("can't use modulo with infinity");
		if (other.form === 'zero') return this;
		return nanAs("can't use modulo with zero and infinity", () => {
			const quotient = this.divide(other).truncate();
			if (quotient.integer === undefined) throw new Error("can't use modulo with infinity");
			const whole = setInteger(quotient.integer, this.precision);
			return addTo(this, mulTo(other, whole, this.precision).negate(), this.precision);
		});
	}

	/** The number with its sign flipped, at its own precision; zero becomes negative zero. */
	negate(): CtyNumber {
		return new CtyNumber(!this.negative, this.form, this.mantissa, this.shift, this.precision);
	}

	/** The number without its sign, at its own precision. */
	absolute(): CtyNumber {
		return new CtyNumber(false, this.form, this.mantissa, this.shift, this.precision);
	}

	/** -1, 0 or +1 as this number is less than, equal to or greater than the other, as Go's big.Float.Cmp orders them. */
	compare(other: CtyNumber): number {
		const ours = this.order();
		const theirs = other.order();
		if (ours !== theirs) return ours < theirs ? -1 : 1;
		if (ours === 1) return compareMagnitudes(this, other);
		if (ours === -1) return compareMagnitudes(other, this);
		return 0;
	}

	/**
	 * Whether two numbers are equal as go-cty's Equals decides it: integers by value, and other numbers by the decimal
	 * text JSON would give them, so that a number read from a decimal text equals another read from the same text.
	 */
	equals(other: CtyNumber): boolean {
		if (this.sign() !== other.sign()) return false;
		const ours = this.isInteger();
		if (ours !== other.isInteger()) return false;
		if (ours) return this.truncate().integer === other.truncate().integer;
		return this.toString() === other.toString();
	}

	/**
	 * The integer the number truncates to, towards zero, and whether that is exact, as Go's big.Float.Int gives them.
	 *
	 * @returns the integer, undefined for an infinity, and its accuracy: exact, or below or above the number.
	 */
	truncate(): { integer: bigint | undefined; accuracy: Accuracy } {
		switch (this.form) {
			case 'zero':
				return { integer: 0n, accuracy: 'exact' };
			case 'inf':
				return { integer: undefined, accuracy: this.negative ? 'above' : 'below' };
			default: {
				const magnitude = this.shift >= 0 ? this.mantissa << BigInt(this.shift) : this.mantissa >> BigInt(-this.shift);
				return {
					integer: this.negative ? -magnitude : magnitude,
					accuracy: this.shift >= 0 ? 'exact' : this.negative ? 'above' : 'below'
				};
			}
		}
	}

	/** The least whole number not below the number, as go-cty's ceil computes it: at the number's own precision. */
	ceil(): CtyNumber {
		if (this.form === 'inf') return this;
		const { integer, accuracy } = this.truncate();
		return setInteger(accuracy === 'below' ? integer! + 1n : integer!, this.precision);
	}

	/** The greatest whole number not above the number, as go-cty's floor computes it: at the number's own precision. */
	floor(): CtyNumber {
		if (this.form === 'inf') return this;
		const { integer, accuracy } = this.truncate();
		return setInteger(accuracy === 'above' ? integer! - 1n : integer!, this.precision);
	}

	/**
	 * The nearest float64, as Go's big.Float.Float64 rounds it, and how it relates to the number.
	 */
	toFloat64(): { value: number; accuracy: Accuracy } {
		if (this.form === 'zero') return { value: this.negative ? -0 : 0, accuracy: 'exact' };
		if (this.form === 'inf') return { value: this.negative ? -Infinity : Infinity, accuracy: 'exact' };
		const exponent = this.exponent() - 1;
		let precision = 53;
		if (exponent < -1022) {
			precision = 53 + 1022 + exponent;
			const half = this.mantissa === 1n;
			if (precision < 0 || (precision === 0 && half)) {
				return { value: this.negative ? -0 : 0, accuracy: this.negative ? 'above' : 'below' };
			}
			if (precision === 0) {
				return { value: this.negative ? -Number.MIN_VALUE : Number.MIN_VALUE, accuracy: this.negative ? 'below' : 'above' };
			}
		}
		const rounded = setTo(this, precision);
		const roundedExponent = rounded.exponent() - 1;
		if (rounded.form === 'inf' || roundedExponent > 1023) {
			return { value: this.negative ? -Infinity : Infinity, accuracy: this.negative ? 'below' : 'above' };
		}
		let bits: bigint;
		if (roundedExponent < -1022) {
			const width = 53 + 1022 + roundedExponent;
			bits = rounded.mantissa << BigInt(width - bitLength(rounded.mantissa));
		} else {
			const normal = rounded.mantissa << BigInt(53 - bitLength(rounded.mantissa));
			bits = (BigInt(roundedExponent + 1023) << 52n) | (normal - pow2(52));
		}
		if (this.negative) bits |= 1n << 63n;
		const view = new DataView(new ArrayBuffer(8));
		view.setBigUint64(0, bits);
		const value = view.getFloat64(0);
		return { value, accuracy: compareMagnitudes(rounded, this) === 0 ? 'exact' : (rounded.compare(this) > 0 ? 'above' : 'below') };
	}

	/**
	 * The number as a float64, as go-cty's gocty converts a number for a function that computes with one: rounded,
	 * and refused only when it rounds to an infinity.
	 *
	 * @throws Error when the number is too large for a float64.
	 */
	toGoFloat64(): number {
		const { value, accuracy } = this.toFloat64();
		if (accuracy !== 'exact' && !Number.isFinite(value)) {
			const largest = CtyNumber.fromFloat64(Number.MAX_VALUE);
			throw new Error(`value must be between ${largest.negate().format('f', {})} and ${largest.format('f', {})} inclusive`);
		}
		return value;
	}

	/**
	 * The number as an int64, as go-cty's gocty converts a number for a function that takes a whole number.
	 *
	 * @throws Error when the number is not whole or does not fit an int64.
	 */
	toGoInt64(): bigint {
		const { integer, accuracy } = this.truncate();
		if (accuracy !== 'exact' || integer === undefined || integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
			throw new Error('value must be a whole number, between -9223372036854775808 and 9223372036854775807');
		}
		return integer;
	}

	/**
	 * The number as Go's big.Float.Text writes it: `f` in plain decimal, `e` and `E` with an exponent, and `g` and `G`
	 * in whichever of the two is shorter for its exponent. A negative precision writes the fewest digits that read
	 * back to the number at its own precision; otherwise it is the count of digits after the point, or for `g` of all
	 * digits. An infinity is `+Inf` or `-Inf`.
	 *
	 * @param format one of `e`, `E`, `f`, `g` and `G`.
	 * @param precision the digits to write, or -1 for the fewest.
	 */
	text(format: 'e' | 'E' | 'f' | 'g' | 'G', precision: number): string {
		const sign = this.negative ? '-' : '';
		if (this.form === 'inf') return this.negative ? '-Inf' : '+Inf';
		const digits: Decimal = this.form === 'finite' ? decimalOf(this.mantissa, this.shift) : { mant: '', exp: 0 };
		let prec = precision;
		const shortest = prec < 0;
		if (shortest) {
			roundShortest(digits, this);
			switch (format) {
				case 'e':
				case 'E':
					prec = digits.mant.length - 1;
					break;
				case 'f':
					prec = Math.max(digits.mant.length - digits.exp, 0);
					break;
				default:
					prec = digits.mant.length;
			}
		} else {
			switch (format) {
				case 'e':
				case 'E':
					decimalRound(digits, 1 + prec);
					break;
				case 'f':
					decimalRound(digits, digits.exp + prec);
					break;
				default:
					if (prec === 0) prec = 1;
					decimalRound(digits, prec);
			}
		}
		switch (format) {
			case 'e':
			case 'E':
				return sign + formatE(format, prec, digits);
			case 'f':
				return sign + formatF(prec, digits);
			default: {
				let exponentPrecision = prec;
				if (exponentPrecision > digits.mant.length && digits.mant.length >= digits.exp) exponentPrecision = digits.mant.length;
				if (shortest) exponentPrecision = 6;
				const exponent = digits.exp - 1;
				if (exponent < -4 || exponent >= exponentPrecision) {
					if (prec > digits.mant.length) prec = digits.mant.length;
					return sign + formatE(format === 'g' ? 'e' : 'E', prec - 1, digits);
				}
				if (prec > digits.exp) prec = digits.mant.length;
				return sign + formatF(Math.max(prec - digits.exp, 0), digits);
			}
		}
	}

	/**
	 * The number as Go's fmt writes a *big.Float for a verb: `e`, `E`, `f`, `g` or `G`, with its flags, width and
	 * precision. Without a precision, `e`, `E` and `f` write 6 digits after the point and `g` and `G` the fewest.
	 *
	 * @param verb the verb.
	 * @param spec its flags, width and precision.
	 */
	format(verb: 'e' | 'E' | 'f' | 'g' | 'G', spec: FormatSpec): string {
		const precision = spec.precision ?? (verb === 'g' || verb === 'G' ? -1 : 6);
		let body = this.text(verb, precision);
		let sign = '';
		if (body.startsWith('-')) {
			sign = '-';
			body = body.slice(1);
		} else if (body.startsWith('+')) {
			sign = spec.space ? ' ' : '+';
			body = body.slice(1);
		} else if (spec.plus) {
			sign = '+';
		} else if (spec.space) {
			sign = ' ';
		}
		const padding = spec.width !== undefined && spec.width > sign.length + body.length ? spec.width - sign.length - body.length : 0;
		if (spec.zero && this.form !== 'inf') return sign + '0'.repeat(padding) + body;
		if (spec.minus) return sign + body + ' '.repeat(padding);
		return ' '.repeat(padding) + sign + body;
	}

	/**
	 * The number's integer as Go's fmt writes a *big.Int for a verb: `b`, `d`, `o`, `x` or `X`, with its flags,
	 * width and precision, the precision being the least count of digits.
	 *
	 * @param verb the verb.
	 * @param spec its flags, width and precision.
	 * @throws Error when the number is not a whole number.
	 */
	formatInteger(verb: 'b' | 'd' | 'o' | 'x' | 'X', spec: FormatSpec): string {
		const { integer, accuracy } = this.truncate();
		if (accuracy !== 'exact' || integer === undefined) throw new Error('an integer is required');
		const negative = integer < 0n;
		const base = verb === 'b' ? 2 : verb === 'o' ? 8 : verb === 'd' ? 10 : 16;
		let digits = (negative ? -integer : integer).toString(base);
		if (verb === 'X') digits = digits.toUpperCase();
		const sign = negative ? '-' : spec.plus ? '+' : spec.space ? ' ' : '';
		let prefix = '';
		if (spec.sharp) prefix = verb === 'b' ? '0b' : verb === 'o' ? '0' : verb === 'x' ? '0x' : verb === 'X' ? '0X' : '';
		let zeros = 0;
		if (spec.precision !== undefined) {
			if (digits.length < spec.precision) zeros = spec.precision - digits.length;
			else if (digits === '0' && spec.precision === 0) return '';
		}
		let left = 0;
		let right = 0;
		const length = sign.length + prefix.length + zeros + digits.length;
		if (spec.width !== undefined && length < spec.width) {
			const pad = spec.width - length;
			if (spec.minus) right = pad;
			else if (spec.zero && spec.precision === undefined) zeros = pad;
			else left = pad;
		}
		return ' '.repeat(left) + sign + prefix + '0'.repeat(zeros) + digits + ' '.repeat(right);
	}

	/** The number as go-cty converts it to a string: the fewest decimal digits that read back to it, with no exponent. */
	toString(): string {
		return this.text('f', -1);
	}

	/**
	 * The number in a JSON document: its decimal text, written as it is by JSON.stringify.
	 *
	 * @throws Error for an infinity, which JSON has no number for, in go-cty's words.
	 */
	toJSON(): unknown {
		if (this.form === 'inf') throw new Error('cannot serialize infinity as JSON');
		return (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(this.toString());
	}

	/** The smallest precision the number is exact with, as Go's big.Float.MinPrec gives it; 0 for zero or an infinity. */
	minimumPrecision(): number {
		return this.form === 'finite' ? bitLength(this.mantissa) : 0;
	}

	/** Go's binary exponent of a finite number: the number is 0.m × 2^exponent with 0.5 <= 0.m < 1. */
	private exponent(): number {
		return bitLength(this.mantissa) + this.shift;
	}

	/** Go's big.Float.ord: -2 for -Inf, -1 negative, 0 zero, 1 positive, 2 for +Inf. */
	private order(): number {
		const magnitude = this.form === 'zero' ? 0 : this.form === 'finite' ? 1 : 2;
		return this.negative ? -magnitude : magnitude;
	}

	/** @internal */
	static make(negative: boolean, form: Form, mantissa: bigint, shift: number, precision: number): CtyNumber {
		return new CtyNumber(negative, form, mantissa, shift, precision);
	}

	/** @internal */
	parts(): { negative: boolean; form: Form; mantissa: bigint; shift: number } {
		return { negative: this.negative, form: this.form, mantissa: this.mantissa, shift: this.shift };
	}
}

function zero(negative: boolean, precision: number): CtyNumber {
	return CtyNumber.make(negative, 'zero', 0n, 0, precision);
}

function infinity(negative: boolean, precision: number): CtyNumber {
	return CtyNumber.make(negative, 'inf', 0n, 0, precision);
}

/** A finite nonzero number with an exact mantissa that already fits its precision, normalized to an odd mantissa. */
function finite(negative: boolean, mantissa: bigint, shift: number, precision: number): CtyNumber {
	const zeros = trailingZeroBits(mantissa);
	return CtyNumber.make(negative, 'finite', mantissa >> BigInt(zeros), shift + zeros, precision);
}

/**
 * Rounds m × 2^shift to a precision as Go's big.Float.setExpAndRound and round do: to nearest even, with the sticky
 * bit standing for nonzero bits already cut off below the mantissa; an exponent below Go's range gives zero and one
 * above it an infinity.
 */
function rounded(negative: boolean, mantissa: bigint, shift: number, precision: number, sticky = false): CtyNumber {
	const length = bitLength(mantissa);
	if (length + shift < MIN_EXP) return zero(negative, precision);
	let value = mantissa;
	let scale = shift;
	if (length > precision) {
		const cut = length - precision;
		const half = pow2(cut - 1);
		const roundBit = (value & half) !== 0n;
		const below = sticky || (value & (half - 1n)) !== 0n;
		value >>= BigInt(cut);
		scale += cut;
		if (roundBit && (below || (value & 1n) === 1n)) value += 1n;
	}
	if (bitLength(value) + scale > MAX_EXP) return infinity(negative, precision);
	return finite(negative, value, scale, precision);
}

/** Go's z.Set(x) for a z of the given precision: x rounded to it. */
function setTo(x: CtyNumber, precision: number): CtyNumber {
	const { negative, form, mantissa, shift } = x.parts();
	if (form !== 'finite') return CtyNumber.make(negative, form, 0n, 0, precision);
	return rounded(negative, mantissa, shift, precision);
}

/** Go's SetInt on a float of the given precision: the integer rounded to it; zero is positive. */
function setInteger(value: bigint, precision: number): CtyNumber {
	if (value === 0n) return zero(false, precision);
	const negative = value < 0n;
	return rounded(negative, negative ? -value : value, 0, precision);
}

/** An integer held with the given precision, which is at least its length. */
function fromInteger(value: bigint, precision: number): CtyNumber {
	return setInteger(value, precision);
}

/** Go's z.Add(x, y) for a z of the given precision. */
function addTo(x: CtyNumber, y: CtyNumber, precision: number): CtyNumber {
	const a = x.parts();
	const b = y.parts();
	if (a.form === 'finite' && b.form === 'finite') {
		const shift = Math.min(a.shift, b.shift);
		const left = a.mantissa << BigInt(a.shift - shift);
		const right = b.mantissa << BigInt(b.shift - shift);
		const sum = (a.negative ? -left : left) + (b.negative ? -right : right);
		if (sum === 0n) return zero(false, precision);
		return sum < 0n ? rounded(true, -sum, shift, precision) : rounded(false, sum, shift, precision);
	}
	if (a.form === 'inf' && b.form === 'inf' && a.negative !== b.negative) throw new NotANumber();
	if (a.form === 'zero' && b.form === 'zero') return zero(a.negative && b.negative, precision);
	if (a.form === 'inf' || b.form === 'zero') return setTo(x, precision);
	return setTo(y, precision);
}

/** Go's z.Mul(x, y) for a z of the given precision. */
function mulTo(x: CtyNumber, y: CtyNumber, precision: number): CtyNumber {
	const a = x.parts();
	const b = y.parts();
	const negative = a.negative !== b.negative;
	if (a.form === 'finite' && b.form === 'finite') return rounded(negative, a.mantissa * b.mantissa, a.shift + b.shift, precision);
	if ((a.form === 'zero' && b.form === 'inf') || (a.form === 'inf' && b.form === 'zero')) throw new NotANumber();
	if (a.form === 'inf' || b.form === 'inf') return infinity(negative, precision);
	return zero(negative, precision);
}

/** Go's z.Quo(x, y) for a z of the given precision. */
function quoTo(x: CtyNumber, y: CtyNumber, precision: number): CtyNumber {
	const a = x.parts();
	const b = y.parts();
	const negative = a.negative !== b.negative;
	if (a.form === 'finite' && b.form === 'finite') {
		// Enough quotient bits for the precision, a rounding bit and one more; the remainder is the sticky bit.
		const extra = Math.max(0, precision + 3 + bitLength(b.mantissa) - bitLength(a.mantissa));
		const numerator = a.mantissa << BigInt(extra);
		const quotient = numerator / b.mantissa;
		const remainder = numerator % b.mantissa;
		return rounded(negative, quotient, a.shift - b.shift - extra, precision, remainder !== 0n);
	}
	if ((a.form === 'zero' && b.form === 'zero') || (a.form === 'inf' && b.form === 'inf')) throw new NotANumber();
	if (a.form === 'zero' || b.form === 'inf') return zero(negative, precision);
	return infinity(negative, precision);
}

function compareMagnitudes(x: CtyNumber, y: CtyNumber): number {
	const a = x.parts();
	const b = y.parts();
	const shift = Math.min(a.shift, b.shift);
	const left = a.mantissa << BigInt(a.shift - shift);
	const right = b.mantissa << BigInt(b.shift - shift);
	return left < right ? -1 : left > right ? 1 : 0;
}

function nanAs(message: string, operation: () => CtyNumber): CtyNumber {
	try {
		return operation();
	} catch (error) {
		if (error instanceof NotANumber) throw new Error(message);
		throw error;
	}
}

/**
 * Go's big.ParseFloat(text, 10, precision, ToNearestEven), as go-cty's ParseNumberVal calls it: the digits are read
 * as one integer, scaled by the power of two the point and exponent give, and then multiplied or divided by the power
 * of five they give, which Go computes with 64 more bits than the result and rounds as it squares.
 */
function parseFloat(text: string, precision: number): CtyNumber | undefined {
	if (text === 'Inf' || text === 'inf') return infinity(false, precision);
	if (text.length === 4 && (text[0] === '+' || text[0] === '-') && (text.slice(1) === 'Inf' || text.slice(1) === 'inf')) {
		return infinity(text[0] === '-', precision);
	}
	let index = 0;
	if (text.length === 0) return undefined;
	const negative = text[0] === '-';
	if (text[0] === '-' || text[0] === '+') index++;

	let digits = '';
	let point = -1;
	let pointAllowed = true;
	for (; index < text.length; index++) {
		const character = text[index];
		if (character === '.' && pointAllowed) {
			pointAllowed = false;
			point = digits.length;
		} else if (character >= '0' && character <= '9') {
			digits += character;
		} else {
			break;
		}
	}
	if (digits.length === 0) return undefined;
	const fractionDigits = point >= 0 ? digits.length - point : 0;

	let exponent = 0n;
	let exponentBase = 10;
	const marker = text[index];
	if (marker === 'e' || marker === 'E' || marker === 'p' || marker === 'P') {
		exponentBase = marker === 'p' || marker === 'P' ? 2 : 10;
		index++;
		let exponentText = '';
		if (text[index] === '+' || text[index] === '-') {
			if (text[index] === '-') exponentText = '-';
			index++;
		}
		let exponentDigits = 0;
		for (; index < text.length && text[index] >= '0' && text[index] <= '9'; index++) {
			exponentText += text[index];
			exponentDigits++;
		}
		if (exponentDigits === 0) return undefined;
		exponent = BigInt(exponentText);
		if (exponent < -(2n ** 63n) || exponent > 2n ** 63n - 1n) return undefined;
	}
	if (index !== text.length) return undefined;

	const mantissa = BigInt(digits);
	if (mantissa === 0n) return zero(negative, precision);

	let exponent2 = BigInt(bitLength(mantissa)) - BigInt(fractionDigits);
	let exponent5 = -BigInt(fractionDigits);
	if (exponentBase === 10) exponent5 += exponent;
	exponent2 += exponent;
	if (exponent2 < BigInt(MIN_EXP) || exponent2 > BigInt(MAX_EXP)) return undefined;

	const length = bitLength(mantissa);
	const scaled = finite(negative, mantissa, Number(exponent2) - length, length);
	if (exponent5 === 0n) return setTo(scaled, precision);
	const power = powerOfFive(exponent5 < 0n ? -exponent5 : exponent5, precision + 64);
	return exponent5 < 0n ? quoTo(scaled, power, precision) : mulTo(scaled, power, precision);
}

/** Go's big.Float.pow5 for a float of the given precision: exact up to 5^27, then squared up with 64 more bits. */
function powerOfFive(exponent: bigint, precision: number): CtyNumber {
	if (exponent <= BigInt(POW5_TABLE_LIMIT)) return finite(false, pow5(Number(exponent)), 0, precision);
	let result = finite(false, pow5(POW5_TABLE_LIMIT), 0, precision);
	let remaining = exponent - BigInt(POW5_TABLE_LIMIT);
	let factor = finite(false, 5n, 0, precision + 64);
	while (remaining > 0n) {
		if ((remaining & 1n) === 1n) result = mulTo(result, factor, precision);
		factor = mulTo(factor, factor, precision + 64);
		remaining >>= 1n;
	}
	return result;
}

/** The exact decimal digits of m × 2^shift. */
function decimalOf(mantissa: bigint, shift: number): Decimal {
	let digits: string;
	let exponent: number;
	if (shift >= 0) {
		digits = (mantissa << BigInt(shift)).toString();
		exponent = digits.length;
	} else {
		digits = (mantissa * pow5(-shift)).toString();
		exponent = digits.length + shift;
	}
	return { mant: digits.replace(/0+$/u, ''), exp: exponent };
}

function trimDecimal(digits: Decimal): void {
	digits.mant = digits.mant.replace(/0+$/u, '');
	if (digits.mant.length === 0) digits.exp = 0;
}

function shouldRoundUp(digits: Decimal, n: number): boolean {
	if (digits.mant[n] === '5' && n + 1 === digits.mant.length) {
		return n > 0 && (digits.mant.charCodeAt(n - 1) - 48) % 2 !== 0;
	}
	return digits.mant[n] >= '5';
}

function decimalRound(digits: Decimal, n: number): void {
	if (n < 0 || n >= digits.mant.length) return;
	if (shouldRoundUp(digits, n)) decimalRoundUp(digits, n);
	else decimalRoundDown(digits, n);
}

function decimalRoundUp(digits: Decimal, n: number): void {
	if (n < 0 || n >= digits.mant.length) return;
	let end = n;
	while (end > 0 && digits.mant[end - 1] >= '9') end--;
	if (end === 0) {
		digits.mant = '1';
		digits.exp++;
		return;
	}
	digits.mant = digits.mant.slice(0, end - 1) + String.fromCharCode(digits.mant.charCodeAt(end - 1) + 1);
}

function decimalRoundDown(digits: Decimal, n: number): void {
	if (n < 0 || n >= digits.mant.length) return;
	digits.mant = digits.mant.slice(0, n);
	trimDecimal(digits);
}

function digitAt(digits: Decimal, index: number): string {
	return index >= 0 && index < digits.mant.length ? digits.mant[index] : '0';
}

/** Go's roundShortest: the fewest digits that lie within half a unit in the last place of the number's precision. */
function roundShortest(digits: Decimal, number: CtyNumber): void {
	if (digits.mant.length === 0) return;
	const { mantissa, shift } = number.parts();
	const length = bitLength(mantissa);
	const exponent = length + shift;
	// The mantissa with precision + 1 bits, so that its last bit is half a unit in the last place.
	const halfUnits = mantissa << BigInt(number.precision + 1 - length);
	const scale = exponent - number.precision - 1;
	const lower = decimalOf(halfUnits - 1n, scale);
	const upper = decimalOf(halfUnits + 1n, scale);
	const inclusive = (halfUnits & 2n) === 0n;
	for (let index = 0; index < digits.mant.length; index++) {
		const m = digits.mant[index];
		const l = digitAt(lower, index);
		const u = digitAt(upper, index);
		const okDown = l !== m || (inclusive && index + 1 === lower.mant.length);
		const okUp = m !== u && (inclusive || m.charCodeAt(0) + 1 < u.charCodeAt(0) || index + 1 < upper.mant.length
			|| (index >= upper.mant.length && m < '9'));
		if (okDown && okUp) {
			decimalRound(digits, index + 1);
			return;
		}
		if (okDown) {
			decimalRoundDown(digits, index + 1);
			return;
		}
		if (okUp) {
			decimalRoundUp(digits, index + 1);
			return;
		}
	}
}

/** Go's fmtE: d.ddddde±dd, with at least two exponent digits. */
function formatE(format: 'e' | 'E', precision: number, digits: Decimal): string {
	let out = digits.mant.length > 0 ? digits.mant[0] : '0';
	if (precision > 0) {
		out += '.';
		let index = 1;
		const end = Math.min(digits.mant.length, precision + 1);
		if (index < end) {
			out += digits.mant.slice(index, end);
			index = end;
		}
		for (; index <= precision; index++) out += '0';
	}
	out += format;
	let exponent = digits.mant.length > 0 ? digits.exp - 1 : 0;
	let sign = '+';
	if (exponent < 0) {
		sign = '-';
		exponent = -exponent;
	}
	return `${out}${sign}${exponent < 10 ? '0' : ''}${exponent}`;
}

/** Go's fmtF: ddddd.ddddd. */
function formatF(precision: number, digits: Decimal): string {
	let out: string;
	if (digits.exp > 0) {
		const end = Math.min(digits.mant.length, digits.exp);
		out = digits.mant.slice(0, end) + '0'.repeat(digits.exp - end);
	} else {
		out = '0';
	}
	if (precision > 0) {
		out += '.';
		for (let index = 0; index < precision; index++) out += digitAt(digits, digits.exp + index);
	}
	return out;
}

/**
 * Reads an integer as Go's big.Int.SetString does with a base from 2 to 62, as go-cty's parseint calls it: an
 * optional sign and digits, the letters standing for 10 to 35 in either case up to base 36, and above it the lower
 * case letters for 10 to 35 and the upper case for 36 to 61.
 *
 * @param text the integer.
 * @param base the base.
 * @returns the integer, or undefined when the text is not one in that base.
 */
export function parseGoInteger(text: string, base: number): bigint | undefined {
	let index = 0;
	if (text.length === 0) return undefined;
	const negative = text[0] === '-';
	if (text[0] === '-' || text[0] === '+') index++;
	let value = 0n;
	let count = 0;
	const radix = BigInt(base);
	for (; index < text.length; index++) {
		const code = text.charCodeAt(index);
		let digit: number;
		if (code >= 48 && code <= 57) digit = code - 48;
		else if (code >= 97 && code <= 122) digit = code - 97 + 10;
		else if (code >= 65 && code <= 90) digit = base <= 36 ? code - 65 + 10 : code - 65 + 36;
		else break;
		if (digit >= base) break;
		value = value * radix + BigInt(digit);
		count++;
	}
	if (count === 0 || index !== text.length) return undefined;
	return negative ? -value : value;
}
