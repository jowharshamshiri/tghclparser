import type { DocumentLink } from "vscode-languageserver";
import { URI } from "vscode-uri";

import type { Token } from "~/model";
import type { ParsedDocument } from "~/ParsedDocument";

export class LinkProvider {
    constructor(private parsedDocument: ParsedDocument) { }

    async getLinks(): Promise<DocumentLink[]> {
        try {
            const links: DocumentLink[] = [];
            const tokens = this.parsedDocument.getTokens();

            const findConfigPaths = async (token: Token) => {
                if (token.type === 'string_lit' && token.parent?.type === 'attribute' && // Handle single dependency path
                        token.parent.value === 'config_path' &&
                            token.parent.parent?.type === 'block' &&
                            token.parent.parent.value === 'dependency') {

                            const targetPath = await this.parsedDocument.getWorkspace().resolveDependencyPath(
                                token, 
                                URI.parse(this.parsedDocument.getUri()).fsPath
                            );

                            links.push({
                                range: {
                                    start: {
                                        line: token.startPosition.line,
                                        character: token.startPosition.character
                                    },
                                    end: {
                                        line: token.endPosition.line,
                                        character: token.endPosition.character
                                    }
                                },
                                target: targetPath
                            });
                        }
                if (token.type === 'array_lit' && 
                    token.parent?.value === 'paths' &&
                    token.parent.parent?.type === 'block' &&
                    token.parent.parent.value === 'dependencies') {

                    for (const child of token.children) {
                        const targetPath = await this.parsedDocument.getWorkspace().resolveDependencyPath(
                            child, 
                            URI.parse(this.parsedDocument.getUri()).fsPath
                        );

                        links.push({
                            range: {
                                start: {
                                    line: child.startPosition.line,
                                    character: child.startPosition.character
                                },
                                end: {
                                    line: child.endPosition.line,
                                    character: child.endPosition.character
                                }
                            },
                            target: targetPath
                        });
                    }
                }

                // Recursively process children
                token.children.forEach(findConfigPaths);
            };

            tokens.forEach(findConfigPaths);
            return links;
        } catch (error) {
            console.error(`Error providing document links: ${error}`);
            return [];
        }
    }
}