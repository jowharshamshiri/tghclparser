import path from 'node:path';

import type { DocumentLink } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

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
			if (token.parent.value === 'source' && block?.type === 'block' && block.value === 'terraform') {
				const target = await this.moduleEntryFile(token);
				if (target) links.push(this.link(token, URI.file(target).toString()));
			}
		}

		if (token.type === 'array_lit' && token.parent?.value === 'paths' && token.parent.parent?.value === 'dependencies') {
			for (const child of token.children) {
				links.push(this.link(child, await this.document.getWorkspace().resolveDependencyPath(child, this.document.getUri())));
			}
		}

		for (const child of token.children) await this.collect(child, links);
	}

	/**
	 * The file a `source` links to: from the module state when this document's source has been loaded, which also
	 * covers a fetched module, else by resolving the source as a local path.
	 */
	private async moduleEntryFile(token: Token): Promise<string | undefined> {
		const state = this.document.getModuleVariables();
		if (state?.status === 'loaded' && state.sourceInThisFile) {
			for (const name of ['variables.tf', 'main.tf']) {
				const match = state.files.find(file => path.basename(file) === name);
				if (match) return match;
			}
			return state.files[0];
		}
		const workspace = this.document.getWorkspace();
		const resolution = await workspace.resolveModuleSource(token, this.document.getUri());
		return resolution.kind === 'local' ? workspace.moduleEntryFile(resolution.moduleDir) : undefined;
	}

	private link(token: Token, target: string): DocumentLink {
		return {
			range: { start: token.startPosition, end: token.endPosition },
			target,
			data: { generated: token.type === 'reference' }
		};
	}
}
