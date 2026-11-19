import { runtimeValueToPlain } from '../src/Evaluator';
import type { RuntimeValue, ValueType } from '../src/model';

/**
 * A value as {@link runtimeValueToPlain} gives it, with each number as the JavaScript number written with the same
 * decimal text, for comparing with literals. A number whose text no float64 writes the same fails the test, so no
 * test compares a number it has rounded: such a number is compared by its text, with {@link jsonText}.
 *
 * @param value the evaluated value.
 * @returns the plain value.
 */
export function plainValue(value: RuntimeValue<ValueType>): unknown {
	const reviver = (_key: string, item: unknown, context?: { source?: string }): unknown => {
		if (typeof item !== 'number') return item;
		const text = context?.source ?? '';
		if (text !== '-0' && String(item) !== text) throw new Error(`${text} is not written the same as a float64; compare it by its text`);
		return item;
	};
	return JSON.parse(jsonText(value), reviver as (key: string, item: unknown) => unknown);
}

/**
 * A value as JSON, each number written as the text the evaluator gives it.
 *
 * @param value the evaluated value.
 * @returns the JSON text.
 */
export function jsonText(value: RuntimeValue<ValueType>): string {
	return JSON.stringify(runtimeValueToPlain(value));
}
