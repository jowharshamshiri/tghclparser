import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';

import type { FunctionContext, RuntimeValue, TerragruntConfig, Token, ValueType } from './model';
import { createDependencyConfig, createIncludeConfig, TreeNode } from './model';
import { ParsedDocument } from './ParsedDocument';
import { Schema } from './Schema';

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
				referencedBy: [],
				sourcePath: URI.parse(uri).fsPath,
				targetPath: URI.parse(uri).fsPath,
				block: undefined,
				dependencyType: 'include',
				parameterValue: undefined
			};
			this.configMap.set(uri, currentConfig);
		}

		// Process includes
		const includes = doc.findIncludeBlocks(ast);
		const includePaths = await Promise.all(includes.map(async inc => {
			const resolvedPath = await this.resolveIncludePath(inc.path, uri);

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

			return resolvedPath;
		}));

		// Process dependencies
		const dependencyEntries = await doc.findDependencyBlocks(ast);
		// console.log('Found outputs for dependencies:', dependencyEntries.map(dep => dep.outputs));
		const dependencyPaths = await Promise.all(dependencyEntries.map(async dep => {
			const resolvedPath = await this.resolveDependencyPath(dep.path, uri);
			const exists = await this.fileExists(URI.parse(resolvedPath).fsPath);
			if (!exists) {
				console.warn(`Warning: Dependency ${resolvedPath} not found`);
				return;
			}
			const content = await fs.readFile(URI.parse(resolvedPath).fsPath, 'utf-8');
			// Create or update the dependency config
			let depConfig = this.configMap.get(resolvedPath);
			if (!depConfig) {
				depConfig = createDependencyConfig(
					resolvedPath,
					content,
					uri,
					resolvedPath,
					dep.block,
					dep.parameter,
					dep.outputs
				);
				this.configMap.set(resolvedPath, depConfig);
			} else if (dep.outputs) {
				// Update outputs even if config exists
				depConfig.outputs = dep.outputs;
			}

			if (!depConfig.referencedBy.includes(uri)) {
				depConfig.referencedBy.push(uri);
			}

			return resolvedPath;
		}));

		// Update current config
		currentConfig.includes = includePaths.filter(Boolean);
		if (dependencyPaths && dependencyPaths.length > 0) {
			currentConfig.dependencies = dependencyPaths.filter((path): path is string => path !== undefined);
		}
		this.configMap.set(uri, currentConfig);

		// Recursively process includes and dependencies
		for (const refUri of [...includePaths, ...dependencyPaths]) {
			if (refUri && !processedPaths.has(refUri)) {
				const refDoc = await this.getParsedDocument(refUri);
				if (refDoc) {
					await this.updateConfigMap(refDoc, processedPaths);
				}
			}
		}
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	public async resolveDependencyPath(pathToken: Token, sourceUri: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);

		let configPath: string;

		switch (pathToken.type) {
			case 'string_lit': {
				configPath = pathToken.value as string;
				break;
			}
			case 'interpolated_string': {
				// Handle interpolated strings
				const parts = await Promise.all(
					pathToken.children.map(async child => {
						if (child.type === 'legacy_interpolation') {
							const innerToken = child.children[0];
							return await this.evaluatePathExpression(innerToken, sourceDir);
						}
						return child.value || '';
					})
				);
				configPath = parts.join('');
				break;
			}
			case 'function_call': {
				configPath = await this.evaluatePathFunction(pathToken, sourceDir);
				break;
			}
			default: {
				configPath = pathToken.value as string || '';
			}
		}

		// Resolve the final path
		const resolvedPath = path.isAbsolute(configPath) ?
			configPath :
			path.resolve(sourceDir, configPath);

		// Don't append terragrunt.hcl if already an .hcl file
		if (path.extname(resolvedPath) === '.hcl') {
			return URI.file(resolvedPath).toString();
		}

		return URI.file(path.join(resolvedPath, 'terragrunt.hcl')).toString();
	}

	private async resolveIncludePath(pathToken: Token, sourceUri: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);

		if (pathToken.type === 'function_call' && pathToken.value === 'find_in_parent_folders') {
			const registry = this.schema.getFunctionRegistry();
			const context: FunctionContext = {
				workingDirectory: sourceDir,
				environmentVariables: process.env as Record<string, string>,
				document: {
					uri: sourceUri,
					content: ''
				},
				fs: {
					access: async (path: string) => fs.access(path)
				}
			};

			try {
				const result = await registry.evaluateFunction('find_in_parent_folders', [], context);
				if (result?.type === 'string' && typeof result.value === 'string') {
					// The result should already be a full path, just convert to URI
					return URI.file(result.value).toString();
				}
			} catch (error) {
				console.warn(`Error evaluating function find_in_parent_folders:`, error);
			}

			// Still fall through to default behavior if function fails
		}

		// For string literals and interpolated strings
		if (pathToken.type === 'string_lit' || pathToken.type === 'interpolated_string') {
			const configPath = pathToken.value as string;
			// For absolute paths use as-is, otherwise resolve relative to source
			const resolvedPath = path.isAbsolute(configPath) ?
				configPath :
				path.resolve(sourceDir, configPath);

			// Don't append terragrunt.hcl if already an .hcl file
			if (path.extname(resolvedPath) === '.hcl') {
				return URI.file(resolvedPath).toString();
			}

			// Check if terragrunt.hcl is already part of the path
			if (resolvedPath.endsWith('terragrunt.hcl')) {
				return URI.file(resolvedPath).toString();
			}

			return URI.file(path.join(resolvedPath, 'terragrunt.hcl')).toString();
		}

		// Default case
		return URI.file(path.join(sourceDir, 'terragrunt.hcl')).toString();
	}
	private async evaluatePathExpression(token: Token, sourceDir: string): Promise<string> {
		switch (token.type) {
			case 'function_call': {
				return await this.evaluatePathFunction(token, sourceDir);
			}
			default: {
				return token.value as string || '';
			}
		}
	}
	private async evaluatePathFunction(token: Token, sourceDir: string): Promise<string> {
		const functionIdentifier = token.children.find(c => c.type === 'function_identifier');
		const funcName = functionIdentifier?.value as string;

		if (!funcName) {
			console.log('Function identifier not found in token:', token);
			return sourceDir;
		}

		// Create function context
		const context: FunctionContext = {
			workingDirectory: sourceDir,
			environmentVariables: Object.fromEntries(
				Object.entries(process.env).filter(([_, v]) => v !== undefined)
			) as Record<string, string>,
			document: {
				uri: URI.file(sourceDir).toString(),
				content: '' // Not needed for path functions
			}
		};

		// Get function arguments
		const args = token.children
			.filter(c => c.type !== 'function_identifier')
			.map(arg => ({
				type: 'string' as const,
				value: arg.value?.toString() || ''
			}));

		// Use function registry to evaluate
		try {
			const result = await this.schema.getFunctionRegistry().evaluateFunction(funcName, args, context);
			if (result && typeof result.value === 'string') {
				return result.value;
			}
		} catch (error) {
			console.warn(`Error evaluating function ${funcName}:`, error);
		}

		// Fallback to default directory
		return sourceDir;
	}

	private async buildDependencyTree(): Promise<void> {
		if (!this.workspaceRoot) return;

		// Find all terragrunt.hcl files
		const configs = await this.findTerragruntConfigs(this.workspaceRoot);

		// First pass: Load and parse all configs
		for (const uri of configs) {
			const doc = await this.getParsedDocument(uri);
			if (doc) {
				await this.updateConfigMap(doc);
			}
		}

		// Second pass: Verify all references and log any missing dependencies
		for (const [uri, config] of this.configMap.entries()) {
			for (const depUri of [...config.includes, ...config.dependencies]) {
				if (!this.configMap.has(depUri)) {
					console.warn(`Warning: Missing dependency ${depUri} referenced from ${uri}`);
				}
			}
		}

		// Find root config
		const rootConfig = Array.from(this.configMap.entries()).find(([uri]) => {
			const parsedUri = URI.parse(uri);
			const isRoot =
				parsedUri.fsPath.endsWith('/terragrunt.hcl') &&
				parsedUri.fsPath.split('/').filter(p => p !== '').length ===
				(this.workspaceRoot ? URI.parse(this.workspaceRoot).fsPath.split('/').filter(p => p !== '').length + 1 : 1);

			if (isRoot) {
				console.log('Found root config:', parsedUri.fsPath);
			}
			return isRoot;
		});

		if (!rootConfig) {
			console.log('No root configuration found');
			return;
		}

		// Initialize the tree with root node
		const [uri, config] = rootConfig;
		this.configTreeRoot = new TreeNode<TerragruntConfig>(
			config,
			this.formatPath(config.uri),
			'root'
		);

		// Build the tree structure
		await this.traverseConfigTree();
	}

	private dumpTreeStructure(node: TreeNode<TerragruntConfig>, depth = 0): void {
		const indent = '  '.repeat(depth);
		console.log(`${indent}${node.name} (${node.type})`);
		if (node.data.outputs && node.data.outputs.size > 0) {
			console.log(`${indent}  outputs:`);
			for (const [key, value] of node.data.outputs.entries()) {
				console.log(`${indent}    ${key}: ${JSON.stringify(value.value)}`);
			}
		}
		for (const child of node.children) {
			this.dumpTreeStructure(child, depth + 1);
		}
	}

	private async traverseConfigTree(): Promise<void> {
		if (!this.configTreeRoot) {
			console.log('No config tree root exists');
			return;
		}

		const traverseNode = async (treeNode: TreeNode<TerragruntConfig>) => {
			const config = this.configMap.get(treeNode.data.uri);
			if (!config) {
				console.error(`Config not found for uri ${treeNode.data.uri}`);
				return;
			}

			// console.log(`Processing node: ${config.uri}`);

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

			// Process all child nodes (configs that reference this one)
			// console.log(`Processing children for ${config.uri}, referencedBy:`, config.referencedBy);
			for (const refUri of config.referencedBy) {
				const refConfig = this.configMap.get(refUri);
				if (!refConfig) {
					console.error(`Referenced config not found for uri ${refUri}`);
					continue;
				}

				// Check if this child has already been processed to avoid cycles
				const existingChild = treeNode.children.find(child => child.data.uri === refUri);
				if (!existingChild) {
					// console.log(`Adding child node: ${refUri}`);
					const childNode = treeNode.addChild(
						refConfig,
						this.formatPath(refConfig.uri),
						refConfig.dependencyType
					);
					await traverseNode(childNode);
				} else {
					console.log(`Skipping already processed child: ${refUri}`);
				}
			}
		};

		// Start traversal from the root
		await traverseNode(this.configTreeRoot);
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

		const scan = async (dir: string) => {
			try {
				const entries = await fs.readdir(dir, { withFileTypes: true });

				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);

					if (entry.isDirectory() && !entry.name.startsWith('.')) {
						await scan(fullPath);
					} else if (entry.isFile() && entry.name === 'terragrunt.hcl') {
						configs.push(URI.file(fullPath).toString());
					}
				}
			} catch (error) {
				// Check if directory exists first
				try {
					await fs.access(dir);
					console.error(`Error reading directory ${dir}:`, error);
				} catch {
					// Directory doesn't exist, which is okay - might be creating a new file
					console.log(`Directory ${dir} does not exist yet`);
				}
			}
		};

		try {
			// Check if root directory exists
			await fs.access(fsRootDir);
			await scan(fsRootDir);
		} catch {
			// Root directory doesn't exist yet, which is fine for new workspaces
			console.log(`Workspace root directory ${fsRootDir} does not exist yet`);
		}

		return configs;
	}

	setWorkspaceRoot(root: string) {
		this.workspaceRoot = root;
		// Get the filesystem path
		const { fsPath } = URI.parse(root);
		// Create the directory if it doesn't exist
		fs.mkdir(fsPath, { recursive: true }).catch(error => {
			console.error(`Error creating workspace root directory: ${error}`);
		});
	}

	async addDocument(document: ParsedDocument) {
		const uri = document.getUri();
		this.documents.set(uri, document);

		// Ensure parent directory exists
		const { fsPath } = URI.parse(uri);
		const dir = path.dirname(fsPath);
		await fs.mkdir(dir, { recursive: true }).catch(error => {
			console.error(`Error creating document directory: ${error}`);
		});

		await this.updateConfigMap(document);  // Update just this document's config
		await this.buildDependencyTree();
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
		try {
			if (this.documents.has(uri)) {
				return this.documents.get(uri);
			}

			const fsPath = this.decodeUri(uri);
			try {
				const stats = await fs.stat(fsPath);
				let actualPath = fsPath;

				if (stats.isDirectory()) {
					actualPath = path.join(fsPath, 'terragrunt.hcl');
					uri = URI.file(actualPath).toString();

					if (this.documents.has(uri)) {
						return this.documents.get(uri);
					}
				}

				const content = await fs.readFile(actualPath, 'utf-8');
				const document = new ParsedDocument(this, uri, content);
				this.documents.set(uri, document);

				return document;
			} catch {
				const diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 }
					},
					message: `File not found: ${fsPath}`,
					source: 'terragrunt'
				};

				// Update diagnostics for any configs that reference this missing file
				for (const [sourceUri, config] of this.configMap.entries()) {
					if (config.dependencies.includes(uri) || config.includes.includes(uri)) {
						const sourceDoc = this.documents.get(sourceUri);
						if (sourceDoc) {
							sourceDoc.addDiagnostic(diagnostic);
						}
					}
				}

				// console.error(`Error accessing file ${fsPath}:`, error);
				return undefined;
			}
		} catch (error) {
			console.error(`Error loading document ${uri}:`, error);
			return undefined;
		}
	}

	removeDocument(uri: string) {
		this.documents.delete(uri);
		this.configMap.delete(uri);
	}

	findInParentFolders(startUri: string, args: RuntimeValue<ValueType>[]): RuntimeValue<ValueType> {
		const filename = args[0];
		if (filename?.type !== 'string') {
			return { type: 'null', value: null };
		}

		const startPath = URI.parse(startUri).fsPath;
		let currentDir = path.dirname(startPath);
		const stopAt = args[1];

		while (currentDir !== path.parse(currentDir).root) {
			if (typeof filename.value !== 'string') {
				return { type: 'null', value: null };
			}
			const filePath = path.join(currentDir, filename.value);
			if (fsSync.existsSync(filePath)) {
				return {
					type: 'string',
					value: filePath
				} as RuntimeValue<'string'>;
			}
			if (stopAt?.type === 'string' && currentDir === stopAt.value) {
				break;
			}
			currentDir = path.dirname(currentDir);
		}

		return { type: 'null', value: null };
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