import type { CompletionItem, Position } from 'vscode-languageserver';

import type { Token } from '~/model';
import type { ParsedDocument } from '~/ParsedDocument';

import type { Schema } from '../Schema';

interface ScanState {
	inBlock: number;        // Depth of { } blocks
	inBrackets: number;     // Depth of [ ] brackets
	inParens: number;       // Depth of ( ) parentheses
	inString: boolean;      // Whether we're in a string literal
	inInterpolation: number; // Depth of ${ } interpolations
	inAttributeAssignment: boolean; // Whether we're in middle of attribute = value
	stringChar: string | null; // The quote character (" or ') of current string
	interpolationBlocks: number[]; // Stack of block levels where interpolations started
}

type CompletionContext = {
	// The most specific (innermost) context type
	type:
	// Top level context
	| { kind: 'root' }

	// Block-related contexts
	| { kind: 'block_type' }
	| { kind: 'block_parameter'; blockType: string }
	| { kind: 'nested_block'; parentBlockType: string }
	| { kind: 'block_attribute_name'; blockType: string }
	| { kind: 'block_attribute_value'; blockType: string; attributeName: string }

	// Reference contexts
	| {
		kind: 'reference';
		namespace: 'local' | 'dependency' | 'module' | 'var' | 'data' | 'terraform' | 'path';
		parts: string[]; // The parts after the namespace that have been typed
	}

	// Function contexts
	| {
		kind: 'function';
		scope: 'root' | 'interpolation' | 'attribute_value';
		name?: string; // The function name if already started typing
		parameterIndex?: number; // Which parameter we're completing
	}

	// String/Interpolation contexts  
	| {
		kind: 'string_literal';
		interpolated: boolean;
	}
	| {
		kind: 'interpolation';
		inProgress: boolean; // Whether we're after ${ or completed it
	}

	// Expression contexts
	| {
		kind: 'expression';
		scope: 'attribute_value' | 'interpolation' | 'function_parameter';
	}

	// Additional context info that applies to any type
	partial?: string; // Partial word that's been typed
	position: Position; // Where in the document we are
	inComment?: boolean; // Whether we're in a comment (should disable completions)
};

export class CompletionsProvider {
	constructor(private schema: Schema) { }
	getCompletions(
		documentText: string,
		position: Position,
		token: Token | null,
		parsedDocument: ParsedDocument
	): Promise<CompletionItem[]> {
		// if (this.isRootContext(documentText, position)) {
		// 	return this.getRootCompletions(context);
		// }
		return Promise.resolve([]);
	}
	isReferenceContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isInterpolationContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isFunctionContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isStringLiteralContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isExpressionContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isBlockParameterContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isNestedBlockContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isBlockAttributeNameContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isBlockAttributeValueContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isCommentContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isPartialContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	isBlockAttributeContext(
		documentText: string,
		position: Position
	): boolean {
		return false;
	}
	getFunctionContext(
		documentText: string,
		position: Position
	): CompletionContext {
		return {
			type: {
				kind: 'function',
				scope: 'root'
			},
			position: { line: 0, character: 0 }
		}
	}
	getArrayContext(
		documentText: string,
		position: Position
	): CompletionContext {
		return {
			type: {
				kind: 'function',
				scope: 'root'
			},
			position: { line: 0, character: 0 }
		}
	}
	getBlockContext(
		documentText: string,
		position: Position
	): CompletionContext {
		return {
			type: {
				kind: 'function',
				scope: 'root'
			},
			position: { line: 0, character: 0 }
		}
	}

	getAttributeContext(
		documentText: string,
		position: Position
	): CompletionContext {
		return {
			type: {
				kind: 'function',
				scope: 'root'
			},
			position: { line: 0, character: 0 }
		}
	}
	private isAttributeValueComplete(text: string): boolean {
		// Remove leading equals and whitespace
		const valueText = text.replace(/^=\s*/, '');

		if (valueText.length === 0) return false;

		// Track state for balanced symbols
		let braceCount = 0;
		let bracketCount = 0;
		let inString = false;
		let stringChar: string | null = null;

		for (let i = 0; i < valueText.length; i++) {
			const char = valueText[i];

			// Handle string literals
			if ((char === '"' || char === "'") && !inString) {
				inString = true;
				stringChar = char;
			} else if (char === stringChar && valueText[i - 1] !== '\\') {
				inString = false;
				stringChar = null;
			}

			// Only process special characters if not in string
			if (!inString) {
				switch (char) {
					case '{': {
						braceCount++; break;
					}
					case '}': {
						braceCount--; break;
					}
					case '[': {
						bracketCount++; break;
					}
					case ']': {
						bracketCount--; break;
					}
					case '\n': {
						return false;
					} // Incomplete if we hit newline
				}
			}

			// Check if we've reached a balanced state with some content
			if (i > 0 && braceCount === 0 && bracketCount === 0 && !inString) {
				return true;
			}
		}

		// If we get here, we haven't found a complete value
		return false;
	}
	isRootContext(
		documentText: string,
		position: Position
	): boolean {
		// Convert position to offset
		const lines = documentText.split('\n');
		const offset = lines
			.slice(0, position.line)
			.reduce((sum, line) => sum + line.length + 1, 0) + position.character;

		// Scan document up to position
		const state: ScanState = {
			inBlock: 0,
			inBrackets: 0,
			inParens: 0,
			inString: false,
			inInterpolation: 0,
			interpolationBlocks: [], // Track block levels for each interpolation
			inAttributeAssignment: false,
			stringChar: null
		};

		let i = 0;
		while (i < offset) {
			const char = documentText[i];
			const nextChar = documentText[i + 1];

			// console.log(`At char '${char}${nextChar || ''}' (${i}):`, {
			// 	inBlock: state.inBlock,
			// 	inParens: state.inParens,
			// 	inInterpolation: state.inInterpolation,
			// 	interpolationBlocks: state.interpolationBlocks,
			// 	inString: state.inString
			// });

			// Handle string literals
			if ((char === '"' || char === "'") && !state.inString) {
				state.inString = true;
				state.stringChar = char;
			} else if (char === state.stringChar && documentText[i - 1] !== '\\') {
				state.inString = false;
				state.stringChar = null;
			}

			// Only process special characters if not in string
			if (!state.inString) {
				switch (char) {
					case '{': {
						if (nextChar !== '%') {
							state.inBlock++;
						}
						break;
					}
					case '}': {
						if (documentText[i - 1] !== '%') {
							state.inBlock--;
							// Check if this closes an interpolation
							if (state.interpolationBlocks.length > 0 &&
								state.inBlock === state.interpolationBlocks.at(-1)) {
								state.interpolationBlocks.pop();
								state.inInterpolation--;
							}
						}
						break;
					}
					case '[': {
						state.inBrackets++; break;
					}
					case ']': {
						state.inBrackets--; break;
					}
					case '(': {
						state.inParens++; break;
					}
					case ')': {
						state.inParens--; break;
					}
					case '=': {
						// Look back for attribute name pattern
						let j = i - 1;
						while (j >= 0 && /\s/.test(documentText[j])) j--; // Skip whitespace
						if (j >= 0 && /\w/.test(documentText[j])) {
							state.inAttributeAssignment = true;
							// Check if the value is already complete
							const match = documentText.slice(i).match(/^[^\n]*/);
							const restOfLine = match ? match[0] : '';
							if (this.isAttributeValueComplete(restOfLine)) {
								state.inAttributeAssignment = false;
							}
						}
						break;
					}
					case '$': {
						// Only count as interpolation if it's not escaped
						if (nextChar === '{' && documentText[i - 1] !== '\\') {
							state.inInterpolation++;
							state.interpolationBlocks.push(state.inBlock);
							state.inBlock++;
							i++; // Skip the {
						}
						break;
					}
				}
			}

			i++;
		}

		// We're at root level if all states are balanced and we're not in a partial state
		// console.log('Final state:', state);
		return (
			state.inBlock === 0 &&
			state.inBrackets === 0 &&
			state.inParens === 0 &&
			!state.inString &&
			state.inInterpolation === 0 &&
			!state.inAttributeAssignment
		);
	}

	isBlockTypeContext(
		documentText: string,
		position: Position
	): boolean {
		// If we're not at root context, we can't be at block type context
		if (!this.isRootContext(documentText, position)) {
			return false;
		}

		// Convert position to offset
		const lines = documentText.split('\n');
		const lineText = lines[position.line];
		const textBeforeCursor = lineText.slice(0, position.character);
		const textAfterCursor = lineText.slice(position.character);

		// Look ahead to ensure we haven't started a new line or block
		if (/^\s*\{/.test(textAfterCursor)) {
			return false;
		}

		// First check for attribute context by looking for a valid identifier followed by equals
		// This handles both "name=" and "name = " cases
		if (/[a-z_][\w-]*\s*=/i.test(textBeforeCursor)) {
			return false;
		}

		// Handle the case of a bare attribute name without equals
		const attributeMatch = textBeforeCursor.match(/[a-z_][\w-]*$/i);
		if (attributeMatch && /^\s*=/.test(textAfterCursor)) {
			return false;
		}

		// Check for valid block type context:
		// 1. Must start with whitespace/empty or closing brace + whitespace
		// 2. Can have a partial or complete identifier
		const blockTypeRegex = /^(?:\s*|\}+\s*)(?:[a-z_][\w-]*)?$/i;
		return blockTypeRegex.test(textBeforeCursor);
	};

	
}
