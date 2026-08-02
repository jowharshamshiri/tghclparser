import type { RuntimeValue, ValueType } from '../model';

export const makeStringValue = (value: string): RuntimeValue<'string'> => ({
    type: 'string',
    value
});

export const makeNumberValue = (value: number): RuntimeValue<'number'> => ({
    type: 'number',
    value
});

export const makeBooleanValue = (value: boolean): RuntimeValue<'boolean'> => ({
	type: 'boolean',
	value
});

export const makeNullValue = (): RuntimeValue<'null'> => ({
    type: 'null',
    value: null
});

export const makeArrayValue = (value: RuntimeValue<ValueType>[]): RuntimeValue<'array'> => ({
    type: 'array',
    value
});

export const makeObjectValue = (value: Map<string, RuntimeValue<ValueType>>): RuntimeValue<'object'> => ({
    type: 'object',
    value
});

export const makeSensitiveValue = (value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => ({
    type: 'sensitive' as unknown as ValueType,
    value
});

export const unwrapSensitive = (value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => {
    if ((value.type as unknown) === 'sensitive' && value.value && typeof value.value === 'object' && 'type' in value.value) {
        return value.value as unknown as RuntimeValue<ValueType>;
    }
    return value;
};

// Converts an arbitrary JS value (as produced by JSON.parse, yaml.load, or CSV
// decoding) into a RuntimeValue tree.
export function convertToRuntimeValue(value: unknown): RuntimeValue<ValueType> {
    if (typeof value === 'string') return makeStringValue(value);
    if (typeof value === 'number') return makeNumberValue(value);
    if (typeof value === 'boolean') return makeBooleanValue(value);
    if (value === null) return makeNullValue();
    if (Array.isArray(value)) return makeArrayValue(value.map(convertToRuntimeValue));
    if (typeof value === 'object') {
        const map = new Map<string, RuntimeValue<ValueType>>();
        for (const [key, entry] of Object.entries(value)) map.set(key, convertToRuntimeValue(entry));
        return makeObjectValue(map);
    }
    return makeNullValue();
}

// Converts a RuntimeValue tree into plain JS (objects become plain records
// with keys in sorted order so JSON output matches deterministic serialization).
export function runtimeToPlain(value: RuntimeValue<ValueType>): unknown {
    switch (value.type) {
        case 'string':
        case 'number':
        case 'boolean':
            return value.value;
        case 'null':
            return null;
        case 'array':
            return (value.value as RuntimeValue<ValueType>[]).map(runtimeToPlain);
        case 'object':
        case 'block': {
            const map = value.value as Map<string, RuntimeValue<ValueType>>;
            const out: Record<string, unknown> = {};
            for (const key of [...map.keys()].sort()) out[key] = runtimeToPlain(map.get(key)!);
            return out;
        }
        default:
            return null;
    }
}

// HCL string coercion: how a value renders inside a string interpolation.
export function coerceToString(value: RuntimeValue<ValueType>): string {
    switch (value.type) {
        case 'string':
        case 'number':
        case 'boolean':
            return String(value.value);
        case 'null':
            return '';
        case 'array':
            return (value.value as RuntimeValue<ValueType>[]).map(coerceToString).join('');
        case 'object':
        case 'block': {
            const map = value.value as Map<string, RuntimeValue<ValueType>>;
            return [...map.entries()].map(([key, entry]) => `${key}=${coerceToString(entry)}`).join(',');
        }
        default:
            return '';
    }
}

export function coerceToBool(value: RuntimeValue<ValueType>): boolean {
    switch (value.type) {
        case 'boolean':
            return Boolean(value.value);
        case 'string':
            return String(value.value).length > 0;
        case 'number':
            return Number(value.value) !== 0;
        case 'array':
            return (value.value as RuntimeValue<ValueType>[]).length > 0;
        case 'object':
        case 'block':
            return (value.value as Map<string, RuntimeValue<ValueType>>).size > 0;
        case 'null':
            return false;
        default:
            return false;
    }
}
