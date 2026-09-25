import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Position } from 'vscode-languageserver-types';

import { parse } from './parser';

/** The flat shape of a type constraint, enough to choose a value snippet by. */
export type ModuleVariableTypeKind = 'string' | 'number' | 'bool' | 'list' | 'set' | 'map' | 'object' | 'tuple' | 'any';

/** A Terraform type constraint, with the authored text of each node kept for display. */
export type ModuleType =
	| {
		kind: 'primitive';
		/** The primitive's name; `any` also stands for every construct the reader does not recognise. */
		name: 'string' | 'number' | 'bool' | 'any';
		/** The authored text of this node, collapsed; for `any` it may be the unrecognised expression itself. */
		text: string;
	}
	| {
		kind: 'list' | 'set' | 'map';
		/** The type of every element, or of every value for a map. */
		element: ModuleType;
		/** The authored text of this node, collapsed. */
		text: string;
	}
	| {
		kind: 'tuple';
		/** The type of each position, in order. */
		elements: ModuleType[];
		/** The authored text of this node, collapsed. */
		text: string;
	}
	| {
		kind: 'object';
		/** The declared attributes, in declaration order. */
		attributes: ModuleTypeAttribute[];
		/** The authored text of this node, collapsed. */
		text: string;
	};

/** One attribute of an `object({ … })` type constraint. */
export interface ModuleTypeAttribute {
	/** The attribute's key. */
	name: string;
	/** The attribute's type, unwrapped from `optional(...)` when it was declared optional. */
	type: ModuleType;
	/** True for `optional(type)` and `optional(type, default)`. */
	optional: boolean;
	/** The authored default of `optional(type, default)`, collapsed. */
	defaultText?: string;
}

/** The type of a variable that declares none, and of every construct the type reader does not recognise. */
export const anyType: ModuleType = { kind: 'primitive', name: 'any', text: 'any' };

/** A `variable` block of a Terraform module, as declared rather than as evaluated. */
export interface ModuleVariable {
	/** The block's label, which is the name an input sets. */
	name: string;
	/** The `description` attribute: a string literal's value, else the authored expression. */
	description?: string;
	/** The authored type expression with whitespace collapsed, such as `map(string)`. */
	typeText?: string;
	/** The flat shape of the type; absent when no `type` is declared. */
	typeKind?: ModuleVariableTypeKind;
	/** The type constraint as a tree; absent when no `type` is declared. */
	type?: ModuleType;
	/** True whenever a `default` attribute is present, including `default = null`. */
	hasDefault: boolean;
	/** The authored default expression, collapsed and truncated for display. */
	defaultText?: string;
	/** The `nullable` attribute when it is a boolean literal; absent otherwise. */
	nullable?: boolean;
	/** The `sensitive` attribute when it is a boolean literal; absent otherwise. */
	sensitive?: boolean;
	/** Absolute path of the `.tf` file declaring the variable. */
	file: string;
	/** Zero-based range of the `variable` block. */
	range: { start: Position; end: Position };
}

/** The variables of one module directory, as {@link readModuleVariables} returns them. */
export interface ModuleVariables {
	/** Absolute path of the module directory. */
	moduleDir: string;
	/** Absolute paths of the `.tf` files read, sorted. */
	files: string[];
	/** The variables declared, in file then declaration order, with the first declaration of a repeated name. */
	variables: ModuleVariable[];
}

/** Characters of a default expression kept for display before it is cut with an ellipsis. */
const maximumDefaultLength = 120;

/**
 * Splits a module source the way go-getter does: an optional forced getter prefix such as `git::`, the repository,
 * a `//subdirectory` inside it, and a `?ref=` query. Leading slashes in the subdirectory are dropped, so the common
 * `modules/x///` form names the module itself rather than the filesystem root.
 *
 * @param source the source as written or evaluated.
 * @returns the parts; `subdirectory` is empty when there is none.
 */
export function splitModuleSource(source: string): {repository: string; subdirectory: string; ref?: string; forced?: string} {
	let value = source.trim();
	let forced: string | undefined;
	const forcedMatch = value.match(/^([a-z][a-z0-9+.-]*):\:/i);
	if (forcedMatch) {
		forced = forcedMatch[1].toLowerCase();
		value = value.slice(forcedMatch[0].length);
	}
	const queryIndex = value.indexOf('?');
	const query = queryIndex >= 0 ? new URLSearchParams(value.slice(queryIndex + 1)) : new URLSearchParams();
	if (queryIndex >= 0) value = value.slice(0, queryIndex);
	let repository = value;
	let subdirectory = '';
	const protocolEnd = value.indexOf('://');
	const searchStart = protocolEnd >= 0 ? protocolEnd + 3 : 0;
	const separator = value.indexOf('//', searchStart);
	if (separator >= 0) {
		repository = value.slice(0, separator);
		subdirectory = value.slice(separator + 2).replace(/^\/+/, '');
	}
	return {repository, subdirectory, ref: query.get('ref') || undefined, forced};
}

/**
 * @param source the repository part of a split module source.
 * @returns true for a relative path, an absolute path or a `file://` URL.
 */
export function isLocalSource(source: string): boolean {
	return source.startsWith('./') || source.startsWith('../') || source.startsWith('/') || source.startsWith('file://');
}

/**
 * Terraform reads only the top level of a module directory, so nested directories are not descended into.
 *
 * @param moduleDir absolute path of the module directory.
 * @returns absolute paths of the visible `.tf` files at its top level, sorted.
 * @throws when the directory does not exist or cannot be read.
 */
export async function listModuleFiles(moduleDir: string): Promise<string[]> {
	const entries = await fs.readdir(moduleDir, { withFileTypes: true });
	return entries
		.filter(entry => entry.isFile() && entry.name.endsWith('.tf') && !entry.name.startsWith('.'))
		.map(entry => path.join(moduleDir, entry.name))
		.sort();
}

/**
 * Reads the `variable` blocks of a module. A file that does not parse is skipped, and the first declaration of a
 * repeated name wins.
 *
 * @param moduleDir absolute path of the module directory.
 * @returns the files read and the variables they declare, in file then declaration order.
 * @throws when the directory or one of its files cannot be read.
 */
export async function readModuleVariables(moduleDir: string): Promise<ModuleVariables> {
	const files = await listModuleFiles(moduleDir);
	const variables: ModuleVariable[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const content = await fs.readFile(file, 'utf8');
		let ast: any;
		try {
			ast = parse(content, { grammarSource: file, tracer: { trace() {} } });
		} catch {
			continue;
		}
		for (const block of ast.children ?? []) {
			if (block.type !== 'block' || block.value !== 'variable') continue;
			const label = block.children?.find((child: any) => child.type === 'parameter');
			if (!label) continue;
			const name = String(label.value);
			if (seen.has(name)) continue;
			seen.add(name);
			variables.push(readVariable(block, name, file, content));
		}
	}
	return { moduleDir, files, variables };
}

/**
 * Reads one `variable` block. Only `description`, `type`, `default`, `nullable` and `sensitive` are looked at;
 * `validation` blocks are not.
 *
 * @param block the parser node of the block.
 * @param name the variable name from the block's label.
 * @param file absolute path of the file the block is in.
 * @param content the file's source text, which the type and default are sliced from.
 * @returns the variable as declared.
 */
function readVariable(block: any, name: string, file: string, content: string): ModuleVariable {
	const variable: ModuleVariable = {
		name,
		hasDefault: false,
		file,
		range: {
			start: { line: block.location.start.line - 1, character: block.location.start.column - 1 },
			end: { line: block.location.end.line - 1, character: block.location.end.column - 1 }
		}
	};
	for (const child of block.children ?? []) {
		if (child.type !== 'attribute') continue;
		const valueNode = child.children?.find((value: any) => value.type !== 'attribute_identifier');
		if (!valueNode) continue;
		const sourceText = collapse(content.slice(valueNode.location.start.offset, valueNode.location.end.offset));
		switch (child.value) {
			case 'description':
				variable.description = valueNode.type === 'string_lit' ? String(valueNode.value) : sourceText;
				break;
			case 'type':
				variable.typeText = sourceText;
				variable.type = readModuleType(valueNode, content);
				variable.typeKind = moduleTypeKind(variable.type);
				break;
			case 'default':
				variable.hasDefault = true;
				variable.defaultText = sourceText.length > maximumDefaultLength ? `${sourceText.slice(0, maximumDefaultLength)}…` : sourceText;
				break;
			case 'nullable':
				if (valueNode.type === 'boolean_lit') variable.nullable = valueNode.value === true;
				break;
			case 'sensitive':
				if (valueNode.type === 'boolean_lit') variable.sensitive = valueNode.value === true;
				break;
		}
	}
	return variable;
}

/**
 * @param text authored source text.
 * @returns the text with every run of whitespace reduced to one space and the ends trimmed.
 */
function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reads a type constraint from its expression node. Anything not recognised is `any`, never an error.
 *
 * @param node the parser node of the `type` expression.
 * @param content the source text the node's offsets index into, used to keep the authored text of each node.
 * @returns the type tree, with `any` standing in for every construct the reader does not know.
 */
export function readModuleType(node: any, content: string): ModuleType {
	const text = collapse(content.slice(node.location.start.offset, node.location.end.offset));
	if (node.type === 'traversal_reference') {
		const name = String(node.value);
		if (name === 'string' || name === 'number' || name === 'bool') return { kind: 'primitive', name, text };
		return { kind: 'primitive', name: 'any', text };
	}
	if (node.type !== 'function_call') return { kind: 'primitive', name: 'any', text };
	const name = node.children?.find((child: any) => child.type === 'function_identifier')?.value;
	const args = (node.children ?? []).filter((child: any) => child.type !== 'function_identifier');
	switch (name) {
		case 'list':
		case 'set':
		case 'map':
			return { kind: name, element: args[0] ? readModuleType(args[0], content) : anyType, text };
		case 'tuple':
			return { kind: 'tuple', elements: (args[0]?.type === 'array_lit' ? args[0].children ?? [] : []).map((child: any) => readModuleType(child, content)), text };
		case 'object': {
			const attributes: ModuleTypeAttribute[] = [];
			for (const attribute of args[0]?.type === 'object' ? args[0].children ?? [] : []) {
				if (attribute.type !== 'attribute') continue;
				const identifier = attribute.children?.find((child: any) => child.type === 'attribute_identifier');
				const value = attribute.children?.find((child: any) => child.type !== 'attribute_identifier');
				const key = identifier?.value ?? attribute.value;
				if (key === null || key === undefined || !value) continue;
				const valueName = value.type === 'function_call' ? value.children?.find((child: any) => child.type === 'function_identifier')?.value : undefined;
				if (valueName === 'optional') {
					const [inner, fallback] = (value.children ?? []).filter((child: any) => child.type !== 'function_identifier');
					attributes.push({
						name: String(key),
						type: inner ? readModuleType(inner, content) : anyType,
						optional: true,
						defaultText: fallback ? collapse(content.slice(fallback.location.start.offset, fallback.location.end.offset)) : undefined
					});
				} else {
					attributes.push({ name: String(key), type: readModuleType(value, content), optional: false });
				}
			}
			return { kind: 'object', attributes, text };
		}
		default:
			return { kind: 'primitive', name: 'any', text };
	}
}

/**
 * Renders a type the way `variables.tf` would declare it, one object attribute per line with aligned equals signs.
 *
 * @param type the type tree to render.
 * @param indent the indentation of the line the rendering starts on, applied to nested object lines.
 * @returns the declaration text, on one line unless it contains an object with attributes.
 */
export function formatModuleType(type: ModuleType, indent = ''): string {
	switch (type.kind) {
		case 'primitive': return type.text;
		case 'list':
		case 'set':
		case 'map': return `${type.kind}(${formatModuleType(type.element, indent)})`;
		case 'tuple': return `tuple([${type.elements.map(element => formatModuleType(element, indent)).join(', ')}])`;
		case 'object': {
			if (type.attributes.length === 0) return 'object({})';
			const inner = `${indent}  `;
			const width = Math.max(...type.attributes.map(attribute => attribute.name.length));
			const lines = type.attributes.map(attribute => {
				const attributeType = formatModuleType(attribute.type, inner);
				const declared = !attribute.optional
					? attributeType
					: attribute.defaultText !== undefined ? `optional(${attributeType}, ${attribute.defaultText})` : `optional(${attributeType})`;
				return `${inner}${attribute.name.padEnd(width)} = ${declared}`;
			});
			return `object({\n${lines.join('\n')}\n${indent}})`;
		}
	}
}

/**
 * A one-line form that names the shape without its contents, such as `list(object({…}))`.
 *
 * @param type the type tree to summarize.
 * @returns the summary text.
 */
export function summarizeModuleType(type: ModuleType): string {
	switch (type.kind) {
		case 'primitive': return type.text;
		case 'list':
		case 'set':
		case 'map': return `${type.kind}(${summarizeModuleType(type.element)})`;
		case 'tuple': return 'tuple([…])';
		case 'object': return type.attributes.length === 0 ? 'object({})' : 'object({…})';
	}
}

/**
 * The flat kind of a type, which is what a value snippet is chosen by.
 *
 * @param type the type tree, or undefined for a variable that declares no type.
 * @returns the primitive's name for a primitive, else the collection or object kind; `any` when no type is known.
 */
export function moduleTypeKind(type: ModuleType | undefined): ModuleVariableTypeKind {
	if (!type) return 'any';
	return type.kind === 'primitive' ? type.name : type.kind;
}

/**
 * Re-reads a module only when its directory or one of its `.tf` files changes on disk. There is no file watcher, so
 * the signature check on each lookup is what keeps an open unit current after a module edit.
 */
export class ModuleVariableCache {
	private entries = new Map<string, { signature: string; value: ModuleVariables }>();

	/**
	 * @param moduleDir absolute path of the module directory.
	 * @returns the module's variables, the same object as the previous call while nothing on disk has changed.
	 * @throws when the directory does not exist or cannot be read.
	 */
	async get(moduleDir: string): Promise<ModuleVariables> {
		const signature = await this.signatureOf(moduleDir);
		const cached = this.entries.get(moduleDir);
		if (cached && cached.signature === signature) return cached.value;
		const value = await readModuleVariables(moduleDir);
		this.entries.set(moduleDir, { signature, value });
		return value;
	}

	/**
	 * Forgets a cached module so the next lookup reads it again regardless of its signature.
	 *
	 * @param moduleDir the module to forget; every module when omitted.
	 */
	invalidate(moduleDir?: string): void {
		if (moduleDir === undefined) this.entries.clear();
		else this.entries.delete(moduleDir);
	}

	/**
	 * @param moduleDir absolute path of the module directory.
	 * @returns a string that changes whenever the directory's mtime or any `.tf` file's name, mtime or size does.
	 * @throws when the directory or a file in it cannot be stat'ed.
	 */
	private async signatureOf(moduleDir: string): Promise<string> {
		const directory = await fs.stat(moduleDir);
		const files = await listModuleFiles(moduleDir);
		const parts = await Promise.all(files.map(async file => {
			const stats = await fs.stat(file);
			return `${path.basename(file)}:${stats.mtimeMs}:${stats.size}`;
		}));
		return [String(directory.mtimeMs), ...parts].join('\n');
	}
}
