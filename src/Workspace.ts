import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { URI } from 'vscode-uri';

import type { FunctionContext, TerragruntConfig, Token } from './model';
import { createDependencyConfig, createIncludeConfig, TreeNode } from './model';
import { ParsedDocument } from './ParsedDocument';
import { Schema } from './Schema';
import { expandTerragruntGlob } from './functions/terragrunt_glob';

export class Workspace {
	private documents: Map<string, ParsedDocument>;
	private configMap: Map<string, TerragruntConfig>;
	private workspaceRoot: string | null;
	private schema: Schema = Schema.getInstance();
	private configTreeRoot: TreeNode<TerragruntConfig> | undefined;

	public constructor() {
		this.documents = new Map();
		this.configMap = new Map();
		this.workspaceRoot = null;
	}

	private async updateConfigMap(doc: ParsedDocument, processedPaths = new Set<string>()): Promise<void> {
		const uri = doc.getUri();
		if (processedPaths.has(uri)) return;
		processedPaths.add(uri);

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
		for (const previousTarget of [...currentConfig.includes, ...currentConfig.dependencies, ...currentConfig.reads]) {
			const target = this.configMap.get(previousTarget);
			if (!target) continue;
			target.referencedBy = target.referencedBy.filter(reference => reference !== uri);
			target.includedBy = target.includedBy.filter(reference => reference !== uri);
			target.dependedOnBy = target.dependedOnBy.filter(reference => reference !== uri);
			target.readBy = target.readBy.filter(reference => reference !== uri);
			if (target.dependencyType === 'unit' || target.dependencyType === 'stack') {
				for (const childUri of target.dependencies) {
					const child = this.configMap.get(childUri);
					if (child) child.referencedBy = child.referencedBy.filter(reference => reference !== target.uri);
				}
				target.dependencies = [];
			}
			if (!this.documents.has(previousTarget) && target.referencedBy.length === 0 && (target.dependencyType === 'unit' || target.dependencyType === 'stack')) {
				this.configMap.delete(previousTarget);
			}
		}
		currentConfig.includes = [];
		currentConfig.dependencies = [];
		currentConfig.reads = [];

		// Process includes
		const includes = doc.findIncludeBlocks(ast);
		const includePaths = await Promise.all(includes.map(async inc => {
			const resolvedPath = await this.resolveIncludePath(inc.path, uri);
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

			if (!includedConfig.referencedBy.includes(uri)) {
				includedConfig.referencedBy.push(uri);
			}
			if (!includedConfig.includedBy.includes(uri)) includedConfig.includedBy.push(uri);

			return resolvedPath;
		}));

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
						referencedBy: [uri],
						includedBy: [],
						dependedOnBy: [uri],
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
					if (!component.referencedBy.includes(uri)) component.referencedBy.push(uri);
				}
				componentPaths.push(targetUri);
			}
		}

		// Dependencies inside a stack component's autoinclude body belong to that
		// generated component, not to the stack file that declares the component.
		const dependencyEntries = await doc.findDependencyBlocks(ast);
		const dependencyPaths: string[] = [];
		for (const dep of dependencyEntries) {
			const resolvedPath = await this.resolveDependencyPath(dep.path, uri);
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
			if (!ownerConfig.dependencies.includes(resolvedPath)) ownerConfig.dependencies.push(resolvedPath);
			if (!depConfig.referencedBy.includes(ownerUri)) depConfig.referencedBy.push(ownerUri);
			if (!depConfig.dependedOnBy.includes(ownerUri)) depConfig.dependedOnBy.push(ownerUri);
			if (ownerUri === uri) dependencyPaths.push(resolvedPath);
		}

		const readPaths = await this.resolveReadPaths(doc);
		for (const readUri of readPaths) {
			let readConfig = this.configMap.get(readUri);
			if (!readConfig) {
				readConfig = {
					uri: readUri,
					content: await fs.readFile(URI.parse(readUri).fsPath, 'utf8'),
					includes: [],
					dependencies: [],
					reads: [],
					referencedBy: [uri],
					includedBy: [],
					dependedOnBy: [],
					readBy: [uri],
					sourcePath: URI.parse(uri).fsPath,
					targetPath: URI.parse(readUri).fsPath,
					dependencyType: 'read'
				};
				this.configMap.set(readUri, readConfig);
			} else {
				if (!readConfig.referencedBy.includes(uri)) readConfig.referencedBy.push(uri);
				if (!readConfig.readBy.includes(uri)) readConfig.readBy.push(uri);
			}
		}

		// Update current config
		currentConfig.includes = includePaths.filter(Boolean);
		currentConfig.dependencies = [
			...dependencyPaths.filter((path): path is string => path !== undefined),
			...componentPaths
		];
		currentConfig.reads = readPaths;
		this.configMap.set(uri, currentConfig);

		// HCL files consumed with read_terragrunt_config can themselves include or
		// read other files. Preserve that transitive lineage instead of flattening it.
		const readableHclPaths = readPaths.filter(readUri => path.extname(URI.parse(readUri).fsPath) === '.hcl');
		for (const refUri of [...includePaths, ...dependencyPaths, ...readableHclPaths]) {
			if (refUri && !processedPaths.has(refUri)) {
				const refDoc = await this.getParsedDocument(refUri);
				if (refDoc) {
					await this.updateConfigMap(refDoc, processedPaths);
				}
			}
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

	public async resolveDependencyPath(pathToken: Token, sourceUri: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);

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

		const configPath = await this.resolvePathToken(pathToken, sourceDir, sourceUri);

		// Resolve the final path
		const resolvedPath = path.isAbsolute(configPath) ?
			configPath :
			path.resolve(sourceDir, configPath);

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

	public async resolveIncludePath(pathToken: Token, sourceUri: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);

		if (pathToken.type === 'function_call') {
			const resolved = await this.evaluatePathFunction(pathToken, sourceDir, sourceUri);
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
						return this.evaluatePathExpression(expression, sourceDir, sourceUri);
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
	private async evaluatePathExpression(token: Token, sourceDir: string, sourceUri = URI.file(sourceDir).toString()): Promise<string> {
		switch (token.type) {
			case 'function_call': {
				return this.evaluatePathFunction(token, sourceDir, sourceUri);
			}
			case 'string_lit': {
				return String(token.value);
			}
			default: throw new Error(`Unsupported path interpolation expression: ${token.type}`);
		}
	}
	private async evaluatePathFunction(token: Token, sourceDir: string, sourceUri = URI.file(sourceDir).toString()): Promise<string> {
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
			fs: { access: async filePath => fs.access(filePath) }
		};

		const args = await Promise.all(token.children
			.filter(child => child.type !== 'function_identifier')
			.map(async argument => ({
				type: 'string' as const,
				value: await this.evaluateReadPath(argument, sourceDir, sourceUri)
			})));

		const result = await this.schema.getFunctionRegistry().evaluateFunction(funcName, args, context);
		if (!result || result.type !== 'string' || typeof result.value !== 'string') {
			throw new Error(`Path function ${funcName} did not return a string`);
		}
		return result.value;
	}

	private async resolveReadPaths(document: ParsedDocument): Promise<string[]> {
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
		const reads = new Set<string>();
		for (const call of calls) {
			const arguments_ = call.children.filter(child => child.type !== 'function_identifier');
			const argument = arguments_[0];
			if (!argument) throw new Error(`${call.value} requires a file path argument`);
			if (call.value === 'mark_glob_as_read') {
				const values = await Promise.all(arguments_.map(value => this.evaluateReadPath(value, sourceDir, sourceUri)));
				for (const match of await expandTerragruntGlob(values, sourceDir)) reads.add(URI.file(match).toString());
				continue;
			}
			const configuredPath = await this.evaluateReadPath(argument, sourceDir, sourceUri);
			if (call.value === 'mark_as_read' && !path.isAbsolute(configuredPath)) {
				throw new Error(`mark_as_read requires an absolute path, got ${configuredPath}`);
			}
			const resolvedPath = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(sourceDir, configuredPath);
			if (!await this.fileExists(resolvedPath)) throw new Error(`${call.value} target not found: ${resolvedPath}`);
			reads.add(URI.file(resolvedPath).toString());
		}
		return [...reads].sort();
	}

	private async evaluateReadPath(token: Token, sourceDir: string, sourceUri: string): Promise<string> {
		if (token.type === 'string_lit') return String(token.value);
		if (token.type === 'function_call') return this.evaluatePathFunction(token, sourceDir, sourceUri);
		if (token.type === 'interpolated_string') {
			const parts = await Promise.all(token.children.map(async child => {
				if (child.type === 'string_lit') return String(child.value);
				if (child.type === 'interpolation' && child.children[0]) {
					return this.evaluateReadPath(child.children[0], sourceDir, sourceUri);
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

		// Second pass: verify that the graph is closed over every authored edge.
		for (const [uri, config] of this.configMap.entries()) {
			for (const depUri of [...config.includes, ...config.dependencies, ...config.reads]) {
				if (!this.configMap.has(depUri)) {
					throw new Error(`Missing configuration ${depUri} referenced from ${uri}`);
				}
			}
		}
		for (const config of this.configMap.values()) {
			config.reading = this.collectReading(config.uri, new Set());
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
			const node = this.configTreeRoot.addChild(config, this.formatPath(config.uri), config.dependencyType);
			await this.traverseConfigTree(node, new Set());
		}
	}

	private collectReading(uri: string, ancestry: Set<string>): string[] {
		if (ancestry.has(uri)) throw new Error(`Reading cycle detected at ${uri}`);
		const config = this.configMap.get(uri);
		if (!config) throw new Error(`Cannot collect reading lineage for missing configuration ${uri}`);
		const nextAncestry = new Set(ancestry);
		nextAncestry.add(uri);
		const reading = new Set(config.reads);
		for (const readUri of config.reads) {
			const readConfig = this.configMap.get(readUri);
			if (!readConfig) throw new Error(`Reading lineage references missing file ${readUri}`);
			for (const transitiveUri of this.collectReading(readUri, nextAncestry)) reading.add(transitiveUri);
		}
		return [...reading].sort();
	}

	private isExternal(uri: string): boolean {
		if (!this.workspaceRoot) throw new Error('Cannot classify an external configuration without a workspace root');
		const relative = path.relative(URI.parse(this.workspaceRoot).fsPath, URI.parse(uri).fsPath);
		return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	}

	private async traverseConfigTree(startNode: TreeNode<TerragruntConfig>, ancestry: Set<string>): Promise<void> {
		const traverseNode = async (treeNode: TreeNode<TerragruntConfig>, ancestors: Set<string>) => {
			const config = this.configMap.get(treeNode.data.uri);
			if (!config) {
				throw new Error(`Configuration graph references an unloaded document: ${treeNode.data.uri}`);
			}
			if (ancestors.has(config.uri)) {
				throw new Error(`Configuration cycle detected at ${config.uri}`);
			}
			const nextAncestors = new Set(ancestors);
			nextAncestors.add(config.uri);

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
					const childNode = treeNode.addChild(
						refConfig,
						this.formatPath(refConfig.uri),
						relationshipType
					);
					await traverseNode(childNode, nextAncestors);
				}
			}
		};

		await traverseNode(startNode, ancestry);
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

	async addDocument(document: ParsedDocument) {
		const uri = document.getUri();
		this.documents.set(uri, document);

		await this.updateConfigMap(document);  // Update just this document's config
	}

	async refreshDependencyTree(): Promise<TreeNode<TerragruntConfig> | undefined> {
		this.configTreeRoot = undefined;
		this.configMap.clear();
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
		const config = this.configMap.get(uri);
		if (config) {
			for (const targetUri of [...config.includes, ...config.dependencies, ...config.reads]) {
				const target = this.configMap.get(targetUri);
				if (target) {
					target.referencedBy = target.referencedBy.filter(reference => reference !== uri);
					target.includedBy = target.includedBy.filter(reference => reference !== uri);
					target.dependedOnBy = target.dependedOnBy.filter(reference => reference !== uri);
					target.readBy = target.readBy.filter(reference => reference !== uri);
				}
			}
		}
		this.documents.delete(uri);
		this.configMap.delete(uri);
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
