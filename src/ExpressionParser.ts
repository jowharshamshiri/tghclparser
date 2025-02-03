import type { TokenType } from './model';
import { Token, TOKEN_PATTERNS  } from './model';

export class ExpressionParser {
	parseArray(value: string, row: number, startCol: number): [Token, number] {
		const arrayToken = new Token(
			'array_lit',
			'arr',
			row,
			startCol,
			startCol + 1
		);

		// Determine if this is a single-line or multi-line array
		const lines = value.split('\n');
		if (lines.length === 1) {
			// Single-line array parsing
			let currentPos = 1; // Skip opening bracket
			let currentElement = '';
			let elementStart = currentPos;
			let inString = false;
			let bracketDepth = 0;

			while (currentPos < value.length) {
				const char = value[currentPos];

				if (char === '"' && (currentPos === 0 || value[currentPos - 1] !== '\\')) {
					inString = !inString;
					currentElement += char;
				} else if (!inString) {
					if (char === '[') {
						if (bracketDepth === 0) {
							// Start of a nested array
							const nestedArrayEnd = this.findMatchingBracket(value, currentPos);
							if (nestedArrayEnd === -1) break;

							const nestedArrayContent = value.substring(currentPos, nestedArrayEnd + 1);
							const [nestedArrayToken] = this.parseArray(
								nestedArrayContent,
								row,
								startCol + currentPos
							);
							arrayToken.children.push(nestedArrayToken);
							currentPos = nestedArrayEnd + 1;
							elementStart = currentPos;
							continue;
						}
						bracketDepth++;
						currentElement += char;
					} else if (char === ']') {
						if (bracketDepth === 0) {
							// Process the last element if it exists
							if (currentElement.trim()) {
								this.addArrayElement(
									currentElement.trim(),
									row,
									startCol + elementStart,
									arrayToken
								);
							}
							break;
						}
						bracketDepth--;
						currentElement += char;
					} else if (char === ',' && bracketDepth === 0) {
						if (currentElement.trim()) {
							this.addArrayElement(
								currentElement.trim(),
								row,
								startCol + elementStart,
								arrayToken
							);
						}
						currentElement = '';
						currentPos++; // Skip comma
						while (currentPos < value.length && /\s/.test(value[currentPos])) {
							currentPos++;
						}
						elementStart = currentPos;
						continue;
					} else {
						currentElement += char;
					}
				} else {
					currentElement += char;
				}
				currentPos++;
			}
		} else {
			// Multi-line array parsing
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();

				if (!line || line === '[' || line === ']' || line === ',' || line === '],') {
					continue;
				}

				const elementText = line.endsWith(',') ? line.slice(0, -1).trim() : line;

				if (elementText.startsWith('[')) {
					// Handle nested array in multiline context
					let nestedContent = elementText;
					let j = i + 1;
					let nestedBracketCount = 1;

					// If the array doesn't end on this line, collect content from subsequent lines
					if (!this.isBalancedArray(elementText)) {
						while (j < lines.length && nestedBracketCount > 0) {
							const nextLine = lines[j].trim();
							if (nextLine) {
								nestedContent += `\n${nextLine}`;
								nestedBracketCount += (nextLine.match(/\[/g) || []).length;
								nestedBracketCount -= (nextLine.match(/\]/g) || []).length;
							}
							j++;
						}
						i = j - 1; // Update outer loop counter
					}

					const [nestedArrayToken] = this.parseArray(
						nestedContent,
						row + i,
						startCol + lines[i].indexOf('[')
					);
					arrayToken.children.push(nestedArrayToken);
				} else if (elementText) {
					this.addArrayElement(
						elementText,
						row + i,
						startCol + lines[i].indexOf(elementText),
						arrayToken
					);
				}
			}
		}

		return [arrayToken, startCol + value.length];
	}

	private findMatchingBracket(text: string, startPos: number): number {
		let bracketCount = 1;
		let inString = false;

		for (let i = startPos + 1; i < text.length; i++) {
			const char = text[i];

			if (char === '"' && text[i - 1] !== '\\') {
				inString = !inString;
			} else if (!inString) {
				if (char === '[') bracketCount++;
				if (char === ']') {
					bracketCount--;
					if (bracketCount === 0) return i;
				}
			}
		}

		return -1;
	}

	private isBalancedArray(text: string): boolean {
		let bracketCount = 0;
		let inString = false;

		for (let i = 0; i < text.length; i++) {
			const char = text[i];

			if (char === '"' && text[i - 1] !== '\\') {
				inString = !inString;
			} else if (!inString) {
				if (char === '[') bracketCount++;
				if (char === ']') bracketCount--;
			}
		}

		return bracketCount === 0;
	}

	private addArrayElement(elementText: string, row: number, startCol: number, arrayToken: Token) {
		let elementToken: Token;

		// Handle string literals (with quotes)
		if (elementText.startsWith('"') && elementText.endsWith('"')) {
			elementToken = new Token(
				'string_lit',
				elementText.slice(1, -1),
				row,
				startCol,
				startCol + elementText.length
			);
		}
		// Handle numeric literals
		else if (TOKEN_PATTERNS.FLOAT_WITH_F.test(elementText)) {
			elementToken = new Token(
				'float_lit_with_f',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}
		else if (TOKEN_PATTERNS.FLOAT.test(elementText)) {
			elementToken = new Token(
				'float_lit',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}
		else if (TOKEN_PATTERNS.INTEGER.test(elementText)) {
			elementToken = new Token(
				'integer_lit',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}
		// Handle boolean literals
		else if (TOKEN_PATTERNS.BOOLEAN.test(elementText)) {
			elementToken = new Token(
				'boolean_lit',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}
		// Handle null literal
		else if (TOKEN_PATTERNS.NULL.test(elementText)) {
			elementToken = new Token(
				'null_lit',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}
		// Handle property access
		else if (/^[\w.]+$/.test(elementText)) {
			elementToken = new Token(
				'property_access',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}
		// Default to string literal for other cases
		else {
			elementToken = new Token(
				'string_lit',
				elementText,
				row,
				startCol,
				startCol + elementText.length
			);
		}

		arrayToken.children.push(elementToken);
	}


	// Update parseValue to avoid recursion with arrays
	parseValue(value: string, row: number, startCol: number, analyzeString?: (value: string) => any[]): [Token, number] {
		// Handle heredoc
		const heredocMatch = value.match(/^\s*<<[-~]?(\w+)\s*$/);
		if (heredocMatch) {
			throw new Error('Heredoc should be handled by token parser');
		}

		// Check for function calls first
		const funcMatch = value.match(TOKEN_PATTERNS.FUNCTION_CALL);
		if (funcMatch) {
			const nestedTokens = this.parseFunctionCallContent(value, row, startCol);
			if (nestedTokens.length > 0) {
				const lastToken = nestedTokens[0];
				return [lastToken, startCol + value.length];
			}
		}

		// Handle interpolated strings
		if (value.startsWith('"') && value.includes('${')) {
			const stringToken = new Token(
				'string_lit',
				value.slice(1, -1),
				row,
				startCol,
				startCol + value.length
			);

			if (analyzeString) {
				stringToken.decorators = analyzeString(value);
			}

			const interpolations = this.parseInterpolation(value, row, startCol);
			stringToken.children.push(...interpolations);
			return [stringToken, startCol + value.length];
		}

		// Try to parse as property access
		try {
			const propertyMatch = value.match(/^([\w.]+)$/);
			if (propertyMatch) {
				return this.parsePropertyAccess(value, row, startCol);
			}
		} catch { /* empty */ }

		// Add check for object literals
		if (value.startsWith('{')) {
			return this.parseObject(value, row, startCol);
		}

		// Handle array literals separately
		if (value.startsWith('[')) {
			return this.parseArray(value, row, startCol);
		}

		// Handle other value types in priority order
		const patterns: [RegExp, TokenType][] = [
			[TOKEN_PATTERNS.STRING, 'string_lit'],
			[TOKEN_PATTERNS.FLOAT_WITH_F, 'float_lit_with_f'],
			[TOKEN_PATTERNS.FLOAT, 'float_lit'],
			[TOKEN_PATTERNS.INTEGER, 'integer_lit'],
			[TOKEN_PATTERNS.NULL, 'null_lit'],
			[TOKEN_PATTERNS.BOOLEAN, 'boolean_lit']
		];

		for (const [pattern, type] of patterns) {
			const match = pattern.test(value);
			if (match) {
				const token = new Token(
					type,
					type === 'string_lit' ? value.slice(1, -1) : value,
					row,
					startCol,
					startCol + value.length
				);

				if (type === 'string_lit' && analyzeString) {
					token.decorators = analyzeString(value);
				}

				return [token, startCol + value.length];
			}
		}

		// Default to string literal if no other patterns match
		return [
			new Token('string_lit', value, row, startCol, startCol + value.length),
			startCol + value.length
		];
	}
	parseInterpolation(line: string, row: number, offset: number): Token[] {
		const tokens: Token[] = [];
		let currentPos = 0;
		while (currentPos < line.length) {
			const dollarBraceIndex = line.indexOf('${', currentPos);
			if (dollarBraceIndex === -1) break;

			let braceCount = 1;
			let endPos = dollarBraceIndex + 2;
			let inString = false;

			while (braceCount > 0 && endPos < line.length) {
				const char = line[endPos];

				if (char === '"' && line[endPos - 1] !== '\\') {
					inString = !inString;
				} else if (!inString) {
					if (char === '{') braceCount++;
					if (char === '}') braceCount--;
				}

				endPos++;
			}

			if (braceCount === 0) {
				const fullValue = line.slice(dollarBraceIndex, endPos);
				const innerValue = line.slice(dollarBraceIndex + 2, endPos - 1);

				const interpolationToken = new Token(
					'interpolation',
					fullValue,
					row,
					dollarBraceIndex,
					endPos
				);
				// Check for property access first
				const propertyMatch = innerValue.match(/^([\w.]+)$/);
				if (propertyMatch) {
					const propertyToken = new Token(
						'property_access',
						propertyMatch[1],
						row,
						dollarBraceIndex + 2 + offset,
						dollarBraceIndex + 2 + propertyMatch[1].length + offset
					);
					interpolationToken.children.push(propertyToken);
				} else {
					// Parse function calls within interpolation
					const functionTokens = this.parseFunctionCallContent(innerValue, row, dollarBraceIndex + 2);
					for (const ft of functionTokens) {
						ft.startPosition.character += offset;
						ft.endPosition.character += offset;
					}
					if (functionTokens.length > 0) {
						interpolationToken.children.push(...functionTokens);
					}
				}

				interpolationToken.startPosition.character += offset;
				interpolationToken.endPosition.character += offset;

				tokens.push(interpolationToken);
			}

			currentPos = endPos;
		}

		return tokens;
	}

	// Modified parseFunctionCall to handle multiline functions
	parseFunctionCall(code: string[], startRow: number, startCol: number): [Token, number, number] {
		const slice = code[startRow].slice(startCol);
		const match = slice.match(TOKEN_PATTERNS.FUNCTION_CALL);
		if (!match) throw new Error('Expected function call');

		const funcName = match[1];
		const token = new Token('function_call', funcName, startRow, startCol, startCol + funcName.length);

		// Find opening parenthesis, which might be on a different line
		let currentRow = startRow;
		let currentPos = slice.indexOf('(');

		// If not found on current line, look in subsequent lines
		while (currentPos === -1 && currentRow < code.length - 1) {
			currentRow++;
			const nextLine = code[currentRow].trimStart();
			currentPos = nextLine.indexOf('(');
			if (currentPos !== -1) {
				// Adjust position to account for leading whitespace
				currentPos = code[currentRow].indexOf('(');
			}
		}

		if (currentPos === -1) throw new Error('Invalid function call syntax: missing opening parenthesis');

		// Build the complete function call content across multiple lines
		let fullContent = '';
		let row = currentRow;
		let inString = false;
		let parenCount = 0;
		let foundStart = false;

		while (row < code.length) {
			const line = row === startRow ? slice : code[row];
			let col = 0;

			while (col < line.length) {
				const char = line[col];

				// Handle string literals
				if (char === '"' && (col === 0 || line[col - 1] !== '\\')) {
					inString = !inString;
				}

				// Track parentheses outside of strings
				if (!inString) {
					if (char === '(') {
						foundStart = true;
						parenCount++;
					} else if (char === ')') {
						parenCount--;
						if (parenCount === 0 && foundStart) {
							// We've found the end of the function call
							fullContent += line.slice(0, col + 1);

							// Parse the complete function content
							const tokens = this.parseFunctionCallContent(fullContent, startRow, startCol);
							if (tokens.length > 0) {
								token.children = tokens[0].children;
							}

							return [token, row, col + 1];
						}
					}
				}

				col++;
			}

			fullContent += `${line}\n`;
			row++;
		}

		throw new Error('Invalid function call syntax: missing closing parenthesis');
	}

	// Helper method to get the full content of a multiline function call
	private getFullFunctionContent(code: string[], startRow: number, startCol: number): string {
		let content = '';
		let currentRow = startRow;
		let parenCount = 0;
		let inString = false;
		let started = false;

		while (currentRow < code.length) {
			const line = currentRow === startRow
				? code[currentRow].slice(startCol)
				: code[currentRow];

			for (let i = 0; i < line.length; i++) {
				const char = line[i];

				if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
					inString = !inString;
				}

				if (!inString) {
					if (char === '(') {
						started = true;
						parenCount++;
					} else if (char === ')') {
						parenCount--;
						if (parenCount === 0 && started) {
							return content + line.slice(0, i + 1);
						}
					}
				}
			}

			content += `${line}\n`;
			currentRow++;
		}

		throw new Error('Unterminated function call');
	}

	private parseFunctionCallContent(content: string, row: number, baseCol: number): Token[] {
		const tokens: Token[] = [];
		let currentPos = 0;
		const seen = new Set<number>(); // Keep track of positions we've already processed

		while (currentPos < content.length) {
			const funcMatch = TOKEN_PATTERNS.FUNCTION_CALL.exec(content.slice(currentPos));
			if (!funcMatch) break;

			const matchPosition = currentPos + funcMatch.index;
			if (seen.has(matchPosition)) {
				currentPos = matchPosition + 1;
				continue;
			}
			seen.add(matchPosition);

			const funcName = funcMatch[1];
			const funcStartCol = baseCol + currentPos + funcMatch.index;
			const funcToken = new Token(
				'function_call',
				funcName,
				row,
				funcStartCol,
				funcStartCol + funcName.length
			);

			// Parse arguments
			const [args, endPos] = this.parseFunctionArgs(
				content,
				currentPos + funcMatch.index + funcName.length,
				row,
				baseCol + currentPos
			);
			funcToken.children.push(...args);
			tokens.push(funcToken);
			currentPos = matchPosition + endPos;
		}

		return tokens;
	}

	private parseFunctionArgs(content: string, startPos: number, row: number, baseCol: number): [Token[], number] {
		const args: Token[] = [];
		let pos = startPos;

		// Move to opening parenthesis
		while (pos < content.length && content[pos] !== '(') pos++;
		if (pos >= content.length) throw new Error('Invalid function call: missing opening parenthesis');
		pos++; // Skip opening parenthesis

		let currentArg = '';
		let currentArgStart = pos;
		let parenCount = 1;
		let inString = false;

		while (pos < content.length && parenCount > 0) {
			const char = content[pos];

			if (char === '"' && content[pos - 1] !== '\\') {
				inString = !inString;
				currentArg += char;
			} else if (!inString) {
				if (char === '(') {
					parenCount++;
					currentArg += char;
				} else if (char === ')') {
					parenCount--;
					if (parenCount > 0) currentArg += char;
				} else if (char === ',' && parenCount === 1) {
					if (currentArg.trim()) {
						const [argToken] = this.parseValue(
							currentArg.trim(),
							row,
							baseCol + currentArgStart
						);
						args.push(argToken);
					}
					currentArg = '';
					pos++; // Skip the comma
					while (pos < content.length && /\s/.test(content[pos])) pos++;
					currentArgStart = pos;
					continue;
				} else {
					currentArg += char;
				}
			} else {
				currentArg += char;
			}
			pos++;
		}

		// Handle the last argument if it exists
		if (currentArg.trim()) {
			const [argToken] = this.parseValue(
				currentArg.trim(),
				row,
				baseCol + currentArgStart
			);
			args.push(argToken);
		}

		return [args, pos];
	}

	parsePropertyAccess(value: string, row: number, startCol: number): [Token, number] {
		// First check if it matches a property access pattern - must start with a letter
		// and can contain only letters, numbers, dots, and underscores
		const propertyMatch = value.match(/^[a-z_][\w.]*$/i);
		if (!propertyMatch) {
			throw new Error('Expected property access');
		}

		return [
			new Token(
				'property_access',
				propertyMatch[0],
				row,
				startCol,
				startCol + propertyMatch[0].length
			),
			startCol + propertyMatch[0].length
		];
	}

	private findFunctionEnd(content: string, startPos: number): number {
		let parenCount = 1;
		let pos = startPos;
		let inString = false;

		while (pos < content.length && parenCount > 0) {
			const char = content[pos];
			if (char === '"' && content[pos - 1] !== '\\') {
				inString = !inString;
			} else if (!inString) {
				if (char === '(') parenCount++;
				if (char === ')') parenCount--;
			}
			pos++;
		}

		return pos;
	}

	private determineValueType(value: string): TokenType {
		if (TOKEN_PATTERNS.STRING.test(value)) return 'string_lit';
		if (TOKEN_PATTERNS.FLOAT_WITH_F.test(value)) return 'float_lit_with_f';
		if (TOKEN_PATTERNS.FLOAT.test(value)) return 'float_lit';
		if (TOKEN_PATTERNS.INTEGER.test(value)) return 'integer_lit';
		if (TOKEN_PATTERNS.NULL.test(value)) return 'null_lit';
		if (TOKEN_PATTERNS.BOOLEAN.test(value)) return 'boolean_lit';
		return 'string_lit';
	}

	private getObjectContent(
		code: string[],
		startRow: number,
		startCol: number,
		endRow: number,
		endCol: number
	): string {
		let content = '';

		for (let row = startRow; row <= endRow; row++) {
			const line = code[row];
			if (row === startRow && row === endRow) {
				content += line.slice(startCol + 1, endCol);
			} else if (row === startRow) {
				content += `${line.slice(startCol + 1)}\n`;
			} else if (row === endRow) {
				content += line.slice(0, endCol);
			} else {
				content += `${line}\n`;
			}
		}

		return content;
	}
	// In ExpressionParser class, add parseObject method
	parseObject(value: string, row: number, startCol: number): [Token, number] {
		const objectToken = new Token('object_lit', 'obj', row, startCol, startCol + 1);
		let currentPos = 1; // Skip opening brace
		let braceCount = 1;
		let inString = false;

		// Find the matching closing brace
		while (currentPos < value.length && braceCount > 0) {
			const char = value[currentPos];

			if (char === '"' && value[currentPos - 1] !== '\\') {
				inString = !inString;
			} else if (!inString) {
				if (char === '{') braceCount++;
				if (char === '}') braceCount--;
			}
			currentPos++;
		}

		if (braceCount !== 0) {
			throw new Error('Unterminated object literal');
		}

		// Extract and parse the object content
		const content = value.slice(1, currentPos - 1).trim();
		const properties = this.parseObjectProperties(content, row, startCol + 1);
		objectToken.children.push(...properties);

		return [objectToken, startCol + currentPos];
	}

	private parseObjectProperties(content: string, row: number, baseCol: number): Token[] {
		const properties: Token[] = [];
		const lines = content.split('\n');

		for (const [i, line_] of lines.entries()) {
			const line = line_.trim();
			if (!line || line.startsWith('#') || line.startsWith('//')) {
				continue;
			}

			const equalIndex = line.indexOf('=');
			if (equalIndex === -1) continue;

			const key = line.slice(0, equalIndex).trim();
			const value = line.slice(equalIndex + 1).trim();

			if (!key || !value) continue;

			// Create identifier token for the key
			const identifierToken = new Token(
				'identifier',
				key,
				row + i,
				baseCol + line_.indexOf(key),
				baseCol + line_.indexOf(key) + key.length
			);

			// Parse the value
			try {
				let valueToken;
				if (value.startsWith('{')) {
					const [objToken, endCol] = this.parseObject(
						value,
						row + i,
						baseCol + line_.indexOf('{')
					);
					valueToken = objToken;
				} else if (value.startsWith('[')) {
					const [arrayToken, endCol] = this.parseArray(
						value,
						row + i,
						baseCol + line_.indexOf('[')
					);
					valueToken = arrayToken;
				} else {
					const [simpleToken, endCol] = this.parseValue(
						value,
						row + i,
						baseCol + line_.indexOf(value)
					);
					valueToken = simpleToken;
				}

				identifierToken.children.push(valueToken);
				properties.push(identifierToken);
			} catch (e) {
				console.error(`Error parsing object property: ${e}`);
			}
		}

		return properties;
	}
}