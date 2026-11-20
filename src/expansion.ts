/*
 * This file ports the block iteration of Terragrunt v1.2.2 (pkg/config/hclparse/expansion.go, its errors in
 * pkg/config/hclparse/errors.go and pkg/config/errors.go, and the spelling check in pkg/config/expansion.go,
 * https://github.com/gruntwork-io/terragrunt, MIT License).
 *
 * A `dependency` block that nests an `expansion` block setting `count` or `for_each` is read once per element: each
 * element is one dependency, addressed by its key, whose body reads `count.index`, or `each.key` and `each.value`.
 */

import { CtyNumber } from './cty-number';
import { compareStrings, friendlyTypeName, makeNumberValue, makeObjectValue, makeStringValue, unwrapSensitive } from './functions/utils';
import { graphemeCount } from './grapheme-clusters';
import type { RuntimeValue, ValueType } from './model';

/** The block that declares a block's iteration. */
export const EXPANSION_BLOCK = 'expansion';

/** The most instances one block may expand into, through `count` or `for_each`. */
export const MAX_INSTANCES = 1_000_000;

/** The meta-arguments an `expansion` block sets exactly one of. */
export type MetaArgument = 'for_each' | 'count';

/** Which element of an expanded block a decoded block came from: the `each.key` of `for_each`, or the `count.index`. */
export type InstanceKey = { eachKey: string } | { countIndex: number };

/** The segment that addresses an instance: its `each.key`, or its `count.index` written in decimal. */
export function instanceKeyText(key: InstanceKey): string {
	return 'eachKey' in key ? key.eachKey : String(key.countIndex);
}

/**
 * The address of a block labelled `label`: the label alone for a block that was not expanded, and `label[key]` for one
 * element of an expanded block, as Terragrunt writes it in its messages.
 */
export function instanceAddress(label: string, key: InstanceKey | undefined): string {
	return key === undefined ? label : `${label}[${instanceKeyText(key)}]`;
}

/** One element of an expansion: its key, and the variables its block's body reads. */
export interface ExpansionElement {
	key: InstanceKey;
	/** `each` or `count`, by name. */
	variables: Map<string, RuntimeValue<ValueType>>;
}

/**
 * Where something is written, as HCL's `hcl.Range` prints it: `file:line,column-column` on one line, or
 * `file:line,column-line,column` across lines, columns counted in grapheme clusters from 1.
 *
 * @param filePath the file, as Terragrunt names it.
 * @param content the file's text.
 * @param start the offset it starts at.
 * @param end the offset it ends before.
 */
export function hclRange(filePath: string, content: string, start: number, end: number): string {
	const position = (offset: number): { line: number; column: number } => {
		const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
		let line = 1;
		for (let index = content.indexOf('\n'); index !== -1 && index < lineStart; index = content.indexOf('\n', index + 1)) line++;
		return { line, column: graphemeCount(content.slice(lineStart, offset)) + 1 };
	};
	const from = position(start);
	const to = position(end);
	return from.line === to.line
		? `${filePath}:${from.line},${from.column}-${to.column}`
		: `${filePath}:${from.line},${from.column}-${to.line},${to.column}`;
}

/** The message of a block that declares a second `expansion` block, placed at the second. */
export function duplicateExpansionBlockMessage(range: string, blockType: string): string {
	return `${range}: the ${blockType} block declares more than one expansion block; a block may declare at most one`;
}

/** The message of an `expansion` block that sets both meta-arguments, placed at the block. */
export function conflictingMetaArgumentsMessage(range: string): string {
	return `${range}: the expansion block sets both for_each and count; set exactly one`;
}

/** The message of an `expansion` block that sets neither meta-argument, placed at the block. */
export function missingMetaArgumentMessage(range: string): string {
	return `${range}: the expansion block sets neither for_each nor count; set exactly one`;
}

/** The message of a dependency label that names both a whole block and the instances of an expanded one. */
export function dependencyLabelCollisionMessage(name: string): string {
	return `dependency "${name}" is declared both with and without an expansion, so the block and its instances claim the same address; rename one of them`;
}

/** The message of two dependency blocks of one file that claim one address. */
export function duplicateDependencyMessage(configPath: string, address: string): string {
	return `${configPath}: dependency ${address} is declared more than once; every dependency needs an address of its own`;
}

/** The message of two dependency blocks of one file that point at one `config_path`. */
export function duplicateDependencyConfigPathMessage(configPath: string, first: string, second: string, dependencyPath: string): string {
	return `${configPath}: dependencies ${first} and ${second} both point at ${dependencyPath}; declare that dependency once and reference it under one name`;
}

/** What Terragrunt warns once per command before naming each pair of dependency blocks that claim one dependency. */
export const DUPLICATE_DEPENDENCY_WARNING = 'Two `dependency` blocks address the same dependency, by sharing a label or a `config_path`. Only the last block with a given label can be referenced, and two blocks for one `config_path` declare the same unit twice. Declare each dependency once. In a future version of Terragrunt, this will result in an error.';

/** The value of a meta-argument that cannot be iterated: null, as requireConcrete refuses it. */
function nullValueMessage(range: string, what: string): string {
	return `${range}: ${what} is null; it must resolve to a concrete value`;
}

function limitMessage(range: string, attribute: MetaArgument, size: number): string {
	return `${range}: ${attribute} expands to ${size} instances, which is above the limit of ${MAX_INSTANCES}. ` +
		'Terragrunt maintainers are not aware of a legitimate use-case for an expansion this large. If you have one, ' +
		'please open an issue at https://github.com/gruntwork-io/terragrunt/issues describing it, so we can consider ' +
		'raising the limit or making it configurable';
}

/**
 * The elements `count` gives: one per index from 0, each reading `count.index`.
 *
 * @param value what `count` evaluated to.
 * @param range where the `count` attribute is written.
 * @throws Error in Terragrunt's words when the value is null, not a whole number, negative or above the limit.
 */
export function countElements(value: RuntimeValue<ValueType>, range: string): ExpansionElement[] {
	const count = unwrapSensitive(value);
	if (count.type === 'null') throw new Error(nullValueMessage(range, 'count'));
	if (count.type !== 'number') throw new Error(`${range}: count must be a whole number: number value is required`);
	let total: bigint;
	try {
		total = (count.value as CtyNumber).toGoInt64();
	} catch (error) {
		throw new Error(`${range}: count must be a whole number: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (total < 0n) throw new Error(`${range}: count is ${total}; it must not be negative`);
	if (total > BigInt(MAX_INSTANCES)) throw new Error(limitMessage(range, 'count', Number(total)));
	const elements: ExpansionElement[] = [];
	for (let index = 0; index < Number(total); index++) {
		elements.push({
			key: { countIndex: index },
			variables: new Map([['count', makeObjectValue(new Map([['index', makeNumberValue(CtyNumber.fromInt64(index))]]))]])
		});
	}
	return elements;
}

/**
 * The elements `for_each` gives, in the order go-cty iterates the collection: a map or object by its keys in the order
 * of their bytes, a set by its elements, each its own key. Each element reads `each.key`, the key as a string, and
 * `each.value`.
 *
 * @param value what `for_each` evaluated to.
 * @param range where the `for_each` attribute is written.
 * @throws Error in Terragrunt's words when the value is null or of a type that cannot be iterated, a set's element is
 *   null or neither a string nor a number, or there are more elements than the limit.
 */
export function forEachElements(value: RuntimeValue<ValueType>, range: string): ExpansionElement[] {
	const collection = unwrapSensitive(value);
	if (collection.type === 'null') throw new Error(nullValueMessage(range, 'for_each'));
	let entries: Array<[RuntimeValue<ValueType>, RuntimeValue<ValueType>]>;
	if (collection.type === 'object' || collection.type === 'block') {
		const map = collection.value as Map<string, RuntimeValue<ValueType>>;
		entries = [...map.keys()].sort(compareStrings).map(key => [makeStringValue(key), map.get(key)!]);
	} else if (collection.type === 'array') {
		entries = (collection.value as RuntimeValue<ValueType>[]).map(element => [element, element]);
	} else {
		throw new Error(`${range}: for_each must be a set or a map, but got ${friendlyTypeName(collection)}`);
	}
	if (entries.length > MAX_INSTANCES) throw new Error(limitMessage(range, 'for_each', entries.length));
	return entries.map(([elementKey, elementValue]) => {
		const key = unwrapSensitive(elementKey);
		let text: string;
		if (key.type === 'null') throw new Error(nullValueMessage(range, 'for_each element'));
		if (key.type === 'string') text = String(key.value);
		else if (key.type === 'number') text = (key.value as CtyNumber).text('f', -1);
		else throw new Error(`${range}: for_each keys must be strings or numbers, but got ${friendlyTypeName(key)}`);
		return {
			key: { eachKey: text },
			variables: new Map([['each', makeObjectValue(new Map([['key', makeStringValue(text)], ['value', elementValue]]))]])
		};
	});
}

/** How far a nested block's name may be from `expansion` and still read as a misspelling of it. */
const MAX_TYPO_DISTANCE = 2;

/** The Levenshtein distance between two strings, counted in characters, as agext/levenshtein counts it. */
function levenshtein(left: string, right: string): number {
	const a = [...left];
	const b = [...right];
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * The first of a block's nested block names that reads as a misspelling of `expansion`, which Terragrunt refuses
 * rather than let the block run without its iteration: one within two edits of it, ignoring case.
 *
 * @param names the types of the blocks nested in a labelled `dependency`, `unit` or `stack` block, in order.
 * @returns the name, or undefined when none is.
 */
export function misspelledExpansionBlock(names: readonly string[]): string | undefined {
	return names.find(name => name !== EXPANSION_BLOCK && levenshtein(name.toLowerCase(), EXPANSION_BLOCK) <= MAX_TYPO_DISTANCE);
}

/** The message of a misspelled `expansion` block. */
export function misspelledExpansionBlockMessage(blockType: string, label: string, configPath: string, name: string): string {
	return `the ${blockType} "${label}" block in ${configPath} declares a "${name}" block, which Terragrunt does not recognize; did you mean "${EXPANSION_BLOCK}"?`;
}

/**
 * The name HCL suggests for one it does not take, as hclsyntax's nameSuggestion finds it: the first fewer than three
 * edits away.
 *
 * @param given the name written.
 * @param names the names taken, in the order HCL tries them.
 * @returns the suggestion, or undefined when none is close.
 */
export function nameSuggestion(given: string, names: readonly string[]): string | undefined {
	return names.find(name => levenshtein(given, name) < 3);
}
