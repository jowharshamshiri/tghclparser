import path from 'node:path';

import type { CompletionItem, Diagnostic, MarkupContent, Position } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { CompletionsProvider } from './CompletionsProvider';
import { DiagnosticsProvider } from './DiagnosticsProvider';
import { HoverProvider } from './HoverProvider';
import type { FunctionContext, ResolvedReference, RuntimeValue, TokenType, ValueType } from './model';
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
	private createToken(node: any): Token {
		const token = new Token(
			node.id,
			node.type as TokenType,
			node.value,
			node.location
		);
	
		if (node.children && Array.isArray(node.children)) {
			token.children = node.children
				.map(child => this.createToken(child))
				.filter((t): t is Token => t !== null);
	
			// For function calls, use the function identifier's value
			if (node.type === 'function_call') {
				const funcId = token.children.find(c => c.type === 'function_identifier');
				if (funcId) {
					token.value = funcId.value;
				}
			}
		}
	
		return token;
	}
	
	public findIncludeBlocks(ast: any): { path: Token, block: Token }[] {
		const includes: { path: Token, block: Token }[] = [];
	
		const processNode = (node: any) => {
			if (node.type === 'block' && node.value === 'include') {
				// console.log('Found include block:', {
				// 	node: {
				// 		type: node.type,
				// 		value: node.value,
				// 		children: node.children?.map(c => ({
				// 			type: c.type,
				// 			value: c.value
				// 		}))
				// 	}
				// });
				const pathAttr = node.children?.find(child =>
					child.type === 'attribute' &&
					child.children?.some(c => c.type === 'attribute_identifier' && c.value === 'path')
				);
	
				if (pathAttr) {
					const pathValueNode = pathAttr.children?.find(c =>
						c.type === 'function_call' ||
						c.type === 'string_lit' ||
						c.type === 'interpolated_string'
					);
	
					if (pathValueNode) {
						includes.push({
							path: this.createToken(pathValueNode),
							block: this.createToken(node)
						});
					}
				}
			}
	
			if (node.children) {
				node.children.forEach(processNode);
			}
		};
	
		processNode(ast);
		return includes;
	}
	
	public findDependencyBlocks(ast: any): { path: Token, block: Token, parameter?: string }[] {
		const dependencies: { path: Token, block: Token, parameter?: string }[] = [];
	
		const processNode = (node: any) => {
			if (node.type === 'block') {
				if (node.value === 'dependency') {
					const paramNode = node.children.find((c: any) => c.type === 'parameter');
					const parameter = paramNode?.value as string | undefined;
	
					const configPathAttr = node.children.find((child: any) =>
						child.type === 'attribute' &&
						child.children?.some((c: any) => c.type === 'attribute_identifier' && c.value === 'config_path')
					);
	
					if (configPathAttr) {
						const pathNode = configPathAttr.children.find((c: any) =>
							c.type === 'string_lit' ||
							c.type === 'interpolated_string' ||
							c.type === 'function_call'
						);
	
						if (pathNode) {
							dependencies.push({
								path: this.createToken(pathNode),
								block: this.createToken(node),
								parameter
							});
						}
					}
				} else if (node.value === 'dependencies') {
					const pathsAttr = node.children.find((child: any) =>
						child.type === 'attribute' &&
						child.children?.some((c: any) => c.type === 'attribute_identifier' && c.value === 'paths')
					);
	
					if (pathsAttr) {
						const arrayLit = pathsAttr.children.find((c: any) => c.type === 'array_lit');
						if (arrayLit) {
							arrayLit.children.forEach((pathElement: any) => {
								if (pathElement.type === 'string_lit' || pathElement.type === 'interpolated_string' || pathElement.type === 'function_call') {
									dependencies.push({
										path: this.createToken(pathElement),
										block: this.createToken(node),
										parameter: undefined
									});
								}
							});
						}
					}
				}
			}
	
			if (node.children) {
				node.children.forEach(processNode);
			}
		};
	
		processNode(ast);
		return dependencies;
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
	// Helper to find the specific function we want to evaluate
	private findTargetFunctionNode(startNode: Token, targetName: string): Token | null {
		if (startNode.type === 'function_call' && startNode.value === targetName) {
			return startNode;
		}
		if (startNode.type === 'function_identifier' && startNode.value === targetName) {
			return startNode.parent;
		}

		for (const child of startNode.children) {
			const found = this.findTargetFunctionNode(child, targetName);
			if (found) return found;
		}

		return null;
	}

	// Main evaluation entry point for a specific function
	public async evaluateTargetFunction(token: Token, targetName: string): Promise<RuntimeValue<ValueType> | undefined> {
		// Find the function node we want to evaluate
		const functionNode = this.findTargetFunctionNode(token, targetName);
		if (!functionNode) return undefined;

		// Evaluate JUST this function node, without traversing to parent functions
		return this.evaluateValue(functionNode, targetName);
	}

	public async evaluateValue(node: Token, targetName?: string): Promise<RuntimeValue<ValueType> | undefined> {
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
        

		// If we have a target name and this is a function_call that's NOT our target,
		// skip evaluation (this prevents evaluating parent functions)
		if (targetName &&
			node.type === 'function_call' &&
			node.value !== targetName) {
			return undefined;
		}

		switch (node.type) {
			case 'function_call': {
				const funcName = node.children.find(c => c.type === 'function_identifier')?.value;
				if (!funcName || typeof funcName !== 'string') return undefined;

				// Always fully evaluate arguments
				const evaluatedArgs = await Promise.all(
					node.children
						.filter(c => c.type !== 'function_identifier')
						.map(arg => this.evaluateValue(arg, targetName))
				);

				const args = evaluatedArgs.filter((arg): arg is RuntimeValue<ValueType> => arg !== undefined);

				const context: FunctionContext = {
					workingDirectory: path.dirname(URI.parse(this.uri).fsPath),
					environmentVariables: Object.fromEntries(
						Object.entries(process.env).filter(([_, v]) => v !== undefined)
					) as Record<string, string>,
					document: {
						uri: this.uri,
						content: this.content
					}
				};

				return await this.schema.getFunctionRegistry().evaluateFunction(funcName, args, context);
			}
			case 'interpolated_string': {
				// Handle interpolated strings by evaluating each child and concatenating
				const parts: string[] = [];
				for (const child of node.children) {
					const evaluated = await this.evaluateValue(child);
					if (evaluated) {
						parts.push(this.coerceToString(evaluated));
					}
				}
				return {
					type: 'string',
					value: parts.join('')
				};
			}

			case 'legacy_interpolation': {
				// Legacy interpolation usually wraps a single expression
				if (node.children.length > 0) {
					const evaluated = await this.evaluateValue(node.children[0]);
					if (evaluated) {
						return {
							type: 'string',
							value: this.coerceToString(evaluated)
						};
					}
				}
				return {
					type: 'string',
					value: ''
				};
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
			default: {
				// Check if it's a function in the registry
				const registry = this.schema.getFunctionRegistry();
				if (registry.hasFunction(parts[0])) {
					const context: FunctionContext = {
						workingDirectory: path.dirname(URI.parse(this.uri).fsPath),
						environmentVariables: process.env as Record<string, string>,
						document: {
							uri: this.uri,
							content: this.content
						}
					};
	
					try {
						// Create function arguments from remaining parts if any
						const args = parts.slice(1).map(part => ({
							type: 'string' as const,
							value: part
						}));
	
						const result = await registry.evaluateFunction(parts[0], args, context);
						if (result) {
							return {
								value: result,
								source: this.uri,
								found: true
							};
						}
					} catch (error) {
						console.warn(`Error evaluating function ${parts[0]}:`, error);
					}
				}
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