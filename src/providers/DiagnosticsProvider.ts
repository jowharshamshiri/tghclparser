import path from 'node:path';

import type { Diagnostic } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { readTypeConstraint, tokenToNode } from '../inline-functions';
import type { AttributeDefinition, BlockDefinition, FunctionDefinition, Token, ValueType } from '../model';
import type { ModuleType } from '../module-variables';
import type { ParsedDocument } from '../ParsedDocument';
import type { Schema } from '../Schema';

export class DiagnosticsProvider {
	constructor(private readonly schema: Schema) {}

	getDiagnostics(document: ParsedDocument): Diagnostic[] {
		const root = document.getTokens()[0];
		if (!root) return [];

		const diagnostics: Diagnostic[] = [];
		const uri = document.getUri();
		const rootBlocks = this.schema.getRootBlockDefinitions(uri);
		const rootAttributes = this.schema.getRootAttributeDefinitions(uri);
		const inlineFunctions = document.getInlineFunctions();

		this.validateInlineFunctions(root, diagnostics);

		for (const token of root.children) {
			if (token.type === 'block') this.validateBlock(token, rootBlocks, diagnostics);
			if (token.type === 'assignment') this.validateRootAttribute(token, uri, rootAttributes, diagnostics);
			this.validateFunctions(token, inlineFunctions, diagnostics);
		}

		this.validateOccurrences(root.children.filter(token => token.type === 'block'), rootBlocks, diagnostics);
		this.validateModuleInputs(document, diagnostics);
		return diagnostics;
	}

	/**
	 * Checks the `inputs` object against the variables of the module the unit sources: keys the module does not
	 * declare, and required variables neither this unit nor its included configurations supply. An `inputs`
	 * value that is not an object literal cannot be enumerated and is left alone, as is coverage when an included
	 * configuration's inputs cannot be. Warnings rather than errors, so evaluation is not held back by them.
	 *
	 * @param document the document being validated.
	 * @param diagnostics the list findings are appended to.
	 */
	private validateModuleInputs(document: ParsedDocument, diagnostics: Diagnostic[]): void {
		const state = document.getModuleVariables();
		if (!state) return;
		const sourceToken = state.sourceInThisFile ? document.getTerraformSourceToken() : undefined;
		if (state.status === 'missing') {
			if (sourceToken) {
				diagnostics.push(this.diagnostic(sourceToken, `Local module source not found: ${state.moduleDir}`, DiagnosticSeverity.Hint));
			}
			return;
		}

		const assignment = document.getInputsAssignment();
		const value = assignment?.children.find(child => child.type !== 'root_assignment_identifier');
		if (assignment && value?.type !== 'object') return;

		const unitDir = path.dirname(URI.parse(document.getUri()).fsPath);
		const moduleName = path.relative(unitDir, state.moduleDir) || '.';
		const declared = new Set(state.variables.map(variable => variable.name));
		const own = new Set<string>();
		for (const attribute of value?.children.filter(child => child.type === 'attribute') ?? []) {
			const identifier = attribute.children.find(child => child.type === 'attribute_identifier');
			if (!identifier) continue;
			const name = identifier.getDisplayText();
			own.add(name);
			if (!declared.has(name)) {
				diagnostics.push(this.diagnostic(identifier, `Input "${name}" is not declared by module ${moduleName}`, DiagnosticSeverity.Warning));
				continue;
			}
			const type = state.variables.find(variable => variable.name === name)?.type;
			const assigned = attribute.children.find(child => child.type !== 'attribute_identifier');
			if (type && assigned) this.validateInputValue(assigned, type, name, identifier, diagnostics);
		}

		if (!state.inheritedInputsKnown) return;
		const missing = state.variables
			.filter(variable => !variable.hasDefault && !own.has(variable.name) && !state.inheritedInputKeys.has(variable.name))
			.map(variable => variable.name);
		if (missing.length === 0) return;
		const anchor = assignment?.children.find(child => child.type === 'root_assignment_identifier') ?? sourceToken;
		if (anchor) {
			diagnostics.push(this.diagnostic(anchor, `Missing required module inputs: ${missing.join(', ')}`, DiagnosticSeverity.Warning));
		}
	}

	/**
	 * Reports inline function definitions the evaluator would reject: a name
	 * already taken by a built-in, a name defined twice, or a parameter carrying
	 * a type annotation the language does not support.
	 */
	private validateInlineFunctions(root: Token, diagnostics: Diagnostic[]): void {
		const seen = new Set<string>();
		for (const token of root.children) {
			if (token.type !== 'inline_function') continue;
			const name = token.getDisplayText();

			if (this.schema.getFunctionDefinition(name)) {
				diagnostics.push(this.diagnostic(token, `Inline function "${name}" shadows a built-in function`));
			} else if (seen.has(name)) {
				diagnostics.push(this.diagnostic(token, `Inline function "${name}" is defined more than once`));
			}
			seen.add(name);

			for (const parameter of token.children.filter(child => child.type === 'inline_param')) {
				const typeNode = parameter.children.find(child => child.type === 'param_type')?.children[0];
				if (!typeNode) continue;
				try {
					readTypeConstraint(tokenToNode(typeNode));
				} catch (error) {
					diagnostics.push(this.diagnostic(
						parameter,
						`Inline function "${name}" parameter "${parameter.getDisplayText()}": ${error instanceof Error ? error.message : String(error)}`
					));
				}
			}
		}
	}

	/**
	 * Checks a literal value against the type constraint of the input it is assigned to. Object literals are
	 * checked for attributes the type does not declare and for required attributes left out, and the walk continues
	 * through nested objects, list and set elements and map values. Anything that is not a literal, such as a
	 * `merge(...)` call or a reference, is left alone. `owner` is the key the value is assigned to, where a missing
	 * attribute is reported; a list element has no key, so it is reported on the element itself.
	 *
	 * @param value the value token.
	 * @param type the type constraint the value must satisfy.
	 * @param label the path of the value as a message names it, such as `ipam.rules[0]`.
	 * @param owner the token a missing-attributes finding is reported on.
	 * @param diagnostics the list findings are appended to.
	 */
	private validateInputValue(value: Token, type: ModuleType, label: string, owner: Token, diagnostics: Diagnostic[]): void {
		if (type.kind === 'object' && value.type === 'object') {
			const present = new Set<string>();
			for (const attribute of value.children.filter(child => child.type === 'attribute')) {
				const identifier = attribute.children.find(child => child.type === 'attribute_identifier');
				if (!identifier) continue;
				const name = identifier.getDisplayText();
				present.add(name);
				const declared = type.attributes.find(candidate => candidate.name === name);
				if (!declared) {
					diagnostics.push(this.diagnostic(identifier, `Attribute "${name}" is not declared by input ${label}`, DiagnosticSeverity.Warning));
					continue;
				}
				const assigned = attribute.children.find(child => child.type !== 'attribute_identifier');
				if (assigned) this.validateInputValue(assigned, declared.type, `${label}.${name}`, identifier, diagnostics);
			}
			const missing = type.attributes.filter(attribute => !attribute.optional && !present.has(attribute.name)).map(attribute => attribute.name);
			if (missing.length > 0) {
				diagnostics.push(this.diagnostic(owner, `Missing required attributes in ${label}: ${missing.join(', ')}`, DiagnosticSeverity.Warning));
			}
			return;
		}
		if (type.kind === 'map' && value.type === 'object') {
			for (const attribute of value.children.filter(child => child.type === 'attribute')) {
				const identifier = attribute.children.find(child => child.type === 'attribute_identifier');
				const assigned = attribute.children.find(child => child.type !== 'attribute_identifier' && child.type !== 'object_key');
				if (!assigned) continue;
				const key = identifier?.getDisplayText();
				this.validateInputValue(assigned, type.element, key === undefined ? `${label}[…]` : `${label}["${key}"]`, identifier ?? assigned, diagnostics);
			}
			return;
		}
		if ((type.kind === 'list' || type.kind === 'set') && value.type === 'array_lit') {
			for (const [index, element] of value.children.entries()) {
				this.validateInputValue(element, type.element, `${label}[${index}]`, element, diagnostics);
			}
			return;
		}
		if (type.kind === 'tuple' && value.type === 'array_lit') {
			for (const [index, element] of value.children.entries()) {
				const elementType = type.elements[index];
				if (elementType) this.validateInputValue(element, elementType, `${label}[${index}]`, element, diagnostics);
			}
		}
	}

	private validateRootAttribute(
		token: Token,
		uri: string,
		definitions: AttributeDefinition[],
		diagnostics: Diagnostic[]
	): void {
		if (this.schema.isArbitraryRootAttributes(uri)) return;
		const definition = definitions.find(attribute => attribute.name === token.getDisplayText());
		if (!definition) {
			diagnostics.push(this.diagnostic(token, `Unknown Terragrunt attribute: ${token.getDisplayText()}`));
			return;
		}
		const value = token.children.find(child => child.type !== 'root_assignment_identifier');
		if (value) this.validateLiteralType(value, definition, diagnostics);
	}

	private validateBlock(token: Token, allowed: BlockDefinition[], diagnostics: Diagnostic[]): void {
		const definition = allowed.find(block => block.type === token.getDisplayText());
		if (!definition) {
			diagnostics.push(this.diagnostic(token, `Unknown block type: ${token.getDisplayText()}`));
			return;
		}

		this.validateParameters(token, definition, diagnostics);
		const attributes = token.children.filter(child => child.type === 'attribute');
		const blocks = token.children.filter(child => child.type === 'block');

		for (const attributeToken of attributes) {
			const attribute = definition.attributes?.find(candidate => candidate.name === attributeToken.getDisplayText());
			if (!attribute && !definition.arbitraryAttributes) {
				diagnostics.push(this.diagnostic(
					attributeToken,
					`Unknown attribute "${attributeToken.getDisplayText()}" in ${definition.type} block`
				));
				continue;
			}
			if (attribute) {
				const value = attributeToken.children.find(child => child.type !== 'attribute_identifier');
				if (value) this.validateLiteralType(value, attribute, diagnostics);
			}
		}

		for (const required of definition.attributes?.filter(attribute => attribute.required) ?? []) {
			if (!attributes.some(attribute => attribute.getDisplayText() === required.name)) {
				diagnostics.push(this.diagnostic(token, `Missing required attribute: ${required.name}`));
			}
		}

		const nestedDefinitions = this.nestedDefinitions(token, definition);
		for (const block of blocks) this.validateBlock(block, nestedDefinitions, diagnostics);
		this.validateOccurrences(blocks, nestedDefinitions, diagnostics);
	}

	private nestedDefinitions(token: Token, definition: BlockDefinition): BlockDefinition[] {
		if (definition.type !== 'autoinclude') return definition.blocks ?? [];
		const owner = token.parent;
		if (owner?.getDisplayText() === 'stack') {
			return ['unit', 'stack'].map(type => this.schema.getBlockDefinition(type)).filter(Boolean) as BlockDefinition[];
		}
		return this.schema.getRootBlockDefinitions('file:///terragrunt.autoinclude.hcl');
	}

	private validateParameters(token: Token, definition: BlockDefinition, diagnostics: Diagnostic[]): void {
		const parameters = token.children.filter(child => child.type === 'parameter');
		const expected = definition.parameters ?? [];
		const required = expected.filter(parameter => parameter.required).length;
		if (parameters.length < required || parameters.length > expected.length) {
			const expectation = required === expected.length
				? `${required}`
				: `${required} to ${expected.length}`;
			diagnostics.push(this.diagnostic(
				token,
				`Block "${definition.type}" requires ${expectation} label${expected.length === 1 ? '' : 's'}`
			));
		}
	}

	private validateOccurrences(tokens: Token[], definitions: BlockDefinition[], diagnostics: Diagnostic[]): void {
		for (const definition of definitions) {
			const matching = tokens.filter(token => token.getDisplayText() === definition.type);
			if (definition.max !== undefined && matching.length > definition.max) {
				for (const duplicate of matching.slice(definition.max)) {
					diagnostics.push(this.diagnostic(
						duplicate,
						`Block "${definition.type}" may appear at most ${definition.max} time${definition.max === 1 ? '' : 's'} in this scope`
					));
				}
			}
		}
	}

	private validateLiteralType(token: Token, definition: AttributeDefinition, diagnostics: Diagnostic[]): void {
		const actual = this.literalType(token);
		if (!actual) return;
		if (!definition.types.includes(actual)) {
			diagnostics.push(this.diagnostic(
				token,
				`Attribute "${definition.name}" expects ${definition.types.join(' or ')}, got ${actual}`
			));
			return;
		}
		if (definition.validation?.allowedValues && !definition.validation.allowedValues.includes(token.value)) {
			diagnostics.push(this.diagnostic(
				token,
				`Invalid value for "${definition.name}". Expected one of: ${definition.validation.allowedValues.join(', ')}`
			));
		}
	}

	private literalType(token: Token): ValueType | undefined {
		switch (token.type) {
			case 'string_lit': return 'string';
			case 'number_lit': return 'number';
			case 'boolean_lit': return 'boolean';
			case 'null_lit': return 'null';
			case 'array_lit': return 'array';
			case 'object': return 'object';
			default: return undefined;
		}
	}

	private validateFunctions(
		token: Token,
		inlineFunctions: Map<string, FunctionDefinition>,
		diagnostics: Diagnostic[]
	): void {
		// A JavaScript body is not HCL: nothing inside it is a function call in
		// this language, so it is not descended into.
		if (token.type === 'js_body') return;

		if (token.type === 'function_call') {
			const name = token.getDisplayText();
			const definition = inlineFunctions.get(name) ?? this.schema.getFunctionDefinition(name);
			if (!definition) diagnostics.push(this.diagnostic(token, `Unknown function: ${name}`));
			else this.validateFunctionArguments(token, definition, diagnostics);
		}
		for (const child of token.children) this.validateFunctions(child, inlineFunctions, diagnostics);
	}

	private validateFunctionArguments(token: Token, definition: FunctionDefinition, diagnostics: Diagnostic[]): void {
		const arguments_ = token.children.filter(child => child.type !== 'function_identifier');
		const required = definition.parameters.filter(parameter => parameter.required).length;
		const variadic = definition.parameters.at(-1)?.variadic === true;
		if (arguments_.length < required) {
			diagnostics.push(this.diagnostic(token, `Function "${definition.name}" requires at least ${required} argument${required === 1 ? '' : 's'}`));
		}
		if (!variadic && arguments_.length > definition.parameters.length) {
			const most = definition.parameters.length;
			diagnostics.push(this.diagnostic(token, `Function "${definition.name}" accepts at most ${most} argument${most === 1 ? '' : 's'}`));
		}
	}

	private diagnostic(token: Token, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): Diagnostic {
		return {
			range: { start: token.startPosition, end: token.endPosition },
			message,
			severity,
			source: 'terragrunt'
		};
	}
}
