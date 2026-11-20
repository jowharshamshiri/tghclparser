import { CtyNumber } from './cty-number';
import { ConversionError, convert, unify } from './cty-convert';
import { type CtyType, ctyBool, ctyDynamic, ctyNumber, ctyString, friendlyName, typeEquals } from './cty-types';
import {
	ctyEquals,
	makeArrayValue,
	makeBooleanValue,
	makeListValue,
	makeNumberValue,
	makeSensitiveValue,
	makeStringValue,
	unwrapSensitive,
	valueType
} from './functions/utils';
import type { RuntimeValue, ValueType } from './model';

/**
 * HCL's expressions as hclsyntax v2.25.0 evaluates them over go-cty v1.19.0's values, where the result depends on
 * types: the operators, each converting its operands to the type the operation takes; indexing and attribute access;
 * the conditional's result type; the elements a for expression visits; splats; and the conversions templates, keys
 * and conditions make. A result computed from a sensitive value is sensitive. A fault is stated as the detail of
 * HCL's diagnostic for it.
 */

type Value = RuntimeValue<ValueType>;

const isSensitive = (value: Value): boolean => (value.type as string) === 'sensitive';

function marked(result: Value, operands: Value[]): Value {
	return operands.some(isSensitive) && !isSensitive(result) ? makeSensitiveValue(result) : result;
}

/**
 * A value converted to a type as HCL converts an operand or a key, or the reason it does not convert.
 *
 * @returns the converted value, or the message of go-cty's conversion error.
 */
function tryConvert(value: Value, type: CtyType): { value: Value } | { error: string } {
	try {
		return { value: convert(value, type) };
	} catch (error) {
		if (!(error instanceof ConversionError)) throw error;
		return { error: error.message };
	}
}

/**
 * A value converted to a number as go-cty's convert does it: a number as it is, and a string read as go-cty's
 * ParseNumberVal reads it.
 *
 * @param value a value that is not null and not sensitive.
 * @returns the number.
 * @throws ConversionError with go-cty's message when the value does not convert.
 */
export function convertToNumber(value: Value): CtyNumber {
	return convert(value, ctyNumber).value as CtyNumber;
}

/**
 * An operand converted to a number, as HCL converts it before it calls the operation.
 *
 * @param value the operand.
 * @param side which operand it is, as HCL names it: `left`, `right` or `unary`.
 * @returns the number, or null for a null operand, which the operation itself refuses.
 * @throws Error in HCL's words when the operand does not convert.
 */
function numberOperand(value: Value, side: string): CtyNumber | null {
	const converted = tryConvert(unwrapSensitive(value), ctyNumber);
	if ('error' in converted) throw new Error(`Unsuitable value for ${side} operand: ${converted.error}.`);
	return converted.value.type === 'null' ? null : (converted.value.value as CtyNumber);
}

function operation(compute: () => Value): Value {
	try {
		return compute();
	} catch (error) {
		throw new Error(`Error during operation: ${error instanceof Error ? error.message : String(error)}.`);
	}
}

function numbersOf(left: Value, right: Value): [CtyNumber, CtyNumber] {
	const a = numberOperand(left, 'left');
	const b = numberOperand(right, 'right');
	if (a === null || b === null) throw new Error('Error during operation: argument must not be null.');
	return [a, b];
}

/**
 * `+`, `-`, `*`, `/` or `%` as HCL computes it.
 *
 * @param operator the operator.
 * @param left the left operand.
 * @param right the right operand.
 * @returns the number.
 * @throws Error in HCL's words when an operand is not a number or the operation fails.
 */
export function arithmetic(operator: string, left: Value, right: Value): Value {
	const [a, b] = numbersOf(left, right);
	const result = operation(() => {
		switch (operator) {
			case '+': return makeNumberValue(a.add(b));
			case '-': return makeNumberValue(a.subtract(b));
			case '*': return makeNumberValue(a.multiply(b));
			case '/': return makeNumberValue(a.divide(b));
			case '%': return makeNumberValue(a.modulo(b));
			default: throw new Error(`unknown arithmetic operator "${operator}"`);
		}
	});
	return marked(result, [left, right]);
}

/**
 * Unary `-` as HCL computes it.
 *
 * @param operand the operand.
 * @returns the number negated.
 */
export function negation(operand: Value): Value {
	const number = numberOperand(operand, 'unary');
	if (number === null) throw new Error('Error during operation: argument must not be null.');
	return marked(makeNumberValue(number.negate()), [operand]);
}

/**
 * `==`, `!=`, `<`, `<=`, `>` or `>=` as HCL computes it: equality takes values of any type as they are, as go-cty's
 * Equals compares them, and the orderings convert their operands to numbers, `<=` and `>=` being the ordering or
 * go-cty's equality.
 *
 * @param operator the operator.
 * @param left the left operand.
 * @param right the right operand.
 * @returns the bool.
 */
export function comparison(operator: string, left: Value, right: Value): Value {
	if (operator === '==' || operator === '!=') {
		const equal = ctyEquals(left, right);
		return marked(makeBooleanValue(operator === '==' ? equal : !equal), [left, right]);
	}
	const [a, b] = numbersOf(left, right);
	const order = a.compare(b);
	let result: boolean;
	switch (operator) {
		case '<': result = order < 0; break;
		case '<=': result = order < 0 || a.equals(b); break;
		case '>': result = order > 0; break;
		case '>=': result = order > 0 || a.equals(b); break;
		default: throw new Error(`Unknown comparison operator "${operator}"`);
	}
	return marked(makeBooleanValue(result), [left, right]);
}

/**
 * A value converted to a bool as HCL converts one (go-cty's conversion): a bool as it is, null as null, and the
 * strings "true" and "1", "false" and "0".
 *
 * @returns the bool, or null for null.
 * @throws ConversionError saying why the value is not a bool, in go-cty's words.
 */
export function convertToBool(value: Value): boolean | null {
	const converted = convert(unwrapSensitive(value), ctyBool);
	return converted.type === 'null' ? null : Boolean(converted.value);
}

/**
 * A condition, of `?:` or of a template's `if`, as HCL takes it.
 *
 * @throws Error when the condition is null or does not convert to a bool, in HCL's words.
 */
export function conditionValue(value: Value): boolean {
	const plain = unwrapSensitive(value);
	if (plain.type === 'null') throw new Error('The condition value is null. Conditions must either be true or false.');
	const converted = tryConvert(plain, ctyBool);
	if ('error' in converted) throw new Error('The condition expression must be of type bool.');
	return Boolean(converted.value.value);
}

/**
 * An operand of `&&`, `||` or `!` converted to a bool as HCL converts it.
 *
 * @param side which operand it is, as HCL names it.
 * @returns the bool, or null for null.
 * @throws Error naming the operand when it does not convert, in HCL's words.
 */
export function operandBool(value: Value, side: 'left' | 'right' | 'unary'): boolean | null {
	const converted = tryConvert(unwrapSensitive(value), ctyBool);
	if ('error' in converted) throw new Error(`Unsuitable value for ${side} operand: ${converted.error}.`);
	return converted.value.type === 'null' ? null : Boolean(converted.value.value);
}

/**
 * An interpolation's value as a string template includes it, as HCL's TemplateExpr converts one: converted to a
 * string by go-cty's conversion. A sensitive value is included as the value it protects, and makes the rendered string
 * sensitive. A template that is one interpolation and nothing else is not converted: HCL gives it the interpolation's
 * value as it is.
 *
 * @returns the text the value renders as, and whether it was sensitive.
 * @throws Error saying why the value cannot be included, in HCL's words.
 */
export function templatePart(value: Value): { text: string; sensitive: boolean } {
	const plain = unwrapSensitive(value);
	if (plain.type === 'null') throw new Error('The expression result is null. Cannot include a null value in a string template.');
	const converted = tryConvert(plain, ctyString);
	if ('error' in converted) throw new Error(`Cannot include the given value in a string template: ${converted.error}.`);
	return { text: String(converted.value.value), sensitive: plain !== value };
}

const INVALID_KEY = 'The given key does not identify an element in this collection value';

/**
 * `collection[key]` as HCL's Index gives it: a list's or tuple's element at a whole-number position, a map's element
 * or an object's attribute by a string key, each key converted as go-cty converts it. A set has no indices. The
 * result carries the collection's sensitivity, and for a list, tuple or map the key's too.
 *
 * @throws Error in HCL's words when the key selects nothing.
 */
export function indexValue(collection: Value, key: Value): Value {
	const base = unwrapSensitive(collection);
	const index = unwrapSensitive(key);
	if (base.type === 'null') throw new Error('This value is null, so it does not have any indices.');
	if (index.type === 'null') throw new Error("Can't use a null value as an indexing key.");
	const type = valueType(base);
	switch (type.kind) {
		case 'list':
		case 'tuple': {
			const converted = tryConvert(index, ctyNumber);
			if ('error' in converted) throw new Error(`${INVALID_KEY}: ${converted.error}.`);
			const elements = base.value as Value[];
			const number = converted.value.value as CtyNumber;
			const { integer, accuracy } = number.truncate();
			if (integer !== undefined && accuracy === 'exact' && integer >= 0n && integer < BigInt(elements.length)) {
				return marked(elements[Number(integer)], [collection, key]);
			}
			throw new Error(`${INVALID_KEY}${sequenceMiss(number, elements.length)}.`);
		}
		case 'map': {
			const converted = tryConvert(index, ctyString);
			if ('error' in converted) throw new Error(`${INVALID_KEY}: ${converted.error}.`);
			const element = (base.value as Map<string, Value>).get(String(converted.value.value));
			if (element === undefined) throw new Error(`${INVALID_KEY}.`);
			return marked(element, [collection, key]);
		}
		case 'object': {
			const converted = tryConvert(index, ctyString);
			if ('error' in converted) throw new Error(`${INVALID_KEY}: ${converted.error}.`);
			const attribute = (base.value as Map<string, Value>).get(String(converted.value.value));
			if (attribute === undefined) {
				const suggestion = index.type === 'number' ? ' An object only supports looking up attributes by name, not by numeric index.' : '';
				throw new Error(`${INVALID_KEY}.${suggestion}`);
			}
			return marked(attribute, [collection]);
		}
		case 'set':
			throw new Error("Elements of a set are identified only by their value and don't have any separate index or key to select with, so it's only possible to perform operations across all elements of the set.");
		default:
			throw new Error('This value does not have any indices.');
	}
}

/**
 * Why a number selects no element of a sequence, as HCL's Index says it after the generic words: a fractional part, a
 * negative number, and an index equal to the length, which alone of the indexes past the end HCL explains.
 */
function sequenceMiss(number: CtyNumber, length: number): string {
	if (number.isInfinite()) return '';
	const { integer, accuracy } = number.truncate();
	if (accuracy !== 'exact') return ': indexing a sequence requires a whole number, but the given index has a fractional part';
	if (number.sign() < 0) return ': a negative number is not a valid index for a sequence';
	if (integer === BigInt(length)) {
		return length === 0 ? ': the collection has no elements' : ': the given index is greater than or equal to the length of the collection';
	}
	return '';
}

/**
 * `value.name` as HCL's GetAttr gives it: an object's attribute, or a map's element by that key. The result carries
 * the value's sensitivity.
 *
 * @throws Error in HCL's words when the value has no such attribute or element.
 */
export function attributeValue(value: Value, name: string): Value {
	const base = unwrapSensitive(value);
	if (base.type === 'null') throw new Error('This value is null, so it does not have any attributes.');
	const type = valueType(base);
	switch (type.kind) {
		case 'object': {
			const attribute = (base.value as Map<string, Value>).get(name.normalize('NFC'));
			if (attribute === undefined) throw new Error(`This object does not have an attribute named "${name}".`);
			return marked(attribute, [value]);
		}
		case 'map': {
			const element = (base.value as Map<string, Value>).get(name.normalize('NFC'));
			if (element === undefined) throw new Error(`This map does not have an element with the key "${name}".`);
			return marked(element, [value]);
		}
		case 'list':
			if (type.element.kind === 'object') {
				if (type.element.attributes.has(name)) {
					throw new Error(`Can't access attributes on a list of objects. Did you mean to access attribute "${name}" for a specific element of the list, or across all elements of the list?`);
				}
				throw new Error("Can't access attributes on a list of objects. Did you mean to access an attribute for a specific element of the list, or across all elements of the list?");
			}
			break;
		case 'set':
			if (type.element.kind === 'object') {
				throw new Error("Can't access attributes on a set of objects. Did you mean to access an attribute across all elements of the set?");
			}
			break;
		case 'string':
		case 'number':
		case 'bool':
			throw new Error(`Can't access attributes on a primitive-typed value (${friendlyName(type)}).`);
		default:
			break;
	}
	throw new Error('This value does not have any attributes.');
}

/**
 * The type of an attribute or element `name` of a value of the given type, as {@link attributeValue} would give it:
 * an object's attribute's type, a map's element type; the dynamic pseudo-type for any other.
 */
export function attributeType(type: CtyType, name: string): CtyType {
	if (type.kind === 'object') return type.attributes.get(name) ?? ctyDynamic;
	if (type.kind === 'map') return type.element;
	return ctyDynamic;
}

/**
 * The elements of a for expression's collection as go-cty's ElementIterator gives them, with the key variable of
 * each: a list's or tuple's elements by index, a map's elements and an object's attributes in the order of their
 * keys' bytes, by key, and a set's elements in set order, each its own key.
 *
 * @param value the collection, unmarked.
 * @throws Error when the collection is null or is not a collection, in HCL's words.
 */
export function forElements(value: Value): Array<[Value, Value]> {
	if (value.type === 'null') throw new Error('A null value cannot be used as the collection in a \'for\' expression.');
	const type = valueType(value);
	switch (type.kind) {
		case 'list':
		case 'tuple':
			return (value.value as Value[]).map((element, index) => [makeNumberValue(CtyNumber.fromInt64(index)), element]);
		case 'set':
			return (value.value as Value[]).map(element => [element, element]);
		case 'map':
		case 'object': {
			const entries = value.value as Map<string, Value>;
			return [...entries.keys()].sort(compareKeys).map(key => [makeStringValue(key), entries.get(key)!]);
		}
		default:
			throw new Error(`A value of type ${friendlyName(type)} cannot be used as the collection in a 'for' expression.`);
	}
}

/** Orders two keys by their UTF-8 bytes, as Go's sort.Strings orders them. */
function compareKeys(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/**
 * The key a `{for ...}` expression produces for an element, converted to a string as HCL converts it.
 *
 * @throws Error in HCL's words when the key is null or does not convert.
 */
export function forKey(value: Value): string {
	const plain = unwrapSensitive(value);
	if (plain.type === 'null') throw new Error("Key expression in 'for' expression must not produce a null value.");
	const converted = tryConvert(plain, ctyString);
	if ('error' in converted) throw new Error(`The key expression produced an invalid result: ${converted.error}.`);
	return String(converted.value.value);
}

/**
 * Whether a for expression keeps an element, by its `if` clause converted to a bool as HCL converts it.
 *
 * @throws Error in HCL's words when the clause is null or does not convert.
 */
export function forCondition(value: Value): boolean {
	const plain = unwrapSensitive(value);
	if (plain.type === 'null') throw new Error("The value of the 'if' clause must not be null.");
	const converted = tryConvert(plain, ctyBool);
	if ('error' in converted) throw new Error(`The 'if' clause value is invalid: ${converted.error}.`);
	return Boolean(converted.value.value);
}

/**
 * A key of an object constructor, `{ (key) = value }`, converted to a string as HCL converts it.
 *
 * @throws Error in HCL's words when the key is null or does not convert.
 */
export function objectKey(value: Value): string {
	const plain = unwrapSensitive(value);
	if (plain.type === 'null') throw new Error("Can't use a null value as a key.");
	const converted = tryConvert(plain, ctyString);
	if ('error' in converted) throw new Error(`Can't use this value as a key: ${converted.error}.`);
	return String(converted.value.value);
}

/** A branch of a conditional once evaluated: its value, or what evaluating it threw. */
export type ConditionalBranch = { value: Value } | { error: unknown };

/** HCL's literal `null`, of the dynamic pseudo-type and unmarked: the only null that takes the other branch's type outright. */
const isUntypedNull = (value: Value): boolean => value.type === 'null' && value.ctyType?.kind === 'dynamic';

/**
 * `condition ? whenTrue : whenFalse` as HCL's ConditionalExpr gives it, once both branches are evaluated: the two
 * branches' types unified to the result's type first, refusing branches of inconsistent types before the condition
 * is looked at; then the chosen branch converted to that type. A branch whose evaluation failed is of no known type,
 * and its fault is reported only when it is chosen. The result carries the sensitivity of the condition and of both
 * branches.
 *
 * @param whenTrue the true branch.
 * @param whenFalse the false branch.
 * @param condition evaluates the condition: its truth, and its value for its sensitivity.
 * @throws Error in HCL's words when the branches' types are inconsistent, what the condition throws, and what the
 *   chosen branch threw.
 */
export function conditionalResult(whenTrue: ConditionalBranch, whenFalse: ConditionalBranch, condition: () => { truth: boolean; value: Value }): Value {
	const typeOf = (branch: ConditionalBranch): CtyType => ('value' in branch ? valueType(branch.value) : ctyDynamic);
	const trueType = typeOf(whenTrue);
	const falseType = typeOf(whenFalse);
	let conversions: (((value: Value) => Value) | undefined)[] = [undefined, undefined];
	if ('value' in whenTrue && isUntypedNull(whenTrue.value)) {
		conversions = [value => convert(value, falseType), undefined];
	} else if ('value' in whenFalse && isUntypedNull(whenFalse.value)) {
		conversions = [undefined, value => convert(value, trueType)];
	} else if (trueType.kind !== 'dynamic' && falseType.kind !== 'dynamic') {
		const unified = unify([trueType, falseType], true);
		if (!unified) {
			throw new Error(`The true and false result expressions must have consistent types. ${describeConditionalTypeMismatch(trueType, falseType)}.`);
		}
		conversions = unified.conversions;
	}
	const { truth, value: conditionMarks } = condition();
	const chosen = truth ? whenTrue : whenFalse;
	if ('error' in chosen) throw chosen.error;
	const conversion = conversions[truth ? 0 : 1];
	let result: Value;
	try {
		result = conversion ? conversion(chosen.value) : chosen.value;
	} catch (error) {
		if (!(error instanceof ConversionError)) throw error;
		throw new Error(`The ${truth ? 'true' : 'false'} result value has the wrong type: ${error.message}.`);
	}
	const marks = [conditionMarks, ...[whenTrue, whenFalse].flatMap(branch => ('value' in branch ? [branch.value] : []))];
	return marked(result, marks);
}

/** HCL's describeConditionalTypeMismatch: where two branch types part ways. */
function describeConditionalTypeMismatch(trueType: CtyType, falseType: CtyType): string {
	if (trueType.kind === 'object' && falseType.kind === 'object') {
		for (const name of [...trueType.attributes.keys()].sort(compareKeys)) {
			const falseAttribute = falseType.attributes.get(name);
			if (falseAttribute === undefined) return `The 'true' value includes object attribute "${name}", which is absent in the 'false' value`;
			const trueAttribute = trueType.attributes.get(name)!;
			if (!typeEquals(trueAttribute, falseAttribute)) {
				return `Type mismatch for object attribute "${name}": ${describeConditionalTypeMismatch(trueAttribute, falseAttribute)}`;
			}
		}
		for (const name of [...falseType.attributes.keys()].sort(compareKeys)) {
			if (!trueType.attributes.has(name)) return `The 'false' value includes object attribute "${name}", which is absent in the 'true' value`;
		}
	} else if (trueType.kind === 'tuple' && falseType.kind === 'tuple') {
		if (trueType.elements.length !== falseType.elements.length) {
			return `The 'true' tuple has length ${trueType.elements.length}, but the 'false' tuple has length ${falseType.elements.length}`;
		}
		for (const [index, trueElement] of trueType.elements.entries()) {
			const falseElement = falseType.elements[index];
			if (!typeEquals(trueElement, falseElement)) {
				return `Type mismatch for tuple element ${index}: ${describeConditionalTypeMismatch(trueElement, falseElement)}`;
			}
		}
	} else if ((trueType.kind === 'list' || trueType.kind === 'set' || trueType.kind === 'map') && trueType.kind === falseType.kind) {
		const trueElement = trueType.element;
		const falseElement = (falseType as typeof trueType).element;
		if ((trueElement.kind === 'object' && falseElement.kind === 'object') || (trueElement.kind === 'tuple' && falseElement.kind === 'tuple')) {
			return `Mismatched ${trueType.kind} element types: ${describeConditionalTypeMismatch(trueElement, falseElement)}`;
		}
	}
	const trueName = friendlyName(trueType);
	const falseName = friendlyName(falseType);
	if (trueName === falseName) return "At least one deeply-nested attribute or element is not compatible across both the 'true' and the 'false' value";
	return `The 'true' value is ${trueName}, but the 'false' value is ${falseName}`;
}

/**
 * `source[*]` and `source.*` as HCL's SplatExpr gives them, `each` applied to each element: a list or set gives a list
 * of the results, in the set's order for a set; a tuple a tuple. Any other value is taken as a tuple of that one
 * value, and a null of such a type as an empty tuple. The result carries the source's sensitivity.
 *
 * @param source the value splatted.
 * @param each the traversal after the splat, applied to an element.
 * @param eachType the type of what `each` gives for an element of the given type, for an empty list or set.
 * @throws Error in HCL's words for a null list, set or tuple, and for results of a list or set's elements that are
 *   not all of one type.
 */
export function splatResult(source: Value, each: (element: Value) => Value, eachType: (type: CtyType) => CtyType): Value {
	const plain = unwrapSensitive(source);
	const type = valueType(plain);
	const sequence = type.kind === 'tuple' || type.kind === 'list' || type.kind === 'set';
	if (plain.type === 'null') {
		if (!sequence) return marked(makeArrayValue([]), [source]);
		throw new Error('Splat expressions (with the * symbol) cannot be applied to null sequences.');
	}
	const elements = sequence ? (plain.value as Value[]) : [plain];
	// A value taken as a tuple of itself keeps its sensitivity as the tuple's element; a sequence's is the result's.
	const results = elements.map(element => each(sequence ? element : source));
	if (type.kind !== 'list' && type.kind !== 'set') return marked(makeArrayValue(results), [source]);
	if (results.length === 0) return marked(makeListValue(eachType(type.element), []), [source]);
	const first = valueType(results[0]);
	if (!results.every(result => typeEquals(valueType(result), first))) {
		throw new Error("The second level of splat expression produced elements of different types, so it isn't possible to construct a valid list to represent the top-level result.\n\nConsider using a for expression instead, to produce a tuple-typed result which can therefore have non-homogenous element types.");
	}
	return marked(makeListValue(first, results), [source]);
}
