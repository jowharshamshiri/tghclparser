import { Schema } from './Schema';
import { Token, AttributeDefinition, FunctionDefinition, BlockDefinition, ValueType } from './model';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';

export class DiagnosticsProvider {
	constructor(private schema: Schema) { }

	getDiagnostics(tokens: Token[]): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];
		const seenBlocks = new Map<string, number>(); // Track block counts by type

		const validateToken = (token: Token) => {
			switch (token.type) {
				case 'block':
					this.validateBlock(token, seenBlocks, diagnostics);
					break;
				case 'function_call':
					this.validateFunction(token, diagnostics);
					break;
				// case 'identifier':
				// 	this.validateIdentifier(token, diagnostics);
				// 	break;
				case 'attribute':
					this.validateAttribute(token, diagnostics);
					break;
				case 'parameter':
					this.validateParameter(token, diagnostics);
					break;
				case 'reference':
					this.validateReference(token, diagnostics);
					break;
				case 'interpolation':
					this.validateInterpolation(token, diagnostics);
					break;
			}

			// Recursively validate children
			token.children.forEach(validateToken);
		};

		tokens.forEach(validateToken);

		// Validate block occurrences after processing all tokens
		this.validateBlockOccurrences(seenBlocks, diagnostics);
		return diagnostics;
	}

	private validateBlock(token: Token, seenBlocks: Map<string, number>, diagnostics: Diagnostic[]) {
		const blockValue = token.getDisplayText();
		const template = this.schema.getBlockDefinition(blockValue);

		if (!template) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Unknown block type: ${blockValue}`,
				DiagnosticSeverity.Error
			));
			return;
		}

		// Track block occurrences
		seenBlocks.set(blockValue, (seenBlocks.get(blockValue) || 0) + 1);

		// Validate block constraints
		this.validateBlockConstraints(token, template, diagnostics);

		// Validate required attributes
		this.validateRequiredAttributes(token, template, diagnostics);

		// Validate attribute combinations
		this.validateAttributeCombinations(token, template, diagnostics);

		// Validate nested blocks
		this.validateNestedBlocks(token, template, diagnostics);
	}

	private validateBlockConstraints(token: Token, template: BlockDefinition, diagnostics: Diagnostic[]) {
		const attributes = token.children.filter(child => child.type === 'attribute');
		const nestedBlocks = token.children.filter(child => child.type === 'block');

		// Check for unknown attributes if arbitraryAttributes is false
		if (!template.arbitraryAttributes) {
			attributes.forEach(attr => {
				const attrName = attr.children.find(c => c.type === 'identifier')?.getDisplayText();
				if (attrName && !template.attributes?.some(a => a.name === attrName)) {
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
			if (!template.blocks?.some(b => b.type === blockType)) {
				diagnostics.push(this.createDiagnostic(
					block,
					`Unknown nested block type "${blockType}" in ${token.getDisplayText()} block`,
					DiagnosticSeverity.Error
				));
			}
		});
	}

	private validateRequiredAttributes(token: Token, template: BlockDefinition, diagnostics: Diagnostic[]) {
		if (!template.attributes) return;

		const presentAttrs = new Set(
			token.children
				.filter(child => child.type === 'attribute')
				.map(child => child.children.find(c => c.type === 'identifier')?.getDisplayText())
				.filter(Boolean)
		);

		// Check required attributes
		template.attributes
			.filter(attr => attr.required)
			.forEach(attr => {
				if (!presentAttrs.has(attr.name)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Missing required attribute: ${attr.name}`,
						DiagnosticSeverity.Error
					));
				}
			});

		// Check required attribute combinations
		if (template.validation?.requiredChoice) {
			template.validation.requiredChoice.forEach(choices => {
				if (!choices.some(choice => presentAttrs.has(choice))) {
					diagnostics.push(this.createDiagnostic(
						token,
						`One of these attributes is required: ${choices.join(', ')}`,
						DiagnosticSeverity.Error
					));
				}
			});
		}
	}

	private validateAttributeCombinations(token: Token, template: BlockDefinition, diagnostics: Diagnostic[]) {
		if (!template.validation?.mutuallyExclusive) return;

		const presentAttrs = new Set(
			token.children
				.filter(child => child.type === 'attribute')
				.map(child => child.children.find(c => c.type === 'identifier')?.getDisplayText())
				.filter(Boolean)
		);

		template.validation.mutuallyExclusive.forEach(group => {
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

	private validateNestedBlocks(token: Token, template: BlockDefinition, diagnostics: Diagnostic[]) {
		if (!template.blocks) return;

		const nestedBlockCounts = new Map<string, number>();
		token.children
			.filter(child => child.type === 'block')
			.forEach(block => {
				const blockType = block.getDisplayText();
				nestedBlockCounts.set(blockType, (nestedBlockCounts.get(blockType) || 0) + 1);
			});

		// Check min/max occurrences for each block type
		template.blocks.forEach(blockDef => {
			const count = nestedBlockCounts.get(blockDef.type) || 0;
			if (blockDef.min !== undefined && count < blockDef.min) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Block "${blockDef.type}" must appear at least ${blockDef.min} times`,
					DiagnosticSeverity.Error
				));
			}
			if (blockDef.max !== undefined && count > blockDef.max) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Block "${blockDef.type}" can appear at most ${blockDef.max} times`,
					DiagnosticSeverity.Error
				));
			}
		});
	}

	private validateBlockOccurrences(seenBlocks: Map<string, number>, diagnostics: Diagnostic[]) {
		// This would validate global block occurrence constraints
		// Implementation depends on your specific requirements
	}

	private validateFunction(token: Token, diagnostics: Diagnostic[]) {
		const funcIdentifier = token.children.find(child => child.type === 'identifier');
		const funcName = funcIdentifier?.getDisplayText();

		if (!funcName) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Invalid function call structure',
				DiagnosticSeverity.Error
			));
			return;
		}

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
				`Function "${funcName}" is deprecated${funcDef.deprecationMessage ? ': ' + funcDef.deprecationMessage : ''}`,
				DiagnosticSeverity.Warning
			));
		}

		this.validateFunctionParameters(token, funcDef, diagnostics);
	}

	private validateFunctionParameters(token: Token, funcDef: FunctionDefinition, diagnostics: Diagnostic[]) {
		const parameters = token.children.filter(child => child.type !== 'identifier');
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
		const lastParam = funcDef.parameters[funcDef.parameters.length - 1];
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
			const paramDef = funcDef.parameters[index] || lastParam;
			if (paramDef) {
				this.validateParameterValue(param, paramDef, diagnostics);
			}
		});
	}

	private validateParameterValue(token: Token, paramDef: FunctionDefinition['parameters'][0], diagnostics: Diagnostic[]) {
		// Validate parameter type
		const valueType = this.inferValueType(token);
		if (valueType && !paramDef.types.includes(valueType)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Invalid parameter type. Expected one of: ${paramDef.types.join(', ')}`,
				DiagnosticSeverity.Error
			));
		}

		// Validate parameter constraints
		if (paramDef.validation) {
			if (paramDef.validation.pattern && token.type === 'string_lit') {
				const value = token.getDisplayText();
				if (!new RegExp(paramDef.validation.pattern).test(value)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Parameter value does not match required pattern: ${paramDef.validation.pattern}`,
						DiagnosticSeverity.Error
					));
				}
			}

			if (paramDef.validation.allowedValues && paramDef.validation.allowedValues.includes(token.value)) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Invalid value. Allowed values are: ${paramDef.validation.allowedValues.join(', ')}`,
					DiagnosticSeverity.Error
				));
			}
		}
	}

	private validateAttribute(token: Token, diagnostics: Diagnostic[]) {
		const attributeIdentifier = token.children.find(child => child.type === 'identifier');
		if (!attributeIdentifier) return;

		const attributeName = attributeIdentifier.getDisplayText();
		const blockToken = this.findParentBlock(token);

		if (blockToken) {
			const blockTemplate = this.schema.getBlockDefinition(blockToken.getDisplayText());
			const attribute = blockTemplate?.attributes?.find(attr => attr.name === attributeName);

			if (attribute) {
				if (attribute.deprecated) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Attribute "${attributeName}" is deprecated${attribute.deprecationMessage ? ': ' + attribute.deprecationMessage : ''}`,
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

	private validateValueConstraints(token: Token, attribute: AttributeDefinition, diagnostics: Diagnostic[]) {
		const validation = attribute.validation;
		if (!validation) return;

		const value = token.value;

		if (validation.pattern && typeof value === 'string') {
			if (!new RegExp(validation.pattern).test(value)) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Value does not match required pattern: ${validation.pattern}`,
					DiagnosticSeverity.Error
				));
			}
		}

		if (validation.min !== undefined && typeof value === 'number') {
			if (value < validation.min) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Value must be greater than or equal to ${validation.min}`,
					DiagnosticSeverity.Error
				));
			}
		}

		if (validation.max !== undefined && typeof value === 'number') {
			if (value > validation.max) {
				diagnostics.push(this.createDiagnostic(
					token,
					`Value must be less than or equal to ${validation.max}`,
					DiagnosticSeverity.Error
				));
			}
		}

		if (validation.allowedValues && !validation.allowedValues.includes(value)) {
			diagnostics.push(this.createDiagnostic(
				token,
				`Invalid value. Allowed values are: ${validation.allowedValues.join(', ')}`,
				DiagnosticSeverity.Error
			));
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

	private validateNestedAttributes(token: Token, attributes: AttributeDefinition[], diagnostics: Diagnostic[]) {
		if (token.type !== 'object' || !token.children) return;

		const presentAttrs = new Set(
			token.children
				.filter(child => child.type === 'attribute')
				.map(child => child.children.find(c => c.type === 'identifier')?.getDisplayText())
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
		token.children
			.filter(child => child.type === 'attribute')
			.forEach(child => {
				const attrName = child.children.find(c => c.type === 'identifier')?.getDisplayText();
				const attrDef = attributes.find(a => a.name === attrName);

				if (!attrDef) {
					diagnostics.push(this.createDiagnostic(
						child,
						`Unknown nested attribute: ${attrName}`,
						DiagnosticSeverity.Error
					));
					return;
				}

				const valueToken = child.children.find(c => c.type !== 'identifier');
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

		const paramValue = token.getDisplayText();
		const matchingParam = blockDef.parameters.find(param =>
			param.validation?.pattern && new RegExp(param.validation.pattern).test(paramValue)
		);

		if (!matchingParam) {
			diagnostics.push(this.createDiagnostic(
				token,
				'Invalid parameter value',
				DiagnosticSeverity.Error
			));
		} else {
			// Validate parameter constraints
			if (matchingParam.validation) {
				if (matchingParam.validation.allowedValues &&
					!matchingParam.validation.allowedValues.includes(paramValue)) {
					diagnostics.push(this.createDiagnostic(
						token,
						`Invalid parameter value. Allowed values: ${matchingParam.validation.allowedValues.join(', ')}`,
						DiagnosticSeverity.Error
					));
				}
			}
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
			case 'string_lit':
				return 'string';
			case 'number_lit':
				return 'number';
			case 'boolean_lit':
				return 'boolean';
			case 'array_lit':
				return 'array';
			case 'object':
				return 'object';
			case 'function_call':
				const funcName = token.children.find(c => c.type === 'identifier')?.getDisplayText();
				if (funcName) {
					const funcDef = this.schema.getFunctionDefinition(funcName);
					return funcDef?.returnType.types[0];
				}
				break;
			case 'reference':
				return this.inferReferenceType(token);
			case 'interpolation':
				return 'string';
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

