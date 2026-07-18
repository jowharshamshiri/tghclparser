import type { DocumentLink } from 'vscode-languageserver';

import type { Token } from '../model';
import type { ParsedDocument } from '../ParsedDocument';

export class LinkProvider {
	constructor(private readonly document: ParsedDocument) {}

	async getLinks(): Promise<DocumentLink[]> {
		const links: DocumentLink[] = [];
		for (const token of this.document.getTokens()) await this.collect(token, links);
		return links;
	}

	private async collect(token: Token, links: DocumentLink[]): Promise<void> {
		if ((token.type === 'string_lit' || token.type === 'interpolated_string' || token.type === 'function_call' || token.type === 'reference') && token.parent?.type === 'attribute') {
			const block = token.parent.parent;
			if (token.parent.value === 'config_path' && block?.type === 'block' && block.value === 'dependency') {
				links.push(this.link(token, await this.document.getWorkspace().resolveDependencyPath(token, this.document.getUri())));
			}
			if (token.parent.value === 'path' && block?.type === 'block' && block.value === 'include') {
				links.push(this.link(token, await this.document.getWorkspace().resolveIncludePath(token, this.document.getUri())));
			}
		}

		if (token.type === 'array_lit' && token.parent?.value === 'paths' && token.parent.parent?.value === 'dependencies') {
			for (const child of token.children) {
				links.push(this.link(child, await this.document.getWorkspace().resolveDependencyPath(child, this.document.getUri())));
			}
		}

		await Promise.all(token.children.map(child => this.collect(child, links)));
	}

	private link(token: Token, target: string): DocumentLink {
		return {
			range: { start: token.startPosition, end: token.endPosition },
			target,
			data: { generated: token.type === 'reference' }
		};
	}
}
