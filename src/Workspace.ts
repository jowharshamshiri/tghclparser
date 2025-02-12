import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';

import type { DependencyInfo, RuntimeValue, ValueType } from './model';
import { Token } from './model';
import { ParsedDocument } from './ParsedDocument';

export class Workspace {
    private documents: Map<string, ParsedDocument>;
    private dependencies: Map<string, DependencyInfo[]>;
    private workspaceRoot: string | null;

    public constructor() {
        this.documents = new Map();
        this.dependencies = new Map();
        this.workspaceRoot = null;
    }

    private decodeUri(uri: string): string {
        const decoded = URI.parse(uri);
        return decoded.fsPath;
    }

    private async loadDocument(uri: string): Promise<ParsedDocument | undefined> {
        try {
            // First check if it's already loaded
            if (this.documents.has(uri)) {
                return this.documents.get(uri);
            }

            // console.log(`Loading document: ${uri}`);
            
            // Decode the URI to get the filesystem path
            const fsPath = this.decodeUri(uri);
            
            try {
                // First check if the path exists
                const stats = await fs.stat(fsPath);
                
                let actualPath = fsPath;
                if (stats.isDirectory()) {
                    actualPath = path.join(fsPath, 'terragrunt.hcl');
                    // Update the URI to reflect the actual file path
                    uri = URI.file(actualPath).toString();
                    
                    // Check if we already loaded this document under the new URI
                    if (this.documents.has(uri)) {
                        return this.documents.get(uri);
                    }
                }

                // Read the file content
                const content = await fs.readFile(actualPath, 'utf-8');

                // Create a new ParsedDocument
                const document = new ParsedDocument(this, uri, content);
                this.documents.set(uri, document);

                // Process its dependencies
                await this.updateDependencies(document);

                return document;
            } catch (error) {
                // Create an error diagnostic that points to the dependency block
                const diagnostic = {
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    message: `Dependency not found: ${fsPath}`,
                    source: 'terragrunt'
                };


                // If there's an existing document that referenced this dependency,
                // we can find the dependency block and update its diagnostics
                for (const [sourceUri, deps] of this.dependencies.entries()) {
                    const depInfo = deps.find(d => d.targetPath === fsPath);
                    if (depInfo && depInfo.block) {
                        // Update the diagnostic range to point to the dependency block
                        diagnostic.range = {
                            start: {
                                line: depInfo.block.startPosition.line,
                                character: depInfo.block.startPosition.character
                            },
                            end: {
                                line: depInfo.block.endPosition.line,
                                character: depInfo.block.endPosition.character
                            }
                        };
                        
                        // Get the source document and add the diagnostic
                        const sourceDoc = this.documents.get(sourceUri);
                        if (sourceDoc) {
                            sourceDoc.addDiagnostic(diagnostic);
                        }
                    }
                }

                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    console.log(`File not found: ${fsPath}`);
                } else {
                    console.error(`Error accessing file ${fsPath}:`, error);
                }
                return undefined;
            }
        } catch (error) {
            console.error(`Error loading document ${uri}:`, error);
            return undefined;
        }
    }

    public resolveDependencyPath(configPath: string, sourcePath: string): string {
        if (!this.workspaceRoot) {
            return configPath;
        }

        let resolvedPath: string;
        if (path.isAbsolute(configPath)) {
            resolvedPath = configPath;
        } else {
            const sourceDir = path.dirname(sourcePath);
            resolvedPath = path.resolve(sourceDir, configPath);
        }

        return resolvedPath;
    }
	

	private async pathExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	setWorkspaceRoot(root: string) {
		this.workspaceRoot = root;
	}

	async addDocument(document: ParsedDocument) {
		const uri = document.getUri();
		this.documents.set(uri, document);
		await this.updateDependencies(document);
	}

	removeDocument(uri: string) {
		this.documents.delete(uri);
		this.dependencies.delete(uri);
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
            // Ensure we have a string value for path.join
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
	
	private async updateDependencies(document: ParsedDocument) {
		const uri = document.getUri();
		const deps: DependencyInfo[] = [];

		// Find all dependency blocks in the AST
		const ast = document.getAST();
		if (ast) {
			this.findDependencyBlocks(ast, deps, URI.parse(uri).fsPath);
		}

		// Load any referenced documents that aren't already loaded
		for (const dep of deps) {
			const depUri = URI.file(dep.targetPath).toString();
			if (!this.documents.has(depUri)) {
				await this.loadDocument(depUri);
			}
		}

		if (deps.length > 0) {
			this.dependencies.set(uri, deps);
		} else {
			this.dependencies.delete(uri);
		}
	}

	private findDependencyBlocks(node: any, deps: DependencyInfo[], sourcePath: string) {
		if (node.type === 'block' &&
			(node.value === 'dependency' || node.value === 'dependencies')) {

			// For dependency blocks, find the config path
			const configPathToken = this.findConfigPathInBlock(node);
			if (configPathToken) {
				const targetPath = this.resolveDependencyPath(configPathToken.value as string, sourcePath);
				deps.push({
					sourcePath,
					targetPath,
					block: new Token(
						node.id,
						node.type,
						node.value,
						node.location
					)
				});
			}
		}

		// Recursively search children
		if (node.children) {
			for (const child of node.children) {
				this.findDependencyBlocks(child, deps, sourcePath);
			}
		}
	}

	private findConfigPathInBlock(node: any): Token | null {
		if (!node.children) return null;

		for (const child of node.children) {
			if (child.type === 'attribute' && child.value === 'config_path') {
				// Find the string literal value
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

	async getDependencies(uri: string): Promise<DependencyInfo[]> {
		// If we don't have the document yet, try to load it
		if (!this.documents.has(uri)) {
			await this.loadDocument(uri);
		}
		return this.dependencies.get(uri) || [];
	}

	async getDependents(uri: string): Promise<DependencyInfo[]> {
		const { fsPath } = URI.parse(uri);
		const dependents: DependencyInfo[] = [];

		// eslint-disable-next-line unused-imports/no-unused-vars
		for (const [sourceUri, deps] of this.dependencies.entries()) {
			for (const dep of deps) {
				if (dep.targetPath === fsPath) {
					dependents.push(dep);
				}
			}
		}

		return dependents;
	}

	async getDocument(uri: string): Promise<ParsedDocument | undefined> {
		// If document isn't loaded yet, try to load it
		if (!this.documents.has(uri)) {
			return await this.loadDocument(uri);
		}
		return this.documents.get(uri);
	}

	// New method to check if a file exists before trying to load it
	private async fileExists(uri: string): Promise<boolean> {
		try {
			const { fsPath } = URI.parse(uri);
			await fs.access(fsPath);
			return true;
		} catch {
			return false;
		}
	}
}