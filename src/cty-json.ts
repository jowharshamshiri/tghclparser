import { CtyNumber } from './cty-number';
import { type CtyType, ctyBool, ctyDynamic, ctyNumber, ctyString, listOf, mapOf, objectOf, setOf, tupleOf } from './cty-types';
import {
	makeArrayValue,
	makeBooleanValue,
	makeListValue,
	makeMapValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeSetValue,
	makeStringValue,
	valueType
} from './functions/utils';
import type { RuntimeValue, ValueType } from './model';

/*
 * go-cty v1.19.0's JSON package, as Terragrunt reads a dependency's outputs with it: `output -json` and a state file
 * record each output's value with its type, and the value is decoded as of that type. The JSON comes from
 * parseJsonDocument, so each number is a CtyNumber read from its own text.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof CtyNumber);

/**
 * A type as go-cty's UnmarshalType reads its JSON: `"string"`, `"number"`, `"bool"`, `"dynamic"`, `["list", T]`,
 * `["set", T]`, `["map", T]`, `["tuple", [T, ...]]` and `["object", {name: T, ...}]`, with optional attributes after
 * an object's, which a value of it holds as any other.
 *
 * @throws Error saying what is not a type.
 */
export function unmarshalType(json: unknown): CtyType {
	switch (json) {
		case 'string': return ctyString;
		case 'number': return ctyNumber;
		case 'bool': return ctyBool;
		case 'dynamic': return ctyDynamic;
		default: break;
	}
	if (!Array.isArray(json) || typeof json[0] !== 'string') throw new Error(`invalid type ${JSON.stringify(json)}`);
	const [kind, argument] = json;
	switch (kind) {
		case 'list': return listOf(unmarshalType(argument));
		case 'set': return setOf(unmarshalType(argument));
		case 'map': return mapOf(unmarshalType(argument));
		case 'tuple':
			if (!Array.isArray(argument)) throw new Error('tuple type must have a list of element types');
			return tupleOf(argument.map(unmarshalType));
		case 'object':
			if (!isRecord(argument)) throw new Error('object type must have an object of attribute types');
			return objectOf(new Map(Object.entries(argument).map(([name, type]) => [name, unmarshalType(type)])));
		default:
			throw new Error(`invalid type kind "${kind}"`);
	}
}

/**
 * A type as go-cty's MarshalType writes its JSON, which {@link unmarshalType} reads back.
 */
export function marshalType(type: CtyType): unknown {
	switch (type.kind) {
		case 'string':
		case 'number':
		case 'bool':
		case 'dynamic':
			return type.kind;
		case 'list':
		case 'set':
		case 'map':
			return [type.kind, marshalType(type.element)];
		case 'tuple':
			return ['tuple', type.elements.map(marshalType)];
		case 'object':
			return ['object', Object.fromEntries([...type.attributes].map(([name, attribute]) => [name, marshalType(attribute)]))];
	}
}

/**
 * A value as go-cty's Unmarshal reads its JSON as of a type: null as a null of the type; a primitive as go-cty reads
 * one, a string also from a number or bool; a list, set, map, tuple or object of its elements; and for the dynamic
 * pseudo-type an object of the value and its type.
 *
 * @throws Error in go-cty's words when the JSON is not a value of the type.
 */
export function unmarshalValue(json: unknown, type: CtyType): RuntimeValue<ValueType> {
	if (json === null) return makeNullValue(type);
	switch (type.kind) {
		case 'dynamic': {
			if (!isRecord(json)) throw new Error("invalid JSON: expected '{'");
			const invalid = Object.keys(json).find(key => key !== 'type' && key !== 'value');
			if (invalid !== undefined) throw new Error(`invalid key "${invalid}" in dynamically-typed value`);
			if (!('type' in json)) throw new Error('missing type in dynamically-typed value');
			if (!('value' in json)) throw new Error('missing value in dynamically-typed value');
			return unmarshalValue(json.value, unmarshalType(json.type));
		}
		case 'bool':
			if (typeof json === 'boolean') return makeBooleanValue(json);
			if (json === 'true' || json === '1') return makeBooleanValue(true);
			if (json === 'false' || json === '0') return makeBooleanValue(false);
			throw new Error(typeof json === 'string' ? 'a bool is required' : 'bool is required');
		case 'number':
			if (json instanceof CtyNumber) return makeNumberValue(json);
			if (typeof json === 'string') {
				const number = CtyNumber.tryParse(json);
				if (!number) throw new Error('a number is required');
				return makeNumberValue(number);
			}
			throw new Error('number is required');
		case 'string':
			if (typeof json === 'string') return makeStringValue(json);
			if (json instanceof CtyNumber) return makeStringValue(json.toString());
			if (typeof json === 'boolean') return makeStringValue(json ? 'true' : 'false');
			throw new Error('string is required');
		case 'list':
		case 'set': {
			if (!Array.isArray(json)) throw new Error("invalid JSON: expected '['");
			const elements = json.map(item => unmarshalValue(item, type.element));
			const element = elements.length === 0 ? type.element : valueType(elements[0]);
			return type.kind === 'list' ? makeListValue(element, elements) : makeSetValue(element, elements);
		}
		case 'map': {
			if (!isRecord(json)) throw new Error("invalid JSON: expected '{'");
			const entries = new Map(Object.entries(json).map(([key, item]) => [key, unmarshalValue(item, type.element)]));
			const element = entries.size === 0 ? type.element : valueType(entries.values().next().value!);
			return makeMapValue(element, entries);
		}
		case 'tuple': {
			if (!Array.isArray(json)) throw new Error("invalid JSON: expected '['");
			if (json.length > type.elements.length) throw new Error(`too many tuple elements (need ${type.elements.length})`);
			if (json.length < type.elements.length) throw new Error(`not enough tuple elements (need ${type.elements.length})`);
			return makeArrayValue(json.map((item, index) => unmarshalValue(item, type.elements[index])));
		}
		case 'object': {
			if (!isRecord(json)) throw new Error("invalid JSON: expected '{'");
			const attributes = new Map<string, RuntimeValue<ValueType>>();
			for (const [name, item] of Object.entries(json)) {
				const attribute = type.attributes.get(name);
				if (attribute === undefined) throw new Error(`unsupported attribute "${name}"`);
				attributes.set(name, unmarshalValue(item, attribute));
			}
			for (const [name, attribute] of type.attributes) if (!attributes.has(name)) attributes.set(name, makeNullValue(attribute));
			return makeObjectValue(attributes);
		}
	}
}
