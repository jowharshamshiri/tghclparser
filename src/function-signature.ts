import { ConversionError, convert } from './cty-convert';
import { type CtyType, ctyBool, ctyDynamic, ctyNumber, ctyString, listOf, mapOf, setOf } from './cty-types';
import { makeArrayValue, makeObjectValue, makeSensitiveValue } from './functions/utils';
import type { RuntimeValue, ValueType } from './model';

/**
 * A function's go-cty parameters, as functions.json states them and HCL reads them: by name, which HCL counts a call's
 * arguments by, and by type, which HCL converts each argument to before the function sees it.
 */

/** The type of the parameter `try` and `can` take: the expression itself, which they evaluate. */
export const EXPRESSION_CLOSURE = 'expression closure';

export interface CtyParameter {
	name: string;
	type: CtyType | typeof EXPRESSION_CLOSURE;
	/** Whether the function takes a null argument; HCL refuses one for it otherwise. */
	allowNull: boolean;
	/** Whether the function takes a sensitive argument as it is; otherwise go-cty unmarks it and marks the result. */
	allowMarked: boolean;
}

export interface FunctionSignature {
	params: CtyParameter[];
	varParam: CtyParameter | null;
}

/** A parameter as functions.json writes it. */
interface WrittenParameter {
	name: string;
	type: string;
	allowNull?: boolean;
	allowMarked?: boolean;
}

/**
 * Reads a function's signature from functions.json.
 *
 * @param name the function, for the message.
 * @param written the `signature` functions.json gives it.
 * @throws Error naming the function and what is wrong with its signature.
 */
export function readSignature(name: string, written: unknown): FunctionSignature {
	const fail = (detail: string): never => {
		throw new Error(`functions.json: function "${name}" has an invalid signature: ${detail}`);
	};
	if (typeof written !== 'object' || written === null) return fail('it is not an object');
	const { params, varParam } = written as { params?: unknown; varParam?: unknown };
	if (!Array.isArray(params)) return fail('"params" is not a list');
	if (varParam === undefined) return fail('"varParam" is missing');
	const parameter = (value: unknown, where: string): CtyParameter => {
		if (typeof value !== 'object' || value === null) return fail(`${where} is not an object`);
		const { name: parameterName, type, allowNull, allowMarked } = value as Partial<WrittenParameter>;
		if (typeof parameterName !== 'string') return fail(`${where} has no "name"`);
		if (typeof type !== 'string') return fail(`${where} has no "type"`);
		if (allowNull !== undefined && allowNull !== true) return fail(`${where} gives "allowNull" other than true`);
		if (allowMarked !== undefined && allowMarked !== true) return fail(`${where} gives "allowMarked" other than true`);
		let parsed: CtyParameter['type'];
		try {
			parsed = type === EXPRESSION_CLOSURE ? EXPRESSION_CLOSURE : parseTypeConstraint(type);
		} catch (error) {
			return fail(`${where}: ${(error as Error).message}`);
		}
		return { name: parameterName, type: parsed, allowNull: allowNull === true, allowMarked: allowMarked === true };
	};
	return {
		params: params.map((value, index) => parameter(value, `parameter ${index + 1}`)),
		varParam: varParam === null ? null : parameter(varParam, 'the variadic parameter')
	};
}

/**
 * A type constraint as HCL's typeexpr.TypeString writes one: `string`, `number`, `bool`, `any` for the dynamic
 * pseudo-type, and `list(...)`, `set(...)` and `map(...)` of another.
 *
 * @throws Error when the text is not such a constraint.
 */
export function parseTypeConstraint(text: string): CtyType {
	switch (text) {
		case 'string': return ctyString;
		case 'number': return ctyNumber;
		case 'bool': return ctyBool;
		case 'any': return ctyDynamic;
		default: break;
	}
	const collection = /^(list|set|map)\((.*)\)$/u.exec(text);
	if (!collection) throw new Error(`"${text}" is not a type constraint`);
	const element = parseTypeConstraint(collection[2]);
	return collection[1] === 'list' ? listOf(element) : collection[1] === 'set' ? setOf(element) : mapOf(element);
}

/** The parameter an argument is passed to: its own, or the variadic parameter. */
export function parameterAt(signature: FunctionSignature, index: number): CtyParameter {
	const parameter = signature.params[index] ?? signature.varParam;
	if (!parameter) throw new RangeError(`no parameter takes argument ${index + 1}`);
	return parameter;
}

const isSensitive = (value: RuntimeValue<ValueType>): boolean => (value.type as string) === 'sensitive';

/**
 * A value with every sensitivity mark in it removed, as go-cty's UnmarkDeep gives it, and whether it held any.
 *
 * @param value the value.
 * @returns the value unmarked, and whether anything in it was marked.
 */
export function unmarkDeep(value: RuntimeValue<ValueType>): { value: RuntimeValue<ValueType>; marked: boolean } {
	if (isSensitive(value)) return { value: unmarkDeep(value.value as RuntimeValue<ValueType>).value, marked: true };
	if (value.type === 'array') {
		const elements = (value.value as RuntimeValue<ValueType>[]).map(unmarkDeep);
		if (!elements.some(element => element.marked)) return { value, marked: false };
		return { value: { ...makeArrayValue(elements.map(element => element.value)), ctyType: value.ctyType }, marked: true };
	}
	if (value.type === 'object' || value.type === 'block') {
		const entries = [...(value.value as Map<string, RuntimeValue<ValueType>>)].map(([key, entry]) => [key, unmarkDeep(entry)] as const);
		if (!entries.some(([, entry]) => entry.marked)) return { value, marked: false };
		const unmarked = makeObjectValue(new Map(entries.map(([key, entry]) => [key, entry.value])));
		return { value: { ...unmarked, type: value.type, ctyType: value.ctyType } as RuntimeValue<ValueType>, marked: true };
	}
	return { value, marked: false };
}

/** A function call's arguments as the function receives them, and whether its result is to be marked sensitive. */
export interface PreparedArguments {
	args: RuntimeValue<ValueType>[];
	marked: boolean;
}

/**
 * A call's arguments made ready for the function as HCL and go-cty make them: each converted to its parameter's type
 * (HCL's FunctionCallExpr), then a null refused for a parameter that does not take one, and a sensitive argument
 * unmarked for one that does not take it, its sensitivity passed on to the result (go-cty's Function.Call).
 *
 * @param signature the function's parameters.
 * @param args the evaluated arguments, an expanded final argument as its elements, `try` and `can` excepted.
 * @returns the arguments, and whether the result is sensitive.
 * @throws Error in HCL's words for the first argument that does not convert, else the first null it refuses.
 */
export function prepareArguments(signature: FunctionSignature, args: RuntimeValue<ValueType>[]): PreparedArguments {
	const converted = args.map((argument, index) => {
		const parameter = parameterAt(signature, index);
		if (parameter.type === EXPRESSION_CLOSURE) throw new TypeError(`parameter "${parameter.name}" takes an expression, not a value`);
		try {
			return convert(argument, parameter.type);
		} catch (error) {
			if (!(error instanceof ConversionError)) throw error;
			throw argumentError(parameter, error.message);
		}
	});
	let marked = false;
	const prepared = converted.map((argument, index) => {
		const parameter = parameterAt(signature, index);
		const plain = isSensitive(argument) ? (argument.value as RuntimeValue<ValueType>) : argument;
		if (plain.type === 'null' && !parameter.allowNull) throw argumentError(parameter, 'argument must not be null');
		if (parameter.allowMarked) return argument;
		const unmarked = unmarkDeep(argument);
		marked ||= unmarked.marked;
		return unmarked.value;
	});
	return { args: prepared, marked };
}

/**
 * An argument a function refuses, as HCL reports it: the parameter it was passed to, and why.
 *
 * @param parameter the parameter.
 * @param detail why, in go-cty's words, without a final full stop.
 */
export function argumentError(parameter: Pick<CtyParameter, 'name'>, detail: string): Error {
	return new Error(`Invalid function argument; Invalid value for "${parameter.name}" parameter: ${detail}.`);
}

/** A function's result marked sensitive when an argument it unmarked was. */
export function markResult(result: RuntimeValue<ValueType>, marked: boolean): RuntimeValue<ValueType> {
	return marked && !isSensitive(result) ? makeSensitiveValue(result) : result;
}
