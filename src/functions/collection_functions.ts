import { CtyNumber } from '../cty-number';
import { ConversionError, convert, getConversionUnsafe, unify } from '../cty-convert';
import {
	type CollectionType,
	type CtyType,
	ctyBool,
	ctyDynamic,
	ctyNumber,
	ctyString,
	friendlyName,
	friendlyNameForConstraint,
	listOf,
	mapOf,
	objectOf,
	setOf,
	tupleOf,
	typeEquals
} from '../cty-types';
import { ArgumentError } from '../function-signature';
import { goQuoted } from '../go-quote';
import { graphemeCount } from '../grapheme-clusters';
import type { RuntimeValue, ValueType } from '../model';
import {
	compareStrings,
	ctyEquals,
	makeArrayValue,
	makeBooleanValue,
	makeListValue,
	makeMapValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeSensitiveValue,
	makeSetValue,
	makeStringValue,
	unwrapSensitive,
	valueType
} from './utils';

/*
 * go-cty v1.19.0's collection and conversion functions, and OpenTofu's, as Terragrunt v1.2.2 calls them: each takes
 * its arguments converted to its parameters' types already (see function-signature.ts) and gives its result the type
 * go-cty's Type function gives it, so a list stays a list and a literal stays a tuple or object. A fault the function
 * reports against an argument is stated as HCL states it, any other in go-cty's words alone.
 */

type Value = RuntimeValue<ValueType>;

const isSensitive = (value: Value): boolean => (value.type as string) === 'sensitive';
const marked = (result: Value, sensitive: boolean): Value => (sensitive && !isSensitive(result) ? makeSensitiveValue(result) : result);
const elementsOf = (value: Value): Value[] => unwrapSensitive(value).value as Value[];
const entriesOf = (value: Value): Map<string, Value> => unwrapSensitive(value).value as Map<string, Value>;
const integer = (value: CtyNumber, what: string): number => {
	try {
		return Number(value.toGoInt64());
	} catch (error) {
		throw new Error(`${what}: ${(error as Error).message}`);
	}
};

/** Whether a value is, or holds anywhere, a sensitive value, as OpenTofu's marks.Contains looks. */
function holdsSensitive(value: Value): boolean {
	if (isSensitive(value)) return true;
	if (value.type === 'array') return (value.value as Value[]).some(holdsSensitive);
	if (value.type === 'object' || value.type === 'block') return [...(value.value as Map<string, Value>).values()].some(holdsSensitive);
	return false;
}

/**
 * OpenTofu's MakeToFunc: `tostring`, `tonumber`, `tobool`, `tolist`, `toset` and `tomap`, each an explicit conversion
 * to its type, `list of any single type` and the like for the collections, so that a tuple's elements unify to one
 * type. A null converts to a null of the type.
 */
function makeToFunction(want: CtyType) {
	return async (args: Value[]): Promise<Value> => {
		const argument = args[0];
		const given = valueType(argument);
		if (!typeEquals(given, want) && !getConversionUnsafe(given, want)) {
			throw new ArgumentError(0, `cannot convert ${friendlyName(given)} to ${friendlyNameForConstraint(want)}`);
		}
		try {
			return convert(argument, want);
		} catch (error) {
			if (!(error instanceof ConversionError)) throw error;
			const plain = unwrapSensitive(argument);
			if (holdsSensitive(argument)) {
				throw new ArgumentError(0, `cannot convert this sensitive ${friendlyName(given)} to ${friendlyNameForConstraint(want)}`);
			}
			if (given.kind === 'string' && want.kind === 'bool') {
				throw new ArgumentError(0, `cannot convert ${goQuoted(String(plain.value))} to bool; only the strings "true" or "false" are allowed`);
			}
			if (given.kind === 'string' && want.kind === 'number') {
				throw new ArgumentError(0, `cannot convert ${goQuoted(String(plain.value))} to number; given string must be a decimal representation of a number`);
			}
			throw new ArgumentError(0, `cannot convert ${friendlyName(given)} to ${friendlyNameForConstraint(want)}`);
		}
	};
}

/** The elements of a tuple, list or set argument and whether the argument was sensitive, for a parameter that takes marks. */
function sequence(argument: Value): { elements: Value[]; type: CtyType; sensitive: boolean } {
	return { elements: elementsOf(argument), type: valueType(argument), sensitive: isSensitive(argument) };
}

/**
 * go-cty's set operations: every argument converted to a set of the element types unified, then combined. Known empty
 * sets of the dynamic pseudo-type take no part in the unification.
 */
function setOperation(combine: (sets: Value[][]) => Value[]) {
	return async (args: Value[]): Promise<Value> => {
		const types = args
			.filter(argument => !(elementsOf(argument).length === 0 && (valueType(argument) as CollectionType).element.kind === 'dynamic'))
			.map(argument => (valueType(argument) as CollectionType).element);
		const element = types.length === 0 ? ctyDynamic : unify(types, true)?.type;
		if (!element) throw new Error('given sets must all have compatible element types');
		const target = setOf(element);
		const sets = args.map((argument, index) => {
			try {
				return elementsOf(convert(argument, target));
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				throw new ArgumentError(index, error.message);
			}
		});
		return makeSetValue(element, combine(sets));
	};
}

const isMember = (value: Value, set: Value[]): boolean => set.some(other => ctyEquals(value, other));

export const collectionFunctions = {
	tostring: makeToFunction(ctyString),
	tonumber: makeToFunction(ctyNumber),
	tobool: makeToFunction(ctyBool),
	tolist: makeToFunction(listOf(ctyDynamic)),
	toset: makeToFunction(setOf(ctyDynamic)),
	tomap: makeToFunction(mapOf(ctyDynamic)),

	// OpenTofu's alltrue and anytrue, over a list of bools: a null element is false to alltrue, and skipped by anytrue.
	alltrue: async (args: Value[]) => makeBooleanValue(elementsOf(args[0]).every(element => element.type !== 'null' && Boolean(element.value))),
	anytrue: async (args: Value[]) => makeBooleanValue(elementsOf(args[0]).some(element => element.type !== 'null' && Boolean(element.value))),

	// go-cty's chunklist: a list of lists of the converted list's type, the whole list in one chunk for a size of zero.
	chunklist: async (args: Value[]) => {
		const { elements, type, sensitive } = sequence(args[0]);
		const sizeSensitive = isSensitive(args[1]);
		const size = integer(unwrapSensitive(args[1]).value as CtyNumber, 'invalid size');
		if (size < 0) throw new Error('the size argument must be positive');
		const chunks: Value[] = [];
		const chunkSize = size === 0 ? elements.length : size;
		for (let index = 0; index < elements.length; index += chunkSize) {
			chunks.push(makeListValue((type as CollectionType).element, elements.slice(index, index + chunkSize)));
		}
		return marked(makeListValue(type, chunks), sensitive || sizeSensitive);
	},

	// OpenTofu's coalesce: every argument converted to the type they unify to, the first not null and, for strings, not
	// empty.
	coalesce: async (args: Value[]) => {
		const unified = unify(args.map(valueType), true)?.type;
		if (!unified) throw new Error('all arguments must have the same type');
		for (const argument of args) {
			const converted = convert(argument, unified);
			const plain = unwrapSensitive(converted);
			if (plain.type === 'null') continue;
			if (unified.kind === 'string' && plain.value === '') continue;
			return converted;
		}
		throw new Error('no non-null, non-empty-string arguments');
	},

	// go-cty's coalescelist: the first list or tuple that is not null or empty, as it is.
	coalescelist: async (args: Value[]) => {
		if (args.length === 0) throw new Error('at least one argument is required');
		for (const argument of args) {
			const kind = valueType(argument).kind;
			if (kind !== 'list' && kind !== 'tuple') throw new Error('coalescelist arguments must be lists or tuples');
		}
		for (const argument of args) {
			if (argument.type === 'null') continue;
			if (elementsOf(argument).length > 0) return argument;
		}
		throw new Error('no non-null arguments');
	},

	// go-cty's compact: a list of strings without its nulls and empty strings.
	compact: async (args: Value[]) => makeListValue(ctyString, elementsOf(args[0]).filter(element => element.type !== 'null' && element.value !== '')),

	// go-cty's concat: a list when every argument is a list and their types unify, else a tuple of all their elements.
	concat: async (args: Value[]) => {
		if (args.length === 0) throw new Error('at least one argument is required');
		const sensitive = args.some(isSensitive);
		const types = args.map(valueType);
		if (types.every(type => type.kind === 'list')) {
			const unified = unify(types, true)?.type;
			if (unified) {
				const elements = args.flatMap((argument, index) => {
					try {
						return elementsOf(convert(unwrapSensitive(argument), unified));
					} catch (error) {
						if (!(error instanceof ConversionError)) throw error;
						throw new ArgumentError(index, error.message);
					}
				});
				return marked(makeListValue((unified as CollectionType).element, elements), sensitive);
			}
		}
		const elements: Value[] = [];
		for (const [index, type] of types.entries()) {
			if (type.kind !== 'tuple' && type.kind !== 'list') {
				throw new ArgumentError(index, `all arguments must be lists or tuples; got ${friendlyName(type)}`);
			}
			elements.push(...elementsOf(args[index]));
		}
		return marked(makeArrayValue(elements), sensitive);
	},

	// go-cty's contains: whether a list, tuple or set holds an element equal to the value, of its very type.
	contains: async (args: Value[]) => {
		const kind = valueType(args[0]).kind;
		if (kind !== 'list' && kind !== 'tuple' && kind !== 'set') throw new Error('argument must be list, tuple, or set');
		return makeBooleanValue(isMember(args[1], elementsOf(args[0])));
	},

	// go-cty's distinct: the converted list without its repeats, in order.
	distinct: async (args: Value[]) => {
		const type = valueType(args[0]) as CollectionType;
		const distinct: Value[] = [];
		for (const element of elementsOf(args[0])) if (!isMember(element, distinct)) distinct.push(element);
		return makeListValue(type.element, distinct);
	},

	// go-cty's element: a list's or tuple's element at the index, wrapping round; a set has no indices.
	element: async (args: Value[]) => {
		const { elements, type, sensitive } = sequence(args[0]);
		if (type.kind !== 'list' && type.kind !== 'tuple') throw new Error(`cannot read elements from ${friendlyName(type)}`);
		const index = integer(args[1].value as CtyNumber, 'invalid index');
		if (elements.length === 0) throw new Error('cannot use element function with an empty list');
		return marked(elements[((index % elements.length) + elements.length) % elements.length], sensitive);
	},

	// go-cty's flatten: a tuple of the elements of every list, set and tuple within, at any depth.
	flatten: async (args: Value[]) => {
		const { type, sensitive } = sequence(args[0]);
		if (type.kind !== 'list' && type.kind !== 'set' && type.kind !== 'tuple') throw new Error('can only flatten lists, sets and tuples');
		let deep = sensitive;
		const flatten = (elements: Value[]): Value[] => elements.flatMap(element => {
			const plain = unwrapSensitive(element);
			const kind = plain.type === 'null' ? 'null' : valueType(plain).kind;
			if (kind !== 'list' && kind !== 'set' && kind !== 'tuple') return [element];
			deep ||= isSensitive(element);
			return flatten(plain.value as Value[]);
		});
		return marked(makeArrayValue(flatten(elementsOf(args[0]))), deep);
	},

	// OpenTofu's index: the position of the first element equal to the value in a list or tuple.
	index: async (args: Value[]) => {
		const kind = valueType(args[0]).kind;
		if (kind !== 'list' && kind !== 'tuple') throw new Error('argument must be a list or tuple');
		const elements = elementsOf(args[0]);
		if (elements.length === 0) throw new Error('cannot search an empty list');
		const position = elements.findIndex(element => ctyEquals(element, args[1]));
		if (position === -1) throw new Error('item not found');
		return makeNumberValue(CtyNumber.fromInt64(position));
	},

	// go-cty's keys: a map's keys as a list of strings, an object's as a tuple of strings, in the order of their bytes.
	keys: async (args: Value[]) => {
		const type = valueType(args[0]);
		const sensitive = isSensitive(args[0]);
		if (type.kind !== 'map' && type.kind !== 'object') throw new ArgumentError(0, 'must have map or object type');
		const keys = [...entriesOf(args[0]).keys()].sort(compareStrings).map(makeStringValue);
		return marked(type.kind === 'map' ? makeListValue(ctyString, keys) : makeArrayValue(keys), sensitive);
	},

	// OpenTofu's length: a string's grapheme clusters, or a collection's or structure's elements.
	length: async (args: Value[]) => {
		const type = valueType(args[0]);
		const sensitive = isSensitive(args[0]);
		const plain = unwrapSensitive(args[0]);
		switch (type.kind) {
			case 'string':
				return marked(makeNumberValue(CtyNumber.fromInt64(graphemeCount(String(plain.value)))), sensitive);
			case 'list':
			case 'set':
			case 'tuple':
				return marked(makeNumberValue(CtyNumber.fromInt64((plain.value as Value[]).length)), sensitive);
			case 'map':
			case 'object':
				return marked(makeNumberValue(CtyNumber.fromInt64((plain.value as Map<string, Value>).size)), sensitive);
			default:
				throw new Error('argument must be a string, a collection type, or a structural type');
		}
	},

	// OpenTofu's lookup: an object's attribute or a map's element, else the default, converted to a map's element type.
	lookup: async (args: Value[]) => {
		if (args.length > 3) throw new Error(`lookup() takes two or three arguments, got ${args.length}`);
		const type = valueType(args[0]);
		const sensitive = isSensitive(args[0]) || isSensitive(args[1]);
		const key = String(unwrapSensitive(args[1]).value);
		if (type.kind !== 'map' && type.kind !== 'object') throw new ArgumentError(0, 'lookup() requires a map as the first argument');
		const found = entriesOf(args[0]).get(key);
		if (type.kind === 'object') {
			if (found !== undefined) return marked(found, sensitive);
			if (args.length === 3) return marked(args[2], sensitive);
			throw new ArgumentError(0, `the given object has no attribute ${goQuoted(key)}`);
		}
		let fallback: Value | undefined;
		if (args.length === 3) {
			try {
				fallback = convert(args[2], type.element);
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				throw new ArgumentError(2, 'the default value must have the same type as the map elements');
			}
		}
		if (found !== undefined) return marked(found, sensitive);
		if (fallback !== undefined) return marked(fallback, sensitive);
		throw new Error(`lookup failed to find key ${sensitive ? '(sensitive value)' : goQuoted(key)}`);
	},

	// OpenTofu's matchkeys: the values whose keys are in the search set, as the list values was converted to.
	matchkeys: async (args: Value[]) => {
		const [values, keys, search] = args;
		const keyType = unify([valueType(keys), valueType(search)], true)?.type;
		if (!keyType) throw new Error('keys and searchset must be of the same type');
		const element = (valueType(values) as CollectionType).element;
		if (elementsOf(values).length !== elementsOf(keys).length) throw new Error('length of keys and values should be equal');
		const keyElements = elementsOf(convert(keys, keyType));
		const searchElements = elementsOf(convert(search, keyType));
		const output = keyElements.flatMap((key, index) => (isMember(key, searchElements) ? [elementsOf(values)[index]] : []));
		return makeListValue(element, output);
	},

	// go-cty's merge: the first type when every argument is of it, so maps of one type give a map; else an object of
	// every attribute and key, a later argument's winning. A null object or map adds nothing.
	merge: async (args: Value[]) => {
		const sensitive = args.some(isSensitive);
		if (args.length === 0) return makeObjectValue(new Map());
		const attributes = new Map<string, CtyType>();
		let first: CtyType | undefined;
		let matching = true;
		let dynamic = false;
		for (const argument of args) {
			let type = valueType(argument);
			// A dynamic argument, such as the null keyword, leaves the result's type to be found as it is built.
			if (type.kind === 'dynamic') {
				dynamic = true;
				continue;
			}
			if (type.kind !== 'map' && type.kind !== 'object') throw new Error(`arguments must be maps or objects, got "${friendlyName(type)}"`);
			const plain = unwrapSensitive(argument);
			if (type.kind === 'object') {
				if (plain.type === 'null') type = objectOf(new Map());
				for (const [name, attribute] of (type as Extract<CtyType, { kind: 'object' }>).attributes) attributes.set(name, attribute);
			} else if (plain.type !== 'null') {
				for (const key of (plain.value as Map<string, Value>).keys()) attributes.set(key, type.element);
			}
			if (first === undefined) first = type;
			else if (matching && !typeEquals(type, first)) matching = false;
		}
		const merged = new Map<string, Value>();
		for (const argument of args) {
			const plain = unwrapSensitive(argument);
			if (plain.type === 'null') continue;
			for (const [key, value] of plain.value as Map<string, Value>) merged.set(key, value);
		}
		const result = !dynamic && matching && first!.kind === 'map' ? makeMapValue(first!.element, merged) : makeObjectValue(merged);
		return marked(result, sensitive);
	},

	// go-cty's reverse: a tuple reversed, and a list or set as a list in reverse order.
	reverse: async (args: Value[]) => {
		const type = valueType(args[0]);
		if (type.kind !== 'tuple' && type.kind !== 'list' && type.kind !== 'set') {
			throw new ArgumentError(0, `can only reverse list or tuple values, not ${friendlyName(type)}`);
		}
		const { elements, sensitive } = sequence(args[0]);
		const reversed = [...elements].reverse();
		return marked(type.kind === 'tuple' ? makeArrayValue(reversed) : makeListValue(type.element, reversed), sensitive);
	},

	setintersection: setOperation(sets => sets[0].filter(element => sets.slice(1).every(set => isMember(element, set)))),
	setsubtract: setOperation(([a, b]) => a.filter(element => !isMember(element, b))),
	setunion: setOperation(sets => sets.flat()),

	// go-cty's setproduct: every combination of one element of each argument, a list of tuples when every argument is
	// a list or tuple and a set of them when any is a set.
	setproduct: async (args: Value[]) => {
		if (args.length < 2) throw new Error('at least two arguments are required');
		const sensitive = args.some(isSensitive);
		let lists = 0;
		const elementTypes = args.map((argument, index) => {
			const type = valueType(argument);
			switch (type.kind) {
				case 'set':
					return type.element;
				case 'list':
					lists++;
					return type.element;
				case 'tuple': {
					lists++;
					if (type.elements.length === 0) return ctyDynamic;
					const unified = unify([...type.elements], true)?.type;
					if (!unified) throw new ArgumentError(index, 'all elements must be of the same type');
					return unified;
				}
				default:
					throw new ArgumentError(index, 'a set or a list is required');
			}
		});
		let combinations: Value[][] = [[]];
		for (const [index, argument] of args.entries()) {
			const elements = elementsOf(argument).map(element => convert(element, elementTypes[index]));
			combinations = combinations.flatMap(combination => elements.map(element => [...combination, element]));
		}
		const tuple = tupleOf(elementTypes);
		const tuples = combinations.map(makeArrayValue);
		return marked(lists === args.length ? makeListValue(tuple, tuples) : makeSetValue(tuple, tuples), sensitive);
	},

	// go-cty's slice: a list's or tuple's elements from the start index up to the end index.
	slice: async (args: Value[]) => {
		const { elements, type, sensitive } = sequence(args[0]);
		if (type.kind === 'set') {
			throw new ArgumentError(0, 'cannot slice a set, because its elements do not have indices; explicitly convert to a list if the ordering of the result is not important');
		}
		if (type.kind !== 'list' && type.kind !== 'tuple') throw new ArgumentError(0, 'must be a list or tuple value');
		const index = (position: 1 | 2, what: string): number => {
			try {
				return Number((args[position].value as CtyNumber).toGoInt64());
			} catch (error) {
				throw new ArgumentError(position, `invalid ${what} index: ${(error as Error).message}`);
			}
		};
		const start = index(1, 'start');
		if (start < 0) throw new ArgumentError(1, 'start index must not be less than zero');
		if (start > elements.length) throw new ArgumentError(1, 'start index must not be greater than the length of the list');
		const end = index(2, 'end');
		if (end < 0) throw new ArgumentError(2, 'end index must not be less than zero');
		if (end > elements.length) throw new ArgumentError(2, 'end index must not be greater than the length of the list');
		if (start > end) throw new ArgumentError(1, 'start index must not be greater than end index');
		const sliced = elements.slice(start, end);
		return marked(type.kind === 'list' ? makeListValue(type.element, sliced) : makeArrayValue(sliced), sensitive);
	},

	// go-cty's sort: a list of strings in the order of their bytes.
	sort: async (args: Value[]) => {
		const elements = elementsOf(args[0]);
		const nullIndex = elements.findIndex(element => element.type === 'null');
		if (nullIndex !== -1) throw new Error(`given list element ${nullIndex} is null; a null string cannot be sorted`);
		return makeListValue(ctyString, elements.map(element => String(element.value)).sort(compareStrings).map(makeStringValue));
	},

	// OpenTofu's sum: a list's, set's or tuple's elements, each converted to a number, added in order to the first.
	sum: async (args: Value[]) => {
		const type = valueType(args[0]);
		const plain = unwrapSensitive(args[0]);
		if (type.kind === 'string' || type.kind === 'number' || type.kind === 'bool') throw new ArgumentError(0, 'cannot sum noniterable');
		const size = plain.type === 'array' ? (plain.value as Value[]).length : (plain.value as Map<string, Value>).size;
		if (size === 0) throw new ArgumentError(0, 'cannot sum an empty list');
		if (type.kind !== 'list' && type.kind !== 'set' && type.kind !== 'tuple') {
			throw new ArgumentError(0, `argument must be list, set, or tuple. Received ${friendlyName(type)}`);
		}
		const notNumbers = (): Error => new ArgumentError(0, 'argument must be list, set, or tuple of number values');
		const number = (element: Value): CtyNumber => {
			if (unwrapSensitive(element).type === 'null') throw notNumbers();
			try {
				return convert(unwrapSensitive(element), ctyNumber).value as CtyNumber;
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				throw notNumbers();
			}
		};
		const [first, ...rest] = plain.value as Value[];
		let total = number(first);
		for (const element of rest) {
			const addend = number(element);
			if (total.isInfinite() && addend.isInfinite() && total.sign() !== addend.sign()) throw new Error("can't compute sum of opposing infinities");
			total = total.add(addend);
		}
		return marked(makeNumberValue(total), isSensitive(args[0]));
	},

	// OpenTofu's transpose: a map of lists of strings with its keys and elements swapped, each list in key order.
	transpose: async (args: Value[]) => {
		const result = new Map<string, Value[]>();
		const entries = entriesOf(args[0]);
		for (const key of [...entries.keys()].sort(compareStrings)) {
			const list = entries.get(key)!;
			if (list.type === 'null') throw new ArgumentError(0, `cannot use null list for [${goQuoted(key)}]`);
			for (const [index, element] of (list.value as Value[]).entries()) {
				if (element.type === 'null') throw new ArgumentError(0, `cannot use null string for [${goQuoted(key)}][${index}]`);
				const swapped = String(element.value);
				result.set(swapped, [...(result.get(swapped) ?? []), makeStringValue(key)]);
			}
		}
		return makeMapValue(listOf(ctyString), new Map([...result].map(([key, keys]) => [key, makeListValue(ctyString, keys)])));
	},

	// go-cty's values: a map's elements as a list, an object's attributes as a tuple, in the order of their keys' bytes.
	values: async (args: Value[]) => {
		const type = valueType(args[0]);
		if (type.kind !== 'map' && type.kind !== 'object') throw new Error('values() requires a map as the first argument');
		const entries = entriesOf(args[0]);
		const values = [...entries.keys()].sort(compareStrings).map(key => entries.get(key)!);
		return marked(type.kind === 'map' ? makeListValue(type.element, values) : makeArrayValue(values), isSensitive(args[0]));
	},

	// go-cty's zipmap: a map of a list's elements, or an object of a tuple's, by the keys in order.
	zipmap: async (args: Value[]) => {
		const keys = elementsOf(args[0]);
		const valuesType = valueType(args[1]);
		const values = elementsOf(args[1]);
		const sensitive = isSensitive(args[0]) || isSensitive(args[1]);
		if (valuesType.kind !== 'list' && valuesType.kind !== 'tuple') throw new Error('values argument must be a list or tuple value');
		if (keys.length !== values.length) throw new Error(`number of keys (${keys.length}) does not match number of values (${values.length})`);
		const entries = new Map<string, Value>();
		for (const [index, key] of keys.entries()) {
			if (unwrapSensitive(key).type === 'null') throw new Error(`keys list has null value at index ${index}`);
			entries.set(String(unwrapSensitive(key).value), values[index]);
		}
		return marked(valuesType.kind === 'list' ? makeMapValue(valuesType.element, entries) : makeObjectValue(entries), sensitive);
	},

	// go-cty's one: a list's, set's or tuple's only element, or a null of its element type when it has none.
	one: async (args: Value[]) => {
		const type = valueType(args[0]);
		const refused = new ArgumentError(0, 'must be a list, set, or tuple value with either zero or one elements');
		if (type.kind !== 'list' && type.kind !== 'set' && type.kind !== 'tuple') throw refused;
		const elements = elementsOf(args[0]);
		if (elements.length > 1) throw refused;
		return elements[0] ?? makeNullValue(type.kind === 'tuple' ? ctyDynamic : type.element);
	}
};
