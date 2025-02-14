import type { CompletionItem, Position } from 'vscode-languageserver';
import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver';

import type { AttributeDefinition, BlockDefinition, FunctionDefinition, RuntimeValue, ValueType } from './model';
import { Token } from './model';
import type { ParsedDocument } from './ParsedDocument';
import type { Schema } from './Schema';

type CompletionContext =
	| { type: 'root_level'; currentWord: string }
	| { type: 'block_type'; currentWord: string }
	| {
		type: 'block_parameter';
		blockType: string;
		currentWord: string
	}
	| {
		type: 'block_body';
		blockType: string;
		currentWord: string;
	}
	| {
		type: 'attribute_name';
		blockType: string;
		currentWord: string;
		partial: boolean;
	}
	| {
		type: 'attribute_value';
		blockType: string;
		attributeName: string;
		currentWord: string;
		partial: boolean;
	}
	| {
		type: 'nested_block_type';
		parentBlockType: string;
		currentWord: string;
		partial: boolean;
	}
	| {
		type: 'pattern_based';
		patternType: string;
		blockType: string;
		attributeName: string;
		currentWord: string;
		partial: boolean;
	};

export class CompletionsProvider {
	constructor(private schema: Schema) { }
	private findBlock(ast: any, type: string): any {
		if (ast.type === 'block' && ast.value === type) return ast;
		if (!ast.children) return null;
		for (const child of ast.children) {
			const found = this.findBlock(child, type);
			if (found) return found;
		}
		return null;
	}

	private async getLocalCompletions(parsedDoc: ParsedDocument, currentWord: string): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const ast = parsedDoc.getAST();
		if (!ast) return completions;

		// Find locals block
		const localsBlock = this.findBlock(ast, 'locals');
		if (!localsBlock) return completions;

		// Process each attribute in locals block
		for (const attr of localsBlock.children) {
			if (attr.type === 'attribute') {
				const name = attr.children.find(c => c.type === 'identifier')?.value;
				const valueToken = attr.children.find(c => c.type !== 'identifier');
				if (typeof name === 'string' && valueToken && valueToken instanceof Token) {
					// Create a more basic completion without evaluated value for now
					completions.push({
						label: name,
						kind: CompletionItemKind.Variable,
						detail: `local.${name}`,
						documentation: {
							kind: 'markdown',
							value: `Local variable defined in ${parsedDoc.getUri()}`
						}
					});
				}
			}
		}

		return completions;
	}
	private async getDependencyCompletions(parsedDoc: ParsedDocument, currentWord: string): Promise<CompletionItem[]> {
		const completions: CompletionItem[] = [];
		const dependencies = await parsedDoc.getWorkspace().getDependencies(parsedDoc.getUri());

		for (const dep of dependencies) {
			// Skip includes, we only want explicit dependencies
			if (dep.dependencyType !== 'dependency') continue;

			// Extract dependency name from parameterValue
			const depName = dep.parameterValue;
			if (!depName) continue;

			// Get the target document
			const depDoc = await parsedDoc.getWorkspace().getDocument(dep.uri);
			if (!depDoc) continue;

			// Find outputs block
			const ast = depDoc.getAST();
			if (!ast) continue;

			const outputsBlock = this.findBlock(ast, 'outputs');
			if (!outputsBlock) continue;

			// Add completions for each output
			for (const attr of outputsBlock.children) {
				if (attr.type === 'attribute') {
					const outputName = attr.children.find(c => c.type === 'identifier')?.value;
					if (typeof outputName === 'string') {
						completions.push({
							label: `${depName}.outputs.${outputName}`,
							kind: CompletionItemKind.Property,
							detail: `Output from ${depName}`,
							documentation: {
								kind: 'markdown',
								value: `Output variable from dependency "${depName}"
	
	Source: ${dep.targetPath}
	Type: dependency`
							}
						});
					}
				}
			}
		}

		return completions;
	}
	private getDependencyName(block: Token): string | undefined {
		// For dependency blocks, name is in the parameter
		if (block.value === 'dependency') {
			const param = block.children.find(c => c.type === 'parameter');
			return param?.value?.toString();
		}
		// For dependencies block, name might be in the paths array
		else if (block.value === 'dependencies') {
			const pathsAttr = block.children.find(c =>
				c.type === 'attribute' &&
				c.children.some(cc => cc.type === 'identifier' && cc.value === 'paths')
			);
			if (pathsAttr) {
				const arrayLit = pathsAttr.children.find(c => c.type === 'array_lit');
				if (arrayLit && arrayLit.children[0]) {
					return arrayLit.children[0].value?.toString();
				}
			}
		}
		return undefined;
	}

	private formatRuntimeValue(value: RuntimeValue<ValueType>): string {
		switch (value.type) {
			case 'string': {
				return `"${value.value}"`;
			}
			case 'number':
			case 'boolean': {
				return String(value.value);
			}
			case 'array': {
				if (Array.isArray(value.value)) {
					return `[${value.value.map(v => this.formatRuntimeValue(v)).join(', ')}]`;
				}
				return '[]';
			}
			case 'object':
			case 'block': {
				if (value.value instanceof Map) {
					const entries: string[] = [];
					value.value.forEach((v, k) => {
						entries.push(`${k} = ${this.formatRuntimeValue(v)}`);
					});
					return `{${entries.join(', ')}}`;
				}
				return '{}';
			}
			default: {
				return value.type;
			}
		}
	}
	private determineCompletionContext(token: Token | null, line: string, position: Position): CompletionContext {
		const lineUptoCursor = line.slice(0, position.character);
		const currentWord = this.getCurrentWord(lineUptoCursor);

		// Check if we're in the middle of typing a function name
		if (token?.type === 'function_identifier' ||
			token?.parent?.type === 'function_identifier' ||
			(this.isAfterEquals(lineUptoCursor) && !lineUptoCursor.trim().endsWith('""'))) {

			// Find the containing block
			const blockContext = this.findBlockContext(token);
			if (blockContext) {
				return {
					type: 'attribute_value',
					blockType: blockContext.currentBlock.getDisplayText(),
					attributeName: this.findCurrentAttributeName(token) || '',
					currentWord,
					partial: true
				};
			}
		}

		// Special handling for inputs block
		if (token?.type === 'root_assignment_identifier' && token.value === 'inputs') {
			return {
				type: 'block_body',
				blockType: 'inputs',
				currentWord
			};
		}

		// Check if we're inside any block body (including inputs)
		const blockContext = this.findBlockContext(token);
		if (blockContext) {
			const { currentBlock, isInBody } = blockContext;
			const blockType = currentBlock.getDisplayText();

			// Inside block parameters (between block name and body)
			if (!isInBody) {
				return {
					type: 'block_parameter',
					blockType,
					currentWord
				};
			}

			// After equals sign - suggesting values/functions
			if (this.isAfterEquals(lineUptoCursor)) {
				const attributeName = this.findCurrentAttributeName(token);
				const blockDef = this.schema.getBlockDefinition(blockType);
				const attribute = blockDef?.attributes?.find(attr => attr.name === attributeName);

				// Always suggest functions for attribute values unless we know they're not allowed
				const modifiedContext = this.handlePatternBasedCompletions({
					type: 'attribute_value',
					blockType,
					attributeName,
					currentWord,
					partial: currentWord.length > 0
				}, attribute);

				return modifiedContext;
			}

			// At start of line or typing an attribute name
			if (this.isStartOfLine(line, position.character) || this.isInAttributeNameContext(token)) {
				return {
					type: 'block_body',
					blockType,
					currentWord
				};
			}

			// In the middle of typing something else inside a block
			if (this.isInsideBlockBody(token?.getDisplayText() || '', position)) {
				return {
					type: 'attribute_name',
					blockType,
					currentWord,
					partial: currentWord.length > 0
				};
			}
		}

		// If not in any block context, we're at root level
		return { type: 'root_level', currentWord };
	}

	private async getAllLocals(doc: ParsedDocument): Promise<Map<string, RuntimeValue<ValueType>>> {
		const locals = new Map<string, RuntimeValue<ValueType>>();
		const ast = doc.getAST();
		if (!ast) return locals;

		// Find locals block
		const localsBlock = this.findBlock(ast, 'locals');
		if (!localsBlock) return locals;

		// Process each attribute in locals block
		for (const attr of localsBlock.children) {
			if (attr.type === 'attribute') {
				const name = attr.children.find(c => c.type === 'identifier')?.value;
				const valueToken = attr.children.find(c => c.type !== 'identifier');
				if (name && valueToken) {
					const value = await doc.evaluateValue(valueToken);
					if (value) {
						locals.set(name.toString(), value);
					}
				}
			}
		}

		return locals;
	}

	private async getOutputs(doc: ParsedDocument): Promise<Map<string, RuntimeValue<ValueType>>> {
		const outputs = new Map<string, RuntimeValue<ValueType>>();
		const ast = doc.getAST();
		if (!ast) return outputs;

		const outputsBlock = this.findBlock(ast, 'outputs');
		if (!outputsBlock) return outputs;

		for (const attr of outputsBlock.children) {
			if (attr.type === 'attribute') {
				const name = attr.children.find(c => c.type === 'identifier')?.value;
				const valueToken = attr.children.find(c => c.type !== 'identifier');
				if (name && valueToken) {
					const value = await doc.evaluateValue(valueToken);
					if (value) {
						outputs.set(name.toString(), value);
					}
				}
			}
		}

		return outputs;
	}

	private getValueCompletions(
		blockType: string,
		attributeName: string,
		currentWord: string,
		token: Token | null
	): CompletionItem[] {
		const blockDef = this.schema.getBlockDefinition(blockType);
		if (!blockDef?.attributes) return [];

		const attribute = blockDef.attributes.find(attr => attr.name === attributeName);

		// Initialize completions array
		const completions: CompletionItem[] = [];

		// Always include function completions unless we explicitly know they're not allowed
		if (!attribute || attribute.types.includes('function') || attribute.types.length === 0) {
			completions.push(...this.getFunctionCompletions());
		}

		// Add allowed values if specified
		if (attribute?.validation?.allowedValues) {
			completions.push(...attribute.validation.allowedValues.map(value => ({
				label: String(value),
				kind: CompletionItemKind.Value,
				insertText: String(value),
				insertTextFormat: InsertTextFormat.PlainText,
				filterText: currentWord
			})));
		}

		return completions;
	}

	private isAfterEquals(lineUptoCursor: string): boolean {
		// Remove string literals to avoid false positives
		const withoutStrings = lineUptoCursor.replaceAll(/"[^"]*"/g, '""');
		const trimmed = withoutStrings.trim();
		// Show completions after equals sign or when in a function name
		return trimmed.endsWith('=') ||
			trimmed.endsWith('(') ||
			/[a-z_]\w*\($/i.test(trimmed) ||
			/[a-z_]\w*$/i.test(trimmed);
	}

	async getCompletions(line: string, position: Position, token: Token | null, parsedDoc: ParsedDocument): Promise<CompletionItem[]> {
		const context = this.determineCompletionContext(token, line, position);
		let completions: CompletionItem[] = [];

		// If we're after a local. reference
		if (context.currentWord.startsWith('local.')) {
			completions = await this.getLocalCompletions(parsedDoc, context.currentWord.slice(6));
		}
		// If we're in a dependency reference
		else if (token?.type === 'reference' && token.parent && token.parent.value === 'dependency') {
			completions = await this.getDependencyCompletions(parsedDoc, context.currentWord);
		}
		else {
			switch (context.type) {
				case 'root_level': {
					completions = this.getTopLevelBlockCompletions();
					break;
				}
				case 'block_type': {
					completions = this.getTopLevelBlockCompletions();
					break;
				}
				case 'block_parameter': {
					completions = this.getBlockParameterCompletions(context.blockType);
					break;
				}
				case 'block_body': {
					const blockDef = this.schema.getBlockDefinition(context.blockType);
					if (blockDef) {
						completions = [
							...this.getAttributeCompletions(context.blockType, token),
							...this.getNestedBlockCompletions(context.blockType)
						];
					}
					break;
				}
				case 'attribute_value': {
					completions = this.getValueCompletions(
						context.blockType,
						context.attributeName,
						context.currentWord,
						token
					);
					break;
				}
				case 'nested_block_type': {
					completions = this.getNestedBlockCompletions(context.parentBlockType);
					break;
				}
			}
		}
		if (context.currentWord) {
			const partial = 'partial' in context ? context.partial : false;
			completions = this.filterCompletionsByWord(completions, context.currentWord, partial);
		}

		return completions;
	}

	private getAttributeCompletions(blockType: string, token: Token | null): CompletionItem[] {
		const template = this.schema.getBlockDefinition(blockType);
		if (!template?.attributes) return [];
		if (template.arbitraryAttributes) return [];

		// Find the parent block token
		const blockToken = this.findParentBlock(token);
		if (!blockToken) return [];

		// Collect existing attributes in the block
		const existingAttributes = new Set<string>();
		blockToken.children
			.filter(child => child.type === 'attribute')
			.forEach(attr => {
				const identifier = attr.children.find(c => c.type === 'attribute_identifier');
				if (identifier) {
					existingAttributes.add(identifier.getDisplayText());
				}
			});

		// Filter out attributes that already exist in the block
		return template.attributes
			.filter(attr => !existingAttributes.has(attr.name))
			.map(attr => ({
				label: attr.name,
				kind: CompletionItemKind.Field,
				detail: attr.description,
				documentation: this.getAttributeDocumentation(attr),
				insertText: this.schema.generateAttributeSnippet(attr),
				insertTextFormat: InsertTextFormat.Snippet
			}));
	}

	private handlePatternBasedCompletions(
		context: Extract<CompletionContext, { type: 'attribute_value' }>,
		attribute?: AttributeDefinition
	): CompletionContext {
		if (!attribute?.validation?.pattern) return context;

		if (attribute.validation.pattern.includes("git::")) {
			return {
				type: 'pattern_based',
				patternType: 'git_url',
				blockType: context.blockType,
				attributeName: context.attributeName,
				currentWord: context.currentWord,
				partial: context.partial
			};
		}
		return context;
	}

	private filterCompletionsByWord(
		completions: CompletionItem[],
		word: string,
		partial = false
	): CompletionItem[] {
		if (!word) return completions;

		return completions.filter(completion => {
			const filterText = (completion.filterText || completion.label).toLowerCase();
			const searchWord = word.toLowerCase();
			return partial ?
				filterText.includes(searchWord) :
				filterText.startsWith(searchWord);
		});
	}

	// Add this helper method for determining if a context has partial property
	private hasPartial(context: CompletionContext): context is Extract<CompletionContext, { partial: boolean }> {
		return 'partial' in context;
	}

	private getFunctionCompletions(): CompletionItem[] {
		return this.schema.getAllFunctions().map(func => ({
			label: func.name,
			kind: CompletionItemKind.Function,
			detail: func.description,
			documentation: this.getFunctionDocumentation(func),
			insertText: this.schema.generateFunctionSnippet(func),
			insertTextFormat: InsertTextFormat.Snippet
		}));
	}

	private getFunctionDocumentation(func: FunctionDefinition): string {
		const parts: string[] = [];

		if (func.description) {
			parts.push(func.description);
		}

		parts.push('\nParameters:');
		func.parameters.forEach(param => {
			const required = param.required ? '(required)' : '(optional)';
			parts.push(`- ${param.name} ${required}: ${param.description || ''}`);
			if (param.types.length > 0) {
				parts.push(`  Types: ${param.types.join(' | ')}`);
			}
		});

		parts.push(`\nReturn Type: ${func.returnType.types.join(' | ')}`);
		if (func.returnType.description) {
			parts.push(func.returnType.description);
		}

		if (func.examples && func.examples.length > 0) {
			parts.push('\nExamples:');
			func.examples.forEach(example => parts.push(example));
		}

		return parts.join('\n');
	}

	private getAttributeDocumentation(attr: AttributeDefinition): string {
		const parts: string[] = [];

		if (attr.description) {
			parts.push(attr.description);
		}

		parts.push(`\nTypes: ${attr.types.join(' | ')}`);

		if (attr.validation) {
			parts.push('\nValidation:');
			if (attr.validation.pattern) {
				parts.push(`- Pattern: ${attr.validation.pattern}`);
			}
			if (attr.validation.min !== undefined) {
				parts.push(`- Minimum: ${attr.validation.min}`);
			}
			if (attr.validation.max !== undefined) {
				parts.push(`- Maximum: ${attr.validation.max}`);
			}
			if (attr.validation.allowedValues) {
				parts.push(`- Allowed values: ${attr.validation.allowedValues.join(', ')}`);
			}
		}

		if (attr.deprecated) {
			parts.push('\nDEPRECATED');
			if (attr.deprecationMessage) {
				parts.push(attr.deprecationMessage);
			}
		}

		return parts.join('\n');
	}



	private isInNestedBlockContext(token: Token | null, line: string, position: Position): boolean {
		if (!token) return false;

		const lineUptoCursor = line.slice(0, position.character);
		if (!this.isInsideBlockBody(line, position)) return false;
		if (this.isAfterEquals(lineUptoCursor)) return false;

		if (this.isStartOfLine(line, position.character)) return true;
		if (token.type === 'block') return true;

		// Replace direct parent access with null check
		if (!token.parent) return false;
		return token.parent.type === 'block';
	}

	private getBlockParameterCompletions(blockType: string): CompletionItem[] {
		const blockDef = this.schema.getBlockDefinition(blockType);
		if (!blockDef?.parameters) return [];

		return blockDef.parameters.map(param => ({
			label: param.name,
			kind: CompletionItemKind.Property,
			detail: param.description,
			documentation: `Type: ${param.types.join(' | ')}`,
			insertText: param.name,
			insertTextFormat: 2
		}));
	}


	private getBlockCompletions(parentBlockType?: string): CompletionItem[] {
		if (!parentBlockType) {
			return this.getTopLevelBlockCompletions();
		}

		const parentTemplate = this.schema.getBlockDefinition(parentBlockType);
		if (!parentTemplate?.blocks) {
			return [];
		}

		return parentTemplate.blocks
			.map(blockDef => {
				const template = this.schema.getBlockDefinition(blockDef.type);
				if (!template) return;

				return {
					label: template.type,
					kind: CompletionItemKind.Class,
					detail: this.getBlockDetail(template, blockDef),
					documentation: this.getBlockDocumentation(template, blockDef),
					insertText: this.schema.generateBlockSnippet(template),
					insertTextFormat: 2, // Snippet
					preselect: false, // Since required doesn't exist in BlockDefinition
					sortText: this.getBlockSortText(blockDef)
				} as CompletionItem;
			})
			.filter((item): item is CompletionItem => item !== undefined);
	}

	private getBlockDetail(template: BlockDefinition, blockDef: BlockDefinition): string {
		const parts: string[] = [];

		if (blockDef.min !== undefined || blockDef.max !== undefined) {
			const constraints: string[] = [];
			if (blockDef.min !== undefined) {
				constraints.push(`min: ${blockDef.min}`);
			}
			if (blockDef.max !== undefined) {
				constraints.push(`max: ${blockDef.max}`);
			}
			parts.push(`Constraints: ${constraints.join(', ')}`);
		}

		if (template.description) {
			parts.push(template.description);
		}

		return parts.join(' | ');
	}

	private getBlockDocumentation(template: BlockDefinition, blockDef: BlockDefinition): string {
		const parts: string[] = [];

		if (template.description) {
			parts.push(template.description);
		}

		if (blockDef.min !== undefined || blockDef.max !== undefined) {
			parts.push('\nConstraints:');
			if (blockDef.min !== undefined) {
				parts.push(`- Minimum occurrences: ${blockDef.min}`);
			}
			if (blockDef.max !== undefined) {
				parts.push(`- Maximum occurrences: ${blockDef.max}`);
			}
		}

		const requiredAttrs = template.attributes?.filter(attr => attr.required);
		if (requiredAttrs && requiredAttrs.length > 0) {
			parts.push('\nRequired attributes:');
			requiredAttrs.forEach(attr => {
				parts.push(`- ${attr.name}: ${attr.description || ''}`);
			});
		}

		return parts.join('\n');
	}

	private getBlockSortText(blockDef: BlockDefinition): string {
		// Since required doesn't exist, we'll sort by type only
		return blockDef.type;
	}

	private findParentBlock(token: Token | null): Token | null {
		if (!token) return null;

		let current: Token | null = token;
		while (current) {
			if (current.type === 'block') {
				return current;
			}
			current = current.parent;
		}
		return null;
	}

	private isStartOfLine(line: string, character: number): boolean {
		return line.slice(0, character).trim().length === 0;
	}

	private getCurrentWord(lineUptoCursor: string): string {
		const words = lineUptoCursor.trim().split(/\s+/);
		const lastWord = words.at(-1);
		return lastWord ?? '';  // Use nullish coalescing
	}

	private isInsideBlockBody(line: string, position: Position): boolean {
		const lineUptoCursor = line.slice(0, position.character);
		const chars = new Set(lineUptoCursor);
		return chars.has('{') && !chars.has('}');
	}

	private findBlockContext(token: Token | null): { currentBlock: Token; isInBody: boolean } | null {
		if (!token) return null;

		let current: Token | null = token;
		while (current) {
			if (current.type === 'block') {
				// Check if we're in the block's body by looking at the token's position
				// relative to the block's opening brace
				const isInBody = this.isTokenAfterBlockOpening(token, current);
				return { currentBlock: current, isInBody };
			}
			current = current.parent;
		}
		return null;
	}
	private isTokenAfterBlockOpening(token: Token, block: Token): boolean {
		// Use line/column comparison instead of offset
		return (
			token.location.start.line > block.location.start.line ||
			(
				token.location.start.line === block.location.start.line &&
				token.location.start.column > block.location.start.column
			)
		);
	}

	private isInAttributeNameContext(token: Token | null): boolean {
		if (!token) return false;

		// Check if we're in an attribute or identifier context
		return token.type === 'attribute' ||
			token.type === 'attribute_identifier' ||
			(token.parent && (
				token.parent.type === 'attribute' ||
				token.parent.type === 'attribute_identifier'
			)) || false;
	}

	private generateFunctionParameters(func: FunctionDefinition): string {
		return func.parameters
			.map((p, i) => `\${${i + 1}:${p.name}}`)
			.join(', ');
	}

	private findCurrentAttributeName(token: Token | null): string {
		if (!token) return '';

		let current: Token | null = token;
		while (current) {
			if (current.type === 'attribute') {
				const identifier = current.children.find(c => c.type === 'identifier');
				return identifier?.getDisplayText() || '';
			}
			current = current.parent;
		}
		return '';
	}

	private getTopLevelBlockCompletions(): CompletionItem[] {
		// Only return blocks that are valid at the root level
		return this.schema.getAllBlockTemplates()
			.map(template => ({
				label: template.type,
				kind: CompletionItemKind.Class,
				detail: template.description,
				insertText: this.schema.generateBlockSnippet(template),
				insertTextFormat: 2 // Snippet
			}));
	}

	private getNestedBlockCompletions(parentBlockType: string): CompletionItem[] {
		const parentTemplate = this.schema.getBlockDefinition(parentBlockType);
		if (!parentTemplate?.blocks) return [];

		return parentTemplate.blocks
			.map(blockDef => {
				const template = this.schema.getBlockDefinition(blockDef.type);
				if (!template) return null;

				return {
					label: template.type,
					kind: CompletionItemKind.Class,
					detail: template.description,
					insertText: this.schema.generateBlockSnippet(template),
					insertTextFormat: 2
				} as CompletionItem;
			})
			.filter((item): item is CompletionItem => item !== null);
	}

	private isAttributeContext(token: Token | null): boolean {
		if (!token) return false;

		if (token.type === 'attribute' ||
			token.type === 'identifier' ||
			(token.parent && token.parent.type === 'attribute')) {
			return true;
		}

		let current = token;
		while (current.parent) {
			if (current.parent.type === 'block' &&
				!current.type.includes('block')) {
				return true;
			}
			current = current.parent;
		}

		return false;
	}

}
