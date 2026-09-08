// Inline functions: JavaScript functions defined directly in a configuration.
//
//   function state_key(environment, component = "app") {
//     return `${environment}/${component}/terraform.tfstate`;
//   }
//
// They are called exactly like built-in functions and are evaluated as
// FunctionOperations, so they travel the same dry/wet context boundary as every
// other function in the registry. Unlike built-ins, which are registered once in
// the process-wide FunctionRegistry, inline functions belong to the file that
// declares them and are carried on the evaluation scope.

import type { FunctionDefinition, FunctionParameter, RuntimeValue, Token, ValueType } from './model';

/** Shape of the parsed nodes this module consumes. */
export interface InlineFunctionNode {
	type: string;
	value?: string | number | boolean | null;
	children?: InlineFunctionNode[];
	variadic?: boolean;
	location?: {
		start: { offset: number; line: number; column: number };
		end: { offset: number; line: number; column: number };
	};
}

export interface InlineFunctionParameter {
	name: string;
	variadic: boolean;
	/** HCL type constraint node, when the parameter carries a `: type` annotation. */
	typeNode?: InlineFunctionNode;
	/** HCL expression node, when the parameter carries an `= default`. */
	defaultNode?: InlineFunctionNode;
}

export interface InlineFunctionDefinition<TScope> {
	name: string;
	parameters: InlineFunctionParameter[];
	/** Raw JavaScript source of the body, exactly as authored. */
	source: string;
	/** 1-based line and column of the body's first character, for error mapping. */
	bodyStart: { line: number; column: number };
	/** Path of the file that declares this function. */
	filePath: string;
	/** Scope of the declaring file: inline functions capture lexically. */
	scope: TScope;
	/** Compiled body, populated on first invocation and reused thereafter. */
	compiled?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * The value types a parameter annotation may name. Mirrors the `type_constraint`
 * and collection nodes produced by the grammar's TypeConstraint rule.
 */
export interface ParameterTypeConstraint {
	kind: 'any' | 'string' | 'number' | 'bool' | 'object' | 'list' | 'set' | 'map' | 'tuple' | 'struct';
	/** Element constraint for list/set/map. */
	element?: ParameterTypeConstraint;
	/** Element constraints for tuple, in order. */
	elements?: ParameterTypeConstraint[];
	/** Attribute constraints for object({...}) struct types. */
	attributes?: Map<string, ParameterTypeConstraint>;
}

/**
 * Reads a grammar type-constraint node into the constraint form used for
 * argument checking. Throws on node shapes the grammar cannot produce, so an
 * unrecognized annotation surfaces as an error rather than silently accepting
 * any value.
 */
export function readTypeConstraint(node: InlineFunctionNode): ParameterTypeConstraint {
	switch (node.type) {
		case 'type_constraint': {
			const name = String(node.value ?? '');
			if (name === 'string' || name === 'number' || name === 'bool' || name === 'object' || name === 'any') {
				return { kind: name };
			}
			throw new Error(`Unsupported parameter type constraint "${name}"`);
		}
		case 'collection_type': {
			const kind = String(node.value ?? '');
			if (kind !== 'list' && kind !== 'set' && kind !== 'map') {
				throw new Error(`Unsupported collection type constraint "${kind}"`);
			}
			const element = node.children?.[0];
			if (!element) throw new Error(`Collection type "${kind}" is missing its element type`);
			return { kind, element: readTypeConstraint(element) };
		}
		case 'tuple_type':
			return { kind: 'tuple', elements: (node.children ?? []).map(child => readTypeConstraint(child)) };
		case 'struct_type': {
			const attributes = new Map<string, ParameterTypeConstraint>();
			for (const attribute of node.children ?? []) {
				if (attribute.type !== 'struct_attribute') {
					throw new Error(`Unexpected node "${attribute.type}" in object type constraint`);
				}
				const constraint = attribute.children?.[0];
				if (!constraint) throw new Error(`Object type attribute "${String(attribute.value)}" is missing its type`);
				attributes.set(String(attribute.value), readTypeConstraint(constraint));
			}
			return { kind: 'struct', attributes };
		}
		default:
			throw new Error(`Unsupported parameter type constraint node "${node.type}"`);
	}
}

/** Renders a constraint the way it was written, for diagnostics and hover. */
export function formatTypeConstraint(constraint: ParameterTypeConstraint): string {
	switch (constraint.kind) {
		case 'list':
		case 'set':
		case 'map':
			return `${constraint.kind}(${formatTypeConstraint(constraint.element!)})`;
		case 'tuple':
			return `tuple(${(constraint.elements ?? []).map(formatTypeConstraint).join(', ')})`;
		case 'struct':
			return `object({${[...(constraint.attributes ?? new Map())]
				.map(([name, value]) => `${name} = ${formatTypeConstraint(value)}`)
				.join(', ')}})`;
		default:
			return constraint.kind;
	}
}

/**
 * Checks a runtime value against a parameter's declared constraint, returning
 * the reason it does not conform or null when it does. Structural constraints
 * are checked through their elements so a mistyped list element is reported
 * where it occurs rather than as a bare "expected list".
 */
export function checkTypeConstraint(
	value: RuntimeValue<ValueType>,
	constraint: ParameterTypeConstraint,
	path: string
): string | null {
	const actual = String(value.type);
	switch (constraint.kind) {
		case 'any':
			return null;
		case 'string':
			return actual === 'string' ? null : `${path} must be a string, got ${actual}`;
		case 'number':
			return actual === 'number' ? null : `${path} must be a number, got ${actual}`;
		case 'bool':
			return actual === 'boolean' ? null : `${path} must be a bool, got ${actual}`;
		case 'object':
			return actual === 'object' || actual === 'block' ? null : `${path} must be an object, got ${actual}`;
		case 'list':
		case 'set': {
			if (actual !== 'array') return `${path} must be a ${constraint.kind}, got ${actual}`;
			const items = value.value as RuntimeValue<ValueType>[];
			for (const [index, item] of items.entries()) {
				const failure = checkTypeConstraint(item, constraint.element!, `${path}[${index}]`);
				if (failure) return failure;
			}
			return null;
		}
		case 'map': {
			if (actual !== 'object' && actual !== 'block') return `${path} must be a map, got ${actual}`;
			const entries = value.value as Map<string, RuntimeValue<ValueType>>;
			for (const [key, item] of entries) {
				const failure = checkTypeConstraint(item, constraint.element!, `${path}["${key}"]`);
				if (failure) return failure;
			}
			return null;
		}
		case 'tuple': {
			if (actual !== 'array') return `${path} must be a tuple, got ${actual}`;
			const items = value.value as RuntimeValue<ValueType>[];
			const expected = constraint.elements ?? [];
			if (items.length !== expected.length) {
				return `${path} must be a tuple of ${expected.length} element${expected.length === 1 ? '' : 's'}, got ${items.length}`;
			}
			for (const [index, item] of items.entries()) {
				const failure = checkTypeConstraint(item, expected[index], `${path}[${index}]`);
				if (failure) return failure;
			}
			return null;
		}
		case 'struct': {
			if (actual !== 'object' && actual !== 'block') return `${path} must be an object, got ${actual}`;
			const entries = value.value as Map<string, RuntimeValue<ValueType>>;
			for (const [name, attributeConstraint] of constraint.attributes ?? new Map()) {
				const attribute = entries.get(name);
				if (attribute === undefined) return `${path} is missing attribute "${name}"`;
				const failure = checkTypeConstraint(attribute, attributeConstraint, `${path}.${name}`);
				if (failure) return failure;
			}
			return null;
		}
		default:
			throw new Error(`Unhandled parameter type constraint "${(constraint as ParameterTypeConstraint).kind}"`);
	}
}

/**
 * Presents a language-service Token as the node shape this module reads, so the
 * providers and the evaluator derive inline function metadata from one
 * implementation rather than two that could disagree.
 */
export function tokenToNode(token: Token): InlineFunctionNode {
	return {
		type: token.type,
		value: token.value,
		variadic: token.variadic,
		location: {
			start: {
				offset: token.location.start.offset,
				line: token.location.start.line,
				column: token.location.start.column
			},
			end: {
				offset: token.location.end.offset,
				line: token.location.end.line,
				column: token.location.end.column
			}
		},
		children: token.children.map(child => tokenToNode(child))
	};
}

/**
 * Reads an `inline_function` node into a definition. The scope and file path are
 * supplied by the caller, which knows the file being evaluated.
 */
export function readInlineFunction<TScope>(
	node: InlineFunctionNode,
	filePath: string,
	scope: TScope
): InlineFunctionDefinition<TScope> {
	const name = String(node.value ?? '');
	if (name === '') throw new Error(`Inline function in ${filePath} has no name`);

	const bodyNode = node.children?.find(child => child.type === 'js_body');
	if (!bodyNode) throw new Error(`Inline function "${name}" in ${filePath} has no body`);
	if (!bodyNode.location) throw new Error(`Inline function "${name}" in ${filePath} has an unlocated body`);

	const parameters: InlineFunctionParameter[] = [];
	for (const child of node.children ?? []) {
		if (child.type !== 'inline_param') continue;
		parameters.push({
			name: String(child.value ?? ''),
			variadic: child.variadic === true,
			typeNode: child.children?.find(entry => entry.type === 'param_type')?.children?.[0],
			defaultNode: child.children?.find(entry => entry.type === 'param_default')?.children?.[0]
		});
	}

	return {
		name,
		parameters,
		source: String(bodyNode.value ?? ''),
		// The js_body node spans the body text itself, so its start is the first
		// body character — the position runtime errors are reported against.
		bodyStart: { line: bodyNode.location.start.line, column: bodyNode.location.start.column },
		filePath,
		scope
	};
}

/**
 * Produces the FunctionDefinition that the language service consumes, so hover,
 * completion, and diagnostics treat inline functions exactly as they treat
 * built-ins. The declaration in the signature is the single source of this
 * metadata; there is nothing separate to keep in sync.
 */
export function synthesizeDefinition<TScope>(definition: InlineFunctionDefinition<TScope>): FunctionDefinition {
	const parameters: FunctionParameter[] = definition.parameters.map(parameter => {
		const constraint = parameter.typeNode ? readTypeConstraint(parameter.typeNode) : undefined;
		const types: ValueType[] = constraint ? constraintValueTypes(constraint) : allValueTypes();
		const entry: FunctionParameter = {
			name: parameter.name,
			types,
			required: !parameter.variadic && parameter.defaultNode === undefined,
			description: parameter.variadic
				? `Variadic parameter "${parameter.name}"`
				: `Parameter "${parameter.name}"${constraint ? ` of type ${formatTypeConstraint(constraint)}` : ''}`
		};
		if (parameter.variadic) entry.variadic = true;
		return entry;
	});

	return {
		name: definition.name,
		description: `Inline function defined in ${definition.filePath}.`,
		parameters,
		returnType: {
			types: allValueTypes(),
			description: 'Value returned by the function body.'
		}
	};
}

/** Value types a constraint admits, for the language service's type reporting. */
function constraintValueTypes(constraint: ParameterTypeConstraint): ValueType[] {
	switch (constraint.kind) {
		case 'string': return ['string'];
		case 'number': return ['number'];
		case 'bool': return ['boolean'];
		case 'list':
		case 'set':
		case 'tuple': return ['array'];
		case 'map':
		case 'object':
		case 'struct': return ['object'];
		case 'any': return allValueTypes();
		default:
			throw new Error(`Unhandled parameter type constraint "${(constraint as ParameterTypeConstraint).kind}"`);
	}
}

function allValueTypes(): ValueType[] {
	return ['string', 'number', 'boolean', 'array', 'object', 'null'];
}
