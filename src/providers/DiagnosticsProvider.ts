import path from 'node:path';

import type { Diagnostic } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import type { AttributeDefinition, BlockDefinition, FunctionDefinition, Token, ValueType } from '../model';
import type { ParsedDocument } from '../ParsedDocument';
import type { Schema } from '../Schema';

export class DiagnosticsProvider {
	constructor(private schema: Schema) { }

	getDiagnostics(parsedDocument: ParsedDocument): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];
		const seenBlocks = new Map<string, number>(); // Track block counts by type

		const validateToken = (token: Token) => {
			switch (token.type) {
				case 'block': {
					this.validateBlock(parsedDocument, token, seenBlocks, diagnostics);
					break;
				}
				case 'function_call': {
					this.validateFunction(token, diagnostics);
					break;
				}
				// case 'identifier':
				// 	this.validateIdentifier(token, diagnostics);
				// 	break;
				case 'attribute': {
					this.validateAttribute(token, diagnostics);
					break;
				}
				case 'parameter': {
					this.validateParameter(token, diagnostics);
					break;
				}
				case 'reference': {
					this.validateReference(token, diagnostics);
					break;
				}
				case 'interpolation': {
					this.validateInterpolation(token, diagnostics);
					break;
				}
			}

			// Recursively validate children
			token.children.forEach(validateToken);
		};

		parsedDocument.getTokens().forEach(validateToken);

		// Validate block occurrences after processing all tokens
		this.validateBlockOccurrences(seenBlocks, diagnostics);
		return diagnostics;
	}

	private validateAttribute(token: Token, diagnostics: Diagnostic[]) {
		const attributeIdentifier = token.children.find(child => child.type === 'identifier');
		if (!attributeIdentifier) return;

		const attributeName = attributeIdentifier.getDisplayText();
		const blockToken = this.findParentBlock(token);

		if (blockToken) {
			const blockTemplate = this.schema.getBlockDefinition(blockToken.getDisplayText());
			// Convert to string explicitly
			const value = token.value != null ? String(token.value) : '';
			const attribute = blockTemplate?.attributes?.find(attr => attr.name === attributeName);

			if (attribute) {
				if (attribute.deprecated) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Attribute "${attributeName}" is deprecated${attribute.deprecationMessage ? `: ${attribute.deprecationMessage}` : ''}`,
						DiagnosticSeverity.Warning
					));
				}

				// Validate attribute value
				const valueToken = token.children.find(child => child.type !== 'identifier');
				if (valueToken) {
					this.validateAttributeValue(valueToken, attribute, diagnostics);
				}
			}
		}
	}

	private validateBlockOccurrences(seenBlocks: Map<string, number>, diagnostics: Diagnostic[]) {
		for (const [blockType, count] of seenBlocks) {
			const blockDef = this.schema.getBlockDefinition(blockType);
			if (!blockDef) continue;

			if (blockDef.min !== undefined && count < blockDef.min) {
				// We need a token to create a diagnostic, but this is a global check
				// You might want to store the first occurrence of each block type
				diagnostics.push({
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 }
					},
					message: `Block type "${blockType}" must appear at least ${blockDef.min} times globally`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}

			if (blockDef.max !== undefined && count > blockDef.max) {
				diagnostics.push({
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 }
					},
					message: `Block type "${blockType}" can appear at most ${blockDef.max} times globally`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}
		}
	}

	private async validateBlock(parsedDocument: ParsedDocument, token: Token, seenBlocks: Map<string, number>, diagnostics: Diagnostic[]) {
		const blockValue = token.getDisplayText();

		// Find the parent block to check if this is a nested block
		const parentBlock = this.findParentBlock(token);
		let definition: BlockDefinition | undefined;

		if (parentBlock) {
			// This is a nested block, look it up in the parent's allowed blocks
			const parentDef = this.schema.getBlockDefinition(parentBlock.getDisplayText());
			definition = parentDef?.blocks?.find(b => b.type === blockValue);
		} else {
			// This is a root block, look it up directly
			definition = this.schema.getBlockDefinition(blockValue);
		}

		if (!definition) {
			const parentContext = parentBlock ? ` in ${parentBlock.getDisplayText()} block` : '';
			diagnostics.push(this.createDiagnostic(
				token,
				`Unknown block type: ${blockValue}${parentContext}`,
				DiagnosticSeverity.Error
			));
			return;
		}

		// Track block occurrences
		seenBlocks.set(blockValue, (seenBlocks.get(blockValue) || 0) + 1);

		// Validate block constraints
		this.validateBlockConstraints(token, definition, diagnostics);

		// Validate required attributes
		this.validateRequiredAttributes(token, definition, diagnostics);

		// Validate attribute combinations
		this.validateAttributeCombinations(token, definition, diagnostics);

		// Validate nested blocks
		this.validateNestedBlocks(token, definition, diagnostics);

		if (token.value === 'dependency') {
			await this.validateDependencyBlock(parsedDocument, token, diagnostics);
		}

		if (token.value === 'dependencies') {
			await this.validateDependenciesBlock(parsedDocument, token, diagnostics);
		}
	}

	private async validateDependencyBlock(parsedDocument: ParsedDocument, token: Token, diagnostics: Diagnostic[]) {
		// Validate the required name parameter
		const parameters = token.children.filter(child => child.type === 'parameter');
		if (parameters.length === 0) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Dependency block requires a name parameter',
				DiagnosticSeverity.Error
			));
			return;
		}

		// Find the configPath attribute
		const configPathAttr = token.children.find(child =>
			child.type === 'attribute' &&
			child.children.some(c => c.type === 'attribute_identifier' && c.value === 'config_path')
		);

		if (!configPathAttr) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Dependency block missing required config_path attribute',
				DiagnosticSeverity.Error
			));
			return;
		}

		// Get the string literal value
		const stringLit = configPathAttr.children.find(c => c.type === 'string_lit');
		if (!stringLit || typeof stringLit.value !== 'string') {
			diagnostics.push(this.createDiagnostic(
				configPathAttr,
				'config_path must be a string literal',
				DiagnosticSeverity.Error
			));
			return;
		}

		await this.validateDependencyPath(parsedDocument, stringLit.value, configPathAttr, token, diagnostics);
	}

	private async validateDependenciesBlock(parsedDocument: ParsedDocument, token: Token, diagnostics: Diagnostic[]) {
		// Validate the required paths attribute for dependencies block
		const pathsAttr = token.children.find(child =>
			child.type === 'attribute' &&
			child.children.some(c => c.type === 'attribute_identifier' && c.value === 'paths')
		);

		if (!pathsAttr) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Dependencies block missing required paths attribute',
				DiagnosticSeverity.Error
			));
			return;
		}

		// Get the array literal value
		const arrayLit = pathsAttr.children.find(c => c.type === 'array_lit');
		if (!arrayLit) {
			diagnostics.push(this.createDiagnostic(
				pathsAttr,
				'paths must be an array',
				DiagnosticSeverity.Error
			));
			return;
		}

		// Validate each path in the array
		for (const pathElement of arrayLit.children) {
			if (pathElement.type !== 'string_lit' || typeof pathElement.value !== 'string') {
				diagnostics.push(this.createDiagnostic(
					pathElement,
					'Each path must be a string literal',
					DiagnosticSeverity.Error
				));
				continue;
			}

			await this.validateDependencyPath(parsedDocument, pathElement.value, pathElement, token, diagnostics);
		}
	}

	// In DiagnosticsProvider.ts

	private async validateDependencyPath(
		parsedDocument: ParsedDocument,
		path: string,
		pathToken: Token,
		blockToken: Token,
		diagnostics: Diagnostic[]
	) {
		const workspaceManager = parsedDocument.getWorkspace();
		const sourceUri = URI.parse(parsedDocument.getUri());
		const targetPath = this.resolveDependencyPath(path, sourceUri.fsPath);
		const targetUri = URI.file(targetPath).toString();

		try {
			// Try to load and parse the dependency
			const dependencyDoc = await workspaceManager.getParsedDocument(targetUri);

			if (!dependencyDoc) {
				// Add a diagnostic for the missing file
				diagnostics.push(this.createDiagnostic(
					pathToken,
					`Terragrunt dependency not found: ${path} (looked for terragrunt.hcl in this directory)`,
					DiagnosticSeverity.Error
				));
				return;
			}

			// Validate that the dependency file is valid Terragrunt configuration
			const depDiagnostics = dependencyDoc.getDiagnostics();
			if (depDiagnostics.some(d => d.severity === DiagnosticSeverity.Error)) {
				diagnostics.push(this.createDiagnostic(
					pathToken,
					`Referenced Terragrunt file contains errors: ${path}`,
					DiagnosticSeverity.Error
				));
			}

			// Check for circular dependencies
			const deps = await workspaceManager.getDependencies(targetUri);
			if (this.hasCircularDependency(parsedDocument, deps)) {
				diagnostics.push(this.createDiagnostic(
					blockToken,
					'Circular dependency detected',
					DiagnosticSeverity.Error
				));
			}

		} catch (error) {
			// Be more specific about the error message
			let errorMessage = 'Error loading dependency';
			if (error instanceof Error) {
				if (error.message.includes('ENOENT')) {
					errorMessage = `Terragrunt dependency not found: ${path} (looked for terragrunt.hcl in this directory)`;
				} else {
					errorMessage = `Error loading dependency: ${error.message}`;
				}
			}

			diagnostics.push(this.createDiagnostic(
				pathToken,
				errorMessage,
				DiagnosticSeverity.Error
			));
		}
	}

	private hasCircularDependency(parsedDocument: ParsedDocument, dependencies: { targetPath: string }[]): boolean {
		const visited = new Set<string>();

		const visit = async (uri: string): Promise<boolean> => {
			if (visited.has(uri)) {
				return uri === parsedDocument.getUri(); // Circular if we're back at source
			}

			visited.add(uri);

			const workspaceManager = parsedDocument.getWorkspace();
			const deps = await workspaceManager.getDependencies(uri);

			for (const dep of deps) {
				const targetUri = URI.file(dep.targetPath).toString();
				if (await visit(targetUri)) {
					return true;
				}
			}

			visited.delete(uri);
			return false;
		};

		return dependencies.some(async dep => {
			const targetUri = URI.file(dep.targetPath).toString();
			return visit(targetUri);
		});
	}

	private resolveDependencyPath(path_value: string, sourcePath: string): string {
		if (path.isAbsolute(path_value)) {
			return path_value;
		}

		const sourceDir = path.dirname(sourcePath);
		return path.resolve(sourceDir, path_value);
	}

	// Add these imports at the top
	private validateDependencyOutputs(token: Token, dependencyDoc: ParsedDocument, diagnostics: Diagnostic[]) {
		// Find outputs reference attributes
		const outputRefs = token.children.filter(child =>
			child.type === 'attribute' &&
			child.children.some(c => c.type === 'identifier' && typeof c.value === 'string' && c.value.startsWith('outputs.'))
		);

		for (const ref of outputRefs) {
			const identifier = ref.children.find(c => c.type === 'identifier');
			const outputName = identifier && typeof identifier.value === 'string' ? identifier.value.split('.')[1] : undefined;

			if (!outputName) continue;

			// Verify the output exists in the dependency
			const outputExists = this.checkOutputExistsInDependency(dependencyDoc, outputName);
			if (!outputExists) {
				diagnostics.push(this.createDiagnostic(
					ref,
					`Referenced output "${outputName}" not found in dependency`,
					DiagnosticSeverity.Error
				));
			}
		}
	}

	private checkOutputExistsInDependency(dependencyDoc: ParsedDocument, outputName: string): boolean {
		// This would need to be implemented based on how outputs are defined in your Terragrunt files
		// For example, looking for output blocks or checking against a schema
		const ast = dependencyDoc.getAST();
		if (!ast) return false;

		// Example implementation - adjust based on your actual AST structure
		const hasOutput = (node: any): boolean => {
			if (node.type === 'block' && node.value === 'output' &&
				node.children.some(c => c.type === 'identifier' && c.value === outputName)) {
				return true;
			}
			return node.children?.some(hasOutput) ?? false;
		};

		return hasOutput(ast);
	}

	private validateBlockConstraints(token: Token, definition: BlockDefinition, diagnostics: Diagnostic[]) {
		const attributes = this.collectAllAttributes(token);
		const nestedBlocks = this.collectAllBlocks(token);

		// Add parameter validation
		const parameters = token.children.filter(child => child.type === 'parameter');
		if (parameters.length > 0 && !definition.parameters) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Block "${token.getDisplayText()}" does not accept parameters`,
				DiagnosticSeverity.Error
			));
		}

		// Check for unknown attributes if arbitraryAttributes is false
		if (!definition.arbitraryAttributes) {
			attributes.forEach(attr => {
				const attrName = attr.children.find(c => c.type === 'identifier')?.getDisplayText();
				if (attrName && !definition.attributes?.some(a => a.name === attrName)) {
					diagnostics.push(this.createDiagnostic(
						attr,
						`Unknown attribute "${attrName}" in ${token.getDisplayText()} block`,
						DiagnosticSeverity.Error
					));
				}
			});
		}

		// Check for unknown nested blocks
		nestedBlocks.forEach(block => {
			const blockType = block.getDisplayText();
			if (!definition.blocks?.some(b => b.type === blockType)) {
				diagnostics.push(this.createDiagnostic(
					block,
					`Unknown nested block type "${blockType}" in ${token.getDisplayText()} block`,
					DiagnosticSeverity.Error
				));
			}
		});
	}

	private collectAllAttributes(token: Token): Token[] {
		const attributes: Token[] = [];

		const collect = (t: Token) => {
			if (t.type === 'attribute') {
				attributes.push(t);
			}

			// Check children recursively
			t.children.forEach(collect);
		};

		collect(token);

		return attributes;
	}

	private validateRequiredAttributes(token: Token, definition: BlockDefinition, diagnostics: Diagnostic[]) {
		if (!definition.attributes) return;

		// Get all attributes from the block, including nested ones
		const attributes = this.collectAllAttributes(token);

		// Check required attributes
		definition.attributes
			.filter(attr => attr.required)
			.forEach(attr => {
				if (!attributes.some(a => a.getDisplayText() === attr.name)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Missing required attribute: ${attr.name}`,
						DiagnosticSeverity.Error
					));
				}
			}
			);

		// Check required attribute combinations
		if (definition.validation?.requiredChoice) {
			definition.validation.requiredChoice.forEach(choices => {
				if (!choices.some(choice => attributes.some(a => a.getDisplayText() === choice))) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Missing required attribute choice: ${choices.join(', ')}`,
						DiagnosticSeverity.Error
					));
				}

				// Check for mutually exclusive attributes
				if (choices.length > 1 && choices.some(choice => attributes.some(a => a.getDisplayText() === choice))) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Mutually exclusive attributes found: ${choices.join(', ')}`,
						DiagnosticSeverity.Error
					));
				}
			});
		}
	}

	private validateAttributeCombinations(token: Token, definition: BlockDefinition, diagnostics: Diagnostic[]) {
		if (!definition.validation?.mutuallyExclusive) return;

		const attributes = this.collectAllAttributes(token);
		const presentAttrs = new Set(
			attributes
				.map(attr => attr.children.find(c => c.type === 'identifier')?.getDisplayText())
				.filter(Boolean)
		);

		definition.validation.mutuallyExclusive.forEach(group => {
			const presentCount = group.filter(attr => presentAttrs.has(attr)).length;
			if (presentCount > 1) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Mutually exclusive attributes found: ${group.join(', ')}`,
					DiagnosticSeverity.Error
				));
			}
		});
	}
	private collectAllBlocks(token: Token): Token[] {
		const blocks: Token[] = [];

		const collect = (t: Token, isRoot = false) => {
			// Only add to blocks collection if it's not the root block
			if (t.type === 'block' && !isRoot) {
				blocks.push(t);
			}

			// Recursively check children
			t.children.forEach(child => collect(child, false));
		};

		// Start collection with root flag true
		collect(token, true);
		return blocks;
	}

	private validateNestedBlocks(token: Token, definition: BlockDefinition, diagnostics: Diagnostic[]) {
		if (!definition.blocks) return;

		const nestedBlocks = this.collectAllBlocks(token);
		const nestedBlockCounts = new Map<string, number>();

		nestedBlocks.forEach(block => {
			const blockType = block.getDisplayText();
			nestedBlockCounts.set(blockType, (nestedBlockCounts.get(blockType) || 0) + 1);
		});

		// Check min/max occurrences for each block type
		definition.blocks.forEach(blockDef => {
			const count = nestedBlockCounts.get(blockDef.type) || 0;

			if (blockDef.min !== undefined && count < blockDef.min) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Block "${blockDef.type}" must appear at least ${blockDef.min} times in ${token.getDisplayText()} block`,
					DiagnosticSeverity.Error
				));
			}
			if (blockDef.max !== undefined && count > blockDef.max) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Block "${blockDef.type}" can appear at most ${blockDef.max} times in ${token.getDisplayText()} block`,
					DiagnosticSeverity.Error
				));
			}
		});
	}

	private validateFunction(token: Token, diagnostics: Diagnostic[]) {
		// Find the function identifier using the correct type
		const funcIdentifier = token.children.find(child => child.type === 'function_identifier');
		if (!funcIdentifier) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Invalid function call structure: missing function identifier',
				DiagnosticSeverity.Error
			));
			return;
		}

		const funcName = (funcIdentifier.value || '').toString();
		const funcDef = this.schema.getFunctionDefinition(funcName);

		if (!funcDef) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Unknown function: ${funcName}`,
				DiagnosticSeverity.Error
			));
			return;
		}

		if (funcDef.deprecated) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Function "${funcName}" is deprecated${funcDef.deprecationMessage ? `: ${funcDef.deprecationMessage}` : ''}`,
				DiagnosticSeverity.Warning
			));
		}

		this.validateFunctionParameters(token, funcDef, diagnostics);
	}

	private validateFunctionParameters(token: Token, funcDef: FunctionDefinition, diagnostics: Diagnostic[]) {
		// Get parameters by excluding the function identifier
		const parameters = token.children.filter(child => child.type !== 'function_identifier');
		const requiredParams = funcDef.parameters.filter(param => param.required);

		// Check required parameter count
		if (parameters.length < requiredParams.length) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Function "${funcDef.name}" requires at least ${requiredParams.length} parameters`,
				DiagnosticSeverity.Error
			));
			return;
		}

		// Check if too many parameters (unless last parameter is variadic)
		const lastParam = funcDef.parameters.at(-1);
		if (!lastParam?.variadic && parameters.length > funcDef.parameters.length) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Function "${funcDef.name}" accepts at most ${funcDef.parameters.length} parameters`,
				DiagnosticSeverity.Error
			));
			return;
		}

		// Validate each parameter
		parameters.forEach((param, index) => {
			const paramDef = index < funcDef.parameters.length
				? funcDef.parameters[index]
				: (lastParam?.variadic ? lastParam : undefined);

			if (paramDef) {
				this.validateParameterValue(param, paramDef, diagnostics);
			}
		});
	}

	private validateParameterValue(token: Token, paramDef: FunctionDefinition['parameters'][0], diagnostics: Diagnostic[]) {
		// Handle literal values directly with type checking
		const validateValue = (value: string | number | boolean | null) => {
			if (value === null) return;

			if (paramDef.validation) {
				if (paramDef.validation.pattern && typeof value === 'string' && !new RegExp(paramDef.validation.pattern).test(value)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Parameter value does not match required pattern: ${paramDef.validation.pattern}`,
						DiagnosticSeverity.Error
					));
				}

				if (paramDef.validation.allowedValues &&
					Array.isArray(paramDef.validation.allowedValues) &&
					!paramDef.validation.allowedValues.includes(value)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Invalid value. Allowed values are: ${paramDef.validation.allowedValues.join(', ')}`,
						DiagnosticSeverity.Error
					));
				}
			}
		};

		// Determine the type and validate accordingly
		let valueType: ValueType | undefined;
		switch (token.type) {
			case 'string_lit': {
				valueType = 'string';
				validateValue(token.value);
				break;
			}
			case 'number_lit': {
				valueType = 'number';
				validateValue(token.value);
				break;
			}
			case 'boolean_lit': {
				valueType = 'boolean';
				validateValue(token.value);
				break;
			}
			case 'array_lit': {
				valueType = 'array';
				break;
			}
			case 'object': {
				valueType = 'object';
				break;
			}
			case 'function_call': {
				const funcName = (token.children.find(c => c.type === 'function_identifier')?.value || '').toString();
				if (funcName) {
					const funcDef = this.schema.getFunctionDefinition(funcName);
					valueType = funcDef?.returnType.types[0];
				}
				break;
			}
			case 'reference': {
				valueType = this.inferReferenceType(token);
				break;
			}
			case 'interpolation': {
				valueType = 'string';
				break;
			}
		}

		// Validate type
		if (valueType && !paramDef.types.includes(valueType)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Invalid parameter type. Expected one of: ${paramDef.types.join(', ')}, got: ${valueType}`,
				DiagnosticSeverity.Error
			));
		}
	}


	private validateValueConstraints(token: Token, attribute: AttributeDefinition, diagnostics: Diagnostic[]) {
		const { validation } = attribute;
		if (!validation) return;

		const { value } = token;
		if (value === null) return;

		if (validation.pattern && typeof value === 'string' && !new RegExp(validation.pattern).test(value)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Value does not match required pattern: ${validation.pattern}`,
				DiagnosticSeverity.Error
			));
		}

		if (validation.min !== undefined && typeof value === 'number' && value < validation.min) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Value must be greater than or equal to ${validation.min}`,
				DiagnosticSeverity.Error
			));
		}

		if (validation.max !== undefined && typeof value === 'number' && value > validation.max) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Value must be less than or equal to ${validation.max}`,
				DiagnosticSeverity.Error
			));
		}

		if (validation.allowedValues && Array.isArray(validation.allowedValues)) {
			// Convert value to string for comparison
			const stringValue = String(value);
			if (!validation.allowedValues.map(String).includes(stringValue)) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Invalid value. Allowed values are: ${validation.allowedValues.join(', ')}`,
					DiagnosticSeverity.Error
				));
			}
		}

		if (validation.customValidator) {
			try {
				if (!validation.customValidator(value)) {
					diagnostics.push(this.createDiagnostic(
						token,
						'Value failed custom validation',
						DiagnosticSeverity.Error
					));
				}
			} catch (error) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Custom validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					DiagnosticSeverity.Error
				));
			}
		}
	}

	private validateAttributeValue(token: Token, attribute: AttributeDefinition, diagnostics: Diagnostic[]) {
		const valueType = this.inferValueType(token);

		// Validate type
		if (valueType && !attribute.types.includes(valueType)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Invalid type for attribute "${attribute.name}". Expected one of: ${attribute.types.join(', ')}`,
				DiagnosticSeverity.Error
			));
		}

		// Validate constraints
		if (attribute.validation) {
			this.validateValueConstraints(token, attribute, diagnostics);
		}

		// Validate nested attributes for object types
		if (valueType === 'object' && attribute.attributes) {
			this.validateNestedAttributes(token, attribute.attributes, diagnostics);
		}
	}

	private validateNestedAttributes(token: Token, attributes: AttributeDefinition[], diagnostics: Diagnostic[]) {
		if (token.type !== 'object' || !token.children) return;

		const nestedAttributes = this.collectAllAttributes(token);
		const presentAttrs = new Set(
			nestedAttributes
				.map(attr => attr.children.find(c => c.type === 'identifier')?.getDisplayText())
				.filter(Boolean)
		);

		// Check for required nested attributes
		attributes
			.filter(attr => attr.required)
			.forEach(attr => {
				if (!presentAttrs.has(attr.name)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Missing required nested attribute: ${attr.name}`,
						DiagnosticSeverity.Error
					));
				}
			});

		// Validate each present nested attribute
		nestedAttributes.forEach(attr => {
			const attrName = attr.children.find(c => c.type === 'identifier')?.getDisplayText();
			const attrDef = attributes.find(a => a.name === attrName);

			if (!attrDef) {
				diagnostics.push(this.createDiagnostic(
					attr,
					`Unknown nested attribute: ${attrName}`,
					DiagnosticSeverity.Error
				));
				return;
			}

			const valueToken = attr.children.find(c => c.type !== 'identifier');
			if (valueToken) {
				this.validateAttributeValue(valueToken, attrDef, diagnostics);
			}
		});
	}

	private validateParameter(token: Token, diagnostics: Diagnostic[]) {
		const parentBlock = this.findParentBlock(token);
		if (!parentBlock) return;

		const blockDef = this.schema.getBlockDefinition(parentBlock.getDisplayText());
		if (!blockDef?.parameters) return;

		// Get parameter position within the block
		const parameterIndex = parentBlock.children
			.filter(child => child.type === 'parameter')
			.indexOf(token);

		// Get the parameter definition for this position
		const paramDef = blockDef.parameters[parameterIndex];
		if (!paramDef) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Too many parameters for block "${parentBlock.getDisplayText()}"`,
				DiagnosticSeverity.Error
			));
			return;
		}

		// Get the parameter value and validate it matches the type
		// const paramValue = token.getDisplayText();
		const valueType = this.inferValueType(token);

		if (valueType && !paramDef.types.includes(valueType)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Invalid parameter type for "${paramDef.name}". Expected one of: ${paramDef.types.join(', ')}, got: ${valueType}`,
				DiagnosticSeverity.Error
			));
		}
	}

	private validateReference(token: Token, diagnostics: Diagnostic[]) {
		// Validate that referenced identifiers exist
		const refPath = this.buildReferencePath(token);
		if (!this.isValidReference(refPath)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Invalid reference: ${refPath.join('.')}`,
				DiagnosticSeverity.Error
			));
		}
	}

	private validateInterpolation(token: Token, diagnostics: Diagnostic[]) {
		// Validate interpolation expression type
		const expressionToken = token.children[0];
		if (!expressionToken) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Empty interpolation expression',
				DiagnosticSeverity.Error
			));
			return;
		}

		// Check if the expression will result in a string-compatible value
		const valueType = this.inferValueType(expressionToken);
		if (valueType && !['string', 'number', 'boolean'].includes(valueType)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Interpolation expression must result in a string-compatible value, got: ${valueType}`,
				DiagnosticSeverity.Error
			));
		}
	}

	private buildReferencePath(token: Token): string[] {
		const path: string[] = [];
		let current: Token | null = token;

		while (current) {
			if (current.type === 'identifier') {
				path.unshift(current.getDisplayText());
			}
			current = current.parent;
		}

		return path;
	}

	private isValidReference(path: string[]): boolean {
		// Implementation depends on your reference resolution rules
		// This is a placeholder that should be implemented based on your specific needs
		return true;
	}

	private inferValueType(token: Token): ValueType | undefined {
		switch (token.type) {
			case 'string_lit': {
				return 'string';
			}
			case 'number_lit': {
				return 'number';
			}
			case 'boolean_lit': {
				return 'boolean';
			}
			case 'array_lit': {
				return 'array';
			}
			case 'object': {
				return 'object';
			}
			case 'function_call': {
				const funcName = token.children.find(c => c.type === 'identifier')?.getDisplayText();
				if (funcName) {
					const funcDef = this.schema.getFunctionDefinition(funcName);
					return funcDef?.returnType.types[0];
				}
				break;
			}
			case 'reference': {
				return this.inferReferenceType(token);
			}
			case 'interpolation': {
				return 'string';
			}
			// Add other expression types as needed
		}
		return undefined;
	}

	private inferReferenceType(token: Token): ValueType | undefined {
		// Implementation depends on your reference resolution rules
		// This is a placeholder that should be implemented based on your specific needs
		return undefined;
	}

	private findParentBlock(token: Token): Token | null {
		let current = token.parent;
		while (current) {
			if (current.type === 'block') {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	private createDiagnostic(
		token: Token,
		message: string,
		severity: DiagnosticSeverity
	): Diagnostic {
		return {
			range: {
				start: token.startPosition,
				end: token.endPosition
			},
			message,
			severity,
			source: 'terragrunt'
		};
	}
}

