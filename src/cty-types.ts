/**
 * go-cty's types, as go-cty v1.19.0 gives them to the values of a Terragrunt v1.2.2 configuration: the primitive
 * types, the dynamic pseudo-type, the collection types list, set and map, each of one element type, and the structural
 * types tuple and object, each of its own element or attribute types.
 */
export type CtyType =
	| { readonly kind: 'string' }
	| { readonly kind: 'number' }
	| { readonly kind: 'bool' }
	| { readonly kind: 'dynamic' }
	| CollectionType
	| { readonly kind: 'tuple'; readonly elements: readonly CtyType[] }
	| { readonly kind: 'object'; readonly attributes: ReadonlyMap<string, CtyType> };

/** A list, set or map type: a collection whose elements share one type. */
export interface CollectionType {
	readonly kind: 'list' | 'set' | 'map';
	readonly element: CtyType;
}

export const ctyString: CtyType = { kind: 'string' };
export const ctyNumber: CtyType = { kind: 'number' };
export const ctyBool: CtyType = { kind: 'bool' };
/** go-cty's DynamicPseudoType: the type of HCL's `null` keyword, and a constraint any type meets. */
export const ctyDynamic: CtyType = { kind: 'dynamic' };

export const listOf = (element: CtyType): CollectionType => ({ kind: 'list', element });
export const setOf = (element: CtyType): CollectionType => ({ kind: 'set', element });
export const mapOf = (element: CtyType): CollectionType => ({ kind: 'map', element });
export const tupleOf = (elements: readonly CtyType[]): CtyType => ({ kind: 'tuple', elements });
export const objectOf = (attributes: ReadonlyMap<string, CtyType>): CtyType => ({ kind: 'object', attributes });

export const isPrimitiveType = (type: CtyType): boolean => type.kind === 'string' || type.kind === 'number' || type.kind === 'bool';
export const isCollectionType = (type: CtyType): type is CollectionType => type.kind === 'list' || type.kind === 'set' || type.kind === 'map';

/** Whether two types are the same type, as go-cty's Type.Equals decides. */
export function typeEquals(left: CtyType, right: CtyType): boolean {
	if (left === right) return true;
	switch (left.kind) {
		case 'list':
		case 'set':
		case 'map':
			return right.kind === left.kind && typeEquals(left.element, (right as CollectionType).element);
		case 'tuple':
			return right.kind === 'tuple'
				&& left.elements.length === right.elements.length
				&& left.elements.every((element, index) => typeEquals(element, right.elements[index]));
		case 'object': {
			if (right.kind !== 'object' || left.attributes.size !== right.attributes.size) return false;
			for (const [name, attribute] of left.attributes) {
				const other = right.attributes.get(name);
				if (other === undefined || !typeEquals(attribute, other)) return false;
			}
			return true;
		}
		default:
			return right.kind === left.kind;
	}
}

/** Whether a type is, or holds anywhere within it, the dynamic pseudo-type, as go-cty's HasDynamicTypes decides. */
export function hasDynamicTypes(type: CtyType): boolean {
	switch (type.kind) {
		case 'dynamic':
			return true;
		case 'list':
		case 'set':
		case 'map':
			return hasDynamicTypes(type.element);
		case 'tuple':
			return type.elements.some(hasDynamicTypes);
		case 'object':
			return [...type.attributes.values()].some(hasDynamicTypes);
		default:
			return false;
	}
}

/**
 * The name go-cty gives a type in a message, its FriendlyName: `string`, `number`, `bool`, `dynamic`, `tuple`,
 * `object`, and a collection as `list of string`, `set of object` or `map of list of number`.
 */
export function friendlyName(type: CtyType): string {
	return typeName(type, false);
}

/**
 * The name go-cty gives a type where it is a constraint a value must meet, its FriendlyNameForConstraint: as
 * {@link friendlyName}, except that the dynamic pseudo-type is `any type`, and a collection of it `list of any single
 * type`.
 */
export function friendlyNameForConstraint(type: CtyType): string {
	return typeName(type, true);
}

function typeName(type: CtyType, constraint: boolean): string {
	switch (type.kind) {
		case 'string':
		case 'number':
		case 'bool':
		case 'tuple':
		case 'object':
			return type.kind;
		case 'dynamic':
			return constraint ? 'any type' : 'dynamic';
		case 'list':
		case 'set':
		case 'map': {
			const element = constraint && type.element.kind === 'dynamic' ? 'any single type' : typeName(type.element, constraint);
			return `${type.kind} of ${element}`;
		}
	}
}
