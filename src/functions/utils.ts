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
