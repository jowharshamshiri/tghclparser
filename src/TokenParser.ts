import type { ExpressionParser } from './ExpressionParser.js';
import type { TokenDecorator} from './model.js';
import { DECORATOR_PATTERNS, Token, TOKEN_PATTERNS    } from './model.js';

export class TokenParser {

	private handleBareToken(line: string, currentRow: number, currentCol: number, tokens: Token[], addToken: (token: Token, tokens: Token[]) => void): [boolean, number] {
		// Skip leading whitespace
		while (currentCol < line.length && /\s/.test(line[currentCol])) {
			currentCol++;
		}
	
		// If we're at the end of the line or hit a comment, return
		if (currentCol >= line.length || 
			line[currentCol] === '#' || 
			line.slice(currentCol).startsWith('//') ||
			line[currentCol] === '"' ||
			line[currentCol] === '{' ||
			line[currentCol] === '}' ||
			line[currentCol] === '(' ||
			line[currentCol] === ')') {
			return [false, currentCol];
		}
	
		// Check if we're part of a larger word/identifier
		// Look backwards to ensure we're at a word boundary
		if (currentCol > 0 && /\w/.test(line[currentCol - 1])) {
			return [false, currentCol];
		}
	
		// Don't treat content inside function calls as bare tokens
		// Include the function name itself
		const beforeCursor = line.slice(0, currentCol);
		const funcCallMatch = beforeCursor.match(/\w+\s*\([^)]*$/);
		if (funcCallMatch) {
			return [false, currentCol];
		}
	
		// Look for complete bare words (must be bounded by non-word chars)
		const match = line.slice(currentCol).match(/^([a-zA-Z_]\w*)(?!\w)/);
		if (match && !line.slice(currentCol + match[1].length).trim().startsWith('(')) {
			const bareToken = new Token(
				'bare_token',
				match[1],
				currentRow,
				currentCol,
				currentCol + match[1].length
			);
			addToken(bareToken, tokens);
			return [true, currentCol + match[1].length];
		}
	
		return [false, currentCol];
	}
	parseLineContent(
		slice: string,
		lines: string[],
		currentRow: number,
		currentCol: number,
		depth: number,
		stack: Token[],
		tokens: Token[],
		addToken: (token: Token, tokens: Token[]) => void,
		expressionParser: ExpressionParser
	): [boolean, number, number] {

		// Handle blocks with parameters
		const blockParamMatch = TOKEN_PATTERNS.BLOCK_WITH_PARAM.exec(slice);
		if (blockParamMatch) {
			const [fullMatch, blockName, paramValue] = blockParamMatch;
			const blockToken = new Token('block', blockName, currentRow, currentCol, currentCol + blockName.length);
	
			const paramStart = currentCol + fullMatch.indexOf('"');
			const paramToken = new Token(
				'block_parameter',
				paramValue,
				currentRow,
				paramStart,
				paramStart + paramValue.length + 2
			);
			blockToken.children.push(paramToken);
	
			addToken(blockToken, tokens);
			return [true, currentRow, currentCol + slice.indexOf('{') + 1];
		}
	
		// Handle regular blocks
		const blockMatch = TOKEN_PATTERNS.BLOCK.exec(slice) || TOKEN_PATTERNS.BLOCK_ASSIGN.exec(slice);
		if (blockMatch) {
			const blockName = blockMatch[1];
			const token = new Token('block', blockName, currentRow, currentCol, currentCol + blockName.length);
			addToken(token, tokens);
			return [true, currentRow, currentCol + slice.indexOf('{') + 1];
		}
	
		// Handle array assignments
		const arrayMatch = slice.match(/^\s*(\w+)\s*=\s*\[/);
		if (arrayMatch) {
			const identifierName = arrayMatch[1];
			const identifierToken = new Token(
				'identifier',
				identifierName,
				currentRow,
				currentCol,
				currentCol + identifierName.length
			);
	
			// Find the end of the array
			let arrayEndRow = currentRow;
			let arrayEndCol = currentCol + arrayMatch[0].length;
			let bracketDepth = 1;
			let inString = false;
			
			while (arrayEndRow < lines.length) {
				const line = arrayEndRow === currentRow 
					? lines[arrayEndRow].slice(arrayEndCol)
					: lines[arrayEndRow];
					
				for (let i = 0; i < line.length; i++) {
					const char = line[i];
					
					if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
						inString = !inString;
					} else if (!inString) {
						if (char === '[') bracketDepth++;
						if (char === ']') {
							bracketDepth--;
							if (bracketDepth === 0) {
								// Found the end of the array
								const actualEndCol = arrayEndRow === currentRow 
									? arrayEndCol + i + 1
									: i + 1;
									
								// Get the full array content
								let arrayContent = '';
								if (arrayEndRow === currentRow) {
									arrayContent = lines[currentRow].slice(
										currentCol + arrayMatch[0].length - 1,
										actualEndCol
									);
								} else {
									arrayContent = `${lines[currentRow].slice(currentCol + arrayMatch[0].length - 1)  }\n`;
									for (let row = currentRow + 1; row < arrayEndRow; row++) {
										arrayContent += `${lines[row]  }\n`;
									}
									arrayContent += lines[arrayEndRow].slice(0, actualEndCol);
								}
	
								const [arrayToken] = expressionParser.parseArray(
									arrayContent,
									currentRow,
									currentCol + arrayMatch[0].length - 1
								);
	
								identifierToken.children.push(arrayToken);
								addToken(identifierToken, tokens);
								return [true, arrayEndRow, actualEndCol];
							}
						}
					}
				}
				
				arrayEndCol = 0;
				arrayEndRow++;
			}
		}
	
		// Handle identifiers (non-array assignments)
		const identifierMatch = TOKEN_PATTERNS.IDENTIFIER.exec(slice);
		if (identifierMatch) {
			const [success, newRow, newCol] = this.handleIdentifier(
				lines,
				currentRow,
				currentCol,
				identifierMatch,
				tokens,
				addToken,
				expressionParser
			);
			if (success) {
				return [true, newRow, newCol];
			}
		}
	
		// Handle closing brace
		if (slice[0] === '}') {
			if (stack.length > 0) {
				stack.pop();
			}
			return [true, currentRow, currentCol + 1];
		}
	
		// Handle inline comments within a line
		if (slice.startsWith('//') || slice.startsWith('#')) {
			const commentText = slice;
			addToken(
				new Token('inline_comment', commentText, currentRow, currentCol, currentCol + commentText.length),
				tokens
			);
			return [true, currentRow + 1, 0];
		}
	
		// Handle bare tokens (invalid syntax)
		const [handled, newCol] = this.handleBareToken(lines[currentRow], currentRow,currentCol, tokens, addToken);
		if (handled) {
			return [true, currentRow, newCol];
		}
	
		// Handle whitespace
		if (TOKEN_PATTERNS.WHITESPACE.test(slice[0])) {
			return [true, currentRow, currentCol + 1];
		}
	
		return [false, currentRow, currentCol];
	}
	
    parseBlockComment(lines: string[], currentRow: number, currentCol: number): [Token, number, number] {
        let commentText = '';
        const startRow = currentRow;
        const startCol = currentCol;
        let endRow = currentRow;
        let endCol = currentCol;

        while (endRow < lines.length) {
            const line = lines[endRow].slice(endCol);
            const endIndex = line.indexOf('*/');

            if (endIndex !== -1) {
                commentText += line.slice(0, Math.max(0, endIndex + 2));
                endCol += endIndex + 2;
                break;
            }

            commentText += `${line  }\n`;
            endRow++;
            endCol = 0;
        }

        return [
            new Token('block_comment', commentText, startRow, startCol, endCol),
            endRow,
            endCol
        ];
    }

    parseHeredocLine(
		trimmedLine: string,
		lines: string[],
		currentRow: number,
		currentCol: number,
		expressionParsers: ExpressionParser
	): [Token, number] | null {
		const heredocStartMatch = trimmedLine.match(/^(\w+)\s*=\s*<<(\w+)\s*$/);
		if (!heredocStartMatch) return null;
	
		const [_, identifierName, heredocId] = heredocStartMatch;  // Using _ for unused first element
		let heredocContent = '';
		let endRow = currentRow + 1;
		let foundEnd = false;

        while (endRow < lines.length) {
            const nextLine = lines[endRow].trim();
            if (nextLine === heredocId) {
                foundEnd = true;
                break;
            }
            heredocContent += `${lines[endRow]  }\n`;
            endRow++;
        }

        if (!foundEnd) {
            throw new Error(`Unterminated heredoc: missing identifier "${heredocId}"`);
        }

        const identifierToken = new Token(
            'identifier',
            identifierName,
            currentRow,
            currentCol,
            currentCol + identifierName.length
        );

        const heredocToken = new Token(
            'heredoc',
            heredocContent.trimEnd(),
            currentRow,
            currentCol + trimmedLine.indexOf('<<'),
            currentCol + trimmedLine.length
        );

        // Parse interpolations in heredoc content
        const contentLines = heredocContent.split('\n');
        for (const [i, contentLine] of contentLines.entries()) {
            const interpolations = expressionParsers.parseInterpolation(contentLine, currentRow + 1 + i,0);
            if (interpolations.length > 0) {
                heredocToken.children.push(...interpolations);
            }
        }

        identifierToken.children.push(heredocToken);
        return [identifierToken, endRow + 1];
    }

    private handleIdentifier(
        lines: string[],
        startRow: number,
        startCol: number,
        identifierMatch: RegExpMatchArray,
        tokens: Token[],
        addToken: (token: Token, tokens: Token[]) => void,
        expressionParsers: ExpressionParser
    ): [boolean, number, number] {
        const currentRow = startRow;
        let currentCol = startCol;
        const identifierText = identifierMatch[1];
        const token = new Token('identifier', identifierText, currentRow, currentCol, currentCol + identifierText.length);

        const equalsIndex = lines[currentRow].slice(currentCol).indexOf('=');
        if (equalsIndex === -1) {
            return [false, currentRow, currentCol];
        }

        currentCol += equalsIndex + 1;

        // Skip whitespace
        while (currentCol < lines[currentRow].length && /\s/.test(lines[currentRow][currentCol])) {
            currentCol++;
        }

        const valueSlice = lines[currentRow].slice(currentCol);

        // Handle function calls
        const funcMatch = valueSlice.match(TOKEN_PATTERNS.FUNCTION_CALL);
        if (funcMatch) {
            try {
                const [funcToken, newRow, newCol] = expressionParsers.parseFunctionCall(lines, currentRow, currentCol);
                token.children.push(funcToken);
                addToken(token, tokens);
                return [true, newRow, newCol];
            } catch (e) {
                console.error('Error parsing function call:', e);
            }
        }

        // Try property access before falling back to other value types
        try {
            const [propToken, newCol] = expressionParsers.parsePropertyAccess(valueSlice.trim(), currentRow, currentCol);
            token.children.push(propToken);
            addToken(token, tokens);
            return [true, currentRow, newCol];
        } catch {
            // Handle other value types
            const [valueToken, newCol] = expressionParsers.parseValue(valueSlice, currentRow, currentCol, this.analyzeString.bind(this));
            token.children.push(valueToken);
            addToken(token, tokens);
            return [true, currentRow, newCol];
        }
    }

    analyzeString(value: string): TokenDecorator[] {
        const decorators: TokenDecorator[] = [];
        
        // Remove quotes if present
        const unquotedValue = value.startsWith('"') && value.endsWith('"') 
            ? value.slice(1, -1) 
            : value;

        // Helper function to add decorator while handling quotes
        const addDecorator = (match: RegExpExecArray, type: TokenDecorator['type']) => {
            decorators.push({
                type,
                startIndex: match.index + (value.startsWith('"') ? 1 : 0),
                endIndex: match.index + match[0].length + (value.startsWith('"') ? 1 : 0)
            });
        };

        // Check patterns in priority order
        const patterns: Array<[RegExp, TokenDecorator['type']]> = [
            [DECORATOR_PATTERNS.GIT_SSH_URL, 'git_ssh_url'],
            [DECORATOR_PATTERNS.GIT_HTTPS_URL, 'git_https_url'],
            [DECORATOR_PATTERNS.TERRAFORM_REGISTRY_URL, 'terraform_registry_url'],
            [DECORATOR_PATTERNS.S3_URL, 's3_url'],
            [DECORATOR_PATTERNS.HTTPS_URL, 'https_url'],
            [DECORATOR_PATTERNS.FILE_PATH, 'file_path'],
            [DECORATOR_PATTERNS.EMAIL, 'email'],
            [DECORATOR_PATTERNS.IP_ADDRESS, 'ip_address'],
            [DECORATOR_PATTERNS.DATE, 'date'],
            [DECORATOR_PATTERNS.TIME, 'time'],
            [DECORATOR_PATTERNS.UUID, 'uuid']
        ];

        const usedRanges: Array<[number, number]> = [];

        for (const [pattern, type] of patterns) {
            const match = pattern.exec(unquotedValue);
            if (match) {
                const start = match.index;
                const end = start + match[0].length;
                
                // Check if this range overlaps with any previously used ranges
                const overlaps = usedRanges.some(([usedStart, usedEnd]) => 
                    (start >= usedStart && start < usedEnd) || 
                    (end > usedStart && end <= usedEnd) ||
                    (start <= usedStart && end >= usedEnd)
                );
                
                if (!overlaps) {
                    addDecorator(match, type);
                    usedRanges.push([start, end]);
                }
            }
        }

        return decorators;
    }
}