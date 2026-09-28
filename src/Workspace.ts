import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { URI } from 'vscode-uri';

import type { FunctionContext, FunctionDefinition, TerragruntConfig, Token } from './model';
import { createDependencyConfig, createIncludeConfig, TreeNode } from './model';
import { isLocalSource, ModuleVariableCache, splitModuleSource } from './module-variables';
import type { ModuleVariables } from './module-variables';
import type { ModuleVariablesState } from './ParsedDocument';
import { ParsedDocument } from './ParsedDocument';
import { Schema } from './Schema';
import { expandTerragruntGlob } from './functions/terragrunt_glob';

/** @returns true for an error from the filesystem, such as a directory that cannot be listed or a file that cannot be read. */
function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
		&& typeof (error as NodeJS.ErrnoException).syscall === 'string';
}

/**
 * The outcome of resolving a `terraform { source }` value. `local` names a directory that exists, `missing` one
 * that does not, `remote` any source that is not a local path, and `unresolvable` a source the path helpers could
 * not evaluate, with the reason.
 */
export type ModuleSourceResolution =
	| {
		kind: 'local' | 'missing';
		/** Absolute path of the module directory as written, including any `//subdirectory`, not its realpath. */
		moduleDir: string;
		/** The source after path functions and interpolations were evaluated. */
		sourceText: string;
	}
	| {
		kind: 'remote';
		/** The source after path functions and interpolations were evaluated. */
		sourceText: string;
	}
	| {
		kind: 'unresolvable';
		/** Why the source could not be evaluated or the subdirectory was refused. */
		reason: string;
	};

/**
 * A read path that cannot be known without evaluating the configuration, such as one interpolating a local whose value
 * comes from another file. The lineage graph drops that single edge rather than failing the whole document.
 */
class UnresolvableReadPath extends Error {}

interface ConfigRelationships {
	includes: string[];
	dependencies: string[];
	reads: string[];
}

export class Workspace {
	private documents: Map<string, ParsedDocument>;
	/** URI-level aggregate used by APIs that do not carry an originating unit. */
	private configMap: Map<string, TerragruntConfig>;
	/** Relationships resolved for each originating unit, then each source file. */
	private configContexts: Map<string, Map<string, ConfigRelationships>>;
	private workspaceRoot: string | null;
	private schema: Schema = Schema.getInstance();
	private configTreeRoot: TreeNode<TerragruntConfig> | undefined;
	private moduleVariables = new ModuleVariableCache();

	public constructor() {
		this.documents = new Map();
		this.configMap = new Map();
		this.configContexts = new Map();
		this.workspaceRoot = null;
	}

	/** `unitUri` is the unit whose lineage is being walked; includes resolve their paths for it, not their own. */
	private async updateConfigMap(doc: ParsedDocument, processedContexts = new Set<string>(), unitUri = doc.getUri()): Promise<void> {
		const uri = doc.getUri();
		const contextKey = `${unitUri}\0${uri}`;
		if (processedContexts.has(contextKey)) return;
		processedContexts.add(contextKey);
		const resolveFrom = path.dirname(URI.parse(unitUri).fsPath);

		const ast = doc.getAST();
		if (!ast) return;

		// First ensure the current config exists in the map
		let currentConfig = this.configMap.get(uri);
		if (!currentConfig) {
			currentConfig = {
				uri,
				content: doc.getContent(),
				includes: [],
				dependencies: [],
				reads: [],
				referencedBy: [],
				includedBy: [],
				dependedOnBy: [],
				readBy: [],
				sourcePath: URI.parse(uri).fsPath,
				targetPath: URI.parse(uri).fsPath,
				block: undefined,
				dependencyType: 'root',
				parameterValue: undefined
			};
			this.configMap.set(uri, currentConfig);
		}
		currentConfig.content = doc.getContent();

		// Process includes
		const includes = doc.findIncludeBlocks(ast);
		const includePaths = await Promise.all(includes.map(async inc => {
			const resolvedPath = await this.resolveIncludePath(inc.path, uri, resolveFrom);
			if (!await this.fileExists(URI.parse(resolvedPath).fsPath)) {
				throw new Error(`Included configuration not found: ${URI.parse(resolvedPath).fsPath}`);
			}

			// Create or update the included config
			let includedConfig = this.configMap.get(resolvedPath);
			if (!includedConfig) {
				const includedDoc = await this.getParsedDocument(resolvedPath);
				const outputs = await includedDoc?.getAllOutputs();

				includedConfig = createIncludeConfig(
					resolvedPath,
					'', // Content loaded later
					uri,
					resolvedPath,
					inc.block,
					outputs
				);
				this.configMap.set(resolvedPath, includedConfig);
			}

			return resolvedPath;
		}));

		// Inline functions are inherited through includes, so a document's
		// diagnostics can only settle once the configurations it includes have
		// been parsed. Supplying them here re-runs diagnostics with calls to
		// inherited functions resolved.
		await this.applyInheritedInlineFunctions(doc, includePaths, resolveFrom);

		// The module a unit sources is only known once its include chain is, because the `terraform` block and
		// part of the `inputs` may live in an included configuration.
		if (uri === unitUri) await this.applyModuleVariables(doc, includes, includePaths, resolveFrom);

		// Explicit stack components are graph edges even before `terragrunt stack generate`
		// materializes their target files.
		const componentPaths: string[] = [];
		if (this.schema.getFileKind(uri) === 'stack') {
			const rootToken = doc.getTokens()[0];
			for (const block of rootToken?.children.filter(child => child.type === 'block' && (child.value === 'unit' || child.value === 'stack')) ?? []) {
				const targetUri = await this.stackComponentTarget(block, uri);
				if (!targetUri) continue;
				const sourceAttribute = block.children.find(child => child.type === 'attribute' && child.value === 'source');
				const sourceValue = sourceAttribute?.children.find(child => child.type !== 'attribute_identifier');
				if (!sourceValue) throw new Error(`${block.value} "${this.getDependencyName(block) ?? ''}" requires source`);
				const source = sourceValue.getDisplayText();
				let component = this.configMap.get(targetUri);
				if (!component) {
					component = {
						uri: targetUri,
						content: source,
						includes: [],
						dependencies: [],
						reads: [],
						referencedBy: [],
						includedBy: [],
						dependedOnBy: [],
						readBy: [],
						sourcePath: source,
						targetPath: URI.parse(targetUri).fsPath,
						block,
						dependencyType: block.value as 'unit' | 'stack',
						parameterValue: this.getDependencyName(block)
					};
					this.configMap.set(targetUri, component);
				} else {
					if (component.dependencyType !== block.value || component.parameterValue !== this.getDependencyName(block) || component.sourcePath !== source) {
						throw new Error(`Conflicting generated stack component target: ${URI.parse(targetUri).fsPath}`);
					}
				}
				componentPaths.push(targetUri);
			}
		}

		// Dependencies inside a stack component's autoinclude body belong to that
		// generated component, not to the stack file that declares the component.
		const dependencyEntries = await doc.findDependencyBlocks(ast);
		const dependencyPaths: string[] = [];
		const ownedDependencies = new Map<string, string[]>();
		for (const dep of dependencyEntries) {
			let resolvedPath: string;
			try {
				resolvedPath = await this.resolveDependencyPath(dep.path, uri, resolveFrom);
			} catch (error) {
				// A config_path built from a value this file cannot see costs one graph edge, not the whole document's lineage.
				if (error instanceof UnresolvableReadPath) continue;
				throw error;
			}
			const exists = await this.fileExists(URI.parse(resolvedPath).fsPath);
			let depConfig = this.configMap.get(resolvedPath);
			let content = depConfig?.content ?? '';
			let outputs = depConfig?.outputs ?? new Map();
			if (exists) {
				content = await fs.readFile(URI.parse(resolvedPath).fsPath, 'utf-8');
				const dependencyDocument = await this.getParsedDocument(resolvedPath);
				if (!dependencyDocument) throw new Error(`Unable to parse dependency configuration: ${URI.parse(resolvedPath).fsPath}`);
				outputs = await dependencyDocument.getAllOutputs();
			} else if (!depConfig) {
				throw new Error(`Dependency configuration not found: ${URI.parse(resolvedPath).fsPath}`);
			}

			if (!depConfig) {
				depConfig = createDependencyConfig(resolvedPath, content, uri, resolvedPath, dep.block, dep.parameter, outputs);
				this.configMap.set(resolvedPath, depConfig);
			} else depConfig.outputs = outputs;

			let ownerUri = uri;
			if (this.schema.getFileKind(uri) === 'stack' && dep.owner) {
				if (dep.owner.value === 'stack') throw new Error('Nested stacks cannot declare dependencies through autoinclude');
				ownerUri = await this.stackComponentTarget(dep.owner, uri) ?? uri;
			}
			const ownerConfig = this.configMap.get(ownerUri);
			if (!ownerConfig) throw new Error(`Dependency owner is missing from workspace graph: ${ownerUri}`);
			const ownerDependencies = ownedDependencies.get(ownerUri) ?? [];
			if (!ownerDependencies.includes(resolvedPath)) ownerDependencies.push(resolvedPath);
			ownedDependencies.set(ownerUri, ownerDependencies);
			if (ownerUri === uri) dependencyPaths.push(resolvedPath);
		}

		const readPaths = await this.resolveReadPaths(doc, resolveFrom);
		for (const readUri of readPaths) {
			let readConfig = this.configMap.get(readUri);
			if (!readConfig) {
				readConfig = {
					uri: readUri,
					content: await fs.readFile(URI.parse(readUri).fsPath, 'utf8'),
					includes: [],
					dependencies: [],
					reads: [],
					referencedBy: [],
					includedBy: [],
					dependedOnBy: [],
					readBy: [],
					sourcePath: URI.parse(uri).fsPath,
					targetPath: URI.parse(readUri).fsPath,
					dependencyType: 'read'
				};
				this.configMap.set(readUri, readConfig);
			}
		}

		this.setContextRelationships(unitUri, uri, {
			includes: includePaths,
			dependencies: [...dependencyPaths, ...componentPaths],
			reads: readPaths
		});
		for (const [ownerUri, dependencies] of ownedDependencies) {
			if (ownerUri === uri) continue;
			this.setContextRelationships(unitUri, ownerUri, { includes: [], dependencies, reads: [] });
		}
		this.configMap.set(uri, currentConfig);

		// HCL files consumed with read_terragrunt_config can themselves include or
		// read other files. Preserve that transitive lineage instead of flattening it.
		const readableHclPaths = readPaths.filter(readUri => path.extname(URI.parse(readUri).fsPath) === '.hcl');
		// Only includes inherit this unit; a read or dependency target is a config in its own right.
		for (const refUri of includePaths) {
			if (refUri && !processedContexts.has(`${unitUri}\0${refUri}`)) {
				const refDoc = await this.getParsedDocument(refUri);
				if (refDoc) await this.updateConfigMap(refDoc, processedContexts, unitUri);
			}
		}
		for (const refUri of [...dependencyPaths, ...readableHclPaths]) {
			if (refUri && !processedContexts.has(`${refUri}\0${refUri}`)) {
				const refDoc = await this.getParsedDocument(refUri);
				if (refDoc) await this.updateConfigMap(refDoc, processedContexts, refUri);
			}
		}
	}

	private setContextRelationships(
		unitUri: string,
		sourceUri: string,
		relationships: ConfigRelationships
	): void {
		let unitContexts = this.configContexts.get(unitUri);
		if (!unitContexts) {
			unitContexts = new Map();
			this.configContexts.set(unitUri, unitContexts);
		}
		unitContexts.set(sourceUri, {
			includes: [...new Set(relationships.includes)].sort(),
			dependencies: [...new Set(relationships.dependencies)].sort(),
			reads: [...new Set(relationships.reads)].sort()
		});
	}

	private relationshipsFor(unitUri: string, source: TerragruntConfig): ConfigRelationships {
		const relationships = this.configContexts.get(unitUri)?.get(source.uri);
		if (relationships) return relationships;

		const extension = path.extname(URI.parse(source.uri).fsPath);
		const nonHclRead = source.dependencyType === 'read' && extension !== '.hcl';
		const ungeneratedComponent = (source.dependencyType === 'unit' || source.dependencyType === 'stack')
			&& !this.documents.has(source.uri);
		if (nonHclRead || ungeneratedComponent) return { includes: [], dependencies: [], reads: [] };

		throw new Error(`Missing workspace context for ${source.uri} while evaluating ${unitUri}`);
	}

	/** Rebuild URI-level reverse indexes from every unit-specific resolution. */
	private syncConfigRelationships(): void {
		const activeUris = new Set<string>();
		for (const unitContexts of this.configContexts.values()) {
			for (const [sourceUri, relationships] of unitContexts) {
				activeUris.add(sourceUri);
				for (const targetUri of [
					...relationships.includes,
					...relationships.dependencies,
					...relationships.reads
				]) activeUris.add(targetUri);
			}
		}

		for (const uri of [...this.configMap.keys()]) {
			if (!activeUris.has(uri)) this.configMap.delete(uri);
		}
		for (const config of this.configMap.values()) {
			config.includes = [];
			config.dependencies = [];
			config.reads = [];
			config.referencedBy = [];
			config.includedBy = [];
			config.dependedOnBy = [];
			config.readBy = [];
		}

		const connect = (
			source: TerragruntConfig,
			targetUri: string,
			forward: 'includes' | 'dependencies' | 'reads',
			reverse: 'includedBy' | 'dependedOnBy' | 'readBy'
		): void => {
			const target = this.configMap.get(targetUri);
			if (!target) throw new Error(`Missing configuration ${targetUri} referenced from ${source.uri}`);
			if (!source[forward].includes(targetUri)) source[forward].push(targetUri);
			if (!target.referencedBy.includes(source.uri)) target.referencedBy.push(source.uri);
			if (!target[reverse].includes(source.uri)) target[reverse].push(source.uri);
		};

		for (const unitContexts of this.configContexts.values()) {
			for (const [sourceUri, relationships] of unitContexts) {
				const source = this.configMap.get(sourceUri);
				if (!source) throw new Error(`Missing configuration data for workspace context ${sourceUri}`);
				for (const target of relationships.includes) connect(source, target, 'includes', 'includedBy');
				for (const target of relationships.dependencies) connect(source, target, 'dependencies', 'dependedOnBy');
				for (const target of relationships.reads) connect(source, target, 'reads', 'readBy');
			}
		}

		for (const config of this.configMap.values()) {
			config.includes.sort();
			config.dependencies.sort();
			config.reads.sort();
			config.referencedBy.sort();
			config.includedBy.sort();
			config.dependedOnBy.sort();
			config.readBy.sort();
		}
	}

	private async stackComponentTarget(block: Token, stackUri: string): Promise<string | null> {
		if (block.type !== 'block' || (block.value !== 'unit' && block.value !== 'stack')) {
			throw new Error(`Expected a unit or stack component block, got ${block.type}:${block.value}`);
		}
		const pathAttribute = block.children.find(child => child.type === 'attribute' && child.value === 'path');
		const pathValue = pathAttribute?.children.find(child => child.type !== 'attribute_identifier');
		if (!pathValue) {
			return null;
		}
		const baseDir = path.dirname(URI.parse(stackUri).fsPath);
		const configPath = await this.resolvePathToken(pathValue, baseDir, stackUri);
		const noStackAttribute = block.children.find(child => child.type === 'attribute' && child.value === 'no_dot_terragrunt_stack');
		const noStack = noStackAttribute?.children.some(child => child.type === 'boolean_lit' && child.value === true) === true;
		const targetDir = path.resolve(noStack ? baseDir : path.join(baseDir, '.terragrunt-stack'), configPath);
		return URI.file(path.join(targetDir, block.value === 'unit' ? 'terragrunt.hcl' : 'terragrunt.stack.hcl')).toString();
	}

	private async resolvePathToken(pathToken: Token, sourceDir: string, sourceUri: string): Promise<string> {
		switch (pathToken.type) {
			case 'string_lit': {
				return String(pathToken.value);
			}
			case 'interpolated_string': {
				const parts = await Promise.all(
					pathToken.children.map(async child => {
						if (child.type === 'interpolation') {
							const innerToken = child.children[0];
							if (!innerToken) throw new Error('Empty path interpolation');
							return this.evaluatePathExpression(innerToken, sourceDir, sourceUri);
						}
						if (child.type === 'string_lit') return String(child.value);
						throw new Error(`Unsupported path segment: ${child.type}`);
					})
				);
				return parts.join('');
			}
			case 'function_call': {
				return this.evaluatePathFunction(pathToken, sourceDir, sourceUri);
			}
			default: throw new Error(`Unsupported path expression for workspace graph resolution: ${pathToken.type}`);
		}
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return false;
			throw error;
		}
	}

	private async findRepositoryRoot(startDir: string): Promise<string | undefined> {
		let current = path.resolve(startDir);
		while (true) {
			if (await this.fileExists(path.join(current, '.git'))) return current;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}

	public async resolveDependencyPath(pathToken: Token, sourceUri: string, unitDir?: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);
		const resolveFrom = unitDir ?? sourceDir;

		if (pathToken.type === 'reference') {
			const namespace = pathToken.children.find(child => child.type === 'namespace')?.value;
			const access = pathToken.children.find(child => child.type === 'access_chain')?.children.map(child => child.value);
			if ((namespace !== 'unit' && namespace !== 'stack') || access?.length !== 2 || access[1] !== 'path' || typeof access[0] !== 'string') {
				throw new Error(`Dependency paths only support unit.<name>.path or stack.<name>.path references, got ${pathToken.getDisplayText()}`);
			}
			const sourceDocument = await this.getParsedDocument(sourceUri);
			const component = sourceDocument?.getTokens()[0]?.children.find(child =>
				child.type === 'block' && child.value === namespace && this.getDependencyName(child) === access[0]
			);
			if (!component) throw new Error(`Unknown ${namespace} component referenced by dependency path: ${access[0]}`);
			const target = await this.stackComponentTarget(component, sourceUri);
			if (!target) throw new Error(`Referenced ${namespace} "${access[0]}" has no path attribute`);
			return target;
		}

		const configPath = await this.resolvePathToken(pathToken, resolveFrom, sourceUri);

		// Resolve the final path
		const resolvedPath = path.isAbsolute(configPath) ?
			configPath :
			path.resolve(resolveFrom, configPath);

		// Explicit HCL paths are authoritative.
		if (path.extname(resolvedPath) === '.hcl') {
			return URI.file(resolvedPath).toString();
		}

		const unitPath = path.join(resolvedPath, 'terragrunt.hcl');
		const stackPath = path.join(resolvedPath, 'terragrunt.stack.hcl');
		const [hasUnit, hasStack] = await Promise.all([this.fileExists(unitPath), this.fileExists(stackPath)]);
		if (hasUnit && hasStack) throw new Error(`Ambiguous dependency path ${resolvedPath}: both unit and stack configuration files exist`);
		if (hasUnit) return URI.file(unitPath).toString();
		if (hasStack) return URI.file(stackPath).toString();
		throw new Error(`Dependency path ${resolvedPath} contains neither terragrunt.hcl nor terragrunt.stack.hcl`);
	}

	/**
	 * Supplies a document with the inline functions it inherits through its
	 * includes, walking the include chain transitively. Nearer declarations win,
	 * so a definition found in a directly included configuration is not replaced
	 * by one of the same name further up the chain. Already-visited URIs are
	 * skipped, so a cyclic include graph terminates rather than recursing
	 * forever.
	 */
	private async applyInheritedInlineFunctions(doc: ParsedDocument, includePaths: string[], unitDir: string): Promise<void> {
		if (includePaths.length === 0) return;

		const inherited = new Map<string, FunctionDefinition>();
		for (const included of await this.includeChain(doc, includePaths, unitDir)) {
			for (const [name, definition] of included.getOwnInlineFunctions()) {
				if (!inherited.has(name)) inherited.set(name, definition);
			}
		}

		doc.setInheritedInlineFunctions(inherited);
	}

	/**
	 * The configurations `doc` includes, nearest first, walked transitively. Already-visited URIs are skipped, so a
	 * cyclic include graph terminates rather than recursing forever.
	 *
	 * @param doc the document whose includes are walked.
	 * @param includePaths URIs of the configurations `doc` includes directly.
	 * @param unitDir directory of the unit the walk serves, which nested include paths resolve against.
	 * @returns the included documents that could be loaded, in breadth-first order.
	 */
	private async includeChain(doc: ParsedDocument, includePaths: string[], unitDir: string): Promise<ParsedDocument[]> {
		const chain: ParsedDocument[] = [];
		const visited = new Set<string>([doc.getUri()]);
		const queue = [...includePaths];
		while (queue.length > 0) {
			const includeUri = queue.shift()!;
			if (visited.has(includeUri)) continue;
			visited.add(includeUri);

			const included = await this.getParsedDocument(includeUri);
			if (!included) continue;
			chain.push(included);

			const includedAst = included.getAST();
			if (!includedAst) continue;
			for (const nested of included.findIncludeBlocks(includedAst)) {
				try {
					queue.push(await this.resolveIncludePath(nested.path, includeUri, unitDir));
				} catch {
					// An include this document cannot resolve is reported by the
					// include processing that owns that document; it contributes
					// nothing to the chain here.
				}
			}
		}
		return chain;
	}

	/**
	 * The value of `source` in a document's root `terraform` block, whatever form it takes.
	 *
	 * @param doc the document to look in.
	 * @returns the value token, or undefined when the document sets no `source`.
	 */
	public findTerraformSourceToken(doc: ParsedDocument): Token | undefined {
		return doc.getTerraformSourceToken();
	}

	/**
	 * Resolves a `terraform { source }` value to a module directory. Only local sources are resolved; anything else
	 * is reported as `remote`. Never throws: a source the path helpers cannot evaluate is `unresolvable`.
	 * `unitDir` is the unit this resolution serves; a relative source written in an included configuration is
	 * resolved against it, as Terragrunt does.
	 *
	 * @param token the `source` value token.
	 * @param sourceUri URI of the file the token is written in.
	 * @param unitDir directory of the unit being resolved for; defaults to the directory of `sourceUri`.
	 * @returns `local` with the module directory, `missing` when that directory does not exist, `remote` for any
	 *   non-local source, or `unresolvable` with the reason.
	 */
	public async resolveModuleSource(token: Token, sourceUri: string, unitDir?: string): Promise<ModuleSourceResolution> {
		const resolveFrom = unitDir ?? path.dirname(URI.parse(sourceUri).fsPath);
		let sourceText: string;
		try {
			sourceText = await this.resolvePathToken(token, resolveFrom, sourceUri);
		} catch (error) {
			return { kind: 'unresolvable', reason: error instanceof Error ? error.message : String(error) };
		}
		const parts = splitModuleSource(sourceText);
		if (parts.forced || !isLocalSource(parts.repository)) return { kind: 'remote', sourceText };
		let moduleDir: string;
		try {
			moduleDir = parts.repository.startsWith('file://')
				? fileURLToPath(new URL(parts.repository))
				: path.resolve(resolveFrom, parts.repository);
		} catch (error) {
			return { kind: 'unresolvable', reason: error instanceof Error ? error.message : String(error) };
		}
		// The directory is reported as written, so hovers and messages show the path the author used; the real
		// paths are only consulted to check that a `//subdirectory` stays inside the module.
		const selected = path.resolve(moduleDir, parts.subdirectory);
		let realRoot: string;
		let realSelected: string;
		try {
			realRoot = await fs.realpath(moduleDir);
			realSelected = await fs.realpath(selected);
		} catch {
			return { kind: 'missing', moduleDir: selected, sourceText };
		}
		const relative = path.relative(realRoot, realSelected);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return { kind: 'unresolvable', reason: `Module source subdirectory escapes repository: ${sourceText}` };
		}
		if (!(await fs.stat(realSelected)).isDirectory()) return { kind: 'missing', moduleDir: selected, sourceText };
		return { kind: 'local', moduleDir: selected, sourceText };
	}

	/**
	 * The file an editor should open for a module directory: `variables.tf`, then `main.tf`, then the first
	 * Terraform file it holds. Editors cannot open a directory as a text document, so a module with no `.tf`
	 * files has no target.
	 *
	 * @param moduleDir absolute path of the module directory.
	 * @returns absolute path of the file to open, or undefined when the module has no Terraform files or cannot be
	 *   read.
	 */
	public async moduleEntryFile(moduleDir: string): Promise<string | undefined> {
		let files: string[];
		try {
			files = (await this.moduleVariables.get(moduleDir)).files;
		} catch {
			return undefined;
		}
		for (const name of ['variables.tf', 'main.tf']) {
			const match = files.find(file => path.basename(file) === name);
			if (match) return match;
		}
		return files[0];
	}

	/**
	 * Supplies a unit with the variables of the module it sources. Included configurations that are not
	 * `terragrunt.hcl` get no state when opened on their own: their sources resolve against the unit that includes
	 * them, not against themselves.
	 *
	 * @param doc the unit being processed.
	 * @param includes the unit's include blocks whose paths resolved, in the order written.
	 * @param includePaths URIs of those includes' configurations, index for index with `includes`.
	 * @param unitDir directory of the unit, which the source and the includes resolve against.
	 */
	private async applyModuleVariables(
		doc: ParsedDocument,
		includes: { path: Token; block: Token }[],
		includePaths: string[],
		unitDir: string
	): Promise<void> {
		const uri = doc.getUri();
		if (this.schema.getFileKind(uri) !== 'unit' || path.basename(URI.parse(uri).fsPath) !== 'terragrunt.hcl') {
			doc.setModuleVariables(undefined);
			return;
		}
		doc.setModuleVariables(await this.moduleVariablesFor(doc, includes, includePaths, unitDir));
	}

	/**
	 * The module a unit runs and the inputs it is given, from the configurations Terragrunt merges into the unit
	 * (see {@link mergedConfigurations}). The first of them, in merge priority, that sets `terraform { source }`
	 * names the module, and the literal `inputs` keys of the others count towards its required variables.
	 *
	 * Every outcome is explicit: a remote source is not checked and yields no state; a configuration or source that
	 * cannot be determined, or a module that cannot be read, yields `unavailable` with the reason. Anything else that
	 * goes wrong is a defect and propagates.
	 */
	private async moduleVariablesFor(
		doc: ParsedDocument,
		includes: { path: Token; block: Token }[],
		includePaths: string[],
		unitDir: string
	): Promise<ModuleVariablesState | undefined> {
		const merged = await this.mergedConfigurations(doc, includes, includePaths, unitDir);
		if ('reason' in merged) return { status: 'unavailable', reason: merged.reason, sourceInThisFile: false };

		let owner: ParsedDocument | undefined;
		for (const configuration of merged.configurations) {
			if (configuration.getAST() === null) {
				return {
					status: 'unavailable',
					reason: `${this.displayPath(configuration.getUri(), unitDir)} does not parse, so the module source it may set is unknown`,
					sourceInThisFile: false
				};
			}
			if (this.findTerraformSourceToken(configuration) !== undefined) {
				owner = configuration;
				break;
			}
		}
		if (!owner) return undefined;
		const sourceInThisFile = owner === doc;

		const resolution = await this.resolveModuleSource(this.findTerraformSourceToken(owner)!, owner.getUri(), unitDir);
		if (resolution.kind === 'remote') return undefined;
		if (resolution.kind === 'unresolvable') {
			return { status: 'unavailable', reason: `the module source could not be resolved: ${resolution.reason}`, sourceInThisFile };
		}
		if (resolution.kind === 'missing') {
			return { status: 'missing', moduleDir: resolution.moduleDir, sourceText: resolution.sourceText, sourceInThisFile };
		}

		let module: ModuleVariables;
		try {
			module = await this.moduleVariables.get(resolution.moduleDir);
		} catch (error) {
			if (!isFileSystemError(error)) throw error;
			return { status: 'unavailable', reason: `module ${resolution.moduleDir} could not be read: ${error.message}`, sourceInThisFile };
		}

		const inheritedInputKeys = new Set<string>();
		let inheritedInputsKnown = true;
		let inheritedInputsProblem: string | undefined;
		for (const configuration of merged.configurations) {
			if (configuration === doc) continue;
			if (configuration.getAST() === null) {
				inheritedInputsKnown = false;
				inheritedInputsProblem ??= `${this.displayPath(configuration.getUri(), unitDir)} does not parse, so the inputs it sets are unknown`;
				continue;
			}
			const keys = configuration.getOwnInputKeys();
			if (keys === undefined) inheritedInputsKnown = false;
			else for (const key of keys) inheritedInputKeys.add(key);
		}
		return {
			status: 'loaded',
			moduleDir: resolution.moduleDir,
			sourceText: resolution.sourceText,
			sourceInThisFile,
			variables: module.variables,
			files: module.files,
			unparsed: module.unparsed,
			inheritedInputKeys,
			inheritedInputsKnown,
			inheritedInputsProblem
		};
	}

	/**
	 * The configurations Terragrunt merges into a unit, highest priority first, as far as `terraform { source }` and
	 * `inputs` go. Terragrunt merges the sibling `terragrunt.autoinclude.hcl` over the unit, winning where both set
	 * something, then merges each direct include beneath the result, the last include first, so a later include wins
	 * over an earlier one and the unit over every include. An include with `merge_strategy = "no_merge"` is not
	 * merged at all.
	 *
	 * What Terragrunt refuses -- an included configuration with include blocks of its own, `deep_map_only`, an
	 * unknown strategy -- and what cannot be read statically -- an include path or strategy written as an expression
	 * this does not evaluate -- is returned as a reason instead.
	 *
	 * @returns the configurations in priority order, or the reason they cannot be determined.
	 */
	private async mergedConfigurations(
		doc: ParsedDocument,
		includes: { path: Token; block: Token }[],
		includePaths: string[],
		unitDir: string
	): Promise<{ configurations: ParsedDocument[] } | { reason: string }> {
		const written = doc.getIncludeBlockTokens();
		if (written.length !== includes.length) {
			const unread = written.find(block => !includes.some(include => include.block.startPosition.line === block.startPosition.line
				&& include.block.startPosition.character === block.startPosition.character));
			return { reason: `the path of ${this.includeName(unread ?? written[0])} is not a string, interpolation or function call, so the configuration it merges in cannot be determined` };
		}

		const merged: ParsedDocument[] = [];
		for (const [index, include] of includes.entries()) {
			const strategy = this.includeMergeStrategy(include.block);
			if ('reason' in strategy) return strategy;
			const included = await this.getParsedDocument(includePaths[index]);
			if (!included) {
				return { reason: `${this.includeName(include.block)} names ${this.displayPath(includePaths[index], unitDir)}, which could not be read` };
			}
			if (included.getAST() !== null && included.getIncludeBlockTokens().length > 0) {
				return {
					reason: `${this.displayPath(includePaths[index], unitDir)}, included by ${this.includeName(include.block)}, has include blocks of its own; Terragrunt does not support nested includes`
				};
			}
			if (strategy.strategy !== 'no_merge') merged.push(included);
		}

		const configurations = [doc, ...merged.reverse()];
		const autoinclude = path.join(unitDir, 'terragrunt.autoinclude.hcl');
		if (await this.fileExists(autoinclude)) {
			const autoincludeDoc = await this.getParsedDocument(URI.file(autoinclude).toString());
			if (!autoincludeDoc) return { reason: `${this.displayPath(URI.file(autoinclude).toString(), unitDir)} exists but could not be read` };
			configurations.unshift(autoincludeDoc);
		}
		return { configurations };
	}

	/**
	 * @param block an `include` block token.
	 * @returns the strategy Terragrunt would merge the include with, or the reason it cannot be known or would be
	 *   refused.
	 */
	private includeMergeStrategy(block: Token): { strategy: 'no_merge' | 'shallow' | 'deep' } | { reason: string } {
		const attribute = block.children.find(child => child.type === 'attribute' && child.value === 'merge_strategy');
		if (!attribute) return { strategy: 'shallow' };
		const value = attribute.children.find(child => child.type !== 'attribute_identifier');
		if (value?.type !== 'string_lit') {
			return { reason: `${this.includeName(block)} sets merge_strategy with an expression, so whether its source and inputs are merged cannot be determined` };
		}
		const strategy = String(value.value);
		if (strategy === 'no_merge' || strategy === 'shallow' || strategy === 'deep') return { strategy };
		if (strategy === 'deep_map_only') {
			return { reason: `${this.includeName(block)} uses merge_strategy "deep_map_only", which Terragrunt does not support on include blocks` };
		}
		return { reason: `${this.includeName(block)} has merge_strategy "${strategy}", which is not one of no_merge, shallow or deep` };
	}

	/** @returns `include "label"`, or `include` for an unlabelled block, as messages name it. */
	private includeName(block: Token): string {
		const label = block.children.find(child => child.type === 'parameter');
		return label ? `include "${String(label.value)}"` : 'include';
	}

	/** @returns the file at `uri` relative to the unit's directory, as messages name it. */
	private displayPath(uri: string, unitDir: string): string {
		return path.relative(unitDir, URI.parse(uri).fsPath) || '.';
	}

	/** `unitDir` is the unit this resolution started from; it differs from the source file in an include chain. */
	public async resolveIncludePath(pathToken: Token, sourceUri: string, unitDir?: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);
		const resolveFrom = unitDir ?? sourceDir;

		if (pathToken.type === 'function_call') {
			const resolved = await this.evaluatePathFunction(pathToken, resolveFrom, sourceUri);
			if (!path.isAbsolute(resolved)) throw new Error(`Include function returned a non-absolute path: ${resolved}`);
			return URI.file(resolved).toString();
		}

		if (pathToken.type === 'string_lit' || pathToken.type === 'interpolated_string') {
			const configPath = pathToken.type === 'string_lit'
				? String(pathToken.value)
				: (await Promise.all(pathToken.children.map(async child => {
					if (child.type === 'interpolation') {
						const expression = child.children[0];
						if (!expression) throw new Error('Empty include path interpolation');
						return this.evaluatePathExpression(expression, resolveFrom, sourceUri);
					}
					if (child.type === 'string_lit') return String(child.value);
					throw new Error(`Unsupported include path segment: ${child.type}`);
				}))).join('');
			// For absolute paths use as-is, otherwise resolve relative to source
			const resolvedPath = path.isAbsolute(configPath) ?
				configPath :
				path.resolve(sourceDir, configPath);

			if (path.extname(resolvedPath) !== '.hcl') throw new Error(`Include path must name an HCL file: ${resolvedPath}`);
			return URI.file(resolvedPath).toString();
		}

		throw new Error(`Unsupported include path expression: ${pathToken.type}`);
	}
	private async evaluatePathExpression(
		token: Token,
		sourceDir: string,
		sourceUri = URI.file(sourceDir).toString(),
		seen: ReadonlySet<string> = new Set()
	): Promise<string> {
		switch (token.type) {
			case 'function_call': {
				return this.evaluatePathFunction(token, sourceDir, sourceUri, seen);
			}
			case 'string_lit': {
				return String(token.value);
			}
			case 'local_reference': {
				return this.evaluateReadPath(token, sourceDir, sourceUri, seen);
			}
			default: throw new Error(`Unsupported path interpolation expression: ${token.type}`);
		}
	}
	private async evaluatePathFunction(
		token: Token,
		sourceDir: string,
		sourceUri = URI.file(sourceDir).toString(),
		seen: ReadonlySet<string> = new Set()
	): Promise<string> {
		const functionIdentifier = token.children.find(c => c.type === 'function_identifier');
		const funcName = functionIdentifier?.value as string;

		if (!funcName) {
			throw new Error('Path function call has no function identifier');
		}

		// Create function context
		const context: FunctionContext = {
			workingDirectory: sourceDir,
			environmentVariables: Object.fromEntries(
				Object.entries(process.env).filter(([_, v]) => v !== undefined)
			) as Record<string, string>,
			document: {
					uri: sourceUri,
				content: '' // Not needed for path functions
			},
			// Without this `find_in_parent_folders` falls back to the document URI and starts one level above the file doing the
			// searching.
			terragruntDir: sourceDir,
			repoRoot: await this.findRepositoryRoot(sourceDir),
			fs: { access: async filePath => fs.access(filePath) }
		};

		const args = await Promise.all(token.children
			.filter(child => child.type !== 'function_identifier')
			.map(async argument => ({
				type: 'string' as const,
				value: await this.evaluateReadPath(argument, sourceDir, sourceUri, seen)
			})));

		const result = await this.schema.getFunctionRegistry().evaluateFunction(funcName, args, context);
		if (!result || result.type !== 'string' || typeof result.value !== 'string') {
			throw new Error(`Path function ${funcName} did not return a string`);
		}
		return result.value;
	}

	private async resolveReadPaths(document: ParsedDocument, unitDir?: string): Promise<string[]> {
		const trackedFunctions = new Set([
			'mark_as_read',
			'mark_glob_as_read',
			'read_terragrunt_config',
			'read_tfvars_file',
			'sops_decrypt_file'
		]);
		const calls: Token[] = [];
		const isInsideLocals = (token: Token): boolean => {
			let ancestor = token.parent;
			while (ancestor) {
				if (ancestor.type === 'block' && ancestor.value === 'locals') return true;
				ancestor = ancestor.parent;
			}
			return false;
		};
		const visit = (token: Token): void => {
			const name = token.value?.toString() ?? '';
			const queueMarker = name === 'mark_as_read' || name === 'mark_glob_as_read';
			if (token.type === 'function_call' && trackedFunctions.has(name) && (!queueMarker || isInsideLocals(token))) calls.push(token);
			for (const child of token.children) visit(child);
		};
		for (const token of document.getTokens()) visit(token);

		const sourceUri = document.getUri();
		const sourceDir = path.dirname(URI.parse(sourceUri).fsPath);
		// Terragrunt evaluates tracked read paths in the unit context, including
		// bare relative paths authored in an included configuration.
		const resolveFrom = unitDir ?? sourceDir;
		const reads = new Set<string>();
		for (const call of calls) {
			const arguments_ = call.children.filter(child => child.type !== 'function_identifier');
			const argument = arguments_[0];
			if (!argument) throw new Error(`${call.value} requires a file path argument`);
			if (call.value === 'mark_glob_as_read') {
				let values: string[];
				try {
					values = await Promise.all(arguments_.map(value => this.evaluateReadPath(value, resolveFrom, sourceUri)));
				} catch (error) {
					if (error instanceof UnresolvableReadPath) continue;
					throw error;
				}
				for (const match of await expandTerragruntGlob(values, resolveFrom)) reads.add(URI.file(match).toString());
				continue;
			}
			let configuredPath: string;
			try {
				configuredPath = await this.evaluateReadPath(argument, resolveFrom, sourceUri);
			} catch (error) {
				if (error instanceof UnresolvableReadPath) continue;
				throw error;
			}
			if (call.value === 'mark_as_read' && !path.isAbsolute(configuredPath)) {
				throw new Error(`mark_as_read requires an absolute path, got ${configuredPath}`);
			}
			// Both a bare relative read and a path built by a unit-relative
			// function resolve from the originating unit.
			const resolvedPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(resolveFrom, configuredPath);
			if (!await this.fileExists(resolvedPath)) throw new Error(`${call.value} target not found: ${resolvedPath}`);
			reads.add(URI.file(resolvedPath).toString());
		}
		return [...reads].sort();
	}

	/** The value token of `local.<name>`, found in the locals block of the file the reference sits in. */
	private findLocalDefinition(token: Token, name: string): Token | undefined {
		let root: Token = token;
		while (root.parent) root = root.parent;
		let found: Token | undefined;
		const visit = (candidate: Token): void => {
			if (found) return;
			if (candidate.type === 'block' && candidate.value === 'locals') {
				for (const attribute of candidate.children) {
					if (attribute.type !== 'attribute' || attribute.value !== name) continue;
					found = attribute.children.find(child =>
						child.type !== 'identifier' && child.type !== 'attribute_identifier');
					if (found) return;
				}
			}
			for (const child of candidate.children) visit(child);
		};
		visit(root);
		return found;
	}

	private async evaluateReadPath(
		token: Token,
		sourceDir: string,
		sourceUri: string,
		seen: ReadonlySet<string> = new Set()
	): Promise<string> {
		if (token.type === 'string_lit') return String(token.value);
		if (token.type === 'function_call') return this.evaluatePathFunction(token, sourceDir, sourceUri, seen);
		if (token.type === 'local_reference') {
			const name = token.children
				.find(child => child.type === 'access_chain')?.children
				.find(child => child.type === 'reference_identifier')?.value;
			if (typeof name !== 'string') throw new Error('Malformed local reference in a read path');
			if (seen.has(name)) throw new Error(`Local ${name} refers to itself in a read path`);
			// An access chain past the name (`local.stage_vars.stage`) indexes into a value, which is not something a path walk
			// can produce.
			const chain = token.children.find(child => child.type === 'access_chain')?.children ?? [];
			if (chain.filter(child => child.type === 'reference_identifier').length > 1) {
				throw new UnresolvableReadPath(`local.${name} is indexed in a read path`);
			}
			const definition = this.findLocalDefinition(token, name);
			if (!definition) throw new Error(`Undefined local.${name} in a read path`);
			return this.evaluateReadPath(definition, sourceDir, sourceUri, new Set([...seen, name]));
		}
		if (token.type === 'interpolated_string') {
			const parts = await Promise.all(token.children.map(async child => {
				if (child.type === 'string_lit') return String(child.value);
				if (child.type === 'interpolation' && child.children[0]) {
					return this.evaluateReadPath(child.children[0], sourceDir, sourceUri, seen);
				}
				throw new Error(`Unsupported read path segment: ${child.type}`);
			}));
			return parts.join('');
		}
		throw new Error(`Unsupported read path expression: ${token.type}`);
	}

	private async buildDependencyTree(): Promise<void> {
		if (!this.workspaceRoot) return;

		// Discover both unit and explicit stack entrypoints.
		const configs = await this.findTerragruntConfigs(this.workspaceRoot);

		// First pass: Load and parse all configs
		for (const uri of configs) {
			const doc = await this.getParsedDocument(uri);
			if (doc) {
				await this.updateConfigMap(doc);
			}
		}
		this.syncConfigRelationships();

		// Second pass: verify that the graph is closed over every authored edge.
		for (const [uri, config] of this.configMap.entries()) {
			for (const depUri of [...config.includes, ...config.dependencies, ...config.reads]) {
				if (!this.configMap.has(depUri)) {
					throw new Error(`Missing configuration ${depUri} referenced from ${uri}`);
				}
			}
		}
		for (const config of this.configMap.values()) {
			const reading = new Set<string>();
			for (const [unitUri, contexts] of this.configContexts) {
				if (!contexts.has(config.uri)) continue;
				for (const readUri of this.collectReading(unitUri, config.uri, new Set())) reading.add(readUri);
			}
			config.reading = [...reading].sort();
			config.external = this.isExternal(config.uri);
		}

		const rootUri = this.workspaceRoot;
		const rootData: TerragruntConfig = {
			uri: rootUri,
			content: '',
			includes: [],
			dependencies: [],
			reads: [],
			referencedBy: [],
			includedBy: [],
			dependedOnBy: [],
			readBy: [],
			reading: [],
			external: false,
			sourcePath: URI.parse(rootUri).fsPath,
			targetPath: URI.parse(rootUri).fsPath,
			dependencyType: 'root'
		};
		this.configTreeRoot = new TreeNode(rootData, path.basename(URI.parse(rootUri).fsPath), 'workspace');
		const roots = [...this.configMap.values()].filter(config => config.referencedBy.length === 0);
		if (roots.length === 0 && this.configMap.size > 0) {
			throw new Error('Configuration graph has no roots; check for include or dependency cycles');
		}
		for (const config of roots) {
			const contextual = this.contextualConfig(config.uri, config);
			const node = this.configTreeRoot.addChild(contextual, this.formatPath(config.uri), config.dependencyType);
			await this.traverseConfigTree(node, config.uri, new Set());
		}
	}

	private contextualConfig(unitUri: string, config: TerragruntConfig): TerragruntConfig {
		const relationships = this.relationshipsFor(unitUri, config);
		return {
			...config,
			includes: [...relationships.includes],
			dependencies: [...relationships.dependencies],
			reads: [...relationships.reads],
			reading: this.collectReading(unitUri, config.uri, new Set()),
			external: this.isExternal(config.uri)
		};
	}

	private collectReading(unitUri: string, uri: string, ancestry: Set<string>): string[] {
		const contextKey = `${unitUri}\0${uri}`;
		if (ancestry.has(contextKey)) throw new Error(`Reading cycle detected at ${uri}`);
		const config = this.configMap.get(uri);
		if (!config) throw new Error(`Cannot collect reading lineage for missing configuration ${uri}`);
		const relationships = this.relationshipsFor(unitUri, config);
		const nextAncestry = new Set(ancestry);
		nextAncestry.add(contextKey);
		const reading = new Set(relationships.reads);
		for (const includeUri of relationships.includes) {
			for (const transitiveUri of this.collectReading(unitUri, includeUri, nextAncestry)) reading.add(transitiveUri);
		}
		for (const readUri of relationships.reads) {
			const readConfig = this.configMap.get(readUri);
			if (!readConfig) throw new Error(`Reading lineage references missing file ${readUri}`);
			for (const transitiveUri of this.collectReading(readUri, readUri, nextAncestry)) reading.add(transitiveUri);
		}
		return [...reading].sort();
	}

	private isExternal(uri: string): boolean {
		if (!this.workspaceRoot) throw new Error('Cannot classify an external configuration without a workspace root');
		const relative = path.relative(URI.parse(this.workspaceRoot).fsPath, URI.parse(uri).fsPath);
		return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	}

	private async traverseConfigTree(
		startNode: TreeNode<TerragruntConfig>,
		unitUri: string,
		ancestry: Set<string>
	): Promise<void> {
		const traverseNode = async (
			treeNode: TreeNode<TerragruntConfig>,
			contextUnitUri: string,
			ancestors: Set<string>
		): Promise<void> => {
			const config = treeNode.data;
			const contextKey = `${contextUnitUri}\0${config.uri}`;
			if (ancestors.has(contextKey)) {
				throw new Error(`Configuration cycle detected at ${config.uri}`);
			}
			const nextAncestors = new Set(ancestors);
			nextAncestors.add(contextKey);

			// Add outputs if they exist
			if (config.outputs && config.outputs.size > 0) {
				const outputsNode = treeNode.addChild(
					config,
					"outputs",
					"outputs"
				);

				for (const [outputName, outputValue] of config.outputs.entries()) {
					let displayValue = '';
					if (outputValue.value !== null && outputValue.value !== undefined) {
						if (typeof outputValue.value === 'string') {
							try {
								const parsed = JSON.parse(outputValue.value);
								if (Array.isArray(parsed)) {
									displayValue = `[${parsed.length} items]`;
									const outputNode = outputsNode.addChild(
										config,
										`${outputName}: ${displayValue}`,
										`output:${outputValue.type}`
									);
									parsed.forEach(item => {
										outputNode.addChild(
											config,
											String(item),
											'output:item'
										);
									});
									continue;
								}
								displayValue = JSON.stringify(parsed, null, 2);
							} catch {
								displayValue = outputValue.value;
							}
						} else {
							displayValue = JSON.stringify(outputValue.value, null, 2);
						}
					}

					outputsNode.addChild(
						config,
						`${outputName}: ${displayValue}`,
						`output:${outputValue.type}`
					);
				}
			}

			// Follow dependencies away from each entrypoint so the visual direction
			// matches the authored relationship (consumer/stack -> dependency/component).
			for (const refUri of [...config.includes, ...config.dependencies, ...config.reads]) {
				const refConfig = this.configMap.get(refUri);
				if (!refConfig) {
					throw new Error(`Configuration graph references an unloaded document: ${refUri}`);
				}

				// Check if this child has already been processed to avoid cycles
				const existingChild = treeNode.children.find(child => child.data.uri === refUri);
				if (!existingChild) {
					const relationshipType = config.includes.includes(refUri)
						? 'include'
						: config.reads.includes(refUri)
							? 'read'
						: refConfig.dependencyType === 'unit' || refConfig.dependencyType === 'stack'
							? refConfig.dependencyType
							: 'dependency';
					// Includes and generated stack components can have relationships
					// authored in the current unit context. Ordinary read/dependency
					// targets are configurations in their own right.
					const childUnitUri = this.configContexts.get(contextUnitUri)?.has(refUri)
						? contextUnitUri
						: refUri;
					const childNode = treeNode.addChild(
						this.contextualConfig(childUnitUri, refConfig),
						this.formatPath(refConfig.uri),
						relationshipType
					);
					await traverseNode(childNode, childUnitUri, nextAncestors);
				}
			}
		};

		await traverseNode(startNode, unitUri, ancestry);
	}

	private formatPath(uri: string): string {
		if (!this.workspaceRoot) return uri;
		const fullPath = URI.parse(uri).fsPath;
		const rootPath = URI.parse(this.workspaceRoot).fsPath;
		return path.relative(rootPath, fullPath);
	}

	async findTerragruntConfigs(rootDir: string): Promise<string[]> {
		const configs: string[] = [];
		const fsRootDir = URI.parse(rootDir).fsPath;  // Convert URI to filesystem path
		const ignoredDirectories = new Set([
			'.git',
			'.scrap',
			'.terraform',
			'.terragrunt-cache',
			'.trash',
			'node_modules'
		]);

		const scan = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
					await scan(fullPath);
				} else if (entry.isFile() && (entry.name === 'terragrunt.hcl' || entry.name === 'terragrunt.stack.hcl')) {
					configs.push(URI.file(fullPath).toString());
				}
			}
		};

		await fs.access(fsRootDir);
		await scan(fsRootDir);

		return configs.sort();
	}

	setWorkspaceRoot(root: string) {
		this.workspaceRoot = root;
	}

	/** @returns the workspace root URI set by {@link setWorkspaceRoot}, or null before one is set. */
	getWorkspaceRoot(): string | null {
		return this.workspaceRoot;
	}

	async addDocument(document: ParsedDocument) {
		const uri = document.getUri();
		this.documents.set(uri, document);

		// Re-resolve every unit whose context contains this file. An included
		// configuration can produce different paths for each unit, so updating a
		// single URI in isolation would leave those contextual relationships stale.
		const affectedUnits = new Set<string>();
		if (this.configContexts.has(uri)) affectedUnits.add(uri);
		for (const [unitUri, contexts] of this.configContexts) {
			if (contexts.has(uri)) affectedUnits.add(unitUri);
		}
		if (affectedUnits.size === 0) affectedUnits.add(uri);
		const previousContexts = new Map<string, Map<string, ConfigRelationships>>();
		for (const unitUri of affectedUnits) {
			const previous = this.configContexts.get(unitUri);
			if (previous) previousContexts.set(unitUri, previous);
		}
		for (const unitUri of affectedUnits) this.configContexts.delete(unitUri);
		try {
			for (const unitUri of affectedUnits) {
				const unitDocument = unitUri === uri ? document : await this.getParsedDocument(unitUri);
				if (unitDocument) await this.updateConfigMap(unitDocument, new Set(), unitUri);
			}
			this.syncConfigRelationships();
		} catch (error) {
			for (const unitUri of affectedUnits) this.configContexts.delete(unitUri);
			for (const [unitUri, contexts] of previousContexts) this.configContexts.set(unitUri, contexts);
			this.syncConfigRelationships();
			throw error;
		}
	}

	async refreshDependencyTree(): Promise<TreeNode<TerragruntConfig> | undefined> {
		this.configTreeRoot = undefined;
		this.configMap.clear();
		this.configContexts.clear();
		await this.buildDependencyTree();
		return this.configTreeRoot;
	}

	private getDependencyName(block: Token): string | undefined {
		const param = block.children.find(c => c.type === 'parameter');
		return param?.value?.toString();
	}

	private decodeUri(uri: string): string {
		const decoded = URI.parse(uri);
		return decoded.fsPath;
	}

	private async loadDocument(uri: string): Promise<ParsedDocument | undefined> {
		if (this.documents.has(uri)) {
			return this.documents.get(uri);
		}

		const fsPath = this.decodeUri(uri);
		const stats = await fs.stat(fsPath);
		let actualPath = fsPath;

		if (stats.isDirectory()) {
			const unitPath = path.join(fsPath, 'terragrunt.hcl');
			const stackPath = path.join(fsPath, 'terragrunt.stack.hcl');
			const [hasUnit, hasStack] = await Promise.all([this.fileExists(unitPath), this.fileExists(stackPath)]);
			if (hasUnit && hasStack) throw new Error(`Ambiguous configuration directory: ${fsPath}`);
			if (!hasUnit && !hasStack) throw new Error(`No Terragrunt unit or stack configuration in ${fsPath}`);
			actualPath = hasUnit ? unitPath : stackPath;
			uri = URI.file(actualPath).toString();
			if (this.documents.has(uri)) return this.documents.get(uri);
		}

		const content = await fs.readFile(actualPath, 'utf-8');
		const document = new ParsedDocument(this, uri, content);
		this.documents.set(uri, document);
		return document;
	}

	removeDocument(uri: string) {
		// Closing an editor document does not remove the configuration from the
		// workspace. Keep its graph state; a later filesystem refresh is what
		// observes an actual deletion.
		this.documents.delete(uri);
	}

	getReferencingConfigs(uri: string): TerragruntConfig[] {
		const config = this.configMap.get(uri);
		if (!config) return [];

		return config.referencedBy
			.map(refUri => this.configMap.get(refUri))
			.filter((c): c is TerragruntConfig => c !== undefined);
	}

	getEvaluationContext(uri: string): { referencingConfigs: TerragruntConfig[] } {
		return {
			referencingConfigs: this.getReferencingConfigs(uri)
		};
	}

	async getParsedDocument(uri: string): Promise<ParsedDocument | undefined> {
		if (!this.documents.has(uri)) {
			return await this.loadDocument(uri);
		}
		return this.documents.get(uri);
	}

	// Get all dependencies (both includes and explicit dependencies) for a given config
	async getDependencies(uri: string): Promise<TerragruntConfig[]> {
		const config = this.configMap.get(uri);
		if (!config) {
			// If config isn't loaded yet, try to load it first
			const doc = await this.getParsedDocument(uri);
			if (!doc) return [];
			// After loading, check configMap again
			const loadedConfig = this.configMap.get(uri);
			if (!loadedConfig) return [];
			return [...loadedConfig.includes, ...loadedConfig.dependencies]
				.map(depUri => this.configMap.get(depUri))
				.filter((c): c is TerragruntConfig => c !== undefined);
		}

		// Return both includes and dependencies
		return [...config.includes, ...config.dependencies]
			.map(depUri => this.configMap.get(depUri))
			.filter((c): c is TerragruntConfig => c !== undefined);
	}

	// Get all configs that depend on or include this config
	async getDependents(uri: string): Promise<TerragruntConfig[]> {
		const config = this.configMap.get(uri);
		if (!config) {
			// If config isn't loaded yet, try to load it first
			const doc = await this.getParsedDocument(uri);
			if (!doc) return [];
			// After loading, check configMap again
			const loadedConfig = this.configMap.get(uri);
			if (!loadedConfig) return [];
			return loadedConfig.referencedBy
				.map(refUri => this.configMap.get(refUri))
				.filter((c): c is TerragruntConfig => c !== undefined);
		}

		// Return all configs that reference this one
		return config.referencedBy
			.map(refUri => this.configMap.get(refUri))
			.filter((c): c is TerragruntConfig => c !== undefined);
	}

	getConfigTreeRoot(): TreeNode<TerragruntConfig> | undefined {
		return this.configTreeRoot;
	}
}
