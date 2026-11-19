import { CtyNumber } from '../cty-number';
import type { RuntimeValue, ValueType } from '../model';

export const makeStringValue = (value: string): RuntimeValue<'string'> => ({
    type: 'string',
    value
});

export const makeNumberValue = (value: CtyNumber): RuntimeValue<'number'> => ({
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

/** The name go-cty gives a value's type in a conversion error. */
function friendlyTypeName(value: RuntimeValue<ValueType>): string {
    switch (value.type) {
        case 'boolean':
            return 'bool';
        case 'array':
            return 'tuple';
        case 'object':
        case 'block':
            return 'object';
        default:
            return value.type;
    }
}

/**
 * A value converted to a number as go-cty's convert does it: a number as it is, and a string read as go-cty's
 * ParseNumberVal reads it.
 *
 * @param value a value that is not null and not sensitive.
 * @returns the number.
 * @throws Error with go-cty's message when the value does not convert.
 */
export function convertToNumber(value: RuntimeValue<ValueType>): CtyNumber {
    if (value.type === 'number') return value.value as CtyNumber;
    if (value.type === 'string') return CtyNumber.parse(String(value.value));
    throw new Error(`number required, but have ${friendlyTypeName(value)}`);
}

/**
 * Whether two values are equal as go-cty's Equals decides it: values of different types never are, nulls always
 * are, numbers are compared as {@link CtyNumber.equals} compares them, and collections element by element.
 */
export function ctyEquals(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): boolean {
    const a = unwrapSensitive(left);
    const b = unwrapSensitive(right);
    if (a.type === 'null' || b.type === 'null') return a.type === b.type;
    const objectLike = (value: RuntimeValue<ValueType>) => value.type === 'object' || value.type === 'block';
    if (objectLike(a) && objectLike(b)) {
        const ours = a.value as Map<string, RuntimeValue<ValueType>>;
        const theirs = b.value as Map<string, RuntimeValue<ValueType>>;
        if (ours.size !== theirs.size) return false;
        for (const [key, value] of ours) {
            const other = theirs.get(key);
            if (other === undefined || !ctyEquals(value, other)) return false;
        }
        return true;
    }
    if (a.type !== b.type) return false;
    switch (a.type) {
        case 'number':
            return (a.value as CtyNumber).equals(b.value as CtyNumber);
        case 'array': {
            const ours = a.value as RuntimeValue<ValueType>[];
            const theirs = b.value as RuntimeValue<ValueType>[];
            return ours.length === theirs.length && ours.every((value, index) => ctyEquals(value, theirs[index]));
        }
        default:
            return a.value === b.value;
    }
}

/**
 * Refuses a call to a Terragrunt function with a number of arguments it does not take, in Terragrunt's own words. Its
 * go-cty parameter is variadic, so HCL counts nothing and the function counts for itself.
 *
 * @param args the call's arguments.
 * @param counts the numbers of arguments the function takes, in increasing order.
 * @param name the function.
 */
export function expectParams(args: RuntimeValue<ValueType>[], counts: number[], name: string): void {
    if (counts.includes(args.length)) return;
    const expected = counts.length < 3 ? counts.join(' or ') : `${counts.slice(0, -1).join(', ')}, or ${counts.at(-1)}`;
    throw new Error(`Expected ${expected} params for function ${name}, but got ${args.length}`);
}

/**
 * Orders two strings as Go compares them, and so as go-cty orders an object's attributes and a map's keys: by their
 * UTF-8 bytes, which is the order of their code points. JavaScript compares UTF-16 code units instead, which puts a
 * character above U+FFFF, stored as a surrogate pair, before one from U+E000 to U+FFFF.
 */
export function compareStrings(left: string, right: string): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const leftUnit = left.charCodeAt(index);
        const rightUnit = right.charCodeAt(index);
        if (leftUnit === rightUnit) continue;
        const leftSurrogate = leftUnit >= 0xd800 && leftUnit <= 0xdfff;
        const rightSurrogate = rightUnit >= 0xd800 && rightUnit <= 0xdfff;
        if (leftSurrogate !== rightSurrogate) return leftSurrogate ? 1 : -1;
        return leftUnit - rightUnit;
    }
    return left.length - right.length;
}

/**
 * Marks the values of a document read from a file sops could not decrypt: every string sops stored encrypted, which
 * it writes as `ENC[...]`, so an editor can show that the value is there without showing it.
 *
 * @param value the decoded document.
 * @returns the same document with its encrypted strings marked.
 */
export function markEncrypted(value: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
    switch (value.type) {
        case 'string':
            return typeof value.value === 'string' && value.value.startsWith('ENC[') ? { ...value, encrypted: true } : value;
        case 'array':
            return makeArrayValue((value.value as RuntimeValue<ValueType>[]).map(markEncrypted));
        case 'object':
        case 'block': {
            const entries = [...(value.value as Map<string, RuntimeValue<ValueType>>)].map(([key, entry]) => [key, markEncrypted(entry)] as const);
            return { ...value, value: new Map(entries) } as RuntimeValue<ValueType>;
        }
        default:
            return value;
    }
}

/**
 * Reads a JSON document as go-cty's JSON decoder does: each number from its own text, as go-cty's ParseNumberVal
 * reads it, so that no digit is lost to a float64.
 *
 * @param text the document.
 * @returns the document, its numbers as {@link CtyNumber}s, for {@link convertToRuntimeValue}.
 * @throws SyntaxError when the text is not JSON.
 */
export function parseJsonDocument(text: string): unknown {
    const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
        if (typeof value !== 'number') return value;
        if (context?.source === undefined) throw new Error('JSON.parse gave no source text for a number');
        return CtyNumber.parse(context.source);
    };
    return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

// Converts an arbitrary JS value (as produced by parseJsonDocument, yaml.load,
// CSV decoding, or an inline function body) into a RuntimeValue tree. A JS
// number is taken as go-cty's NumberFloatVal takes a float64; a CtyNumber as it
// is.
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
    if (value instanceof CtyNumber) return makeNumberValue(value);
    if (typeof value === 'number') {
        if (label !== undefined && !Number.isFinite(value)) {
            throw new Error(`${path} is ${String(value)}, which has no HCL representation`);
        }
        return makeNumberValue(CtyNumber.fromFloat64(value));
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
// A number stays a CtyNumber, which JSON.stringify writes as its exact decimal
// text. Sensitive values are unwrapped to the value they protect: the wrapper
// marks how a value is displayed, not what it is.
export function runtimeToPlain(value: RuntimeValue<ValueType>): unknown {
    return plainValue(value, number => number);
}

/**
 * A value as an inline function's JavaScript body receives it: as {@link runtimeToPlain} gives it, with each number
 * a JavaScript number, converted as go-cty converts a number for a function that computes with a float64.
 */
export function runtimeToJavaScript(value: RuntimeValue<ValueType>): unknown {
    return plainValue(value, number => number.toGoFloat64());
}

function plainValue(value: RuntimeValue<ValueType>, number: (value: CtyNumber) => unknown): unknown {
    switch (value.type) {
        case 'number':
            return number(value.value as CtyNumber);
        case 'string':
        case 'boolean':
            return value.value;
        case 'null':
            return null;
        case 'array':
            return (value.value as RuntimeValue<ValueType>[]).map(entry => plainValue(entry, number));
        case 'object':
        case 'block': {
            const map = value.value as Map<string, RuntimeValue<ValueType>>;
            const out: Record<string, unknown> = {};
            for (const key of [...map.keys()].sort(compareStrings)) out[key] = plainValue(map.get(key)!, number);
            return out;
        }
        default: {
            if ((value.type as string) === 'sensitive') {
                return plainValue(value.value as RuntimeValue<ValueType>, number);
            }
            throw new Error(`Value of type ${String(value.type)} has no plain representation`);
        }
    }
}

// HCL string coercion: how a value renders inside a string interpolation. A
// number is written as go-cty converts it to a string.
export function coerceToString(value: RuntimeValue<ValueType>): string {
    switch (value.type) {
        case 'number':
            return (value.value as CtyNumber).toString();
        case 'string':
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

export function coerceToBool(sensitiveOrValue: RuntimeValue<ValueType>): boolean {
    const value = unwrapSensitive(sensitiveOrValue);
    switch (value.type) {
        case 'boolean':
            return Boolean(value.value);
        case 'string':
            return String(value.value).length > 0;
        case 'number':
            return !(value.value as CtyNumber).isZero();
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
