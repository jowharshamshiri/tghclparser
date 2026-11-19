import { CtyNumber } from './cty-number';
import { convertToNumber, ctyEquals, makeBooleanValue, makeNumberValue, makeSensitiveValue, unwrapSensitive } from './functions/utils';
import type { RuntimeValue, ValueType } from './model';

/**
 * HCL's operators as hclsyntax v2.25.0 applies them to go-cty values: each operand is converted to the type the
 * operation takes, and the operation is go-cty's function for it. A result computed from a sensitive operand is
 * sensitive.
 */

const isSensitive = (value: RuntimeValue<ValueType>): boolean => (value.type as string) === 'sensitive';

function marked(result: RuntimeValue<ValueType>, operands: RuntimeValue<ValueType>[]): RuntimeValue<ValueType> {
	return operands.some(isSensitive) ? makeSensitiveValue(result) : result;
}

/**
 * An operand converted to a number, as HCL converts it before it calls the operation.
 *
 * @param value the operand.
 * @param side which operand it is, as HCL names it: `left`, `right` or `unary`.
 * @returns the number, or null for a null operand, which the operation itself refuses.
 * @throws Error in HCL's words when the operand does not convert.
 */
function numberOperand(value: RuntimeValue<ValueType>, side: string): CtyNumber | null {
	const operand = unwrapSensitive(value);
	if (operand.type === 'null') return null;
	try {
		return convertToNumber(operand);
	} catch (error) {
		throw new Error(`Unsuitable value for ${side} operand: ${error instanceof Error ? error.message : String(error)}.`);
	}
}

function operation(compute: () => RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	try {
		return compute();
	} catch (error) {
		throw new Error(`Error during operation: ${error instanceof Error ? error.message : String(error)}.`);
	}
}

function numbersOf(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): [CtyNumber, CtyNumber] {
	const a = numberOperand(left, 'left');
	const b = numberOperand(right, 'right');
	if (a === null || b === null) throw new Error('Error during operation: argument must not be null.');
	return [a, b];
}

/**
 * `+`, `-`, `*`, `/` or `%` as HCL computes it.
 *
 * @param operator the operator.
 * @param left the left operand.
 * @param right the right operand.
 * @returns the number.
 * @throws Error in HCL's words when an operand is not a number or the operation fails.
 */
export function arithmetic(operator: string, left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	const [a, b] = numbersOf(left, right);
	const result = operation(() => {
		switch (operator) {
			case '+': return makeNumberValue(a.add(b));
			case '-': return makeNumberValue(a.subtract(b));
			case '*': return makeNumberValue(a.multiply(b));
			case '/': return makeNumberValue(a.divide(b));
			case '%': return makeNumberValue(a.modulo(b));
			default: throw new Error(`unknown arithmetic operator "${operator}"`);
		}
	});
	return marked(result, [left, right]);
}

/**
 * Unary `-` as HCL computes it.
 *
 * @param operand the operand.
 * @returns the number negated.
 */
export function negation(operand: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	const number = numberOperand(operand, 'unary');
	if (number === null) throw new Error('Error during operation: argument must not be null.');
	return marked(makeNumberValue(number.negate()), [operand]);
}

/**
 * `==`, `!=`, `<`, `<=`, `>` or `>=` as HCL computes it: equality takes values of any type as they are, and the
 * orderings convert their operands to numbers, `<=` and `>=` being the ordering or go-cty's equality.
 *
 * @param operator the operator.
 * @param left the left operand.
 * @param right the right operand.
 * @returns the bool.
 */
export function comparison(operator: string, left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	if (operator === '==' || operator === '!=') {
		const equal = ctyEquals(left, right);
		return marked(makeBooleanValue(operator === '==' ? equal : !equal), [left, right]);
	}
	const [a, b] = numbersOf(left, right);
	const order = a.compare(b);
	let result: boolean;
	switch (operator) {
		case '<': result = order < 0; break;
		case '<=': result = order < 0 || a.equals(b); break;
		case '>': result = order > 0; break;
		case '>=': result = order > 0 || a.equals(b); break;
		default: throw new Error(`Unknown comparison operator "${operator}"`);
	}
	return marked(makeBooleanValue(result), [left, right]);
}

/**
 * The position a key selects in a list or tuple, as HCL's Index finds it: the key is converted to a number, which
 * must be a whole number from zero up to the last element.
 *
 * @param length the sequence's length.
 * @param key the key.
 * @returns the position.
 * @throws Error in HCL's words when the key selects no element.
 */
export function sequencePosition(length: number, key: RuntimeValue<ValueType>): number {
	const value = unwrapSensitive(key);
	if (value.type === 'null') throw new Error("Can't use a null value as an indexing key.");
	const prefix = 'The given key does not identify an element in this collection value';
	let number: CtyNumber;
	try {
		number = convertToNumber(value);
	} catch (error) {
		throw new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}.`);
	}
	const { integer, accuracy } = number.truncate();
	if (integer !== undefined && accuracy === 'exact' && integer >= 0n && integer < BigInt(length)) return Number(integer);
	if (number.isInfinite()) throw new Error(`${prefix}.`);
	if (accuracy !== 'exact') throw new Error(`${prefix}: indexing a sequence requires a whole number, but the given index has a fractional part.`);
	if (number.sign() < 0) throw new Error(`${prefix}: a negative number is not a valid index for a sequence.`);
	if (length === 0) throw new Error(`${prefix}: the collection has no elements.`);
	throw new Error(`${prefix}: the given index is greater than or equal to the length of the collection.`);
}
