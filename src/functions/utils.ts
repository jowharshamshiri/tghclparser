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

// Converts an arbitrary JS value (as produced by JSON.parse, yaml.load, CSV
// decoding, or an inline function body) into a RuntimeValue tree.
//
// When `label` is supplied, values with no HCL representation — functions,
// symbols, undefined, non-finite numbers, and cyclic structures — raise an error
// naming the offending path instead of being coerced. Callers that decode
// already-validated JSON omit the label and keep the historical coercion of
// unrepresentable values to null, which JSON parsing can never produce anyway.
export function convertToRuntimeValue(value: unknown, label?: string): RuntimeValue<ValueType> {
    return convertValue(value, label, label ?? '', new Set());
}

function convertValue(
    value: unknown,
    label: string | undefined,
    path: string,
    seen: Set<object>
): RuntimeValue<ValueType> {
    if (typeof value === 'string') return makeStringValue(value);
    if (typeof value === 'number') {
        if (label !== undefined && !Number.isFinite(value)) {
            throw new Error(`${path} is ${String(value)}, which has no HCL representation`);
        }
        return makeNumberValue(value);
    }
    if (typeof value === 'boolean') return makeBooleanValue(value);
    if (value === null) return makeNullValue();

    if (typeof value === 'object') {
        if (seen.has(value)) {
            throw new Error(`${path} contains a circular reference, which has no HCL representation`);
        }
        seen.add(value);
        try {
            if (Array.isArray(value)) {
                return makeArrayValue(value.map((entry, index) =>
                    convertValue(entry, label, `${path}[${index}]`, seen)));
            }
            const map = new Map<string, RuntimeValue<ValueType>>();
            for (const [key, entry] of Object.entries(value)) {
                map.set(key, convertValue(entry, label, `${path}.${key}`, seen));
            }
            return makeObjectValue(map);
        } finally {
            seen.delete(value);
        }
    }

    if (label !== undefined) {
        const kind = value === undefined ? 'undefined' : typeof value;
        throw new Error(`${path} is ${kind}, which has no HCL representation`);
    }
    return makeNullValue();
}

// Converts a RuntimeValue tree into plain JS (objects become plain records
// with keys in sorted order so JSON output matches deterministic serialization).
// Sensitive values are unwrapped to the value they protect: the wrapper marks
// how a value is displayed, not what it is.
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
        default: {
            if ((value.type as string) === 'sensitive') {
                return runtimeToPlain(value.value as RuntimeValue<ValueType>);
            }
            throw new Error(`Value of type ${String(value.type)} has no plain representation`);
        }
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
