import { CtyNumber } from '../cty-number';
import { consistentWithPrefix } from '../cty-strings';
import type { RuntimeValue, ValueType } from '../model';
import { ConversionError, convert } from '../cty-convert';
import { ArgumentError } from '../function-signature';
import { ctyEquals, friendlyTypeName, makeBooleanValue, makeSensitiveValue, unwrapSensitive, valueType } from './utils';

/*
 * The functions of OpenTofu v1.2.2's function table that state an assumption about a value, and the ones that report
 * or drop what marks a value: as Terragrunt v1.2.2 vendors them from OpenTofu, with go-cty's conversions and
 * refinement checks applied to the known values a Terragrunt configuration holds.
 */

const isSensitive = (value: RuntimeValue<ValueType>): boolean => (value.type as string) === 'sensitive';

/** A result marked as go-cty marks it when a parameter does not take marked values: sensitive when an argument is. */
export function markedLike(result: RuntimeValue<ValueType>, args: RuntimeValue<ValueType>[]): RuntimeValue<ValueType> {
	return args.some(isSensitive) ? makeSensitiveValue(result) : result;
}

/** go-cty's conversion of a value to the type of another, or undefined when it refuses. */
function convertLike(value: RuntimeValue<ValueType>, like: RuntimeValue<ValueType>): RuntimeValue<ValueType> | undefined {
	const actual = unwrapSensitive(value);
	const target = unwrapSensitive(like);
	if (target.type === 'null' || actual.type === 'null') return actual;
	try {
		return convert(actual, valueType(target));
	} catch (error) {
		if (error instanceof ConversionError) return undefined;
		throw error;
	}
}

const valuesEqual = ctyEquals;

// Go's math.MaxInt.
const maxInt = 2n ** 63n - 1n;

/**
 * A length bound HCL has converted to a number, refused unless go-cty reads it as a whole number below the largest
 * int. OpenTofu reports the refusal at the position it gives, which for the one-bound functions is that of the value.
 *
 * @param args the call's arguments.
 * @param index the bound's position.
 * @param reported the position OpenTofu reports a refused bound at.
 */
function lengthBound(args: RuntimeValue<ValueType>[], index: number, reported: number): number {
	const { integer, accuracy } = (unwrapSensitive(args[index]).value as CtyNumber).truncate();
	if (accuracy !== 'exact' || integer === undefined || integer >= maxInt) {
		throw new ArgumentError(reported, `must be a whole number between 0 and ${maxInt}`);
	}
	return Number(integer);
}

/**
 * The collection an assumption is stated about, which HCL has converted to a list, set or map of one element type
 * already, as the parameter's type asks.
 */
function convertCollection(argument: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	return unwrapSensitive(argument);
}

const notUpheld = (): Error => new ArgumentError(0, 'assumption was not upheld');

function lengthOf(collection: RuntimeValue<ValueType>): number {
	if (collection.type === 'null') throw notUpheld();
	return collection.type === 'array'
		? (collection.value as RuntimeValue<ValueType>[]).length
		: (collection.value as Map<string, RuntimeValue<ValueType>>).size;
}

/** assume<kind>length: the collection, when its length lies within both bounds. */
function assumeLengthBetween() {
	return async (args: RuntimeValue<ValueType>[]) => {
		const collection = convertCollection(args[0]);
		const min = lengthBound(args, 1, 1);
		const max = lengthBound(args, 2, 2);
		const length = lengthOf(collection);
		if (min > length || max < length) throw notUpheld();
		return markedLike(collection, args);
	};
}

/** assume<kind>lengthmin and assume<kind>lengthmax: the collection, when its length meets the one bound. */
function assumeLengthBound(bound: 'min' | 'max') {
	return async (args: RuntimeValue<ValueType>[]) => {
		const collection = convertCollection(args[0]);
		const limit = lengthBound(args, 1, 0);
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
			throw new ArgumentError(0, `actual value type ${friendlyTypeName(actual)} does not match assumed value type ${friendlyTypeName(assumed)}`);
		}
		if (!valuesEqual(converted, unwrapSensitive(assumed))) {
			throw new ArgumentError(0, 'the actual value does not match the assumed value');
		}
		return assumed;
	},
	assumenotnull: async (args: RuntimeValue<ValueType>[]) => {
		// HCL's null keyword, and every null a configuration can hold here, has no type, which go-cty refuses first.
		if (unwrapSensitive(args[0]).type === 'null') {
			throw new ArgumentError(0, 'given value must have a known type; consider using the \\"convert\\" function to specify a type to assume');
		}
		return args[0];
	},
	// HCL has converted the value to a string, or a null, and the prefix to a string.
	assumestringprefix: async (args: RuntimeValue<ValueType>[]) => {
		const value = unwrapSensitive(args[0]);
		const prefix = String(unwrapSensitive(args[1]).value);
		if (value.type !== 'null' && !consistentWithPrefix(String(value.value), prefix)) throw notUpheld();
		return markedLike(value, args);
	},
	assumelistlength: assumeLengthBetween(),
	assumelistlengthmin: assumeLengthBound('min'),
	assumelistlengthmax: assumeLengthBound('max'),
	assumesetlength: assumeLengthBetween(),
	assumesetlengthmin: assumeLengthBound('min'),
	assumesetlengthmax: assumeLengthBound('max'),
	assumemaplength: assumeLengthBetween(),
	assumemaplengthmin: assumeLengthBound('min'),
	assumemaplengthmax: assumeLengthBound('max'),
	// A Terragrunt configuration holds no ephemeral value, so nothing becomes null and every other mark stays.
	ephemeralasnull: async (args: RuntimeValue<ValueType>[]) => args[0],
	// Only the value's own mark counts: an element marked sensitive does not mark the collection that holds it.
	issensitive: async (args: RuntimeValue<ValueType>[]) => makeBooleanValue(isSensitive(args[0])),
	list: removedFunction('list', 'tolist([ ... ])'),
	map: removedFunction('map', 'tomap({ ... })')
};
