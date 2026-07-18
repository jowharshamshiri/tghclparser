import type { RuntimeValue, ValueType } from "~/model";

export const makeStringValue = (value: string): RuntimeValue<'string'> => ({
    type: 'string',
    value
});


export const makeArrayValue = (value: RuntimeValue<ValueType>[]): RuntimeValue<'array'> => ({
    type: 'array',
    value
});

export const makeBooleanValue = (value: boolean): RuntimeValue<'boolean'> => ({
	type: 'boolean',
	value
});