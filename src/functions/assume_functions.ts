import { consistentWithPrefix } from '../cty-strings';
import type { RuntimeValue, ValueType } from '../model';
import { makeArrayValue, makeBooleanValue, makeNumberValue, makeObjectValue, makeSensitiveValue, makeStringValue, runtimeToPlain, unwrapSensitive } from './utils';

/*
 * The functions of OpenTofu v1.2.2's function table that state an assumption about a value, and the ones that report
 * or drop what marks a value: as Terragrunt v1.2.2 vendors them from OpenTofu, with go-cty's conversions and
 * refinement checks applied to the known values a Terragrunt configuration holds.
 */

type Primitive = 'string' | 'number' | 'boolean';

const isSensitive = (value: RuntimeValue<ValueType>): boolean => (value.type as string) === 'sensitive';

/** A result marked as go-cty marks it when a parameter does not take marked values: sensitive when an argument is. */
export function markedLike(result: RuntimeValue<ValueType>, args: RuntimeValue<ValueType>[]): RuntimeValue<ValueType> {
	return args.some(isSensitive) ? makeSensitiveValue(result) : result;
}

/** go-cty's friendly name for the type of a value, as its conversion errors give it. */
function typeName(value: RuntimeValue<ValueType>): string {
	switch (value.type) {
		case 'string': return 'string';
		case 'number': return 'number';
		case 'boolean': return 'bool';
		case 'array': return 'tuple';
		case 'object':
		case 'block': return 'object';
		default: return 'dynamic';
	}
}

const numberPattern = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u;

/**
 * Converts a value to a primitive type as go-cty does, or answers undefined when go-cty refuses. A null stays null,
 * of the type converted to.
 */
function convertPrimitive(value: RuntimeValue<ValueType>, target: Primitive): RuntimeValue<ValueType> | undefined {
	if (value.type === 'null' || value.type === target) return value;
	switch (target) {
		case 'string':
			return value.type === 'number' || value.type === 'boolean' ? makeStringValue(String(value.value)) : undefined;
		case 'number':
			return value.type === 'string' && numberPattern.test(String(value.value)) ? makeNumberValue(Number(value.value)) : undefined;
		case 'boolean':
			if (value.type !== 'string') return undefined;
			if (value.value === 'true' || value.value === '1') return makeBooleanValue(true);
			if (value.value === 'false' || value.value === '0') return makeBooleanValue(false);
			return undefined;
	}
}

const isPrimitive = (value: RuntimeValue<ValueType>): boolean => value.type === 'string' || value.type === 'number' || value.type === 'boolean';

/**
 * The elements of a collection converted to the one type go-cty unifies them to: unchanged when they share a type,
 * all strings when they are primitives of several types. Undefined when go-cty finds no single type.
 */
function unifyElements(elements: RuntimeValue<ValueType>[]): RuntimeValue<ValueType>[] | undefined {
	const present = elements.map(unwrapSensitive).filter(element => element.type !== 'null');
	const kinds = new Set(present.map(element => element.type === 'block' ? 'object' : element.type));
	if (kinds.size <= 1) return elements;
	if (!present.every(isPrimitive)) return undefined;
	return elements.map(element => {
		const converted = convertPrimitive(unwrapSensitive(element), 'string')!;
		return isSensitive(element) ? makeSensitiveValue(converted) : converted;
	});
}

function valuesEqual(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): boolean {
	return JSON.stringify(runtimeToPlain(left)) === JSON.stringify(runtimeToPlain(right));
}

/** go-cty's conversion of a value to the type of another, or undefined when it refuses. */
function convertLike(value: RuntimeValue<ValueType>, like: RuntimeValue<ValueType>): RuntimeValue<ValueType> | undefined {
	const actual = unwrapSensitive(value);
	const target = unwrapSensitive(like);
	if (target.type === 'null' || actual.type === 'null') return actual;
	if (target.type === 'string' || target.type === 'number' || target.type === 'boolean') return convertPrimitive(actual, target.type);
	if (target.type === 'array') {
		if (actual.type !== 'array') return undefined;
		const items = actual.value as RuntimeValue<ValueType>[];
		const targets = target.value as RuntimeValue<ValueType>[];
		if (items.length !== targets.length) return undefined;
		const converted = items.map((item, index) => convertLike(item, targets[index]));
		return converted.every(item => item !== undefined) ? makeArrayValue(converted as RuntimeValue<ValueType>[]) : undefined;
	}
	if (target.type === 'object' || target.type === 'block') {
		if (actual.type !== 'object' && actual.type !== 'block') return undefined;
		const entries = actual.value as Map<string, RuntimeValue<ValueType>>;
		const converted = new Map<string, RuntimeValue<ValueType>>();
		for (const [key, targetValue] of target.value as Map<string, RuntimeValue<ValueType>>) {
			const entry = entries.get(key);
			if (entry === undefined) return undefined;
			const convertedEntry = convertLike(entry, targetValue);
			if (convertedEntry === undefined) return undefined;
			converted.set(key, convertedEntry);
		}
		return makeObjectValue(converted);
	}
	return undefined;
}

// Go's math.MaxInt, which a JavaScript number holds only as the nearest double; the message gives it exactly.
const maxInt = 2 ** 63 - 1;
const maxIntText = '9223372036854775807';

/**
 * A length bound, refused unless go-cty reads it as a whole number below the largest int. OpenTofu names the
 * parameter by the index it reports, which for the one-bound functions is that of the value.
 */
function lengthBound(argument: RuntimeValue<ValueType>, parameter: string): number {
	const value = unwrapSensitive(argument);
	if (value.type === 'null') throw new Error(`Invalid value for "${parameter}" parameter: argument must not be null.`);
	const bound = convertPrimitive(value, 'number');
	if (bound === undefined) throw new Error(`Invalid value for "${parameter}" parameter: number required.`);
	const number = Number(bound.value);
	if (!Number.isInteger(number) || number >= maxInt) {
		throw new Error(`Invalid value for "${parameter}" parameter: must be a whole number between 0 and ${maxIntText}.`);
	}
	return number;
}

type CollectionKind = 'list' | 'set' | 'map';

/** A value converted to a list, set or map of one element type, as go-cty converts a function argument. */
function convertCollection(argument: RuntimeValue<ValueType>, kind: CollectionKind): RuntimeValue<ValueType> {
	const value = unwrapSensitive(argument);
	if (value.type === 'null') return value;
	const refused = new Error(`Invalid value for "value" parameter: ${kind} of any single type required.`);
	if (kind === 'map') {
		if (value.type !== 'object' && value.type !== 'block') throw refused;
		const entries = [...(value.value as Map<string, RuntimeValue<ValueType>>)];
		const unified = unifyElements(entries.map(([, entry]) => entry));
		if (!unified) throw refused;
		return makeObjectValue(new Map(entries.map(([key], index) => [key, unified[index]])));
	}
	if (value.type !== 'array') throw refused;
	const unified = unifyElements(value.value as RuntimeValue<ValueType>[]);
	if (!unified) throw refused;
	if (kind === 'list') return makeArrayValue(unified);
	const distinct: RuntimeValue<ValueType>[] = [];
	for (const item of unified) if (!distinct.some(existing => valuesEqual(existing, item))) distinct.push(item);
	return makeArrayValue(sortSetElements(distinct));
}

/** go-cty's order for a set's elements: numbers by value, strings by their bytes, anything else as it came. */
function sortSetElements(items: RuntimeValue<ValueType>[]): RuntimeValue<ValueType>[] {
	const plain = items.map(unwrapSensitive);
	if (plain.every(item => item.type === 'number')) {
		return [...items].sort((left, right) => Number(unwrapSensitive(left).value) - Number(unwrapSensitive(right).value));
	}
	if (plain.every(item => item.type === 'string')) {
		return [...items].sort((left, right) => Buffer.compare(Buffer.from(String(unwrapSensitive(left).value)), Buffer.from(String(unwrapSensitive(right).value))));
	}
	return items;
}

const notUpheld = (): Error => new Error('Invalid value for "value" parameter: assumption was not upheld.');

function lengthOf(collection: RuntimeValue<ValueType>): number {
	if (collection.type === 'null') throw notUpheld();
	return collection.type === 'array'
		? (collection.value as RuntimeValue<ValueType>[]).length
		: (collection.value as Map<string, RuntimeValue<ValueType>>).size;
}

/** assume<kind>length: the collection, when its length lies within both bounds. */
function assumeLengthBetween(kind: CollectionKind) {
	return async (args: RuntimeValue<ValueType>[]) => {
		const collection = convertCollection(args[0], kind);
		const min = lengthBound(args[1], 'min_length');
		const max = lengthBound(args[2], 'max_length');
		const length = lengthOf(collection);
		if (min > length || max < length) throw notUpheld();
		return markedLike(collection, args);
	};
}

/** assume<kind>lengthmin and assume<kind>lengthmax: the collection, when its length meets the one bound. */
function assumeLengthBound(kind: CollectionKind, bound: 'min' | 'max') {
	return async (args: RuntimeValue<ValueType>[]) => {
		const collection = convertCollection(args[0], kind);
		const limit = lengthBound(args[1], 'value');
		const length = lengthOf(collection);
		if (bound === 'min' ? limit > length : limit < length) throw notUpheld();
		return markedLike(collection, args);
	};
}

const removedFunction = (name: 'list' | 'map', literal: string) => async (): Promise<RuntimeValue<ValueType>> => {
	throw new Error(`the "${name}" function was deprecated in Terraform v0.12 and is not available in OpenTofu; use ${literal} syntax to write a literal ${name}`);
};

export const assumeFunctions = {
	assumeequal: async (args: RuntimeValue<ValueType>[]) => {
		const [actual, assumed] = args;
		const converted = convertLike(actual, assumed);
		if (converted === undefined) {
			throw new Error(`Invalid value for "actual_value" parameter: actual value type ${typeName(unwrapSensitive(actual))} does not match assumed value type ${typeName(unwrapSensitive(assumed))}.`);
		}
		if (!valuesEqual(converted, unwrapSensitive(assumed))) {
			throw new Error('Invalid value for "actual_value" parameter: the actual value does not match the assumed value.');
		}
		return assumed;
	},
	assumenotnull: async (args: RuntimeValue<ValueType>[]) => {
		// HCL's null keyword, and every null a configuration can hold here, has no type, which go-cty refuses first.
		if (unwrapSensitive(args[0]).type === 'null') {
			throw new Error('Invalid value for "value" parameter: given value must have a known type; consider using the \\"convert\\" function to specify a type to assume.');
		}
		return args[0];
	},
	assumestringprefix: async (args: RuntimeValue<ValueType>[]) => {
		const value = unwrapSensitive(args[0]);
		const prefixArgument = unwrapSensitive(args[1]);
		if (prefixArgument.type === 'null') throw new Error('Invalid value for "prefix" parameter: argument must not be null.');
		const prefix = convertPrimitive(prefixArgument, 'string');
		if (prefix === undefined) throw new Error('Invalid value for "prefix" parameter: string required.');
		const converted = convertPrimitive(value, 'string');
		if (converted === undefined) throw new Error('Invalid value for "value" parameter: string required.');
		if (converted.type !== 'null' && !consistentWithPrefix(String(converted.value), String(prefix.value))) throw notUpheld();
		return markedLike(converted, args);
	},
	assumelistlength: assumeLengthBetween('list'),
	assumelistlengthmin: assumeLengthBound('list', 'min'),
	assumelistlengthmax: assumeLengthBound('list', 'max'),
	assumesetlength: assumeLengthBetween('set'),
	assumesetlengthmin: assumeLengthBound('set', 'min'),
	assumesetlengthmax: assumeLengthBound('set', 'max'),
	assumemaplength: assumeLengthBetween('map'),
	assumemaplengthmin: assumeLengthBound('map', 'min'),
	assumemaplengthmax: assumeLengthBound('map', 'max'),
	// A Terragrunt configuration holds no ephemeral value, so nothing becomes null and every other mark stays.
	ephemeralasnull: async (args: RuntimeValue<ValueType>[]) => args[0],
	// Only the value's own mark counts: an element marked sensitive does not mark the collection that holds it.
	issensitive: async (args: RuntimeValue<ValueType>[]) => makeBooleanValue(isSensitive(args[0])),
	list: removedFunction('list', 'tolist([ ... ])'),
	map: removedFunction('map', 'tomap({ ... })')
};
