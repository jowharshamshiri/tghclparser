import { Schema } from './Schema';
import { BlockDefinition, Token } from './model';
import { CompletionItem, CompletionItemKind, Position } from 'vscode-languageserver';
type CompletionContext =
	| { type: 'block'; parentBlock?: string }
	| { type: 'nested_block'; parentBlock: string }
	| { type: 'attribute'; parentBlock: string }
	| { type: 'value'; parentBlock: string; attributeName: string };

export class CompletionsProvider {
	constructor(private schema: Schema) { }

	getCompletions(line: string, position: Position, token: Token | null): CompletionItem[] {
		if (!token) {
			if (this.isStartOfLine(line, position.character)) {
				return this.getTopLevelBlockCompletions();
			}
			return [];
		}

		const context = this.determineCompletionContext(token, line, position);

		switch (context.type) {
			case 'block':
				return this.getBlockCompletions(context.parentBlock);
			case 'attribute':
				return this.getAttributeCompletions(context.parentBlock);
			case 'value':
				return this.getValueCompletions(context.parentBlock, context.attributeName);
			case 'nested_block':
				return this.getNestedBlockCompletions(context.parentBlock);
			default:
				return [];
		}
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
				if (!template) return undefined;

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

	private determineCompletionContext(token: Token, line: string, position: Position): CompletionContext {
		const parentBlock = this.findParentBlock(token);

		// Check if we're in a value position (after equals sign)
		if (this.isAfterEquals(line, position.character)) {
			const attributeName = this.findCurrentAttributeName(token);
			return {
				type: 'value',
				parentBlock: parentBlock?.getDisplayText() || '',
				attributeName
			};
		}

		// Check if we're inside a block body
		if (parentBlock) {
			// If we're at the start of a line inside a block, suggest nested blocks
			if (this.isStartOfLine(line, position.character)) {
				return {
					type: 'nested_block',
					parentBlock: parentBlock.getDisplayText()
				};
			}

			// If we're in an attribute context
			if (this.isAttributeContext(token)) {
				return {
					type: 'attribute',
					parentBlock: parentBlock.getDisplayText()
				};
			}
		}

		// Default to block context at root level
		return { type: 'block' };
	}

	private findCurrentAttributeName(token: Token): string {
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

	private getAttributeCompletions(blockType: string): CompletionItem[] {
		const template = this.schema.getBlockDefinition(blockType);
		if (!template?.attributes) return [];

		// Filter out attributes that are already present in the block
		const existingAttributes = new Set<string>();
		// TODO: Collect existing attributes from the block

		return template.attributes
			.filter(attr => !existingAttributes.has(attr.name))
			.map(attr => ({
				label: attr.name,
				kind: CompletionItemKind.Field,
				detail: attr.description,
				insertText: this.schema.generateAttributeSnippet(attr),
				insertTextFormat: 2
			}));
	}

	private getValueCompletions(blockType: string, attributeName: string): CompletionItem[] {
		const template = this.schema.getBlockDefinition(blockType);
		if (!template?.attributes) return [];

		const attribute = template.attributes.find(attr => attr.name === attributeName);
		if (!attribute) return [];

		// If the attribute accepts function values, include function completions
		if (attribute.types.includes('function')) {
			return this.getFunctionCompletions();
		}

		// If the attribute has allowed values, suggest them
		if (attribute.validation?.allowedValues) {
			return attribute.validation.allowedValues.map(value => ({
				label: String(value),
				kind: CompletionItemKind.Value
			}));
		}

		return [];
	}

	private getFunctionCompletions(): CompletionItem[] {
		return this.schema.getAllFunctions().map(func => ({
			label: func.name,
			kind: CompletionItemKind.Function,
			detail: func.description,
			insertText: this.schema.generateFunctionSnippet(func),
			insertTextFormat: 2
		}));
	}

	private isStartOfLine(line: string, character: number): boolean {
		return line.slice(0, character).trim().length === 0;
	}

	private isAfterEquals(line: string, character: number): boolean {
		const beforeCursor = line.slice(0, character).trim();
		return beforeCursor.endsWith('=');
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
