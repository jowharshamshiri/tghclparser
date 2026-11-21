import path from 'node:path';

import { URI } from 'vscode-uri';

import { CtyNumber } from '../cty-number';
import type { FunctionContext, RuntimeValue, ValueType } from '../model';

/**
 * The directory Terragrunt's own functions resolve a relative path from and its repository-root functions answer for,
 * its WorkingDir: the unit's, in a configuration the unit includes as well, and a configuration read_terragrunt_config
 * reads its own.
 */
export function unitWorkingDirectory(context: FunctionContext): string {
	return context.terragruntDir ?? path.dirname(URI.parse(context.document.uri).fsPath);
}

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

export const makeNullValue = (): RuntimeValue<'null'> => ({
    type: 'null',
    value: null
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

/**
 * The name go-cty gives a value's type in a message, such as `bool` or `tuple`. A list or an object written in
 * configuration is a tuple or an object to go-cty, and those are the names given to every list and object here.
 *
 * @param value the value, not sensitive.
 * @returns the type's name.
 */
export function friendlyTypeName(value: RuntimeValue<ValueType>): string {
    switch (value.type) {
        case 'string':
        case 'number':
            return value.type;
        case 'boolean':
            return 'bool';
        case 'array':
            return 'tuple';
        case 'object':
        case 'block':
            return 'object';
        case 'null':
            return 'dynamic';
        default:
            throw new Error(`Value of type ${String(value.type)} has no type name`);
    }
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

/**
 * An interpolation's value as a string template includes it, as HCL's TemplateExpr converts one (cty's conversion to
 * a string): a string as it is, a number or a bool written out. A sensitive value is included as the value it
 * protects, and makes the rendered string sensitive.
 *
 * A template that is one interpolation and nothing else is not converted: HCL gives it the interpolation's value as
 * it is.
 *
 * @returns the text the value renders as, and whether it was sensitive.
 * @throws Error saying why the value cannot be included, in HCL's words: null and collections do not convert. HCL
 *   names a collection by its cty type; values have one kind of collection each, so a list or a set is named a tuple
 *   and a map an object.
 */
export function templatePart(value: RuntimeValue<ValueType>): { text: string; sensitive: boolean } {
    const protectedValue = unwrapSensitive(value);
    const sensitive = protectedValue !== value;
    switch (protectedValue.type) {
        case 'string':
        case 'number':
        case 'boolean':
            return { text: String(protectedValue.value), sensitive };
        case 'null':
            throw new Error('The expression result is null. Cannot include a null value in a string template.');
        case 'array':
            return failTemplatePart('tuple');
        case 'object':
        case 'block':
            return failTemplatePart('object');
        default:
            return failTemplatePart(protectedValue.type);
    }
}

function failTemplatePart(type: string): never {
    throw new Error(`Cannot include the given value in a string template: string required, but have ${type}.`);
}

/**
 * A value converted to a bool as HCL converts one (cty's conversion): a bool as it is, null as null, and the strings
 * "true" and "1", "false" and "0". Nothing else converts: no other string, number or collection.
 *
 * @returns the bool, or null for null.
 * @throws Error saying why the value is not a bool, in cty's words.
 */
export function convertToBool(value: RuntimeValue<ValueType>): boolean | null {
    switch (value.type) {
        case 'boolean':
            return Boolean(value.value);
        case 'null':
            return null;
        case 'string': {
            const text = String(value.value);
            if (text === 'true' || text === '1') return true;
            if (text === 'false' || text === '0') return false;
            const lower = text.toLowerCase();
            if (lower === 'true' || lower === 'false') {
                throw new Error(`a bool is required; to convert from string, use lowercase "${lower}"`);
            }
            throw new Error('a bool is required');
        }
        case 'array':
            return failBool('tuple');
        case 'object':
        case 'block':
            return failBool('object');
        default:
            return failBool(value.type);
    }
}

function failBool(type: string): never {
    throw new Error(`bool required, but have ${type}`);
}

/**
 * A condition, of `?:` or of a template's `if`, as HCL takes it.
 *
 * @throws Error when the condition is null or does not convert to a bool, in HCL's words.
 */
export function conditionValue(value: RuntimeValue<ValueType>): boolean {
    if (value.type === 'null') throw new Error('The condition value is null. Conditions must either be true or false.');
    try {
        return convertToBool(value) as boolean;
    } catch {
        throw new Error('The condition expression must be of type bool.');
    }
}

/**
 * An operand of `&&`, `||` or `!` converted to a bool as HCL converts it.
 *
 * @param side which operand it is, as HCL names it.
 * @returns the bool, or null for null.
 * @throws Error naming the operand when it does not convert, in HCL's words.
 */
export function operandBool(value: RuntimeValue<ValueType>, side: 'left' | 'right' | 'unary'): boolean | null {
    try {
        return convertToBool(value);
    } catch (error) {
        throw new Error(`Unsuitable value for ${side} operand: ${(error as Error).message}.`);
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
