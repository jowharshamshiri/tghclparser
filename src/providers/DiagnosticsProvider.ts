import type { Diagnostic } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';

import type { AttributeDefinition, BlockDefinition, FunctionDefinition, Token, ValueType } from '../model';
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

		for (const token of root.children) {
			if (token.type === 'block') this.validateBlock(token, rootBlocks, diagnostics);
			if (token.type === 'assignment') this.validateRootAttribute(token, uri, rootAttributes, diagnostics);
			this.validateFunctions(token, diagnostics);
		}

		this.validateOccurrences(root.children.filter(token => token.type === 'block'), rootBlocks, diagnostics);
		return diagnostics;
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

	private validateFunctions(token: Token, diagnostics: Diagnostic[]): void {
		if (token.type === 'function_call') {
			const name = token.getDisplayText();
			const definition = this.schema.getFunctionDefinition(name);
			if (!definition) diagnostics.push(this.diagnostic(token, `Unknown function: ${name}`));
			else this.validateFunctionArguments(token, definition, diagnostics);
		}
		for (const child of token.children) this.validateFunctions(child, diagnostics);
	}

	private validateFunctionArguments(token: Token, definition: FunctionDefinition, diagnostics: Diagnostic[]): void {
		const arguments_ = token.children.filter(child => child.type !== 'function_identifier');
		const required = definition.parameters.filter(parameter => parameter.required).length;
		const variadic = definition.parameters.at(-1)?.variadic === true;
		if (arguments_.length < required) {
			diagnostics.push(this.diagnostic(token, `Function "${definition.name}" requires at least ${required} argument${required === 1 ? '' : 's'}`));
		}
		if (!variadic && arguments_.length > definition.parameters.length) {
			diagnostics.push(this.diagnostic(token, `Function "${definition.name}" accepts at most ${definition.parameters.length} arguments`));
		}
	}

	private diagnostic(token: Token, message: string, severity = DiagnosticSeverity.Error): Diagnostic {
		return {
			range: { start: token.startPosition, end: token.endPosition },
			message,
			severity,
			source: 'terragrunt'
		};
	}
}
