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
				await this.linkResolved(token, links, () => this.document.getWorkspace().resolveDependencyPath(token, this.document.getUri()));
			}
			if (token.parent.value === 'path' && block?.type === 'block' && block.value === 'include') {
				await this.linkResolved(token, links, () => this.document.getWorkspace().resolveIncludePath(token, this.document.getUri()));
			}
			if (token.parent.value === 'source' && block?.type === 'block' && block.value === 'terraform') {
				const target = await this.moduleEntryFile(token);
				if (target) links.push(this.link(token, URI.file(target).toString()));
			}
		}

		if (token.type === 'array_lit' && token.parent?.value === 'paths' && token.parent.parent?.value === 'dependencies') {
			for (const child of token.children) {
				await this.linkResolved(child, links, () => this.document.getWorkspace().resolveDependencyPath(child, this.document.getUri()));
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

	/**
	 * Links a path token to its resolved target. A path that does not resolve, such as one still being typed, gets no
	 * link: the workspace reports that problem when the document is added to it, with the same message.
	 * @param token the path token the link covers.
	 * @param links the links collected so far, added to when the path resolves.
	 * @param resolve resolves the token to the target URI, rejecting when it cannot.
	 * @throws what `resolve` rejected with when that is a defect and not a path that does not resolve.
	 */
	private async linkResolved(token: Token, links: DocumentLink[], resolve: () => Promise<string>): Promise<void> {
		let target: string;
		try {
			target = await resolve();
		} catch (error) {
			// The resolvers say a path does not resolve with a plain Error. Anything else is a defect in resolving,
			// and leaving a link out would hide it.
			if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
			return;
		}
		links.push(this.link(token, target));
	}

	private link(token: Token, target: string): DocumentLink {
		return {
			range: { start: token.startPosition, end: token.endPosition },
			target,
			data: { generated: token.type === 'reference' }
		};
	}
}
