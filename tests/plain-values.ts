import { CtyNumber } from '../src/cty-number';
import { runtimeValueToPlain } from '../src/Evaluator';
import type { RuntimeValue, ValueType } from '../src/model';

/**
 * A value as {@link runtimeValueToPlain} gives it, with each number as the JavaScript number written with the same
 * decimal text, for comparing with literals. A number whose text no float64 writes the same fails the test, so no
 * test compares a number it has rounded: such a number is compared by its text.
 *
 * @param value the evaluated value.
 * @returns the plain value.
 */
export function plainValue(value: RuntimeValue<ValueType>): unknown {
	return withJavaScriptNumbers(runtimeValueToPlain(value));
}

function withJavaScriptNumbers(value: unknown): unknown {
	if (value instanceof CtyNumber) {
		const text = value.toString();
		const number = text === '-0' ? -0 : Number(text);
		if (!Object.is(number, -0) && String(number) !== text) throw new Error(`${text} is not written the same as a float64; compare it by its text`);
		return number;
	}
	if (Array.isArray(value)) return value.map(withJavaScriptNumbers);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withJavaScriptNumbers(item)]));
	}
	return value;
}
