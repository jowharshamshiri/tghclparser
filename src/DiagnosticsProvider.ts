import type { Diagnostic, Range } from 'vscode-languageserver';
import { DiagnosticSeverity } from 'vscode-languageserver';

import type { BlockTemplate, BlockDelimiter, Token, ValueDefinition, ValueType } from './model';
import type { ParsedDocument } from './index';

export class DiagnosticsProvider {
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
			} else if (token.type === 'boolean_lit' && !token.parent) {
				// Detect loose boolean literals not attached to any parent context
				diagnostics.push({
					range: this.tokenToRange(token),
					message: `Invalid syntax: unexpected boolean literal "${token.text}". Boolean values must be part of an attribute assignment or expression`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			} else if (token.type === 'bare_token') {
				diagnostics.push({
					range: this.tokenToRange(token),
					message: `Invalid syntax: unexpected bare word "${token.text}". Expected attribute assignment (key = value) or block definition`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}

			if (token.children?.length > 0) {
				stack.push(...token.children.slice().reverse());
			}
		}
	}

	private isInArbitraryAttributesBlock(token: Token, parsedDocument: ParsedDocument): boolean {
        let currentToken = token;
        
        while (true) {
            const parentBlock = parsedDocument.findContainingBlock(currentToken.startPosition);
            if (!parentBlock) break;

            const template = parsedDocument.getSchema().getBlockTemplate(parentBlock.text);
            if (template?.arbitraryAttributes) {
                return true;
            }

            currentToken = parentBlock;
        }

        return false;
    }

	private validateBlock(token: Token, diagnostics: Diagnostic[], parsedDocument: ParsedDocument) {
		const parentToken = parsedDocument.findParentBlock(token);

		// Check if we're inside a block that allows arbitrary attributes
        const isInArbitraryBlock = this.isInArbitraryAttributesBlock(token, parsedDocument);
		console.log(`token: ${token.text} parentToken: ${parentToken?.text} isInArbitraryBlock: ${isInArbitraryBlock}`);

        // If we're in an arbitrary block, don't validate this as a block type
        if (isInArbitraryBlock) {
            return;
        }

		const template = parentToken
			? parsedDocument.getSchema().findNestedBlockTemplate(parentToken.text, token.text)
			: parsedDocument.getSchema().getBlockTemplate(token.text);

		if (!template) {
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

		// First, validate the overall structure of the block's content
		for (const child of token.children ?? []) {
			// Valid tokens are either blocks, identifiers that are part of attribute assignments,
			// or block parameters
			if (child.type === 'block') {
				continue; // Will be validated separately
			} else if (child.type === 'block_parameter') {
				continue; // Will be validated as part of parameter validation
			} else if (child.type === 'identifier') {
				// An identifier must have exactly one child that represents its value
				if (child.children.length === 0) {
					diagnostics.push({
						range: this.tokenToRange(child),
						message: `Missing value for attribute "${child.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
			} else if (child.type === 'inline_comment' || child.type === 'block_comment') {
				continue; // Ignore comments
			} else {
				// Any other token type is invalid in this context
				diagnostics.push({
					range: this.tokenToRange(child),
					message: `Unexpected "${child.type === 'string_lit' ? child.text : child.type}" in block. Expected attribute assignment or block definition`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}
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

		// Collect both identifier and block tokens as attributes
		const foundAttrs = new Set(
			token.children
				?.filter(c => c.type === 'identifier' || (c.type === 'block' && !this.isNestedBlockType(c.text, template)))
				.map(c => c.text) ?? []
		);

		// Check required attributes
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

		// Validate each identifier-value pair and nested blocks
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
				} else {
					// For arbitrary attributes, validate value and check for trailing content
					if (child.children.length === 0) {
						diagnostics.push({
							range: this.tokenToRange(child),
							message: `Missing value for attribute "${child.text}"`,
							severity: DiagnosticSeverity.Error,
							source: 'terragrunt'
						});
					} else if (child.children.length > 1) {
						// Report error for any token after the first one
						for (let i = 1; i < child.children.length; i++) {
							diagnostics.push({
								range: this.tokenToRange(child.children[i]),
								message: `Unexpected token after value in attribute "${child.text}"`,
								severity: DiagnosticSeverity.Error,
								source: 'terragrunt'
							});
						}
					} else {
						const value = child.children[0];
						if (!this.isValidValueType(value.type)) {
							diagnostics.push({
								range: this.tokenToRange(value),
								message: `Invalid value type for attribute "${child.text}"`,
								severity: DiagnosticSeverity.Error,
								source: 'terragrunt'
							});
						} else {
							this.validateValueSyntax(value, child, diagnostics);
						}
					}
				}
			} else if (child.type === 'block' && !template.arbitraryAttributes) {
				// Only validate nested blocks if not in an arbitraryAttributes block
				const nestedTemplate = template.blocks?.find(b => b.type === child.text);
				if (!nestedTemplate) {
					diagnostics.push({
						range: this.tokenToRange(child),
						message: `Unknown nested block type "${child.text}" in "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
			}
		}
	}

	private isValidNumber(value: string): boolean {
		// For integers
		if (/^-?\d+$/.test(value)) return true;
		// For floats
		if (/^-?\d+\.\d+$/.test(value)) return true;
		// For floats with f suffix
		if (/^-?\d+\.\d+f$/.test(value)) return true;
		return false;
	}

	private validateValueSyntax(value: Token, token: Token, diagnostics: Diagnostic[]) {
		switch (value.type) {
			case 'integer_lit':
			case 'float_lit':
			case 'float_lit_with_f':
				if (!this.isValidNumber(value.text)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Invalid numeric value "${value.text}" for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
				break;
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
		if (token.children.length === 0) {
			diagnostics.push({
				range: this.tokenToRange(token),
				message: `Missing value for attribute "${token.text}"`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
			return;
		}

		if (token.children.length > 1) {
			// Report error for any token after the first one
			for (let i = 1; i < token.children.length; i++) {
				diagnostics.push({
					range: this.tokenToRange(token.children[i]),
					message: `Unexpected token after value in attribute "${token.text}"`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}
			return;
		}

		const value = token.children[0];

		// Skip validation for dynamic values and heredoc
		if (value.type === 'function_call' ||
			value.type === 'property_access' ||
			value.type === 'heredoc' ||
			(value.type === 'string_lit' && value.children.some(child => child.type === 'interpolation'))) {
			return;
		}

		if (valueDefinition.type === 'string') {
			const validTypes = ['string_lit', 'heredoc'];
			if (!validTypes.includes(value.type)) {
				diagnostics.push({
					range: this.tokenToRange(value),
					message: `Expected a string value for attribute "${token.text}"`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}
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
		}

		// Special handling for boolean values in complex expressions
		if (valueDefinition.type === 'boolean') {
			const validBooleanTypes = ['boolean_lit', 'function_call', 'property_access', 'conditional'];
			if (!validBooleanTypes.includes(value.type)) {
				diagnostics.push({
					range: this.tokenToRange(value),
					message: `Expected a boolean value (true/false) for attribute "${token.text}"`,
					severity: DiagnosticSeverity.Error,
					source: 'terragrunt'
				});
			}
			// If it's a conditional (ternary), validate both branches are boolean
			if (value.type === 'conditional' && value.children.length === 3) {
				const [_, trueBranch, falseBranch] = value.children;
				for (const branch of [trueBranch, falseBranch]) {
					if (!validBooleanTypes.includes(branch.type) && branch.type !== 'boolean_lit') {
						diagnostics.push({
							range: this.tokenToRange(branch),
							message: `Expected a boolean value in ternary expression`,
							severity: DiagnosticSeverity.Error,
							source: 'terragrunt'
						});
					}
				}
			}
		}

		switch (valueDefinition.type) {
			case 'number': {
				const validTypes = ['integer_lit', 'float_lit', 'float_lit_with_f'];
				if (!validTypes.includes(value.type)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected a number value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				} else if (!this.isValidNumber(value.text)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Invalid numeric value "${value.text}" for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				}
				break;
			}
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
				const validTypes = ['object_lit', 'block'];
				if (!validTypes.includes(value.type)) {
					diagnostics.push({
						range: this.tokenToRange(value),
						message: `Expected an object value for attribute "${token.text}"`,
						severity: DiagnosticSeverity.Error,
						source: 'terragrunt'
					});
				} else if (valueDefinition.properties) {
					// Only validate properties if they're defined in the schema
					const properties = value.children.filter(child => child.type === 'identifier');
					for (const [propName, propDef] of Object.entries(valueDefinition.properties)) {
						const propToken = properties.find(p => p.text === propName);
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
		const hasVariadicParam = func.parameters.some(p => p.variadic);
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

	private isNestedBlockType(blockName: string, template: BlockTemplate): boolean {
		return template.blocks?.some(block => block.type === blockName) ?? false;
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

	private validateObjectSeparators(parsedDocument: ParsedDocument, diagnostics: Diagnostic[]): void {
        const lines = parsedDocument.getLines();
        let inObject = 0; // Track nested object depth
        let expectingProperty = false;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            let inString = false;
            let lastCommaPos = -1;

            // Skip empty lines
            if (!line.trim()) continue;

            // Process the line character by character
            for (let charPos = 0; charPos < line.length; charPos++) {
                const char = line[charPos];

                // Handle string literals
                if (char === '"' && (charPos === 0 || line[charPos - 1] !== '\\')) {
                    inString = !inString;
                    continue;
                }

                // Skip content inside strings
                if (inString) continue;

                // Track object depth
                if (char === '{') {
                    inObject++;
                    expectingProperty = true;
                    continue;
                }
                if (char === '}') {
                    inObject--;
                    expectingProperty = false;
                    lastCommaPos = -1; // Reset comma position when closing object
                    continue;
                }

                // Handle commas
                if (char === ',') {
                    lastCommaPos = charPos;
                    expectingProperty = true;
                    continue;
                }

                // Check what follows a comma when we're in an object
                if (inObject > 0 && lastCommaPos !== -1 && charPos > lastCommaPos) {
                    // Skip whitespace when looking for next character
                    if (/\s/.test(char)) continue;

                    // If we find a closing brace, it's a valid trailing comma
                    if (char === '}') {
                        lastCommaPos = -1;
                        continue;
                    }

                    // Only quotes are allowed as the next non-whitespace character after a comma
                    if (char !== '"') {
                        diagnostics.push({
                            range: {
                                start: { line: lineNum, character: lastCommaPos },
                                end: { line: lineNum, character: charPos + 1 }
                            },
                            message: 'Invalid character after comma in object. Expected property declaration starting with quote (")',
                            severity: DiagnosticSeverity.Error,
                            source: 'terragrunt'
                        });
                        lastCommaPos = -1; // Reset to avoid multiple errors for the same issue
                    }
                }
            }

            // Check if we need to look ahead for the next property
            if (lastCommaPos !== -1 && expectingProperty) {
                // Look ahead at the next non-empty line
                let nextLine = '';
                let nextLineNum = lineNum + 1;
                while (nextLineNum < lines.length) {
                    const nextCandidate = lines[nextLineNum].trim();
                    if (nextCandidate && !nextCandidate.startsWith('#') && !nextCandidate.startsWith('//')) {
                        nextLine = nextCandidate;
                        break;
                    }
                    nextLineNum++;
                }

                // If next line starts with closing brace, it's a valid trailing comma
                if (nextLine.startsWith('}')) {
                    continue;
                }

                // If next line doesn't start with a quote and isn't a closing brace, it's invalid
                if (nextLine && !nextLine.trimLeft().startsWith('"')) {
                    diagnostics.push({
                        range: {
                            start: { line: lineNum, character: lastCommaPos },
                            end: { line: lineNum, character: lastCommaPos + 1 }
                        },
                        message: 'Invalid syntax after comma. Next property must start with a quote (")',
                        severity: DiagnosticSeverity.Error,
                        source: 'terragrunt'
                    });
                }
            }
        }
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
	
	getDiagnostics(parsedDocument: ParsedDocument): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        this.validateTokensIterative(parsedDocument.getTokens(), parsedDocument, diagnostics);
        this.validateObjectSeparators(parsedDocument, diagnostics);
        return diagnostics;
    }

	private validateUnclosedBlocks(parsedDocument: ParsedDocument, diagnostics: Diagnostic[]): void {
		const lines = parsedDocument.getLines();
		const delimiters: BlockDelimiter[] = [];
		let inString = false;
		let inComment = false;
		let inMultilineComment = false;

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum];

			for (let colNum = 0; colNum < line.length; colNum++) {
				const char = line[colNum];
				const prevChar = colNum > 0 ? line[colNum - 1] : '';

				// Handle string literals
				if (char === '"' && prevChar !== '\\') {
					inString = !inString;
					continue;
				}

				// Skip content inside strings
				if (inString) continue;

				// Handle comments
				if (char === '/' && line[colNum + 1] === '/') {
					break; // Skip rest of line for single-line comments
				}
				if (char === '#') {
					break; // Skip rest of line for # comments
				}
				if (char === '/' && line[colNum + 1] === '*') {
					inMultilineComment = true;
					colNum++; // Skip next character
					continue;
				}
				if (char === '*' && line[colNum + 1] === '/' && inMultilineComment) {
					inMultilineComment = false;
					colNum++; // Skip next character
					continue;
				}

				// Skip content inside comments
				if (inMultilineComment) continue;

				// Track opening delimiters
				if (char === '{' || char === '[' || char === '(') {
					delimiters.push({
						char,
						line: lineNum,
						column: colNum,
						type: this.getDelimiterType(char)
					});
				}
				// Check closing delimiters
				else if (char === '}' || char === ']' || char === ')') {
					const openChar = this.getMatchingOpenDelimiter(char);
					const lastDelimiter = delimiters[delimiters.length - 1];

					if (!lastDelimiter || lastDelimiter.char !== openChar) {
						// Unmatched closing delimiter
						diagnostics.push({
							range: {
								start: { line: lineNum, character: colNum },
								end: { line: lineNum, character: colNum + 1 }
							},
							message: `Unmatched closing ${this.getDelimiterName(char)}`,
							severity: DiagnosticSeverity.Error,
							source: 'terragrunt'
						});
					} else {
						delimiters.pop();
					}
				}
			}
		}

		// Report remaining unclosed delimiters
		for (const delimiter of delimiters) {
			diagnostics.push({
				range: {
					start: { line: delimiter.line, character: delimiter.column },
					end: { line: delimiter.line, character: delimiter.column + 1 }
				},
				message: `Unclosed ${this.getDelimiterName(delimiter.char)}`,
				severity: DiagnosticSeverity.Error,
				source: 'terragrunt'
			});
		}
	}

	private getDelimiterType(char: string): 'brace' | 'bracket' | 'parenthesis' {
		switch (char) {
			case '{':
			case '}':
				return 'brace';
			case '[':
			case ']':
				return 'bracket';
			case '(':
			case ')':
				return 'parenthesis';
			default:
				throw new Error(`Invalid delimiter character: ${char}`);
		}
	}

	private getMatchingOpenDelimiter(closeChar: string): string {
		switch (closeChar) {
			case '}': return '{';
			case ']': return '[';
			case ')': return '(';
			default: throw new Error(`Invalid closing delimiter: ${closeChar}`);
		}
	}

	private getDelimiterName(char: string): string {
		switch (char) {
			case '{':
			case '}':
				return 'brace';
			case '[':
			case ']':
				return 'bracket';
			case '(':
			case ')':
				return 'parenthesis';
			default:
				return 'delimiter';
		}
	}
}