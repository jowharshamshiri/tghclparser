import { CtyNumber } from './cty-number';
import {
	type CollectionType,
	type CtyType,
	ctyDynamic,
	friendlyName,
	friendlyNameForConstraint,
	hasDynamicTypes,
	isCollectionType,
	isPrimitiveType,
	listOf,
	mapOf,
	objectOf,
	setOf,
	tupleOf,
	typeEquals
} from './cty-types';
import {
	compareStrings,
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
} from './functions/utils';
import type { RuntimeValue, ValueType } from './model';

/*
 * go-cty v1.19.0's convert package, for the known values a Terragrunt configuration holds: the conversions between
 * types, the unification of several types to one, and the message that says why a value does not convert.
 */

type Value = RuntimeValue<ValueType>;

/** Converts a value of the type it was made for, or throws a {@link ConversionError}. */
export type Conversion = (value: Value) => Value;

/** A value that has a conversion's types but not a value it can convert, in go-cty's words. */
export class ConversionError extends Error {}

const isSensitive = (value: Value): boolean => (value.type as string) === 'sensitive';

/**
 * The conversion from one type to another, as go-cty's getConversion finds it: undefined when there is none. A safe
 * conversion never fails; an unsafe one also converts a string to a number or bool, a list to a set and a map to an
 * object, and may fail on the value it is given. Either keeps a value's sensitivity and gives a null of the type
 * converted to.
 */
export function getConversion(from: CtyType, to: CtyType, unsafe: boolean): Conversion | undefined {
	const known = getConversionKnown(from, to, unsafe);
	if (!known) return undefined;
	const conversion: Conversion = value => {
		if (isSensitive(value)) return makeSensitiveValue(conversion(unwrapSensitive(value)));
		if (to.kind === 'dynamic') return value;
		if (value.type === 'null') return makeNullValue(dynamicReplace(valueType(value), to));
		return known(value);
	};
	return conversion;
}

/** go-cty's GetConversionUnsafe. */
export const getConversionUnsafe = (from: CtyType, to: CtyType): Conversion | undefined => getConversion(from, to, true);

/**
 * A value converted to a type, as go-cty's Convert does it: unchanged when it is of that type already, else by the
 * unsafe conversion.
 *
 * @throws ConversionError saying why it does not convert: {@link mismatchMessage} when its type has no conversion,
 *   the conversion's own words when the value does not.
 */
export function convert(value: Value, want: CtyType): Value {
	const type = valueType(value);
	if (typeEquals(type, want)) return value;
	const conversion = getConversionUnsafe(type, want);
	if (!conversion) throw new ConversionError(mismatchMessage(type, want));
	return conversion(value);
}

function getConversionKnown(from: CtyType, to: CtyType, unsafe: boolean): Conversion | undefined {
	if (to.kind === 'dynamic') return value => value;
	if (unsafe && from.kind === 'dynamic') return value => convert(value, to);
	if (isPrimitiveType(from) && isPrimitiveType(to)) return primitiveConversion(from, to, unsafe);
	if (to.kind === 'object' && from.kind === 'object') return conversionObjectToObject(from, to, unsafe);
	if (to.kind === 'tuple' && from.kind === 'tuple') return conversionTupleToTuple(from, to, unsafe);
	if (to.kind === 'list' && (from.kind === 'list' || from.kind === 'set')) {
		if (typeEquals(from.element, to.element)) return conversionCollectionToList(to.element, undefined);
		const element = getConversion(from.element, to.element, unsafe);
		return element && conversionCollectionToList(to.element, element);
	}
	if (to.kind === 'set' && (from.kind === 'list' || from.kind === 'set')) {
		if (from.kind === 'list' && !unsafe) return undefined;
		if (typeEquals(from.element, to.element)) return conversionCollectionToSet(to.element, undefined);
		const element = getConversion(from.element, to.element, unsafe);
		return element && conversionCollectionToSet(to.element, element);
	}
	if (to.kind === 'map' && from.kind === 'map') {
		const element = getConversion(from.element, to.element, unsafe);
		return element && conversionCollectionToMap(to.element, element);
	}
	if (to.kind === 'list' && from.kind === 'tuple') return conversionTupleToList(from.elements, to.element, unsafe);
	if (to.kind === 'set' && from.kind === 'tuple') return conversionTupleToSet(from.elements, to.element, unsafe);
	if (to.kind === 'map' && from.kind === 'object') return conversionObjectToMap(from.attributes, to.element, unsafe);
	if (to.kind === 'object' && from.kind === 'map') return unsafe ? conversionMapToObject(from, to.attributes, unsafe) : undefined;
	return undefined;
}

/** go-cty's primitive conversions: a number or bool to a string safely, and a string to a number or bool unsafely. */
function primitiveConversion(from: CtyType, to: CtyType, unsafe: boolean): Conversion | undefined {
	if (to.kind === 'string') {
		if (from.kind === 'number') return value => makeStringValue((value.value as CtyNumber).text('f', -1));
		if (from.kind === 'bool') return value => makeStringValue(value.value ? 'true' : 'false');
		return undefined;
	}
	if (!unsafe || from.kind !== 'string') return undefined;
	if (to.kind === 'number') {
		return value => {
			const number = CtyNumber.tryParse(String(value.value));
			if (!number) throw new ConversionError('a number is required');
			return makeNumberValue(number);
		};
	}
	if (to.kind === 'bool') {
		return value => {
			const text = String(value.value);
			if (text === 'true' || text === '1') return makeBooleanValue(true);
			if (text === 'false' || text === '0') return makeBooleanValue(false);
			const lower = text.toLowerCase();
			if (lower === 'true' || lower === 'false') throw new ConversionError(`a bool is required; to convert from string, use lowercase "${lower}"`);
			throw new ConversionError('a bool is required');
		};
	}
	return undefined;
}

const elementsOf = (value: Value): Value[] => value.value as Value[];
const entriesOf = (value: Value): Map<string, Value> => value.value as Map<string, Value>;

function conversionObjectToObject(from: Extract<CtyType, { kind: 'object' }>, to: Extract<CtyType, { kind: 'object' }>, unsafe: boolean): Conversion | undefined {
	const conversions = new Map<string, Conversion | undefined>();
	for (const [name, wanted] of to.attributes) {
		const given = from.attributes.get(name);
		if (given === undefined) return undefined;
		if (typeEquals(given, wanted)) {
			conversions.set(name, undefined);
			continue;
		}
		const conversion = getConversion(given, wanted, unsafe);
		if (!conversion) return undefined;
		conversions.set(name, conversion);
	}
	return value => {
		const attributes = new Map<string, Value>();
		for (const [name, entry] of entriesOf(value)) {
			if (!conversions.has(name)) continue;
			const conversion = conversions.get(name);
			attributes.set(name, conversion ? conversion(entry) : entry);
		}
		return makeObjectValue(attributes);
	};
}

function conversionTupleToTuple(from: Extract<CtyType, { kind: 'tuple' }>, to: Extract<CtyType, { kind: 'tuple' }>, unsafe: boolean): Conversion | undefined {
	if (from.elements.length !== to.elements.length) return undefined;
	const conversions: (Conversion | undefined)[] = [];
	for (const [index, wanted] of to.elements.entries()) {
		const given = from.elements[index];
		if (typeEquals(given, wanted)) {
			conversions.push(undefined);
			continue;
		}
		const conversion = getConversion(given, wanted, unsafe);
		if (!conversion) return undefined;
		conversions.push(conversion);
	}
	return value => makeArrayValue(elementsOf(value).map((element, index) => conversions[index]?.(element) ?? element));
}

/** go-cty's CanListVal and CanSetVal: whether the elements are all of one type. */
function allOneType(values: Value[]): boolean {
	if (values.length === 0) return true;
	const first = valueType(values[0]);
	return values.every(value => typeEquals(valueType(value), first));
}

function conversionCollectionToList(element: CtyType, conversion: Conversion | undefined): Conversion {
	return value => {
		const elements = elementsOf(value).map(entry => (conversion ? conversion(entry) : entry));
		if (elements.length === 0) {
			const source = valueType(value) as CollectionType;
			return makeListValue(element.kind === 'dynamic' ? source.element : element, []);
		}
		if (!allOneType(elements)) throw new ConversionError('element types must all match for conversion to list');
		return makeListValue(valueType(elements[0]), elements);
	};
}

function conversionCollectionToSet(element: CtyType, conversion: Conversion | undefined): Conversion {
	return value => {
		const elements = elementsOf(value).map(entry => (conversion ? conversion(entry) : entry));
		if (elements.length === 0) {
			const source = valueType(value) as CollectionType;
			return makeSetValue(element.kind === 'dynamic' ? source.element : element, []);
		}
		if (!allOneType(elements)) throw new ConversionError('element types must all match for conversion to set');
		return makeSetValue(valueType(elements[0]), elements);
	};
}

function conversionCollectionToMap(element: CtyType, conversion: Conversion | undefined): Conversion {
	return value => {
		let entries = new Map<string, Value>();
		for (const [key, entry] of entriesOf(value)) entries.set(key, conversion ? conversion(entry) : entry);
		if (entries.size === 0) {
			const source = valueType(value) as CollectionType;
			return makeMapValue(element.kind === 'dynamic' ? source.element : element, new Map());
		}
		if (isCollectionType(element) || element.kind === 'object') entries = unifyEntries(entries, false);
		if (!allOneType([...entries.values()])) throw new ConversionError('element types must all match for conversion to map');
		return makeMapValue(valueType(entries.values().next().value!), entries);
	};
}

/**
 * The element type a tuple's or object's element types convert to for a collection of the given element type: that
 * type, or for the dynamic pseudo-type the type they unify to. Undefined where there is none, and where the dynamic
 * pseudo-type is all they unify to although one of them is of another type.
 */
function structuralElementType(given: CtyType[], wanted: CtyType, unsafe: boolean, dynamicOnlyIfAll: boolean): CtyType | undefined {
	if (wanted.kind !== 'dynamic') return wanted;
	const unified = unify(given, unsafe)?.type;
	if (!unified) return undefined;
	if (dynamicOnlyIfAll && unified.kind === 'dynamic' && !given.every(type => type.kind === 'dynamic')) return undefined;
	return unified;
}

/** The conversion of each of a tuple's or object's element types to one element type, or undefined where one has none. */
function elementConversions(given: CtyType[], element: CtyType, unsafe: boolean): (Conversion | undefined)[] | undefined {
	const conversions: (Conversion | undefined)[] = [];
	for (const type of given) {
		if (typeEquals(type, element)) {
			conversions.push(undefined);
			continue;
		}
		const conversion = getConversion(type, element, unsafe);
		if (!conversion) return undefined;
		conversions.push(conversion);
	}
	return conversions;
}

function conversionTupleToSet(given: readonly CtyType[], wanted: CtyType, unsafe: boolean): Conversion | undefined {
	if (given.length === 0) return () => makeSetValue(wanted, []);
	const element = structuralElementType([...given], wanted, unsafe, true);
	if (!element) return undefined;
	const conversions = elementConversions([...given], element, unsafe);
	if (!conversions) return undefined;
	return value => {
		const elements = elementsOf(value).map((entry, index) => conversions[index]?.(entry) ?? entry);
		if (!allOneType(elements)) throw new ConversionError('element types must all match for conversion to set');
		return makeSetValue(valueType(elements[0]), elements);
	};
}

function conversionTupleToList(given: readonly CtyType[], wanted: CtyType, unsafe: boolean): Conversion | undefined {
	if (given.length === 0) return () => makeListValue(wanted, []);
	const element = structuralElementType([...given], wanted, unsafe, true);
	if (!element) return undefined;
	const conversions = elementConversions([...given], element, unsafe);
	if (!conversions) return undefined;
	return value => {
		const elements = unifyElements(elementsOf(value).map((entry, index) => conversions[index]?.(entry) ?? entry), unsafe);
		if (!allOneType(elements)) throw new ConversionError('element types must all match for conversion to list');
		return makeListValue(valueType(elements[0]), elements);
	};
}

function conversionObjectToMap(given: ReadonlyMap<string, CtyType>, wanted: CtyType, unsafe: boolean): Conversion | undefined {
	if (given.size === 0) return () => makeMapValue(wanted, new Map());
	const element = structuralElementType([...given.values()], wanted, unsafe, false);
	if (!element) return undefined;
	const names = [...given.keys()];
	const list = elementConversions([...given.values()], element, unsafe);
	if (!list) return undefined;
	const conversions = new Map(names.map((name, index) => [name, list[index]]));
	return value => {
		let entries = new Map<string, Value>();
		for (const [name, entry] of entriesOf(value)) entries.set(name, conversions.get(name)?.(entry) ?? entry);
		if (isCollectionType(element) || element.kind === 'object') entries = unifyEntries(entries, unsafe);
		if (!allOneType([...entries.values()])) throw new ConversionError('attribute types must all match for conversion to map');
		return makeMapValue(valueType(entries.values().next().value!), entries);
	};
}

function conversionMapToObject(from: CollectionType, attributes: ReadonlyMap<string, CtyType>, unsafe: boolean): Conversion | undefined {
	const conversions = new Map<string, Conversion | undefined>();
	for (const [name, wanted] of attributes) {
		if (typeEquals(wanted, from.element)) continue;
		const conversion = getConversion(from.element, wanted, unsafe);
		if (!conversion) return undefined;
		conversions.set(name, conversion);
	}
	return value => {
		const converted = new Map<string, Value>();
		for (const [name, entry] of entriesOf(value)) {
			if (!attributes.has(name)) continue;
			const conversion = conversions.get(name);
			converted.set(name, conversion ? conversion(entry) : entry);
		}
		for (const name of attributeNames(attributes)) {
			if (!converted.has(name)) throw new ConversionError(`map has no element for required attribute "${name}"`);
		}
		return makeObjectValue(converted);
	};
}

/** go-cty's conversionUnifyListElements: a list's elements converted to the one type they unify to. */
function unifyElements(elements: Value[], unsafe: boolean): Value[] {
	const unified = unify(elements.map(valueType), unsafe)?.type;
	if (!unified) throw new ConversionError('cannot find a common base type for all elements');
	return elements.map(element => {
		const type = valueType(element);
		return typeEquals(type, unified) ? element : getConversion(type, unified, unsafe)!(element);
	});
}

/** go-cty's conversionUnifyCollectionElements: a map's elements converted to the one type they unify to. */
function unifyEntries(entries: Map<string, Value>, unsafe: boolean): Map<string, Value> {
	const names = [...entries.keys()];
	const values = unifyElements(names.map(name => entries.get(name)!), unsafe);
	return new Map(names.map((name, index) => [name, values[index]]));
}

/**
 * The type a value of the given type converts to where the conversion's target is, or holds, the dynamic
 * pseudo-type, as go-cty's dynamicReplace gives the type of a null it converts.
 */
function dynamicReplace(from: CtyType, to: CtyType): CtyType {
	if (from.kind === 'dynamic') return to;
	switch (to.kind) {
		case 'dynamic':
			return from;
		case 'string':
		case 'number':
		case 'bool':
			return to;
		case 'map':
			if (from.kind === 'map') return mapOf(dynamicReplace(from.element, to.element));
			if (from.kind === 'object') return mapOf(dynamicReplace(unify([...from.attributes.values()], true)?.type ?? ctyDynamic, to.element));
			return to;
		case 'object': {
			const attributes = new Map<string, CtyType>();
			if (from.kind === 'map') for (const [name, type] of to.attributes) attributes.set(name, dynamicReplace(from.element, type));
			if (from.kind === 'object') {
				for (const [name, type] of to.attributes) {
					const given = from.attributes.get(name);
					attributes.set(name, given === undefined ? type : dynamicReplace(given, type));
				}
			}
			return objectOf(attributes);
		}
		case 'set':
		case 'list': {
			const make = to.kind === 'set' ? setOf : listOf;
			if (from.kind === 'set' || from.kind === 'list') return make(dynamicReplace(from.element, to.element));
			if (from.kind === 'tuple') return make(dynamicReplace(unify([...from.elements], true)?.type ?? ctyDynamic, to.element));
			return to;
		}
		case 'tuple':
			return tupleOf(to.elements.map((type, index) => dynamicReplace((from as Extract<CtyType, { kind: 'tuple' }>).elements[index], type)));
	}
}

/** The one type several types unify to, and the conversion of each to it (undefined where it is that type already). */
export interface Unified {
	type: CtyType;
	conversions: (Conversion | undefined)[];
}

/**
 * The one type several types convert to, as go-cty's unify finds it: undefined when there is none. Collections of one
 * kind unify their element types, objects and tuples of one shape their attribute or element types, and otherwise
 * the most general type that every type converts to is chosen.
 */
export function unify(types: CtyType[], unsafe: boolean): Unified | undefined {
	if (types.length === 0) return undefined;
	const count = (kind: CtyType['kind']) => types.filter(type => type.kind === kind).length;
	const maps = count('map');
	const lists = count('list');
	const sets = count('set');
	const objects = count('object');
	const tuples = count('tuple');
	const dynamics = count('dynamic');
	if (maps > 0 && maps + dynamics === types.length) return unifyCollectionTypes(mapOf, types, unsafe, dynamics > 0);
	if (maps > 0 && maps + objects + dynamics === types.length) {
		const unified = unifyStructuralAsCollection(types, 'object', unsafe);
		if (unified) return unified;
	} else if (lists > 0 && lists + dynamics === types.length) {
		return unifyCollectionTypes(listOf, types, unsafe, dynamics > 0);
	} else if (lists > 0 && lists + tuples + dynamics === types.length) {
		const unified = unifyStructuralAsCollection(types, 'tuple', unsafe);
		if (unified) return unified;
	} else if (sets > 0 && sets + dynamics === types.length) {
		return unifyCollectionTypes(setOf, types, unsafe, dynamics > 0);
	} else if (objects > 0 && objects + dynamics === types.length) {
		return unifyObjectTypes(types, unsafe, dynamics > 0);
	} else if (tuples > 0 && tuples + dynamics === types.length) {
		return unifyTupleTypes(types, unsafe, dynamics > 0);
	} else if (objects > 0 && tuples > 0) {
		return undefined;
	}

	preferences: for (const wantIndex of sortTypes(types)) {
		const want = types[wantIndex];
		const conversions: (Conversion | undefined)[] = [];
		for (const [index, type] of types.entries()) {
			if (index === wantIndex || typeEquals(type, want)) {
				conversions.push(undefined);
				continue;
			}
			const conversion = getConversion(type, want, unsafe);
			if (!conversion) continue preferences;
			conversions.push(conversion);
		}
		return { type: want, conversions };
	}
	return undefined;
}

/** go-cty's unifyTuplesAsList and unifyObjectsAsMaps: the tuples or objects among maps or lists unified as one first. */
function unifyStructuralAsCollection(types: CtyType[], structural: 'tuple' | 'object', unsafe: boolean): Unified | undefined {
	const indexes = types.flatMap((type, index) => (type.kind === structural ? [index] : []));
	const asCollection = structural === 'tuple'
		? unifyTupleTypesToList(indexes.map(index => types[index]), unsafe)
		: unifyObjectTypesToMap(indexes.map(index => types[index]), unsafe);
	const kind = structural === 'tuple' ? 'list' : 'map';
	if (asCollection?.type.kind !== kind) return undefined;
	const replaced = types.map((type, index) => (indexes.includes(index) ? asCollection.type : type));
	const unified = unify(replaced, unsafe);
	if (unified?.type.kind !== kind) return undefined;
	const conversions = [...unified.conversions];
	for (const [position, index] of indexes.entries()) {
		const collectionConversion = conversions[index];
		const structuralConversion = asCollection.conversions[position];
		conversions[index] = collectionConversion === undefined
			? structuralConversion
			// go-cty applies the collection conversion to the value as given, not to the structural conversion's result.
			: value => {
				structuralConversion?.(value);
				return collectionConversion(value);
			};
	}
	return { type: unified.type, conversions };
}

/** The conversion of each type to the unified one, or undefined when one has none. */
function conversionsTo(types: CtyType[], unified: CtyType, unsafe: boolean): (Conversion | undefined)[] | undefined {
	const conversions: (Conversion | undefined)[] = [];
	for (const type of types) {
		if (typeEquals(type, unified)) {
			conversions.push(undefined);
			continue;
		}
		const conversion = getConversion(type, unified, unsafe);
		if (!conversion) return undefined;
		conversions.push(conversion);
	}
	return conversions;
}

function unifyCollectionTypes(make: (element: CtyType) => CtyType, types: CtyType[], unsafe: boolean, hasDynamic: boolean): Unified | undefined {
	if (hasDynamic) return unifyAllAsDynamic(types);
	const element = unify(types.map(type => (type as CollectionType).element), unsafe)?.type;
	if (!element) return undefined;
	const type = make(element);
	const conversions = conversionsTo(types, type, unsafe);
	return conversions && { type, conversions };
}

function unifyObjectTypes(types: CtyType[], unsafe: boolean, hasDynamic: boolean): Unified | undefined {
	if (hasDynamic) return unifyAllAsDynamic(types);
	const objects = types as Extract<CtyType, { kind: 'object' }>[];
	const first = objects[0].attributes;
	for (const object of objects.slice(1)) {
		if (object.attributes.size !== first.size || [...object.attributes.keys()].some(name => !first.has(name))) {
			return unifyObjectTypesToMap(types, unsafe);
		}
	}
	const attributes = new Map<string, CtyType>();
	for (const name of first.keys()) {
		const unified = unify(objects.map(object => object.attributes.get(name)!), unsafe)?.type;
		if (!unified) return undefined;
		attributes.set(name, unified);
	}
	const type = objectOf(attributes);
	const conversions = conversionsTo(types, type, unsafe);
	return conversions ? { type, conversions } : unifyObjectTypesToMap(types, unsafe);
}

function unifyObjectTypesToMap(types: CtyType[], unsafe: boolean): Unified | undefined {
	const attributes = (types as Extract<CtyType, { kind: 'object' }>[]).flatMap(object => [...object.attributes.values()]);
	const element = unify(attributes, unsafe)?.type;
	if (!element) return undefined;
	const type = mapOf(element);
	const conversions = conversionsTo(types, type, unsafe);
	return conversions && { type, conversions };
}

function unifyTupleTypes(types: CtyType[], unsafe: boolean, hasDynamic: boolean): Unified | undefined {
	if (hasDynamic) return unifyAllAsDynamic(types);
	const tuples = types as Extract<CtyType, { kind: 'tuple' }>[];
	const length = tuples[0].elements.length;
	if (tuples.some(tuple => tuple.elements.length !== length)) return unifyTupleTypesToList(types, unsafe);
	const elements: CtyType[] = [];
	for (let index = 0; index < length; index++) {
		const unified = unify(tuples.map(tuple => tuple.elements[index]), unsafe)?.type;
		if (!unified) return undefined;
		elements.push(unified);
	}
	const type = tupleOf(elements);
	const conversions = conversionsTo(types, type, unsafe);
	return conversions ? { type, conversions } : unifyTupleTypesToList(types, unsafe);
}

function unifyTupleTypesToList(types: CtyType[], unsafe: boolean): Unified | undefined {
	const elements = (types as Extract<CtyType, { kind: 'tuple' }>[]).flatMap(tuple => [...tuple.elements]);
	const element = unify(elements, unsafe)?.type;
	if (!element) return undefined;
	const type = listOf(element);
	const conversions = conversionsTo(types, type, unsafe);
	return conversions && { type, conversions };
}

/**
 * go-cty's unifyAllAsDynamic: where a dynamic type is among collections or structures of one kind, they unify to the
 * dynamic pseudo-type, and every conversion gives a value not known yet, which a Terragrunt configuration's known
 * values never reach: HCL's callers take the known value as it is first.
 */
function unifyAllAsDynamic(types: CtyType[]): Unified {
	return { type: ctyDynamic, conversions: types.map(() => undefined) };
}

/**
 * go-cty's compareTypes: negative when the first type is the more general of the two, so that the other converts to
 * it, positive when the second is, and zero when neither is.
 */
function compareTypes(a: CtyType, b: CtyType): number {
	if (a.kind === 'dynamic' || b.kind === 'dynamic') {
		if (a.kind !== 'dynamic') return -1;
		if (b.kind !== 'dynamic') return 1;
		return 0;
	}
	if (isPrimitiveType(a) && isPrimitiveType(b) && (a.kind === 'string' || b.kind === 'string')) {
		if (a.kind !== 'string') return 1;
		if (b.kind !== 'string') return -1;
		return 0;
	}
	if ((a.kind === 'list' && b.kind === 'list') || (a.kind === 'set' && b.kind === 'set') || (a.kind === 'map' && b.kind === 'map')) {
		return compareTypes(a.element, b.element);
	}
	let swap = 1;
	if ((a.kind === 'tuple' && b.kind === 'list') || (a.kind === 'object' && b.kind === 'map') || (a.kind === 'set' && b.kind === 'tuple') || (a.kind === 'set' && b.kind === 'list')) {
		[a, b] = [b, a];
		swap = -1;
	}
	if (b.kind === 'set' && (a.kind === 'tuple' || a.kind === 'list')) return -1 * swap;
	if (a.kind === 'list' && b.kind === 'tuple') return -1 * swap;
	if (a.kind === 'map' && b.kind === 'object') return -1 * swap;
	const compareAll = (pairs: [CtyType, CtyType][]): number => {
		let aSuper = false;
		let bSuper = false;
		for (const [left, right] of pairs) {
			const order = compareTypes(left, right);
			if (order < 0) aSuper = true;
			else if (order > 0) bSuper = true;
		}
		if (aSuper && bSuper) return 0;
		if (aSuper) return -1 * swap;
		if (bSuper) return 1 * swap;
		return 0;
	};
	if (a.kind === 'object' && b.kind === 'object') {
		if (a.attributes.size !== b.attributes.size) return 0;
		const pairs: [CtyType, CtyType][] = [];
		for (const [name, type] of a.attributes) {
			const other = b.attributes.get(name);
			if (other === undefined) return 0;
			pairs.push([type, other]);
		}
		return compareAll(pairs);
	}
	if (a.kind === 'tuple' && b.kind === 'tuple') {
		if (a.elements.length !== b.elements.length) return 0;
		const other = b.elements;
		return compareAll(a.elements.map((type, index) => [type, other[index]]));
	}
	return 0;
}

/** go-cty's sortTypes: the types' positions, the most general first, in a topological order of {@link compareTypes}. */
function sortTypes(types: CtyType[]): number[] {
	const edges: number[][] = types.map(() => []);
	for (let i = 0; i < types.length - 1; i++) {
		for (let j = i + 1; j < types.length; j++) {
			const order = compareTypes(types[i], types[j]);
			if (order < 0) edges[i].push(j);
			else if (order > 0) edges[j].push(i);
		}
	}
	const inDegree = types.map(() => 0);
	for (const outs of edges) for (const j of outs) inDegree[j]++;
	const queue = inDegree.flatMap((degree, index) => (degree === 0 ? [index] : []));
	const result: number[] = [];
	while (queue.length > 0) {
		const i = queue.shift()!;
		result.push(i);
		for (const j of edges[i]) {
			inDegree[j]--;
			if (inDegree[j] === 0) queue.push(j);
		}
	}
	// go-cty fills a slice of the types' length, so a cycle leaves the first position at the zero it starts with.
	while (result.length < types.length) result.push(0);
	return result;
}

/** go-cty's MismatchMessage: why a value of one type does not convert to another, in go-cty's words. */
export function mismatchMessage(got: CtyType, want: CtyType): string {
	if (got.kind === 'object' && want.kind === 'object') return mismatchMessageObjects(got, want);
	if (got.kind === 'tuple' && want.kind === 'list' && want.element.kind === 'dynamic') return 'all list elements must have the same type';
	if (got.kind === 'tuple' && want.kind === 'set' && want.element.kind === 'dynamic') return 'all set elements must have the same type';
	if (got.kind === 'object' && want.kind === 'map' && want.element.kind === 'dynamic') return 'all map elements must have the same type';
	if ((got.kind === 'tuple' || got.kind === 'object') && isCollectionType(want)) return mismatchMessageCollectionsFromStructural(got, want);
	if (isCollectionType(got) && isCollectionType(want)) return mismatchMessageCollectionsFromCollections(got, want);
	if (!typesAreLikelyToCauseConfusion(got, want)) return `${friendlyName(want)} required, but have ${friendlyName(got)}`;
	return `${friendlyNameForConstraint(want)} required`;
}

/**
 * The names of an object type's attributes in the order this port visits them, by their bytes. go-cty ranges over a
 * Go map, whose order is not fixed, so where more than one attribute is at fault its message may name any of them.
 */
const attributeNames = (attributes: ReadonlyMap<string, CtyType>): string[] => [...attributes.keys()].sort(compareStrings);

function mismatchMessageObjects(got: Extract<CtyType, { kind: 'object' }>, want: Extract<CtyType, { kind: 'object' }>): string {
	const missing: string[] = [];
	let unsafeMismatch = '';
	let safeMismatch = '';
	for (const name of attributeNames(want.attributes)) {
		const wanted = want.attributes.get(name)!;
		const given = got.attributes.get(name);
		if (given === undefined) {
			missing.push(name);
			continue;
		}
		if (typeEquals(given, wanted)) continue;
		if (unsafeMismatch !== '') continue;
		if (!getConversion(given, wanted, true)) unsafeMismatch = `attribute "${name}": ${mismatchMessage(given, wanted)}`;
		if (safeMismatch !== '') continue;
		if (!getConversion(given, wanted, false)) safeMismatch = `attribute "${name}": ${mismatchMessage(given, wanted)}`;
	}
	if (missing.length > 0) {
		missing.sort();
		const quoted = missing.map(name => `"${name}"`);
		if (quoted.length === 1) return `attribute ${quoted[0]} is required`;
		if (quoted.length === 2) return `attributes ${quoted[0]} and ${quoted[1]} are required`;
		return `attributes ${quoted.slice(0, -1).join(', ')}, and ${quoted.at(-1)} are required`;
	}
	if (unsafeMismatch !== '') return unsafeMismatch;
	if (safeMismatch !== '') return safeMismatch;
	return 'incorrect object attributes';
}

function mismatchMessageCollectionsFromStructural(got: CtyType, want: CollectionType): string {
	if ((want.kind === 'list' || want.kind === 'set') && got.kind !== 'tuple') return `${friendlyNameForConstraint(want)} required`;
	if (want.kind === 'map' && got.kind !== 'object') return `${friendlyNameForConstraint(want)} required`;
	const element = want.element;
	if (got.kind === 'tuple') {
		for (const [index, type] of got.elements.entries()) {
			if (typeEquals(type, element) || getConversion(type, element, true)) continue;
			return `element ${index}: ${mismatchMessage(type, element)}`;
		}
		return `all elements must be ${friendlyNameForConstraint(element)}`;
	}
	if (got.kind === 'object') {
		for (const name of attributeNames(got.attributes)) {
			const type = got.attributes.get(name)!;
			if (typeEquals(type, element) || getConversion(type, element, true)) continue;
			return `element "${name}": ${mismatchMessage(type, element)}`;
		}
		return `all elements must be ${friendlyNameForConstraint(element)}`;
	}
	return `${friendlyNameForConstraint(want)} required`;
}

function mismatchMessageCollectionsFromCollections(got: CollectionType, want: CollectionType): string {
	if ((want.kind === 'list' || want.kind === 'set') && got.kind === 'map') return `${friendlyNameForConstraint(want)} required`;
	if (want.kind === 'map' && got.kind !== 'map') return `${friendlyNameForConstraint(want)} required`;
	return `incorrect ${want.kind} element type: ${mismatchMessage(got.element, want.element)}`;
}

function typesAreLikelyToCauseConfusion(got: CtyType, want: CtyType): boolean {
	if (isPrimitiveType(got) !== isPrimitiveType(want)) return false;
	if (want.kind === 'string') return false;
	if ((want.kind === 'bool' && got.kind === 'number') || (got.kind === 'bool' && want.kind === 'number')) return false;
	if (isCollectionType(got) && isCollectionType(want) && !hasDynamicTypes(got.element) && hasDynamicTypes(want.element)) return false;
	// go-cty's second test, got.IsObjectType() && got.IsTupleType(), can never hold.
	if (got.kind === 'tuple' && want.kind === 'object') return false;
	return true;
}
