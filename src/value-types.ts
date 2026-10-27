import type { RuntimeValue, ValueType } from './model';
import type { ModuleType, ModuleTypeAttribute } from './module-variables';

/** The type of every expression whose shape cannot be read from its syntax. */
const unknownType: ModuleType = { kind: 'primitive', name: 'any', text: 'any' };

/** Characters of an evaluated string kept as its type's text before it is cut with an ellipsis. */
const maximumValueLength = 60;

/**
 * Reads the type of a value expression from its syntax alone, without evaluating anything. Literals give their own
 * shape, `local.` and `var.` references follow the locals and declared variables the reader was given, and `merge`
 * of objects gives the union of their attributes. Every other expression is `any`.
 */
export class ValueTypeReader {
	private readonly locals = new Map<string, any>();
	private readonly resolving = new Set<string>();

	/**
	 * Collects the root `locals` blocks of the given syntax trees. The first assignment of a repeated name wins.
	 *
	 * @param roots the syntax trees whose `locals` blocks `local.` references resolve against.
	 * @param variables the declared types `var.` references resolve to.
	 */
	constructor(roots: any[], private readonly variables: Map<string, ModuleType> = new Map()) {
		for (const root of roots) {
			for (const block of root?.children ?? []) {
				if (block.type !== 'block' || block.value !== 'locals') continue;
				for (const attribute of block.children ?? []) {
					const name = attributeKey(attribute);
					const value = attributeValue(attribute);
					if (name !== undefined && value && !this.locals.has(name)) this.locals.set(name, value);
				}
			}
		}
	}

	/**
	 * The type of a local value, or undefined when no such local is assigned or it refers back to itself.
	 *
	 * @param name the local's name.
	 * @returns the type its value reads as.
	 */
	localType(name: string): ModuleType | undefined {
		const node = this.locals.get(name);
		if (!node || this.resolving.has(name)) return undefined;
		this.resolving.add(name);
		try {
			return this.typeOf(node);
		} finally {
			this.resolving.delete(name);
		}
	}

	/**
	 * The type an expression reads as from its syntax.
	 *
	 * @param node the parser node of the expression.
	 * @returns its type, `any` for an expression whose shape cannot be read.
	 */
	typeOf(node: any): ModuleType {
		switch (node?.type) {
			case 'string_lit':
			case 'interpolated_string':
				return { kind: 'primitive', name: 'string', text: 'string' };
			case 'number_lit':
				return { kind: 'primitive', name: 'number', text: 'number' };
			case 'boolean_lit':
				return { kind: 'primitive', name: 'bool', text: 'bool' };
			case 'array_lit':
				return { kind: 'tuple', elements: (node.children ?? []).map((child: any) => this.typeOf(child)), text: 'tuple' };
			case 'object':
				return this.objectType(node);
			case 'local_reference': {
				const parts = referenceParts(node);
				return (parts && parts.length > 0 && typeAt(this.localType(parts[0]), parts.slice(1))) || unknownType;
			}
			case 'var_reference': {
				const parts = referenceParts(node);
				return (parts && parts.length > 0 && typeAt(this.variables.get(parts[0]), parts.slice(1))) || unknownType;
			}
			case 'function_call':
				return node.value === 'merge' ? this.mergeType(node) : unknownType;
			default:
				return unknownType;
		}
	}

	/**
	 * The type of an object literal. Attributes with computed keys, such as `(local.k) = 1`, are left out.
	 *
	 * @param node the parser node of the object literal.
	 * @returns an object type with one attribute per literal key.
	 */
	private objectType(node: any): ModuleType {
		const attributes: ModuleTypeAttribute[] = [];
		for (const attribute of node.children ?? []) {
			const name = attributeKey(attribute);
			const value = attributeValue(attribute);
			if (name !== undefined && value) attributes.push({ name, type: this.typeOf(value), optional: false });
		}
		return { kind: 'object', attributes, text: 'object' };
	}

	/**
	 * The type of a `merge(...)` call: the attributes of every argument that reads as an object, a later argument's
	 * attribute replacing an earlier one of the same name, as `merge` does.
	 *
	 * @param node the parser node of the call.
	 * @returns an object type, or `any` when no argument reads as an object.
	 */
	private mergeType(node: any): ModuleType {
		const objects = (node.children ?? [])
			.filter((child: any) => child.type !== 'function_identifier')
			.map((child: any) => this.typeOf(child))
			.filter((type: ModuleType) => type.kind === 'object');
		if (objects.length === 0) return unknownType;
		return objects.reduce((merged: ModuleType, type: ModuleType) => mergeObjectTypes(merged, type, false));
	}
}

/**
 * The type of an evaluated value. A string, number or boolean keeps the value itself as its text, so it can be shown
 * where a type would be; a long string is cut with an ellipsis.
 *
 * @param value the evaluated value.
 * @returns its type: an object for an object or block, a tuple for an array, else a primitive.
 */
export function typeOfValue(value: RuntimeValue<ValueType>): ModuleType {
	switch (value.type) {
		case 'string': {
			const text = JSON.stringify(value.value);
			return { kind: 'primitive', name: 'string', text: text.length > maximumValueLength ? `${text.slice(0, maximumValueLength)}…` : text };
		}
		case 'number':
			return { kind: 'primitive', name: 'number', text: String(value.value) };
		case 'boolean':
			return { kind: 'primitive', name: 'bool', text: String(value.value) };
		case 'null':
			return { kind: 'primitive', name: 'any', text: 'null' };
		case 'array':
			return { kind: 'tuple', elements: (value.value as RuntimeValue<ValueType>[]).map(typeOfValue), text: 'tuple' };
		case 'object':
		case 'block':
			return {
				kind: 'object',
				text: 'object',
				attributes: [...(value.value as Map<string, RuntimeValue<ValueType>>).entries()].map(([name, entry]) => ({ name, type: typeOfValue(entry), optional: false }))
			};
		default:
			return unknownType;
	}
}

/**
 * Combines two object types. With `deep`, an attribute both declare as objects is combined in turn; otherwise the
 * second type's attribute replaces the first's.
 *
 * @param first the earlier type.
 * @param second the later type, which wins where the two disagree unless it is `any`.
 * @param deep whether attributes both sides declare as objects are combined rather than replaced.
 * @returns the combined type; when either is not an object, `first` if `second` is `any`, else `second`.
 */
export function mergeObjectTypes(first: ModuleType, second: ModuleType, deep: boolean): ModuleType {
	if (first.kind !== 'object' || second.kind !== 'object') return second.kind === 'primitive' && second.name === 'any' ? first : second;
	const attributes = new Map(first.attributes.map(attribute => [attribute.name, attribute]));
	for (const attribute of second.attributes) {
		const existing = attributes.get(attribute.name);
		attributes.set(attribute.name, deep && existing ? { ...attribute, type: mergeObjectTypes(existing.type, attribute.type, true) } : attribute);
	}
	return { kind: 'object', attributes: [...attributes.values()], text: second.text };
}

/**
 * Follows attribute names down a type: an object gives the named attribute's type and a map its element type.
 *
 * @param type the type to start from.
 * @param path the attribute names to follow, outermost first.
 * @returns the type at the end of the path, or undefined when the type does not describe it.
 */
export function typeAt(type: ModuleType | undefined, path: string[]): ModuleType | undefined {
	let current = type;
	for (const name of path) {
		if (current?.kind === 'object') current = current.attributes.find(attribute => attribute.name === name)?.type;
		else if (current?.kind === 'map') current = current.element;
		else return undefined;
	}
	return current;
}

/**
 * The attribute names after a reference's namespace, such as `a` and `b` in `local.a.b`.
 *
 * @param node the parser node of a `local_reference` or `var_reference`.
 * @returns the names in order, or undefined when the reference indexes, splats or calls along the way.
 */
function referenceParts(node: any): string[] | undefined {
	const chain = node.children?.find((child: any) => child.type === 'access_chain');
	const steps = chain?.children ?? [];
	if (steps.some((step: any) => step.type !== 'reference_identifier')) return undefined;
	return steps.map((step: any) => String(step.value));
}

/**
 * The literal key of an attribute node.
 *
 * @param attribute a parser node.
 * @returns the key, or undefined when the node is not an attribute or its key is computed.
 */
function attributeKey(attribute: any): string | undefined {
	if (attribute?.type !== 'attribute') return undefined;
	const identifier = attribute.children?.find((child: any) => child.type === 'attribute_identifier');
	return identifier ? String(identifier.value) : undefined;
}

/**
 * The value expression of an attribute node.
 *
 * @param attribute an `attribute` parser node.
 * @returns the expression's node, or undefined when there is none.
 */
function attributeValue(attribute: any): any {
	return attribute.children?.find((child: any) => child.type !== 'attribute_identifier');
}
