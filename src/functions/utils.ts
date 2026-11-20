import { crc32 } from 'node:zlib';

import { CtyNumber } from '../cty-number';
import { type CtyType, ctyBool, ctyDynamic, ctyNumber, ctyString, friendlyName, mapOf, listOf, objectOf, setOf, tupleOf, typeEquals } from '../cty-types';
import { goQuoted } from '../go-quote';
import type { RuntimeValue, ValueType } from '../model';

// A string value is NFC-normalized as it is made, as go-cty normalizes every string on entry, so two spellings of
// one character are one string wherever strings are compared, counted or written out.
export const makeStringValue = (value: string): RuntimeValue<'string'> => ({
    type: 'string',
    value: value.normalize('NFC')
});

export const makeNumberValue = (value: CtyNumber): RuntimeValue<'number'> => ({
    type: 'number',
    value
});

export const makeBooleanValue = (value: boolean): RuntimeValue<'boolean'> => ({
	type: 'boolean',
	value
});

/** A null of a go-cty type: HCL's `null` keyword is a null of the dynamic pseudo-type. */
export const makeNullValue = (type: CtyType): RuntimeValue<'null'> => ({
    type: 'null',
    value: null,
    ctyType: type
});

export const makeArrayValue = (value: RuntimeValue<ValueType>[]): RuntimeValue<'array'> => ({
    type: 'array',
    value
});

// An object's attribute names are NFC-normalized as go-cty normalizes them; the map is kept when they already are.
export const makeObjectValue = (value: Map<string, RuntimeValue<ValueType>>): RuntimeValue<'object'> => ({
    type: 'object',
    value: [...value.keys()].every(key => key === key.normalize('NFC'))
        ? value
        : new Map([...value].map(([key, entry]) => [key.normalize('NFC'), entry]))
});

/** Refuses an element whose type is not the collection's element type: the evaluator built the collection wrongly. */
function checkElements(kind: string, element: CtyType, values: Iterable<RuntimeValue<ValueType>>): void {
    for (const value of values) {
        const type = valueType(value);
        if (!typeEquals(type, element)) {
            throw new TypeError(`a ${kind} of ${friendlyName(element)} cannot hold a value of type ${friendlyName(type)}`);
        }
    }
}

/**
 * A go-cty list: its elements in order, each of the element type.
 *
 * @param element the element type.
 * @param values the elements.
 * @throws TypeError when an element is of another type.
 */
export function makeListValue(element: CtyType, values: RuntimeValue<ValueType>[]): RuntimeValue<'array'> {
    checkElements('list', element, values);
    return { type: 'array', value: values, ctyType: listOf(element) };
}

/**
 * A go-cty set: the distinct elements, each of the element type, in the order go-cty iterates a set.
 *
 * @param element the element type.
 * @param values the elements, in any order and with any repeats.
 * @throws TypeError when an element is of another type.
 */
export function makeSetValue(element: CtyType, values: RuntimeValue<ValueType>[]): RuntimeValue<'array'> {
    checkElements('set', element, values);
    // go-cty looks for an equal element only among those of the same hash, so 0 and -0, which hash apart, are both kept.
    const distinct: RuntimeValue<ValueType>[] = [];
    for (const value of values) {
        const bucket = setBucket(value);
        if (!distinct.some(existing => setBucket(existing) === bucket && ctyEquals(existing, value))) distinct.push(value);
    }
    return { type: 'array', value: setOrder(distinct), ctyType: setOf(element) };
}

/**
 * A go-cty map: its elements by key, each of the element type, kept in the order of their keys' bytes, as go-cty
 * iterates a map.
 *
 * @param element the element type.
 * @param entries the elements by key.
 * @throws TypeError when an element is of another type.
 */
export function makeMapValue(element: CtyType, entries: Map<string, RuntimeValue<ValueType>>): RuntimeValue<'object'> {
    checkElements('map', element, entries.values());
    const normalized = [...entries].map(([key, entry]) => [key.normalize('NFC'), entry] as const);
    normalized.sort(([left], [right]) => compareStrings(left, right));
    return { type: 'object', value: new Map(normalized), ctyType: mapOf(element) };
}

/**
 * A value's go-cty type. A mark such as sensitivity is not part of it.
 *
 * @param value the value.
 * @returns its type.
 * @throws TypeError for a null that carries no type, or a value that is not data.
 */
export function valueType(value: RuntimeValue<ValueType>): CtyType {
    const plain = unwrapSensitive(value);
    switch (plain.type) {
        case 'string':
            return ctyString;
        case 'number':
            return ctyNumber;
        case 'boolean':
            return ctyBool;
        case 'null':
            if (!plain.ctyType) throw new TypeError('a null value carries no type');
            return plain.ctyType;
        case 'array':
            return plain.ctyType ?? tupleOf((plain.value as RuntimeValue<ValueType>[]).map(valueType));
        case 'object':
        case 'block': {
            if (plain.ctyType) return plain.ctyType;
            const attributes = new Map<string, CtyType>();
            for (const [name, entry] of plain.value as Map<string, RuntimeValue<ValueType>>) attributes.set(name, valueType(entry));
            return objectOf(attributes);
        }
        default:
            throw new TypeError(`a value of kind ${String(plain.type)} has no type`);
    }
}

/**
 * The bytes go-cty hashes a value by to place it in a set, and orders a set of other than primitives by: a number
 * as big.Float's String writes it, a string quoted as Go quotes it, and collections and structures by their elements.
 */
function setHashBytes(value: RuntimeValue<ValueType>): string {
    const plain = unwrapSensitive(value);
    switch (plain.type) {
        case 'null':
            return '~';
        case 'number':
            return (plain.value as CtyNumber).text('g', 10);
        case 'boolean':
            return plain.value ? 'T' : 'F';
        case 'string':
            return goQuoted(String(plain.value));
        default:
            break;
    }
    const type = valueType(plain);
    switch (type.kind) {
        case 'map':
            return `{${[...(plain.value as Map<string, RuntimeValue<ValueType>>)].map(([key, entry]) => `${goQuoted(key)}:${setHashBytes(entry)};`).join('')}}`;
        case 'list':
        case 'set':
            return `[${(plain.value as RuntimeValue<ValueType>[]).map(entry => `${setHashBytes(entry)};`).join('')}]`;
        case 'tuple':
            return `<${(plain.value as RuntimeValue<ValueType>[]).map(entry => `${setHashBytes(entry)};`).join('')}>`;
        case 'object': {
            const map = plain.value as Map<string, RuntimeValue<ValueType>>;
            return `<${[...map.keys()].sort(compareStrings).map(name => `${setHashBytes(map.get(name)!)};`).join('')}>`;
        }
        default:
            throw new TypeError(`a value of type ${friendlyName(type)} has no set hash`);
    }
}

/**
 * go-cty's setRules.Less: a null after every other value; strings by their bytes, numbers by value, false before
 * true, and anything else by its set hash bytes.
 */
function setLess(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): boolean {
    const a = unwrapSensitive(left);
    const b = unwrapSensitive(right);
    if (a.type === 'null' || b.type === 'null') return a.type !== 'null' && b.type === 'null';
    if (a.type === 'string' && b.type === 'string') return compareStrings(String(a.value), String(b.value)) < 0;
    if (a.type === 'number' && b.type === 'number') return (a.value as CtyNumber).compare(b.value as CtyNumber) < 0;
    if (a.type === 'boolean' && b.type === 'boolean') return !a.value && Boolean(b.value);
    return Buffer.compare(Buffer.from(setHashBytes(a)), Buffer.from(setHashBytes(b))) < 0;
}

/**
 * A set's distinct elements in the order go-cty's Set.Values gives them: by the bucket each hashes to (the CRC-32 of
 * its set hash bytes), then stably by {@link setLess}.
 */
/** The bucket go-cty's set puts a value in: the CRC-32 of its set hash bytes. */
function setBucket(value: RuntimeValue<ValueType>): number {
    return crc32(Buffer.from(setHashBytes(value)));
}

function setOrder(values: RuntimeValue<ValueType>[]): RuntimeValue<ValueType>[] {
    const buckets = values.map(value => ({ value, bucket: setBucket(value) }));
    buckets.sort((left, right) => left.bucket - right.bucket);
    const ordered = buckets.map(entry => entry.value);
    // Array.prototype.sort is stable, as Go's sort.SliceStable is.
    ordered.sort((left, right) => (setLess(left, right) ? -1 : setLess(right, left) ? 1 : 0));
    return ordered;
}

/**
 * The name go-cty gives a value's type in a message, its FriendlyName: such as `bool`, `tuple` or `list of string`.
 *
 * @param value the value; a mark such as sensitivity is not part of its type.
 * @returns the type's name.
 */
export function friendlyTypeName(value: RuntimeValue<ValueType>): string {
    return friendlyName(valueType(value));
}

export const makeSensitiveValue =(value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => ({
    type: 'sensitive' as unknown as ValueType,
    value
});

export const unwrapSensitive = (value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => {
    if ((value.type as unknown) === 'sensitive' && value.value && typeof value.value === 'object' && 'type' in value.value) {
        return value.value as unknown as RuntimeValue<ValueType>;
    }
    return value;
};

/**
 * Whether two values are equal as go-cty's Equals decides it for known values: two nulls always are, a null and
 * another value never are, values of different types never are, numbers are compared as {@link CtyNumber.equals}
 * compares them, sets by their members, and the rest element by element. A mark such as sensitivity plays no part.
 */
export function ctyEquals(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): boolean {
    const a = unwrapSensitive(left);
    const b = unwrapSensitive(right);
    if (a.type === 'null' || b.type === 'null') return a.type === b.type;
    const type = valueType(a);
    if (!typeEquals(type, valueType(b))) return false;
    switch (type.kind) {
        case 'number':
            return (a.value as CtyNumber).equals(b.value as CtyNumber);
        case 'string':
        case 'bool':
            return a.value === b.value;
        case 'list':
        case 'tuple': {
            const ours = a.value as RuntimeValue<ValueType>[];
            const theirs = b.value as RuntimeValue<ValueType>[];
            return ours.length === theirs.length && ours.every((value, index) => ctyEquals(value, theirs[index]));
        }
        case 'set': {
            const ours = a.value as RuntimeValue<ValueType>[];
            const theirs = b.value as RuntimeValue<ValueType>[];
            return ours.every(value => theirs.some(other => ctyEquals(value, other)))
                && theirs.every(value => ours.some(other => ctyEquals(value, other)));
        }
        case 'map':
        case 'object': {
            const ours = a.value as Map<string, RuntimeValue<ValueType>>;
            const theirs = b.value as Map<string, RuntimeValue<ValueType>>;
            if (ours.size !== theirs.size) return false;
            for (const [key, value] of ours) {
                const other = theirs.get(key);
                if (other === undefined || !ctyEquals(value, other)) return false;
            }
            return true;
        }
        default:
            throw new TypeError(`values of type ${friendlyName(type)} cannot be compared`);
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
    if (value === null) return makeNullValue(ctyDynamic);

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
    return makeNullValue(ctyDynamic);
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

/** HCL refuses null where it is all `!`, `&&` or `||` has to decide by. */
export const NULL_OPERAND = 'Error during operation: argument must not be null.';

/** An operand of `&&` or `||` once evaluated and converted: a bool, null, or what evaluating it threw. */
export type LogicalOperand = boolean | null | { error: unknown };

/**
 * `left && right` or `left || right` as HCL decides it, once both operands are evaluated and converted. A known
 * operand that is false (for `&&`, null counting as false) or true (for `||`) decides, and what evaluating the other
 * threw is dropped.
 *
 * @throws what an operand threw when the result needs it; an Error when null is all there is to decide by.
 */
export function logicalOperation(operator: '&&' | '||', left: LogicalOperand, right: LogicalOperand): boolean {
    const known = (operand: LogicalOperand): operand is boolean | null => operand === null || typeof operand === 'boolean';
    const decides = (operand: LogicalOperand) => known(operand) && (operator === '&&' ? operand !== true : operand === true);
    if (!known(left)) {
        if (decides(right)) return operator === '||';
        throw left.error;
    }
    if (decides(left)) return operator === '||';
    if (!known(right)) throw right.error;
    if (decides(right)) return operator === '||';
    // Neither decides: both true for &&; for ||, each false or null.
    if (left === null || right === null) throw new Error(NULL_OPERAND);
    return operator === '&&';
}
