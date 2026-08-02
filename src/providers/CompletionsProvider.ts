import type { CompletionItem, Position } from 'vscode-languageserver';
import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver';

import type { AttributeDefinition, BlockDefinition, Token } from '../model';
import type { ParsedDocument } from '../ParsedDocument';
import type { Schema } from '../Schema';

interface BlockFrame {
	type: string;
	label?: string;
}

interface CursorContext {
	beforeCursor: string;
	lineBeforeCursor: string;
	blocks: BlockFrame[];
	inComment: boolean;
	inString: boolean;
}

export class CompletionsProvider {
	constructor(private readonly schema: Schema) {}

	async getCompletions(
		documentText: string,
		position: Position,
		_token: Token | null,
		document: ParsedDocument
	): Promise<CompletionItem[]> {
		const context = this.contextAt(documentText, position);
		if (context.inComment) return [];

		const reference = this.referenceAtCursor(context.beforeCursor);
		if (reference) return this.referenceCompletions(reference, documentText);

		const expression = this.isExpressionPosition(context);
		const structural = context.lineBeforeCursor.trim().match(/^([\w-]*)$/)?.[1];
		const completions: CompletionItem[] = [];

		if (structural !== undefined && !context.inString) {
			if (context.blocks.length === 0) {
				completions.push(...this.blockItems(this.schema.getRootBlockDefinitions(document.getUri()), structural));
				completions.push(...this.attributeItems(this.schema.getRootAttributeDefinitions(document.getUri()), structural));
			} else {
				const current = context.blocks.at(-1)!;
				const definition = this.definitionForFrame(current, context.blocks.at(-2), document.getUri());
				if (definition) {
					completions.push(...this.attributeItems(definition.attributes ?? [], structural));
					completions.push(...this.blockItems(this.nestedBlocks(definition, current, context.blocks.at(-2)), structural));
				}
			}
		}

		if (expression) {
			const partial = context.beforeCursor.match(/[\w.]*$/)?.[0] ?? '';
			completions.push(...this.functionItems(partial));
			completions.push(...this.namespaceItems(partial, documentText));
		}

		return this.unique(completions);
	}

	isRootContext(documentText: string, position: Position): boolean {
		const context = this.contextAt(documentText, position);
		return context.blocks.length === 0 && !context.inString && !context.inComment;
	}

	isBlockTypeContext(documentText: string, position: Position): boolean {
		const context = this.contextAt(documentText, position);
		return context.blocks.length === 0 && !context.inString && /^\s*[\w-]*$/.test(context.lineBeforeCursor);
	}

	isReferenceContext(documentText: string, position: Position): boolean {
		return this.referenceAtCursor(this.contextAt(documentText, position).beforeCursor) !== undefined;
	}

	isInterpolationContext(documentText: string, position: Position): boolean {
		const before = this.contextAt(documentText, position).beforeCursor;
		const start = before.lastIndexOf('${');
		return start >= 0 && before.lastIndexOf('}') < start;
	}

	isFunctionContext(documentText: string, position: Position): boolean {
		return /[\w.]+\([^)]*$/.test(this.contextAt(documentText, position).beforeCursor);
	}

	isStringLiteralContext(documentText: string, position: Position): boolean {
		return this.contextAt(documentText, position).inString;
	}

	isExpressionContext(documentText: string, position: Position): boolean {
		return this.isExpressionPosition(this.contextAt(documentText, position));
	}

	isBlockParameterContext(documentText: string, position: Position): boolean {
		return /^\s*[\w-]+\s+"[^"]*$/.test(this.contextAt(documentText, position).lineBeforeCursor);
	}

	isNestedBlockContext(documentText: string, position: Position): boolean {
		const context = this.contextAt(documentText, position);
		return context.blocks.length > 0 && /^\s*[\w-]*$/.test(context.lineBeforeCursor);
	}

	isBlockAttributeNameContext(documentText: string, position: Position): boolean {
		return this.isNestedBlockContext(documentText, position);
	}

	isBlockAttributeValueContext(documentText: string, position: Position): boolean {
		return /=\s*[^\n]*$/.test(this.contextAt(documentText, position).lineBeforeCursor);
	}

	isCommentContext(documentText: string, position: Position): boolean {
		return this.contextAt(documentText, position).inComment;
	}

	isPartialContext(documentText: string, position: Position): boolean {
		return /[\w.-]+$/.test(this.contextAt(documentText, position).lineBeforeCursor);
	}

	isBlockAttributeContext(documentText: string, position: Position): boolean {
		return this.isBlockAttributeNameContext(documentText, position);
	}

	private contextAt(text: string, position: Position): CursorContext {
		const offset = this.offsetAt(text, position);
		const beforeCursor = text.slice(0, offset);
		const blocks: BlockFrame[] = [];
		let inString = false;
		let inLineComment = false;
		let inBlockComment = false;
		let escaped = false;
		let linePrefix = '';

		for (let index = 0; index < beforeCursor.length; index++) {
			const char = beforeCursor[index];
			const next = beforeCursor[index + 1];
			if (inLineComment) {
				if (char === '\n') { inLineComment = false; linePrefix = ''; }
				continue;
			}
			if (inBlockComment) {
				if (char === '*' && next === '/') { inBlockComment = false; index++; }
				continue;
			}
			if (!inString && char === '/' && next === '*') { inBlockComment = true; index++; continue; }
			if (!inString && ((char === '/' && next === '/') || char === '#')) {
				inLineComment = true;
				if (char === '/') index++;
				continue;
			}
			if (char === '"' && !escaped) inString = !inString;
			escaped = char === '\\' && !escaped;
			if (char !== '\\') escaped = false;
			if (inString) continue;

			if (char === '\n') { linePrefix = ''; continue; }
			linePrefix += char;

			if (char === '{' && beforeCursor[index - 1] !== '$') {
				const header = linePrefix.slice(0, -1).match(/^\s*([\w-]+)(?:\s+"([^"]+)")?\s*$/);
				if (header) blocks.push({ type: header[1], label: header[2] });
				else blocks.push({ type: '<expression>' });
			}
			if (char === '}' && blocks.length > 0) blocks.pop();
		}

		return {
			beforeCursor,
			lineBeforeCursor: beforeCursor.slice(beforeCursor.lastIndexOf('\n') + 1),
			blocks: blocks.filter(block => block.type !== '<expression>'),
			inComment: inLineComment || inBlockComment,
			inString
		};
	}

	private offsetAt(text: string, position: Position): number {
		let offset = 0;
		const lines = text.split('\n');
		for (let line = 0; line < position.line && line < lines.length; line++) offset += lines[line].length + 1;
		return Math.min(text.length, offset + position.character);
	}

	private isExpressionPosition(context: CursorContext): boolean {
		if (this.isInterpolationText(context.beforeCursor)) return true;
		return /=\s*[^\n]*$/.test(context.lineBeforeCursor) && !context.inComment;
	}

	private isInterpolationText(text: string): boolean {
		const start = text.lastIndexOf('${');
		return start >= 0 && text.lastIndexOf('}') < start;
	}

	private definitionForFrame(frame: BlockFrame, parent: BlockFrame | undefined, uri: string): BlockDefinition | undefined {
		if (!parent) return this.schema.getRootBlockDefinitions(uri).find(block => block.type === frame.type);
		const parentDefinition = this.schema.getBlockDefinition(parent.type);
		return parentDefinition?.blocks?.find(block => block.type === frame.type) ?? this.schema.getBlockDefinition(frame.type);
	}

	private nestedBlocks(definition: BlockDefinition, frame: BlockFrame, parent?: BlockFrame): BlockDefinition[] {
		if (frame.type !== 'autoinclude') return definition.blocks ?? [];
		if (parent?.type === 'stack') {
			return ['unit', 'stack'].map(type => this.schema.getBlockDefinition(type)).filter(Boolean) as BlockDefinition[];
		}
		return this.schema.getRootBlockDefinitions('file:///terragrunt.autoinclude.hcl');
	}

	private blockItems(definitions: BlockDefinition[], partial: string): CompletionItem[] {
		return definitions.filter(block => block.type.startsWith(partial)).map(block => {
			const labeled = (block.parameters?.length ?? 0) > 0;
			const required = block.attributes?.filter(attribute => attribute.required) ?? [];
			let index = 1;
			const label = labeled ? ` "\${${index++}:name}"` : '';
			const body = required.map(attribute => `\t${attribute.name} = ${this.valueSnippet(attribute, index++)}`).join('\n');
			return {
				label: block.type,
				kind: CompletionItemKind.Class,
				detail: 'Terragrunt block',
				documentation: { kind: MarkupKind.Markdown, value: block.description ?? '' },
				insertText: `${block.type}${label} {\n${body}${body ? '\n' : ''}}`,
				insertTextFormat: InsertTextFormat.Snippet,
				sortText: `1-${block.type}`
			};
		});
	}

	private attributeItems(definitions: AttributeDefinition[], partial: string): CompletionItem[] {
		return definitions.filter(attribute => attribute.name.startsWith(partial)).map(attribute => ({
			label: attribute.name,
			kind: CompletionItemKind.Property,
			detail: `${attribute.required ? 'Required' : 'Optional'} Terragrunt attribute`,
			documentation: { kind: MarkupKind.Markdown, value: attribute.description },
			insertText: `${attribute.name} = ${this.valueSnippet(attribute, 1)}`,
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: `${attribute.required ? '0' : '2'}-${attribute.name}`
		}));
	}

	private valueSnippet(attribute: AttributeDefinition, index: number): string {
		if (attribute.validation?.allowedValues?.length) {
			return `"\${${index}|${attribute.validation.allowedValues.join(',')}|}"`;
		}
		switch (attribute.types[0]) {
			case 'string': return `"\${${index}:value}"`;
			case 'number': return `\${${index}:0}`;
			case 'boolean': return `\${${index}|true,false|}`;
			case 'array': return `[\${${index}}]`;
			case 'object': return `{\n\t\${${index}}\n}`;
			default: return `\${${index}}`;
		}
	}

	private functionItems(partial: string): CompletionItem[] {
		return this.schema.getAllFunctions().filter(func => func.name.startsWith(partial)).map(func => ({
			label: func.name,
			kind: CompletionItemKind.Function,
			detail: this.schema.getFunctionSignature(func),
			documentation: { kind: MarkupKind.Markdown, value: func.description },
			insertText: this.schema.generateFunctionSnippet(func),
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: `3-${func.name}`
		}));
	}

	private namespaceItems(partial: string, text: string): CompletionItem[] {
		return ['local', 'dependency', 'include', 'feature', 'values', 'unit', 'stack']
			.filter(namespace => namespace.startsWith(partial) && this.symbols(namespace, text).length > 0)
			.map(namespace => ({
				label: namespace,
				kind: CompletionItemKind.Module,
				insertText: `${namespace}.`,
				detail: `Terragrunt ${namespace} namespace`,
				sortText: `2-${namespace}`
			}));
	}

	private referenceAtCursor(text: string): { namespace: string; parts: string[]; partial: string } | undefined {
		const match = text.match(/\b(local|dependency|include|feature|values|unit|stack)((?:\.[\w-]*)+)$/);
		if (!match) return undefined;
		const segments = match[2].slice(1).split('.');
		return { namespace: match[1], parts: segments.slice(0, -1), partial: segments.at(-1) ?? '' };
	}

	private referenceCompletions(reference: { namespace: string; parts: string[]; partial: string }, text: string): CompletionItem[] {
		if (reference.namespace === 'dependency' && reference.parts.length === 1) {
			return ['outputs'].filter(value => value.startsWith(reference.partial)).map(value => this.referenceItem(value));
		}
		if (reference.namespace === 'feature' && reference.parts.length === 1) {
			return ['value'].filter(value => value.startsWith(reference.partial)).map(value => this.referenceItem(value));
		}
		if ((reference.namespace === 'unit' || reference.namespace === 'stack') && reference.parts.length === 1) {
			return ['path', 'name'].filter(value => value.startsWith(reference.partial)).map(value => this.referenceItem(value));
		}
		if (reference.parts.length > 0) return [];
		return this.symbols(reference.namespace, text)
			.filter(value => value.startsWith(reference.partial))
			.map(value => this.referenceItem(value));
	}

	private symbols(namespace: string, text: string): string[] {
		const patterns: Record<string, RegExp> = {
			local: /locals\s*\{([\s\S]*?)\}/g,
			dependency: /dependency\s+"([^"]+)"\s*\{/g,
			include: /include\s+"([^"]+)"\s*\{/g,
			feature: /feature\s+"([^"]+)"\s*\{/g,
			unit: /unit\s+"([^"]+)"\s*\{/g,
			stack: /stack\s+"([^"]+)"\s*\{/g,
			values: /^\s*([\w-]+)\s*=/gm
		};
		const pattern = patterns[namespace];
		if (!pattern) return [];
		const values: string[] = [];
		for (const match of text.matchAll(pattern)) {
			if (namespace === 'local') {
				for (const assignment of match[1].matchAll(/^\s*([\w-]+)\s*=/gm)) values.push(assignment[1]);
			} else values.push(match[1]);
		}
		return [...new Set(values)];
	}

	private referenceItem(label: string): CompletionItem {
		return { label, kind: CompletionItemKind.Reference, insertText: label, sortText: `0-${label}` };
	}

	private unique(items: CompletionItem[]): CompletionItem[] {
		const seen = new Set<string>();
		return items.filter(item => {
			const key = String(item.label);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
}
