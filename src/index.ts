import { CompletionItem, Diagnostic, Position } from 'vscode-languageserver';
import { parse as tg_parse, SyntaxError } from './terragrunt-parser';
import { Token, Location, BlockValue, ASTValue, ASTNode, TokenType } from './model';
import { Schema } from './Schema';
import { CompletionsProvider } from './CompletionsProvider';
import { HoverProvider } from './HoverProvider';
import { DiagnosticsProvider } from './DiagnosticsProvider';

export interface HoverResult {
	content: {
		kind: 'markdown';
		value: string;
	};
}

export class ParsedDocument {
	private ast: any | null = null;
	private diagnostics: Diagnostic[] = [];
	private tokens: Token[] = [];
	private schema: Schema;
	private completionsProvider: CompletionsProvider;
	private hoverProvider: HoverProvider;
	private diagnosticsProvider: DiagnosticsProvider;

	constructor(private uri: string, private content: string) {
		this.schema = Schema.getInstance();
		this.completionsProvider = new CompletionsProvider(this.schema);
		this.hoverProvider = new HoverProvider(this.schema);
		this.diagnosticsProvider = new DiagnosticsProvider(this.schema);
		this.content = content;
		this.parseContent();
	}

	private createToken(node: any): Token | null {
		if (!node || !node.location) return null;

		return new Token(
			node.id,
			node.type as any,
			node.value,
			node.location
		);
	}

	private processNode(node: any, parentToken: Token | null = null): Token | null {
		const token = this.createToken(node);
		if (!token) return null;

		if (parentToken) {
			token.parent = parentToken;
		}

		if (node.children && Array.isArray(node.children)) {
			for (const childNode of node.children) {
				const childToken = this.processNode(childNode, token);
				if (childToken) {
					token.children.push(childToken);
				}
			}
		}

		return token;
	}

	private flattenTokens(rootToken: Token): Token[] {
		const tokens: Token[] = [];
		const processed = new Set<number>();

		const traverse = (token: Token) => {
			if (!processed.has(token.id)) {
				processed.add(token.id);
				tokens.push(token);
				token.children.forEach(child => traverse(child));
			}
		};

		traverse(rootToken);
		return tokens;
	}

	parseNode(node: any, parent: Token | null = null): Token {
		const token = new Token(node.id, node.type as TokenType, node.value ?? null, node.location as Location);
		token.parent = parent;

		if (node.children) {
			token.children = node.children.map((child: any) => this.parseNode(child, token));
		}

		return token;
	}

	private parseContent() {
		try {
			this.ast = tg_parse(this.content, { grammarSource: this.uri });
			this.tokens = [this.parseNode(this.ast)];

			this.diagnostics = this.diagnosticsProvider.getDiagnostics(this.tokens);
		} catch (error) {
			if (error instanceof SyntaxError && error.location) {
				// Convert the parser's location format to VSCode's format
				this.diagnostics.push( {
					severity: 1,
					range: {
						start: {
							line: error.location.start.line - 1,  // PEG.js uses 1-based line numbers
							character: error.location.start.column - 1
						},
						end: {
							line: error.location.end.line - 1,
							character: error.location.end.column - 1
						}
					},
					message: error.message,
					source: 'terragrunt'
				});

				// Keep your console.log statements for debugging if needed
			} else {
				// Fallback for unknown errors
				this.diagnostics.push({
					severity: 1,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 }
					},
					message: error instanceof Error ? error.message : 'Unknown error',
					source: 'terragrunt'
				});
			}

		}
	}

	private removeCircularReferences<T>(data: T[]): string {
		return JSON.stringify(data, (key, value) => (key === "parent" ? null : value), 2);
	}

	public getUri(): string {
		return this.uri;
	}

	public getContent(): string {
		return this.content;
	}

	public setContent(content: string) {
		this.content = content;
		this.parseContent();
	}

	public getAST(): any | null {
		return this.ast;
	}

	public getTokens(): Token[] {
		return this.tokens;
	}

	public getDiagnostics(): Diagnostic[] {
		return this.diagnostics;
	}

	public getCompletionsAtPosition(position: Position): CompletionItem[] {
		const lineText = this.getLineAtPosition(position);
		const token = this.findTokenAtPosition(position);
		return this.completionsProvider.getCompletions(lineText, position, token);
	}

	public getHoverInfo(position: Position): HoverResult | null {
		const token = this.findTokenAtPosition(position);
		if (!token) return null;
		return this.hoverProvider.getHoverInfo(token);
	}

	public findTokenAtPosition(position: Position): Token | null {
		const findToken = (tokens: Token[]): Token | null => {
			for (const token of tokens) {
				if (this.isPositionInRange(position, token)) {
					// Check children first for more specific matches
					const childMatch = findToken(token.children);
					if (childMatch) return childMatch;
					return token;
				}
			}
			return null;
		};

		return findToken(this.tokens);
	}

	private getLineAtPosition(position: Position): string {
		const lines = this.content.split('\n');
		return position.line < lines.length ? lines[position.line] : '';
	}

	private isPositionInRange(position: Position, token: Token): boolean {
		const startPos = token.startPosition;
		const endPos = token.endPosition;

		if (position.line < startPos.line || position.line > endPos.line) {
			return false;
		}

		if (position.line === startPos.line && position.character < startPos.character) {
			return false;
		}

		if (position.line === endPos.line && position.character > endPos.character) {
			return false;
		}

		return true;
	}
}

export { Token };