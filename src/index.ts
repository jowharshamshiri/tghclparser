import type { CompletionItem, Diagnostic, MarkupContent, Position } from 'vscode-languageserver-types';

import { CompletionsProvider } from './CompletionsProvider';
import { DiagnosticsProvider } from './DiagnosticsProvider';
import { HCLParser } from './HCLParser';
import { HoverProvider } from './HoverProvider';
import type { Token } from './model';
import { PositionContext } from './model';
import { Schema } from './Schema';

export class ParsedDocument {
	private schema = Schema.getInstance();
	private parser = new HCLParser();
	private tokens: Token[] = [];
	private hoverProvider = new HoverProvider();
	private completionProvider = new CompletionsProvider();
	private diagnosticsProvider = new DiagnosticsProvider();

	constructor(private uri: string, private document: string) {
		this.update(document);
	}

	getDiagnostics(): Diagnostic[] {
		return this.diagnosticsProvider.getDiagnostics(this);
	}

	getCompletionsAtPosition(position: Position): CompletionItem[] {
		return this.completionProvider.getCompletionsAtPosition(position, this);
	}

	getHoverInfo(token: Token): { contents: MarkupContent } | null {
		return this.hoverProvider.getHoverInfo(token, this);
	}

	getTokens(): Token[] {
		return this.tokens;
	}

	update(document: string): void {
		this.tokens = this.parser.parse(document);
		this.hoverProvider = new HoverProvider();
		this.completionProvider = new CompletionsProvider();
		this.diagnosticsProvider = new DiagnosticsProvider();
	}

	getContextAtPosition(position: Position): PositionContext | null {
		const textBeforeCursor = this.getTextBeforeCursor(position);
		const isBlockContext = this.isNewBlockContext(textBeforeCursor);
		const isFunctionContext = this.isFunctionContext(textBeforeCursor);

		if (isBlockContext) {
			return PositionContext.Block;
		} else if (isFunctionContext) {
			return PositionContext.Function;
		}

		return null;

	}

	getTextBeforeCursor(position: Position): string {
		const lines = this.document.split('\n');
		const lineText = lines[position.line] || '';
		const textBeforeCursor = lineText.slice(0, Math.max(0, position.character));
		return textBeforeCursor;
	}

	getDocument(): string {
		return this.document;
	}

	getSchema(): Schema {
		return this.schema;
	}

	getLines(): string[] {
		return this.document.split('\n');
	}

	getLineText(position: Position): string {
		return this.getLines()[position.line];
	}


	isNewBlockContext(textBeforeCursor: string): boolean {
		const trimmed = textBeforeCursor.trim();
		return trimmed === '' ||
			trimmed.endsWith('}') ||
			/^[a-z_]\w*\s*$/i.test(trimmed);
	}

	isFunctionContext(textBeforeCursor: string): boolean {
		const trimmed = textBeforeCursor.trim();
		return trimmed.endsWith('=') ||
			/=\s*$/.test(trimmed) ||
			/\w+\s*=\s*\w*$/.test(trimmed);
	}


	findContainingBlock(position: Position): Token | null {
		const lines = this.getLines();
		const currentLine = lines[position.line];
		const currentIndent = currentLine?.search(/\S/) ?? -1;

		const findInTokens = (ts: Token[]): Token | null => {
			for (const token of ts) {
				if (token.type !== 'block') continue;

				let blockEndLine = token.endPosition.line;
				for (let i = token.startPosition.line + 1; i < lines.length; i++) {
					if (lines[i].trim() === '}') {
						blockEndLine = i;
						break;
					}
				}

				if (position.line > token.startPosition.line &&
					position.line <= blockEndLine) {

					const blockStartLine = lines[token.startPosition.line];
					const blockIndent = blockStartLine.search(/\S/);

					if (currentIndent > blockIndent || currentIndent === -1) {
						const childResult = findInTokens(token.children);
						if (childResult) return childResult;
						return token;
					}
				}

				const childResult = findInTokens(token.children);
				if (childResult) return childResult;
			}
			return null;
		};

		return findInTokens(this.tokens);
	}

	getUri(): string {
		return this.uri;
	}

	findParentBlock(token: Token): Token | null {
		const findParent = (tokens: Token[], target: Token, currentParent: Token | null = null): Token | null => {
			for (const t of tokens) {
				if (t === target) {
					return currentParent;
				}
				if (t.children?.length > 0) {
					const nextParent = t.type === 'block' ? t : currentParent;
					const result = findParent(t.children, target, nextParent);
					if (result) return result;
				}
			}
			return null;
		};

		return findParent(this.tokens, token);
	}

	findTokenAtPosition(pos: { line: number; character: number }): Token | null {
		// Helper function to check if pos is within bounds, handling line numbers properly
		const isWithinBounds = (token: Token, pos: { line: number; character: number }): boolean => {
			// Helper to compare positions
			const isPositionAfterOrEqual = (a: { line: number; character: number }, b: { line: number; character: number }) => {
				return a.line > b.line || (a.line === b.line && a.character >= b.character);
			};

			const isPositionBeforeOrEqual = (a: { line: number; character: number }, b: { line: number; character: number }) => {
				return a.line < b.line || (a.line === b.line && a.character <= b.character);
			};

			return isPositionAfterOrEqual(pos, token.startPosition) &&
				isPositionBeforeOrEqual(pos, token.endPosition);
		};

		// Recursive function to find deepest matching token
		const findDeepestToken = (tokens: Token[]): Token | null => {
			// First check all children deeply
			for (const token of tokens) {
				// Check children first to find the most specific match
				if (token.children.length > 0) {
					const childMatch = findDeepestToken(token.children);
					if (childMatch) {
						return childMatch;
					}
				}

				// If no child matches, check if this token matches
				if (isWithinBounds(token, pos)) {
					return token;
				}
			}

			return null;
		};

		// Check for token starting from the root
		const result = findDeepestToken(this.tokens);
		return result;
	}



}