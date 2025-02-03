import type { Diagnostic, Range } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';

import type { Token, ValueDefinition, ValueType } from './model';
import type { ParsedDocument } from './index';

export class DiagnosticsProvider {
	getDiagnostics(parsedDocument: ParsedDocument): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        this.validateTokensIterative(parsedDocument.getTokens(), parsedDocument, diagnostics);
        return diagnostics;
    }

    private validateTokensIterative(tokens: Token[], parsedDocument: ParsedDocument, diagnostics: Diagnostic[]) {
        const stack: Token[] = [...tokens];
        const processedTokens = new Set<Token>();

        while (stack.length > 0) {
            const token = stack.pop();
            if (!token || processedTokens.has(token)) continue;

            processedTokens.add(token);

            if (token.type === 'block') {
                this.validateBlock(token, diagnostics, parsedDocument);
            } else if (token.type === 'function_call') {
                this.validateFunctionCall(token, diagnostics, parsedDocument);
            }

            if (token.children?.length > 0) {
                stack.push(...token.children.slice().reverse());
            }
        }
    }

	private validateBlock(token: Token, diagnostics: Diagnostic[], parsedDocument: ParsedDocument) {
        const parentToken = parsedDocument.findParentBlock(token);
        const template = parentToken
            ? parsedDocument.getSchema().findNestedBlockTemplate(parentToken.text, token.text)
            : parsedDocument.getSchema().getBlockTemplate(token.text);

        if (!template) {
            // Only validate as unknown block if parent doesn't have arbitraryAttributes
            const parentTemplate = parentToken 
                ? parsedDocument.getSchema().getBlockTemplate(parentToken.text)
                : null;

            if (!parentTemplate?.arbitraryAttributes) {
                const contextMessage = parentToken ? ` in "${parentToken.text}" block` : '';
                diagnostics.push({
                    range: this.tokenToRange(token),
                    message: `Unknown block type: ${token.text}${contextMessage}`,
                    severity: DiagnosticSeverity.Error,
                    source: 'terragrunt'
                });
            }
            return;
        }

        // Validate block parameters
        if (template.parameters && template.parameters.length > 0) {
            const paramToken = token.children.find(child => child.type === 'block_parameter');
            if (!paramToken && template.parameters.some(p => p.required)) {
                diagnostics.push({
                    range: this.tokenToRange(token),
                    message: `Missing required parameter for block "${token.text}"`,
                    severity: DiagnosticSeverity.Error,
                    source: 'terragrunt'
                });
            } else if (paramToken && template.parameters[0].pattern) {
                const pattern = new RegExp(template.parameters[0].pattern);
                if (!pattern.test(paramToken.text)) {
                    diagnostics.push({
                        range: this.tokenToRange(paramToken),
                        message: `Parameter value must match pattern: ${template.parameters[0].pattern}`,
                        severity: DiagnosticSeverity.Error,
                        source: 'terragrunt'
                    });
                }
            }
        }

        const foundAttrs = new Set(
            token.children
                ?.filter(c => c.type === 'identifier')
                .map(c => c.text) ?? []
        );

        // Always validate required attributes regardless of arbitraryAttributes flag
        if (template.attributes) {
            for (const attr of template.attributes) {
                if (attr.required && !foundAttrs.has(attr.name)) {
                    diagnostics.push({
                        range: this.tokenToRange(token),
                        message: `Missing required attribute: ${attr.name}`,
                        severity: DiagnosticSeverity.Error,
                        source: 'terragrunt'
                    });
                }
            }
        }

        // Validate attributes and their values
        for (const child of token.children ?? []) {
            if (child.type === 'identifier') {
                const attrDef = template.attributes?.find(attr => attr.name === child.text);
                
                if (attrDef) {
                    // If it's a defined attribute, validate it according to its schema
                    this.validateAttributeValue(child, attrDef.value, diagnostics, parsedDocument);
                } else if (!template.arbitraryAttributes) {
                    // Only report unknown attributes if arbitraryAttributes is false
                    diagnostics.push({
                        range: this.tokenToRange(child),
                        message: `Unknown attribute "${child.text}" in block "${token.text}"`,
                        severity: DiagnosticSeverity.Error,
                        source: 'terragrunt'
                    });
                }
                // If template.arbitraryAttributes is true, we don't validate the attribute value
                // This allows object literals and other values in arbitrary attribute blocks
            }
        }

        // Validate nested blocks only if not in an arbitraryAttributes block
        if (!template.arbitraryAttributes && template.blocks) {
            for (const nestedBlock of token.children ?? []) {
                if (nestedBlock.type === 'block') {
                    const nestedTemplate = template.blocks.find(b => b.type === nestedBlock.text);
                    if (!nestedTemplate) {
                        diagnostics.push({
                            range: this.tokenToRange(nestedBlock),
                            message: `Unknown nested block type "${nestedBlock.text}" in "${token.text}"`,
                            severity: DiagnosticSeverity.Error,
                            source: 'terragrunt'
                        });
                    }
                }
            }
        }
    }

	private validateArbitraryAttributeValue(token: Token, diagnostics: Diagnostic[], parsedDocument: ParsedDocument) {
		const value = token.children[0];
		if (!value) {
			diagnostics.push({
				range: this.tokenToRange(token),
				message: `Missing value for attribute "${token.text}"`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
			return;
		}

		if (!this.isValidValueType(value.type)) {
			diagnostics.push({
				range: this.tokenToRange(value),
				message: `Invalid value type for attribute "${token.text}"`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
		}
	}

	private isValidValueType(type: string): boolean {
		const validTypes = [
			'string_lit',
			'integer_lit',
			'float_lit',
			'float_lit_with_f',
			'boolean_lit',
			'null_lit',
			'array_lit',
			'object_lit',
			'block',
			'function_call',
			'property_access',
			'interpolation'
		];
		return validTypes.includes(type);
	}

	private validateAttributeValue(token: Token, valueDefinition: ValueDefinition, diagnostics: Diagnostic[], parsedDocument: ParsedDocument) {
        const value = token.children[0];
        if (!value) {
            diagnostics.push({
                range: this.tokenToRange(token),
                message: `Missing value for attribute "${token.text}"`,
                severity: DiagnosticSeverity.Error,
                source: 'terragrunt'
            });
            return;
        }

        // Skip validation for dynamic values
        if (value.type === 'function_call' || 
            value.type === 'property_access' ||
            (value.type === 'string_lit' && value.children.some(child => child.type === 'interpolation'))) {
            return;
        }

		switch (valueDefinition.type) {
			case 'string': {
				const validTypes = ['string_lit', 'property_access'];
				if (!validTypes.includes(value.type)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected a string value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
				// Validate pattern if specified
				if (valueDefinition.pattern && value.type === 'string_lit') {
					const pattern = new RegExp(valueDefinition.pattern);
					if (!pattern.test(value.text)) {
						diagnostics.push({
							range: this.tokenToRange(value),
							message: `Value must match pattern ${valueDefinition.pattern}`,
							severity: DiagnosticSeverity.Error,
							source: 'terragrunt'
						});
					}
				}
				break;
			}
			case 'number': {
				const validTypes = ['integer_lit', 'float_lit', 'float_lit_with_f'];
				if (!validTypes.includes(value.type)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected a number value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
				break;
			}
			case 'boolean': {
				if (value.type !== 'boolean_lit') {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected a boolean value (true/false) for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
				break;
			}
			case 'array': {
				if (value.type !== 'array_lit') {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected an array value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				} else {
					// Validate array constraints
					if (valueDefinition.minItems !== undefined && value.children.length < valueDefinition.minItems) {
						diagnostics.push({
							range: this.tokenToRange(value),
							message: `Array must have at least ${valueDefinition.minItems} items`,
							severity: DiagnosticSeverity.Error,
							source: 'terragrunt'
						});
					}
					if (valueDefinition.maxItems !== undefined && value.children.length > valueDefinition.maxItems) {
						diagnostics.push({
							range: this.tokenToRange(value),
							message: `Array must have at most ${valueDefinition.maxItems} items`,
							severity: DiagnosticSeverity.Error,
							source: 'terragrunt'
						});
					}
					// Validate array element types if specified
					if (valueDefinition.elementType && value.children) {
						value.children.forEach(element => {
							this.validateAttributeValue(
								{ ...token, children: [element] },
								{ type: valueDefinition.elementType as ValueType },
								diagnostics,
								parsedDocument
							);
						});
					}
				}
				break;
			}
			case 'object': {
				if (!['object_lit', 'block'].includes(value.type)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected an object value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				} else if (valueDefinition.properties) {
					for (const [propName, propDef] of Object.entries(valueDefinition.properties)) {
						const propToken = value.children.find(
							child => child.type === 'identifier' && child.text === propName
						);
						if (propDef.required && !propToken) {
							diagnostics.push({
								range: this.tokenToRange(value),
								message: `Missing required property "${propName}"`,
								severity: DiagnosticSeverity.Error,
								source: 'terragrunt'
							});
						}
						if (propToken) {
							this.validateAttributeValue(propToken, propDef, diagnostics, parsedDocument);
						}
					}
				}
				break;
			}
			case 'null': {
				if (value.type !== 'null_lit') {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected a null value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
				break;
			}
		}

		if (valueDefinition.enum && value.type === 'string_lit' && !valueDefinition.enum.includes(value.text)) {
			diagnostics.push({
				range: this.tokenToRange(value),
				message: `Value must be one of: ${valueDefinition.enum.join(', ')}`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
		}
	}

	private validateFunctionCall(token: Token, diagnostics: Diagnostic[], parsedDocument: ParsedDocument) {
		const func = parsedDocument.getSchema().getFunctionDefinition(token.text);
		if (!func) {
			diagnostics.push({
				range: this.tokenToRange(token),
				message: `Unknown function: ${token.text}`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
			return;
		}

		// Check minimum required parameters
		const requiredParams = func.parameters.filter(p => p.required);
		const hasVariadicParam = func.parameters.some(p => p.type === 'array');
		const maxParams = hasVariadicParam ? Infinity : func.parameters.length;

		if (!token.children || token.children.length < requiredParams.length) {
			diagnostics.push({
				range: this.tokenToRange(token),
				message: `Missing required arguments. Expected ${requiredParams.length}, got ${token.children?.length ?? 0}`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
			return;
		}

		if (!hasVariadicParam && token.children.length > maxParams) {
			diagnostics.push({
				range: this.tokenToRange(token),
				message: `Too many arguments. Expected ${maxParams}, got ${token.children.length}`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
			return;
		}

		// Validate each argument
		token.children.forEach((arg, index) => {
			const param = func.parameters[hasVariadicParam ? Math.min(index, func.parameters.length - 1) : index];
			if (param) {
				this.validateArgumentType(arg, param.type, token.text, diagnostics);
			}
		});
	}

	private validateArgumentType(arg: Token, expectedType: string, funcName: string, diagnostics: Diagnostic[]) {
		// Skip validation for dynamic values
		if (arg.type === 'function_call' ||
			arg.type === 'property_access' ||
			(arg.type === 'string_lit' && arg.children.some(child => child.type === 'interpolation'))) {
			return;
		}

		const typeMap: Record<string, string[]> = {
			'string': ['string_lit'],
			'number': ['integer_lit', 'float_lit', 'float_lit_with_f'],
			'boolean': ['boolean_lit'],
			'array': ['array_lit'],
			'object': ['object_lit', 'block'],
			'any': []  // Will match any type
		};

		const validTypes = typeMap[expectedType] || [];
		if (validTypes.length > 0 && !validTypes.includes(arg.type)) {
			diagnostics.push({
				range: this.tokenToRange(arg),
				message: `Invalid argument type for function "${funcName}". Expected ${expectedType}, got ${arg.type}`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
		}
	}

	private tokenToRange(token: Token): Range {
		return {
			start: {
				line: token.startPosition.line,
				character: token.startPosition.character
			},
			end: {
				line: token.endPosition.line,
				character: token.endPosition.character
			}
		};
	}

	private getDefaultValueForType(type: string): string {
		const defaults: Record<string, string> = {
			string: '""',
			number: '0',
			boolean: 'false',
			array: '[]',
			object: '{}',
		};
		return defaults[type] || '""';
	}
}