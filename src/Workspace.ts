import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';

import type { RuntimeValue, TerragruntConfig, ValueType } from './model';
import { Token } from './model';
import { ParsedDocument } from './ParsedDocument';

export class Workspace {
	private documents: Map<string, ParsedDocument>;
	private configMap: Map<string, TerragruntConfig>;
	private workspaceRoot: string | null;

	public constructor() {
		this.documents = new Map();
		this.configMap = new Map();
		this.workspaceRoot = null;
	}
	private async updateConfigMap(doc: ParsedDocument, processedPaths = new Set<string>()): Promise<void> {
		const uri = doc.getUri();
		console.log('\nUpdating config map for:', uri);
		
		// Prevent infinite recursion
		if (processedPaths.has(uri)) {
			console.log('Already processed:', uri);
			return;
		}
		processedPaths.add(uri);
		
		const ast = doc.getAST();
		if (!ast) {
			console.log('No AST found for:', uri);
			return;
		}
	
		// Process includes
		const includes = doc.findIncludeBlocks(ast);
		console.log('Found includes:', includes.length);
		includes.forEach(inc => {
			console.log('Include:', {
				type: inc.path.type,
				value: inc.path.value,
				blockType: inc.block.type
			});
		});
	
		const includePaths = await Promise.all(includes.map(async inc => {
			const targetUri = await this.resolveIncludePath(inc.path, uri);
			console.log('Resolved include path:', targetUri);
			if (!this.configMap.has(targetUri)) {
				const targetDoc = await this.getDocument(targetUri);
				if (targetDoc) {
					await this.updateConfigMap(targetDoc, processedPaths);
				}
			}
			return targetUri;
		}));
	
		// Process dependencies
		const dependencies = doc.findDependencyBlocks(ast);
		console.log('Found dependencies:', dependencies.length);
		dependencies.forEach(dep => {
			console.log('Dependency:', {
				type: dep.path.type,
				value: dep.path.value,
				blockType: dep.block.type
			});
		});
	
		const dependencyPaths = await Promise.all(dependencies.map(async dep => {
			const targetUri = await this.resolveDependencyPath(dep.path, uri);
			if (!this.configMap.has(targetUri)) {
				const targetDoc = await this.getDocument(targetUri);
				if (targetDoc) {
					await this.updateConfigMap(targetDoc, processedPaths);
				}
			}
			return {
				uri: targetUri,
				parameterValue: this.getDependencyName(dep.block)
			};
		}));
	
		// Create or update the config entry
		const sourcePath = URI.parse(uri).fsPath;
		const existingConfig = this.configMap.get(uri);
		const depUris = dependencyPaths.map(d => d.uri);
	
		const newConfig: TerragruntConfig = {
			uri,
			content: doc.getContent(),
			includes: includePaths,
			dependencies: depUris,
			referencedBy: existingConfig?.referencedBy || [],
			sourcePath,
			targetPath: sourcePath,
			dependencyType: 'include',
			block: undefined,
			parameterValue: dependencyPaths[0]?.parameterValue
		};
	
		this.configMap.set(uri, newConfig);
	
		// Update reverse references
		for (const includedUri of includePaths) {
			const includedConfig = this.configMap.get(includedUri);
			if (includedConfig && !includedConfig.referencedBy.includes(uri)) {
				includedConfig.referencedBy.push(uri);
			}
		}
	
		for (const depPath of dependencyPaths) {
			const depConfig = this.configMap.get(depPath.uri);
			if (depConfig && !depConfig.referencedBy.includes(uri)) {
				depConfig.referencedBy.push(uri);
			}
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
		const finalPath = path.isAbsolute(configPath) ?
			configPath :
			path.resolve(sourceDir, configPath);

		return URI.file(path.join(finalPath, 'terragrunt.hcl')).toString();
	}

	public async resolveIncludePath(pathToken: Token, sourceUri: string): Promise<string> {
		const sourcePath = URI.parse(sourceUri).fsPath;
		const sourceDir = path.dirname(sourcePath);

		let configPath: string;

		switch (pathToken.type) {
			case 'function_call': {
				configPath = await this.evaluatePathFunction(pathToken, sourceDir);
				break;
			}
			case 'interpolated_string': {
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
			case 'string_lit': {
				configPath = pathToken.value as string;
				break;
			}
			default: {
				configPath = pathToken.value as string || '';
			}
		}

		// Resolve the final path
		const finalPath = path.isAbsolute(configPath) ?
			configPath :
			path.resolve(sourceDir, configPath);

		return URI.file(path.join(finalPath, 'terragrunt.hcl')).toString();
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
		const funcName = token.children.find(c => c.type === 'function_identifier')?.value;
	
		switch (funcName) {
			case 'find_in_parent_folders': {
				let currentDir = sourceDir;
				const rootDir = this.workspaceRoot ? URI.parse(this.workspaceRoot).fsPath : path.parse(currentDir).root;
				
				while (currentDir !== rootDir && currentDir !== path.parse(currentDir).root) {
					const configPath = path.join(currentDir, 'terragrunt.hcl');
					try {
						const stats = await fs.stat(configPath);
						if (stats.isFile() && // Don't resolve to the same file we're currently processing
							configPath !== sourceDir) {
								return configPath;
							}
					} catch {
						// Continue searching
					}
					currentDir = path.dirname(currentDir);
				}
				
				// If we've reached the root without finding a file, return the root terragrunt.hcl
				return path.join(rootDir, 'terragrunt.hcl');
			}
			case 'get_parent_terragrunt_dir': {
				return path.dirname(sourceDir);
			}
			case 'get_terragrunt_dir': {
				return sourceDir;
			}
			case 'path_relative_to_include': {
				const relativePath = path.relative(sourceDir, path.dirname(URI.parse(this.workspaceRoot || '').fsPath));
				return relativePath;
			}
			default: {
				console.log(`Unknown function: ${funcName}`);
				return sourceDir;
			}
		}
	}

	private async buildDependencyTree(): Promise<void> {
		if (!this.workspaceRoot) return;

		// Find all terragrunt.hcl files
		const configs = await this.findTerragruntConfigs(this.workspaceRoot);
		console.log('Found terragrunt configs:', configs);

		// First pass: Load and parse all configs
		for (const uri of configs) {
			const doc = await this.getDocument(uri);
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

		// Print dependency tree for verification
		this.printDependencyTree();
	}
	printDependencyTree(): void {
		console.log('\nTerragrunt Dependency Tree:');
		console.log('=========================');
		
		// Debug info about the configMap
		console.log('Total configurations:', this.configMap.size);
		console.log('Configuration keys:', Array.from(this.configMap.keys()));
	
		const printed = new Set<string>();
	
		const printNode = (uri: string, depth = 0) => {
			const config = this.configMap.get(uri);
			if (!config) {
				console.log(`${' '.repeat(depth * 2)}[Missing config for ${uri}]`);
				return;
			}
			if (printed.has(uri)) {
				console.log(`${' '.repeat(depth * 2)}[Circular reference to ${this.formatPath(uri)}]`);
				return;
			}
	
			const indent = ' '.repeat(depth * 2);
			console.log(`${indent}├── ${this.formatPath(uri)}`);
			
			// Print detailed config info
			console.log(`${indent}│   Type: ${config.dependencyType}`);
			if (config.parameterValue) {
				console.log(`${indent}│   Parameter: ${config.parameterValue}`);
			}
	
			printed.add(uri);
	
			// Print includes
			if (config.includes && config.includes.length > 0) {
				console.log(`${indent}├── Includes (${config.includes.length}):`);
				config.includes.forEach(inc => {
					console.log(`${indent}│   └── ${this.formatPath(inc)}`);
				});
			}
	
			// Print dependencies
			if (config.dependencies && config.dependencies.length > 0) {
				console.log(`${indent}├── Dependencies (${config.dependencies.length}):`);
				config.dependencies.forEach(dep => {
					const depConfig = this.configMap.get(dep);
					const depName = depConfig?.parameterValue ? ` (${depConfig.parameterValue})` : '';
					console.log(`${indent}│   └── ${this.formatPath(dep)}${depName}`);
				});
			}
	
			// Print referenced by
			if (config.referencedBy && config.referencedBy.length > 0) {
				console.log(`${indent}└── Referenced By (${config.referencedBy.length}):`);
				config.referencedBy.forEach(ref => {
					console.log(`${indent}    └── ${this.formatPath(ref)}`);
				});
			}
	
			// Print full content for debugging
			console.log(`${indent}│   Content preview (first 100 chars):`);
			console.log(`${indent}│   ${config.content.substring(0, 100).replaceAll('\n', ' ')}...`);
	
			// Recursively print included configs
			config.includes.forEach(inc => {
				if (!printed.has(inc)) {
					console.log(`${indent}│`);
					printNode(inc, depth + 1);
				}
			});
	
			// Recursively print dependencies
			config.dependencies.forEach(dep => {
				if (!printed.has(dep)) {
					console.log(`${indent}│`);
					printNode(dep, depth + 1);
				}
			});
		};
	
		// Find and sort root configs
		const rootConfigs = Array.from(this.configMap.entries())
			.filter(([_, config]) => !config.referencedBy || config.referencedBy.length === 0)
			.map(([uri]) => uri)
			.sort();
	
		console.log('Root configurations:', rootConfigs.length);
		rootConfigs.forEach(rootUri => {
			console.log('\nRoot:', this.formatPath(rootUri));
			printNode(rootUri, 0);
		});
	
		// Print orphaned configs (those not reachable from roots)
		const allConfigs = new Set(this.configMap.keys());
		printed.forEach(uri => allConfigs.delete(uri));
		
		if (allConfigs.size > 0) {
			console.log('\nOrphaned configurations:', allConfigs.size);
			allConfigs.forEach(uri => {
				console.log(`Orphaned: ${this.formatPath(uri)}`);
				printNode(uri, 0);
			});
		}
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
		await this.buildDependencyTree();     // Rebuild entire tree to update references
	}

	private getDependencyName(block: Token): string | undefined {
		const param = block.children.find(c => c.type === 'parameter');
		return param?.value?.toString();
	}

	private decodeUri(uri: string): string {
		const decoded = URI.parse(uri);
		return decoded.fsPath;
	}
	private findIncludeBlocks(ast: any): { path: Token, block: Token }[] {
		const includes: { path: Token, block: Token }[] = [];

		const processBlock = (node: any) => {
			if (node.type === 'block' && node.value === 'include') {
				const pathAttr = node.children?.find((child: any) =>
					child.type === 'attribute' &&
					child.children?.some((c: any) => c.type === 'identifier' && c.value === 'path')
				);

				if (pathAttr) {
					const pathToken = pathAttr.children?.find((c: any) =>
						c.type === 'interpolated_string' ||
						c.type === 'string_lit' ||
						c.type === 'function_call'
					);
					if (pathToken) {
						includes.push({ path: pathToken, block: node });
					}
				}
			}

			if (node.children) {
				node.children.forEach(processBlock);
			}
		};

		processBlock(ast);
		return includes;
	}

	private findConfigPathInBlock(node: any): Token | null {
		if (!node.children) return null;

		for (const child of node.children) {
			if (child.type === 'attribute' && child.value === 'config_path') {
				const stringLit = child.children?.find((c: any) => c.type === 'string_lit');
				if (stringLit) {
					return new Token(
						stringLit.id,
						stringLit.type,
						stringLit.value,
						stringLit.location
					);
				}
			}
		}

		return null;
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

	async getDocument(uri: string): Promise<ParsedDocument | undefined> {
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
			const doc = await this.getDocument(uri);
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
			const doc = await this.getDocument(uri);
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
}