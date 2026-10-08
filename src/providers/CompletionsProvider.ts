import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CompletionItem, Position } from 'vscode-languageserver';
import { CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { escapeMarkdownText, markdownCode } from '../markdown';
import type { AttributeDefinition, BlockDefinition, Token } from '../model';
import type { ModuleType, ModuleVariableTypeKind } from '../module-variables';
import { anyType, moduleTypeKind } from '../module-variables';
import type { ParsedDocument } from '../ParsedDocument';
import type { Schema } from '../Schema';

/**
 * A construct the cursor sits inside. `<inputs>` is the root `inputs = {` object, `<expression>` any other brace
 * object and `<array>` a bracket, each carrying the key it is assigned to when one is on the same line.
 */
interface BlockFrame {
	/** The block type from its header, or `<inputs>`, `<expression>` or `<array>` for a construct with none. */
	type: string;
	/** The block's quoted label, such as `root` in `include "root" {`. */
	label?: string;
	/** The key the brace or bracket is assigned to, when `key =` precedes it on the same line. */
	key?: string;
}

/** Matches a line that assigns a value to a bare or quoted key, up to the `=`, capturing the key either way. */
const keyPrefix = /^\s*(?:"([^"]*)"|([\w-]+))\s*=\s*$/;

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

		const dependencyPath = this.dependencyPathAt(context);
		if (dependencyPath !== undefined) return this.dependencyPathItems(dependencyPath, position, document);

		const reference = this.referenceAtCursor(context.beforeCursor);
		if (reference) return this.referenceCompletions(reference, documentText);

		const expression = this.isExpressionPosition(context);
		const structural = context.lineBeforeCursor.trim().match(/^([\w-]*)$/)?.[1];
		const completions: CompletionItem[] = [];

		if (structural !== undefined && !context.inString) {
			const current = context.blocks.at(-1);
			if (!current) {
				completions.push(...this.blockItems(this.schema.getRootBlockDefinitions(document.getUri()), structural));
				completions.push(...this.attributeItems(this.schema.getRootAttributeDefinitions(document.getUri()), structural));
			} else if (current.type === '<inputs>') {
				completions.push(...this.moduleVariableItems(document, structural));
			} else if (current.type === '<expression>') {
				completions.push(...this.nestedInputItems(document, context.blocks, structural));
			} else if (current.type !== '<array>') {
				const definition = this.definitionForFrame(current, context.blocks.at(-2), document.getUri());
				if (definition) {
					completions.push(...this.attributeItems(definition.attributes ?? [], structural));
					completions.push(...this.blockItems(this.nestedBlocks(definition, current, context.blocks.at(-2)), structural));
				}
			}
		}

		if (expression) {
			const partial = context.beforeCursor.match(/[\w.]*$/)?.[0] ?? '';
			completions.push(...this.inlineFunctionItems(partial, document));
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

	/**
	 * Whether the cursor is inside a dependency's literal `config_path` string, where directories are offered.
	 * @param documentText the full text of the document.
	 * @param position the cursor position.
	 * @returns true when `getCompletions` would offer directories at the position.
	 */
	isDependencyPathContext(documentText: string, position: Position): boolean {
		return this.dependencyPathAt(this.contextAt(documentText, position)) !== undefined;
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
			// String contents stay in the line prefix so a block label or a quoted key is still readable when the
			// opening brace is reached.
			if (inString) { linePrefix += char; continue; }

			if (char === '\n') { linePrefix = ''; continue; }
			linePrefix += char;

			if (char === '{' && beforeCursor[index - 1] !== '$') {
				const prefix = linePrefix.slice(0, -1);
				const header = prefix.match(/^\s*([\w-]+)(?:\s+"([^"]+)")?\s*$/);
				if (header) blocks.push({ type: header[1], label: header[2] });
				else if (/^\s*inputs\s*=\s*$/.test(prefix)) blocks.push({ type: '<inputs>' });
				else blocks.push({ type: '<expression>', key: this.keyOf(prefix) });
			}
			if (char === '[') blocks.push({ type: '<array>', key: this.keyOf(linePrefix.slice(0, -1)) });
			if (char === ']' && blocks.at(-1)?.type === '<array>') blocks.pop();
			if (char === '}' && blocks.length > 0) blocks.pop();
		}

		// Expression and array frames only matter inside `inputs = {`, where they trace the path from the module
		// variable to the value being written. Elsewhere they are dropped so the enclosing block's definition still
		// applies.
		const frames: BlockFrame[] = [];
		for (const block of blocks) {
			if ((block.type !== '<expression>' && block.type !== '<array>') || frames.some(frame => frame.type === '<inputs>')) frames.push(block);
		}

		return {
			beforeCursor,
			lineBeforeCursor: beforeCursor.slice(beforeCursor.lastIndexOf('\n') + 1),
			blocks: frames,
			inComment: inLineComment || inBlockComment,
			inString
		};
	}

	/**
	 * @param prefix the text of the line before an opening brace or bracket.
	 * @returns the key when the prefix is `key =` or `"key" =`, else undefined.
	 */
	private keyOf(prefix: string): string | undefined {
		const match = prefix.match(keyPrefix);
		return match ? match[1] ?? match[2] : undefined;
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

	/**
	 * Variables of the module the unit sources, offered at the top level of its `inputs` object. Keys the object
	 * already assigns are left out, and required variables sort ahead of optional ones. The document accessors are
	 * optional because a provider driven without a workspace has no module state.
	 *
	 * @param document the document being completed.
	 * @param partial the word typed so far, which item names must start with.
	 * @returns one item per remaining variable, empty when no module is loaded.
	 */
	private moduleVariableItems(document: ParsedDocument, partial: string): CompletionItem[] {
		const state = document.getModuleVariables?.();
		if (state?.status !== 'loaded') return [];
		const present = new Set(document.getOwnInputKeys?.() ?? []);
		return state.variables
			.filter(variable => variable.name.startsWith(partial) && !present.has(variable.name))
			.map(variable => this.inputItem(
				variable.name,
				variable.typeText ?? 'any',
				variable.typeKind,
				variable.hasDefault,
				variable.description,
				variable.defaultText
			));
	}

	/**
	 * Attributes of the object the cursor is writing inside `inputs`, found by walking the frames since `inputs`
	 * down the module variable's type: a keyed frame selects an object attribute or a map's element, an array frame
	 * selects a list or set element, and a keyless object frame is only meaningful as a list element. Anything the
	 * type does not describe offers nothing.
	 *
	 * @param document the document being completed.
	 * @param blocks the frames enclosing the cursor, outermost first, including the `<inputs>` frame.
	 * @param partial the word typed so far, which item names must start with.
	 * @returns one item per attribute of the object at the cursor not already written, empty when the path does not
	 *   lead to an object the type describes.
	 */
	private nestedInputItems(document: ParsedDocument, blocks: BlockFrame[], partial: string): CompletionItem[] {
		const state = document.getModuleVariables?.();
		const start = blocks.findIndex(block => block.type === '<inputs>');
		if (state?.status !== 'loaded' || start < 0) return [];
		const frames = blocks.slice(start + 1);

		let type: ModuleType = {
			kind: 'object',
			text: 'inputs',
			attributes: state.variables.map(variable => ({ name: variable.name, type: variable.type ?? anyType, optional: variable.hasDefault, defaultText: variable.defaultText }))
		};
		for (const [index, frame] of frames.entries()) {
			if (frame.key !== undefined) {
				if (type.kind === 'object') {
					const attribute = type.attributes.find(candidate => candidate.name === frame.key);
					if (!attribute) return [];
					type = attribute.type;
				} else if (type.kind === 'map') {
					type = type.element;
				} else return [];
			} else if (frame.type === '<expression>' && frames[index - 1]?.type !== '<array>') return [];
			if (frame.type === '<array>') {
				if (type.kind === 'list' || type.kind === 'set') type = type.element;
				else return [];
			}
		}
		if (type.kind !== 'object') return [];

		const present = new Set(this.presentKeysAt(document, frames));
		return type.attributes
			.filter(attribute => attribute.name.startsWith(partial) && !present.has(attribute.name))
			.map(attribute => this.inputItem(attribute.name, attribute.type.text, moduleTypeKind(attribute.type), attribute.optional, undefined, attribute.defaultText));
	}

	/**
	 * Keys already written in the nested object the frames lead to, when the document parses and the path has no
	 * array in it.
	 *
	 * @param document the document being completed.
	 * @param frames the frames inside `inputs`, outermost first.
	 * @returns the key names, or an empty list whenever they cannot be read.
	 */
	private presentKeysAt(document: ParsedDocument, frames: BlockFrame[]): string[] {
		let value = document.getInputsAssignment?.()?.children.find(child => child.type !== 'root_assignment_identifier');
		for (const frame of frames) {
			if (!value || value.type !== 'object' || frame.key === undefined || frame.type === '<array>') return [];
			const attribute = value.children.find(child => child.type === 'attribute' && this.attributeName(child) === frame.key);
			value = attribute?.children.find(child => child.type !== 'attribute_identifier');
		}
		if (!value || value.type !== 'object') return [];
		return value.children.filter(child => child.type === 'attribute').map(child => this.attributeName(child)).filter((name): name is string => name !== undefined);
	}

	/**
	 * @param attribute an `attribute` token of an object literal.
	 * @returns its key, or undefined for a computed key such as `(local.k)`.
	 */
	private attributeName(attribute: Token): string | undefined {
		return attribute.children.find(child => child.type === 'attribute_identifier')?.getDisplayText();
	}

	/**
	 * A completion item for one input key, top-level or nested, whose snippet inserts `name = <value>`.
	 *
	 * @param name the key.
	 * @param typeText the type as shown in the item's detail.
	 * @param kind the flat type kind the value snippet is chosen by.
	 * @param optional whether the key may be left out; required keys sort first.
	 * @param description the variable's description, shown as documentation when present.
	 * @param defaultText the authored default, shown as documentation when present.
	 * @returns the item.
	 */
	private inputItem(name: string, typeText: string, kind: ModuleVariableTypeKind | undefined, optional: boolean, description?: string, defaultText?: string): CompletionItem {
		const lines: string[] = [];
		if (description) lines.push(escapeMarkdownText(description), '');
		if (defaultText !== undefined) lines.push(`Default: ${markdownCode(defaultText)}`);
		return {
			label: name,
			kind: CompletionItemKind.Property,
			detail: `${typeText} · ${optional ? 'optional' : 'required'}`,
			documentation: { kind: MarkupKind.Markdown, value: lines.join('\n').trim() },
			insertText: `${name} = ${this.moduleValueSnippet(kind, 1)}`,
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: `${optional ? '1' : '0'}-${name}`
		};
	}

	/**
	 * The value placeholder for a module input, mirroring {@link valueSnippet} for schema attributes.
	 *
	 * @param kind the flat type kind of the input.
	 * @param index the snippet tab stop to use.
	 * @returns a snippet: a quoted string, a number, a true/false choice, brackets, braces, or a bare tab stop.
	 */
	private moduleValueSnippet(kind: ModuleVariableTypeKind | undefined, index: number): string {
		switch (kind) {
			case 'string': return `"\${${index}:value}"`;
			case 'number': return `\${${index}:0}`;
			case 'bool': return `\${${index}|true,false|}`;
			case 'list':
			case 'set':
			case 'tuple': return `[\${${index}}]`;
			case 'map':
			case 'object': return `{\n\t\${${index}}\n}`;
			default: return `\${${index}}`;
		}
	}

	/**
	 * Functions declared in the document being edited. They sort ahead of
	 * built-ins because a name defined in the file at hand is the more likely
	 * intent, and because a definition can never share a built-in's name.
	 */
	private inlineFunctionItems(partial: string, document: ParsedDocument): CompletionItem[] {
		return [...document.getInlineFunctions().values()]
			.filter(func => func.name.startsWith(partial))
			.map(func => ({
				label: func.name,
				kind: CompletionItemKind.Function,
				detail: this.schema.getFunctionSignature(func),
				documentation: { kind: MarkupKind.Markdown, value: func.description },
				insertText: this.schema.generateFunctionSnippet(func),
				insertTextFormat: InsertTextFormat.Snippet,
				sortText: `1-${func.name}`
			}));
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

	/**
	 * The path typed so far when the cursor is inside a dependency's literal `config_path` string.
	 * @param context the cursor context.
	 * @returns the text between the opening quote and the cursor, or undefined outside such a string or when the string
	 * is interpolated.
	 */
	private dependencyPathAt(context: CursorContext): string | undefined {
		if (!context.inString || context.blocks.at(-1)?.type !== 'dependency') return undefined;
		return context.lineBeforeCursor.match(/^\s*config_path\s*=\s*"([^"$]*)$/)?.[1];
	}

	/**
	 * The directories under the typed path, relative to the document. Unit and stack directories sort first and complete
	 * as they are; any other directory completes with a trailing `/` and reopens the list to step into it.
	 * @param typed the path typed so far, from {@link dependencyPathAt}.
	 * @param position the cursor position, which ends the segment each item replaces.
	 * @param document the document being edited, whose directory relative paths resolve against.
	 * @returns one folder item per directory, plus `../`, or none when the document is not a file or the directory
	 * cannot be read.
	 */
	private async dependencyPathItems(typed: string, position: Position, document: ParsedDocument): Promise<CompletionItem[]> {
		const uri = URI.parse(document.getUri());
		if (uri.scheme !== 'file') return [];

		const separator = typed.lastIndexOf('/');
		const dirPart = typed.slice(0, separator + 1);
		const namePrefix = typed.slice(separator + 1);
		const dir = path.resolve(path.dirname(uri.fsPath), dirPart || '.');
		const range = {
			start: { line: position.line, character: position.character - namePrefix.length },
			end: position
		};
		const reopen = { title: 'Suggest', command: 'editor.action.triggerSuggest' };

		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
		if (!entries) return [];

		const directories = await Promise.all(entries
			.filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
			.map(async entry => {
				const entryPath = path.join(dir, entry.name);
				if (entry.isSymbolicLink() && !(await this.isDirectory(entryPath))) return undefined;
				const [hasUnit, hasStack] = await Promise.all([
					this.isFile(path.join(entryPath, 'terragrunt.hcl')),
					this.isFile(path.join(entryPath, 'terragrunt.stack.hcl'))
				]);
				return { name: entry.name, kind: hasUnit ? 'unit' : hasStack ? 'stack' : undefined };
			}));

		const items: CompletionItem[] = directories
			.filter(directory => directory !== undefined)
			.map(({ name, kind }) => kind ?
				{
					label: name,
					kind: CompletionItemKind.Folder,
					detail: `Terragrunt ${kind}`,
					textEdit: { range, newText: name },
					sortText: `0-${name}`
				} :
				{
					label: `${name}/`,
					kind: CompletionItemKind.Folder,
					textEdit: { range, newText: `${name}/` },
					sortText: `1-${name}`,
					command: reopen
				});

		if ('..'.startsWith(namePrefix)) {
			items.push({ label: '../', kind: CompletionItemKind.Folder, textEdit: { range, newText: '../' }, sortText: '2-..', command: reopen });
		}
		return items;
	}

	/**
	 * @param filePath the path to check, following symlinks.
	 * @returns true when it is a directory, false when it is anything else or cannot be read.
	 */
	private async isDirectory(filePath: string): Promise<boolean> {
		try {
			return (await fs.stat(filePath)).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * @param filePath the path to check, following symlinks.
	 * @returns true when it is a regular file, false when it is anything else or cannot be read.
	 */
	private async isFile(filePath: string): Promise<boolean> {
		try {
			return (await fs.stat(filePath)).isFile();
		} catch {
			return false;
		}
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
