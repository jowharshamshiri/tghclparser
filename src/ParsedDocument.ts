import path from 'node:path';

import type { CompletionItem, Diagnostic, MarkupContent, Position } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { CompletionsProvider } from './CompletionsProvider';
import { DiagnosticsProvider } from './DiagnosticsProvider';
import { HoverProvider } from './HoverProvider';
import type { ResolvedReference, RuntimeValue, TokenType, ValueType } from './model';
import { Token } from './model';
import { Schema } from './Schema';
import { parse as tg_parse, SyntaxError } from './terragrunt-parser';
import type { Workspace } from './Workspace';

export class ParsedDocument {
	private ast: any | null = null;
	private diagnostics: Diagnostic[] = [];
	private tokens: Token[] = [];
	private locals = new Map<string, RuntimeValue<ValueType>>();
	private dependencies = new Map<string, string>();
	private schema: Schema;
	private completionsProvider: CompletionsProvider;
	private hoverProvider: HoverProvider;
	private diagnosticsProvider: DiagnosticsProvider;

	constructor(
		private workspace: Workspace,
		private uri: string,
		private content: string
	) {
		this.schema = Schema.getInstance();
		this.completionsProvider = new CompletionsProvider(this.schema);
		this.hoverProvider = new HoverProvider(this.schema);
		this.diagnosticsProvider = new DiagnosticsProvider(this.schema);
		this.parseContent();
		this.buildProfile();
	}

	private buildProfile() {
		if (!this.ast) return;
		this.processLocalsBlock(this.ast);
		this.processDependencyBlocks(this.ast);
	}

	public async getAllLocals(): Promise<Map<string, RuntimeValue<ValueType>>> {
		console.log('getAllLocals called');
		const locals = new Map<string, RuntimeValue<ValueType>>();

		const localsBlock = this.findBlock(this.ast, 'locals');
		if (!localsBlock) return locals;

		for (const attr of localsBlock.children) {
			if (attr.type === 'attribute') {
				const nameChild = attr.children.find(c => c.type === 'attribute_identifier');
				// Get the function call or value token
				const valueToken = attr.children.find(c => c.type !== 'attribute_identifier');

				console.log('Processing local:', {
					name: nameChild?.value,
					valueToken: valueToken ? {
						type: valueToken.type,
						value: valueToken.value,
						children: valueToken.children?.map(c => ({
							type: c.type,
							value: c.value
						}))
					} : null
				});

				if (nameChild?.value && valueToken instanceof Token) {
					// Actually evaluate the value
					const value = await this.evaluateValue(valueToken);
					console.log(`Evaluated ${nameChild.value}:`, value);
					if (value) {
						locals.set(nameChild.value as string, value);
					}
				}
			}
		}

		console.log('Final locals:', Array.from(locals.entries()));
		return locals;
	}
	public async evaluateValue(node: Token): Promise<RuntimeValue<ValueType> | undefined> {
		if (!node) return undefined;
		
		console.log('evaluateValue called for node:', {
			type: node.type,
			value: node.value,
			children: node.children?.map(c => ({
				type: c.type,
				value: c.value,
				children: c.children?.length
			}))
		});
	
		switch (node.type) {
			case 'function_call': {
				const funcName = node.children.find(c => c.type === 'function_identifier')?.value;
				if (!funcName || typeof funcName !== 'string') return undefined;
	
				// Evaluate all arguments first
				const evaluatedArgs = await Promise.all(
					node.children
						.filter(c => c.type !== 'function_identifier')
						.map(arg => this.evaluateValue(arg))
				);
	
				// Filter out undefined arguments
				const args = evaluatedArgs.filter((arg): arg is RuntimeValue<ValueType> => arg !== undefined);
	
				// Create context for function evaluation
				
				const context = {
					workingDirectory: path.dirname(URI.parse(this.uri).fsPath),
					environmentVariables: Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, String(value)])),
					document: {
						uri: this.uri,
						content: this.content
					}
				};
	
				return await this.schema.getFunctionRegistry().evaluateFunction(funcName, args, context);
			}
	
			case 'ternary_expression': {
				const [condition, trueExpr, falseExpr] = node.children;
				const condValue = await this.evaluateValue(condition);
				if (!condValue) return undefined;
	
				const condBool = this.coerceToBool(condValue);
				return condBool ?
					await this.evaluateValue(trueExpr) :
					await this.evaluateValue(falseExpr);
			}
	
			case 'comparison_expression': {
				const [left, op, right] = node.children;
				const leftValue = await this.evaluateValue(left);
				const rightValue = await this.evaluateValue(right);
				if (!leftValue || !rightValue || !op.value || typeof op.value !== 'string') {
					return undefined;
				}
	
				return this.evaluateComparison(leftValue, rightValue, op.value);
			}
			case 'legacy_interpolation': {
				// Legacy interpolation wraps expressions - evaluate its first child
				if (node.children.length > 0) {
					return await this.evaluateValue(node.children[0]);
				}
				return {
					type: 'string',
					value: ''
				};
			}
	
			case 'interpolated_string': {
				const parts: string[] = [];
				
				for (const child of node.children) {
					const evaluated = await this.evaluateValue(child);
					if (evaluated) {
						parts.push(String(evaluated.value));
					}
				}
	
				return {
					type: 'string',
					value: parts.join('')
				};
			}
			case 'string_lit': {
				return {
					type: 'string',
					value: String(node.value ?? '')
				};
			}
	
			default: {
				return this.evaluateLiteral(node);
			}
		}
	}

	private evaluateLiteral(node: Token): RuntimeValue<ValueType> | undefined {
		switch (node.type) {
			case 'string_lit': {
				return {
					type: 'string',
					value: String(node.value ?? '')
				};
			}
			case 'number_lit': {
				return {
					type: 'number',
					value: Number(node.value)
				};
			}
			case 'boolean_lit': {
				return {
					type: 'boolean',
					value: Boolean(node.value)
				};
			}
			case 'array_lit': {
				return {
					type: 'array',
					value: node.children.map(child => this.evaluateLiteral(child)).filter((v): v is RuntimeValue<ValueType> => v !== undefined)
				};
			}
			// Add more literal types here...
		}
		return undefined;
	}
	
	private coerceToBool(value: RuntimeValue<ValueType>): boolean {
		switch (value.type) {
			case 'boolean': {
				return Boolean(value.value);
			}
			case 'string': {
				return typeof value.value === 'string' && value.value.length > 0;
			}
			case 'number': {
				return value.value !== 0;
			}
			case 'array': {
				return Array.isArray(value.value) && value.value.length > 0;
			}
			case 'object':
			case 'block': {
				return value.value instanceof Map && value.value.size > 0;
			}
			default: {
				return false;
			}
		}
	}
	private coerceToString(value: RuntimeValue<ValueType>): string {
		switch (value.type) {
			case 'string':
			case 'number':
			case 'boolean': {
				return String(value.value);
			}
			case 'array': {
				return Array.isArray(value.value) ? value.value.map(v => this.coerceToString(v)).join('') : '';
			}
			case 'object':
			case 'block': {
				if (value.value instanceof Map) {
					const entries: string[] = [];
					value.value.forEach((v, k) => {
						entries.push(`${k}=${this.coerceToString(v)}`);
					});
					return entries.join(',');
				}
				return '';
			}
			default: {
				return '';
			}
		}
	}
	private isPrimitiveValue(value: unknown): value is string | number | boolean | null {
		return typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean' ||
			value === null;
	}

	private getPrimitiveValue(value: RuntimeValue<ValueType>): string | number | boolean | null {
		if (!value) return null;

		switch (value.type) {
			case 'string':
			case 'number':
			case 'boolean': {
				if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean' || value.value === null) {
					return value.value;
				}
				return null;
			}
			case 'null': {
				return null;
			}
			case 'array': {
				if (!Array.isArray(value.value)) return null;
				const primitives = value.value
					.map(v => this.getPrimitiveValue(v))
					.filter(this.isPrimitiveValue);
				return primitives.join(',');
			}
			case 'object':
			case 'block': {
				if (!(value.value instanceof Map)) return null;
				const obj: Record<string, string | number | boolean> = {};
				value.value.forEach((v, k) => {
					const primitive = this.getPrimitiveValue(v);
					if (primitive !== null) {
						obj[k] = primitive;
					}
				});
				return JSON.stringify(obj);
			}
			case 'function': {
				return null;
			}
			default: {
				// Handle expression types
				if (value.value && typeof value.value === 'object' && 'type' in value.value) {
					return this.getPrimitiveValue(value.value as RuntimeValue<ValueType>);
				}
				return null;
			}
		}
	}

	private traverseValue(value: RuntimeValue<ValueType>, parts: string[]): RuntimeValue<ValueType> {
		if (parts.length === 0) return value;

		const nullValue: RuntimeValue<'null'> = { type: 'null', value: null };

		switch (value.type) {
			case 'object':
			case 'block': {
				if (!(value.value instanceof Map)) return nullValue;
				const nextValue = value.value.get(parts[0]);
				if (!nextValue) return nullValue;
				return this.traverseValue(nextValue, parts.slice(1));
			}
			case 'array': {
				if (!Array.isArray(value.value)) return nullValue;
				const index = Number.parseInt(parts[0], 10);
				if (Number.isNaN(index) || index < 0 || index >= value.value.length) {
					return nullValue;
				}
				return this.traverseValue(value.value[index], parts.slice(1));
			}
			default: {
				return nullValue;
			}
		}
	}


	private async unwrapPromise<T extends ValueType>(promise: Promise<RuntimeValue<T> | undefined>): Promise<RuntimeValue<T> | undefined> {
		const result = await promise;
		if (!result) return undefined;
		return result;
	}

	// Update the evaluate functions to properly handle async/await
	private async processLocalsBlock(ast: any) {
		const localsBlock = this.findBlock(ast, 'locals');
		if (!localsBlock) return;

		for (const attr of localsBlock.children) {
			if (attr.type === 'attribute') {
				const name = attr.children.find((c: any) => c.type === 'identifier')?.value;
				const valueToken = attr.children.find((c: any) => c.type !== 'identifier');
				if (name && valueToken) {
					const value = await this.evaluateValue(valueToken);
					if (value) {
						this.locals.set(name, value);
					}
				}
			}
		}
	}

	public async resolveOutputReference(parts: string[], _node: Token): Promise<ResolvedReference | undefined> {
		const outputsBlock = this.findBlock(this.ast, 'outputs');
		if (!outputsBlock) return undefined;

		const outputName = parts[0];
		const outputAttr = outputsBlock.children.find((c: any) =>
			c.type === 'attribute' &&
			c.children.some((cc: any) => cc.type === 'identifier' && cc.value === outputName)
		);

		if (!outputAttr) return undefined;

		const valueToken = outputAttr.children.find((c: any) => c.type !== 'identifier');
		if (!valueToken) return undefined;

		const value = await this.evaluateValue(valueToken);
		if (!value) return undefined;

		const result = parts.length > 1 ? this.traverseValue(value, parts.slice(1)) : value;
		return {
			value: result,
			source: this.uri,
			found: true
		};
	}

	private async evaluateExpression(node: Token): Promise<RuntimeValue<ValueType> | undefined> {
		switch (node.type) {
			case 'ternary_expression': {
				const [condition, trueExpr, falseExpr] = node.children;
				const condValue = await this.evaluateValue(condition);
				if (!condValue) return undefined;

				const condBool = this.getPrimitiveValue(condValue);
				if (condBool === null) return undefined;

				return condBool ?
					await this.evaluateValue(trueExpr) :
					await this.evaluateValue(falseExpr);
			}
			case 'comparison_expression': {
				const [left, op, right] = node.children;
				const leftValue = await this.evaluateValue(left);
				const rightValue = await this.evaluateValue(right);
				if (!op.value || typeof op.value !== 'string') return undefined;

				return this.evaluateComparison(leftValue, rightValue, op.value);
			}
			default: {
				return undefined;
			}
		}
	}
	private async evaluateInterpolation(node: Token): Promise<RuntimeValue<'string'>> {
		const parts: string[] = [];

		for (const child of node.children) {
			const value = await this.evaluateValue(child);
			if (value) {
				parts.push(this.coerceToString(value));
			}
		}

		return {
			type: 'string',
			value: parts.join('')
		};
	}
	private evaluateComparison(
		left: RuntimeValue<ValueType> | undefined,
		right: RuntimeValue<ValueType> | undefined,
		operator: string
	): RuntimeValue<'boolean'> {
		if (!left || !right) {
			return { type: 'boolean', value: false };
		}

		const leftValue = this.getPrimitiveValue(left);
		const rightValue = this.getPrimitiveValue(right);

		if (leftValue === null || rightValue === null) {
			return { type: 'boolean', value: false };
		}

		let result = false;
		switch (operator) {
			case '==': {
				result = leftValue === rightValue; break;
			}
			case '!=': {
				result = leftValue !== rightValue; break;
			}
			case '<': {
				result = leftValue < rightValue; break;
			}
			case '<=': {
				result = leftValue <= rightValue; break;
			}
			case '>': {
				result = leftValue > rightValue; break;
			}
			case '>=': {
				result = leftValue >= rightValue; break;
			}
		}

		return { type: 'boolean', value: result };
	}

	private evaluateFunction(funcName: string, args: RuntimeValue<ValueType>[]): RuntimeValue<ValueType> | undefined {
		switch (funcName) {
			case 'find_in_parent_folders': {
				const result = this.workspace.findInParentFolders(this.uri, args);
				return result ?? { type: 'null', value: null } as RuntimeValue<'null'>;
			}
			case 'get_env': {
				if (!args[0] || args[0].type !== 'string') {
					return { type: 'string', value: '' } as RuntimeValue<'string'>;
				}
				return {
					type: 'string',
					value: process.env[args[0].value as string] ?? ''
				} as RuntimeValue<'string'>;
			}
			case 'get_terraform_commands_that_need_vars': {
				return {
					type: 'array',
					value: ['plan', 'apply', 'destroy', 'import', 'push', 'refresh'].map(cmd => ({
						type: 'string',
						value: cmd
					} as RuntimeValue<'string'>))
				} as RuntimeValue<'array'>;
			}
			default: {
				return undefined;
			}
		}
	}

	public async resolveReference(node: Token): Promise<ResolvedReference | undefined> {
		const parts = this.buildReferencePath(node);
		if (parts.length === 0) return undefined;

		switch (parts[0]) {
			case 'local': {
				return this.resolveLocalReference(parts.slice(1));
			}
			case 'dependency': {
				return this.resolveDependencyReference(parts.slice(1), node);
			}
			case 'get_parent_terragrunt_dir': {
				return {
					value: {
						type: 'string',
						value: path.dirname(this.uri)
					} as RuntimeValue<'string'>,
					source: this.uri,
					found: true
				};
			}
		}
		return undefined;
	}

	private resolveLocalReference(parts: string[]): ResolvedReference | undefined {
		if (parts.length === 0) return undefined;

		const value = this.locals.get(parts[0]);
		if (!value) return undefined;

		return {
			value: this.traverseValue(value, parts.slice(1)),
			source: this.uri,
			found: true
		};
	}

	private async resolveDependencyReference(parts: string[], node: Token): Promise<ResolvedReference | undefined> {
		if (parts.length < 2) return undefined;

		const depUri = this.dependencies.get(parts[0]);
		if (!depUri) return undefined;

		const depDoc = await this.workspace.getDocument(depUri);
		if (!depDoc) return undefined;

		if (parts[1] === 'outputs') {
			const outputRef = parts.slice(2);
			return depDoc.resolveOutputReference(outputRef, node);
		}

		return undefined;
	}

	private findAllBlocks(ast: any, types: string[]): any[] {
		const blocks: any[] = [];
		if (ast.type === 'block' && types.includes(ast.value)) {
			blocks.push(ast);
		}
		if (ast.children) {
			for (const child of ast.children) {
				blocks.push(...this.findAllBlocks(child, types));
			}
		}
		return blocks;
	}

	private findAttributeValue(block: any, name: string): any {
		const attr = block.children.find((c: any) =>
			c.type === 'attribute' &&
			c.children.some((cc: any) => cc.type === 'identifier' && cc.value === name)
		);
		if (!attr) return undefined;
		const valueNode = attr.children.find((c: any) => c.type !== 'identifier');
		return valueNode?.value;
	}

	private resolveDependencyPath(configPath: string): string {
		if (path.isAbsolute(configPath)) {
			return configPath;
		}
		const sourceDir = path.dirname(URI.parse(this.uri).fsPath);
		return path.resolve(sourceDir, configPath);
	}

	private buildReferencePath(node: Token): string[] {
		const parts: string[] = [];
		let current: Token | null = node;
		while (current) {
			if (current.type === 'identifier') {
				parts.unshift(current.getDisplayText());
			}
			current = current.parent;
		}
		return parts;
	}

	private processDependencyBlocks(ast: any) {
		const dependencyBlocks = this.findAllBlocks(ast, ['dependency', 'dependencies']);

		for (const block of dependencyBlocks) {
			if (block.value === 'dependency') {
				const name = block.children.find((c: any) => c.type === 'parameter')?.value;
				const configPath = this.findAttributeValue(block, 'config_path');
				if (name && configPath) {
					const uri = this.resolveDependencyPath(configPath as string);
					this.dependencies.set(name, uri);
				}
			} else if (block.value === 'dependencies') {
				const pathsAttr = block.children.find((c: any) =>
					c.type === 'attribute' &&
					c.children.some((cc: any) => cc.type === 'identifier' && cc.value === 'paths')
				);
				if (pathsAttr) {
					const arrayLit = pathsAttr.children.find((c: any) => c.type === 'array_lit');
					if (arrayLit) {
						for (const pathElement of arrayLit.children) {
							if (pathElement.type === 'string_lit') {
								const uri = this.resolveDependencyPath(pathElement.value);
								this.dependencies.set(pathElement.value, uri);
							}
						}
					}
				}
			}
		}
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

	addDiagnostic(diagnostic: Diagnostic) {
		this.diagnostics.push(diagnostic);
	}

	parseNode(node: any, parent: Token | null = null): Token {
		const token = new Token(node.id, node.type as TokenType, node.value ?? null, node.location);
		token.parent = parent;

		if (node.children) {
			token.children = node.children.map((child: any) => this.parseNode(child, token));
		}

		return token;
	}

	private parseContent() {
		try {
			// console.log('Parsing:', this.uri);
			this.ast = tg_parse(this.content, { grammarSource: this.uri });
			// console.log('AST:', this.removeCircularReferences(this.ast));
			this.tokens = [this.parseNode(this.ast)];

			this.diagnostics = this.diagnosticsProvider.getDiagnostics(this);
		} catch (error) {
			if (error instanceof SyntaxError && error.location) {
				// Log the basic error location
				console.error(`Syntax Error at line ${error.location.start.line}, column ${error.location.start.column}:`);

				// Log the full error location object for debugging
				console.log('Location details:', {
					start: error.location.start,
					end: error.location.end
				});

				// Log the expected rules/tokens
				console.log('Expected rules/tokens:', error.expected);

				// Log what was actually found
				console.log('Found:', error.found || 'end of input');

				// Log the rule stack if available
				if ('rules' in error) {
					console.log('Rule stack:', error.rules);
				}

				// Get the failing rule name - this is often in the error message or rule stack
				const failingRule = error.message.match(/Expected [^,]+ but /)?.[0]  // Extract from message
					|| (error as any).rule  // Some PEG implementations store it directly
					|| error.format([{ source: this.uri, text: this.content }]).split('\n')[0]; // First line often contains rule

				console.log('Failed at rule:', failingRule);


				// Log what was actually found
				console.log('\nFound:', error.found || 'end of input');



				// Get the specific line of code where the error occurred
				const lines = this.content.split('\n');
				const errorLine = lines[error.location.start.line - 1];
				console.log('\nProblematic line:', errorLine);

				// Create a pointer to the exact error position
				const pointer = `${' '.repeat("Problematic line:".length + error.location.start.column)}^`;
				console.log(pointer);

				// Log the formatted error message
				console.log('\nFormatted error:');
				console.log(error.format([{ source: this.uri, text: this.content }]));

				// Log the full error object for debugging
				console.log('\nFull error object:', error);
			} else {
				console.error("Unknown Parsing Error:", error);
				if (error instanceof Error) {
					console.log('Stack trace:', error.stack);
				}
			}

			if (error instanceof SyntaxError && error.location) {
				// Convert the parser's location format to VSCode's format
				this.diagnostics.push({
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

	public getCompletionsAtPosition(position: Position): Promise<CompletionItem[]> {
		const lineText = this.getLineAtPosition(position);
		const token = this.findTokenAtPosition(position);
		return this.completionsProvider.getCompletions(lineText, position, token, this);
	}

	public async getHoverInfo(position: Position): Promise<MarkupContent | null> {
		const token = this.findTokenAtPosition(position);
		if (!token) return null;
		return this.hoverProvider.getHoverInfo(token, this);
	}

	public findBlock(ast: any, type: string): any {
		if (ast.type === 'block' && ast.value === type) return ast;
		if (!ast.children) return null;
		for (const child of ast.children) {
			const found = this.findBlock(child, type);
			if (found) return found;
		}
		return null;
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

	getWorkspace(): Workspace {
		return this.workspace;
	}
}