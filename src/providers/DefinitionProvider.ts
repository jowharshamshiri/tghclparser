import type { LocationLink, Position, Range } from 'vscode-languageserver';

import type { Token } from '../model';
import type { ParsedDocument } from '../ParsedDocument';

/** The start of a file, for a definition that is a whole configuration rather than something in it. */
const fileStart: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/**
 * Where the value a reference names is set: `local.<name>`, `include.<label>…` and `dependency.<name>…`.
 */
export class DefinitionProvider {
	constructor(private readonly document: ParsedDocument) {}

	/**
	 * Finds the definition of the reference at a position.
	 *
	 * - `local.<name>` leads to the attribute in this configuration's `locals` block. Locals belong to the file that
	 *   sets them.
	 * - `include.<label>.locals.<name>` leads to the local in the included configuration, and
	 *   `include.<label>.inputs.<key>` to the key in its `inputs`, or to `inputs` itself when that is an expression
	 *   whose keys cannot be read. `include.<label>.<name>` leads to the root block or attribute of that name in the
	 *   included configuration, and `include.<label>` to the configuration.
	 * - `dependency.<name>` leads to the dependency block. Terragrunt merges the dependency blocks of included
	 *   configurations into the unit, so the block is looked for in the configurations merged into this one, in
	 *   their merge priority, leaving out an include with `merge_strategy = "no_merge"`.
	 *
	 * @param position the position, anywhere in the reference.
	 * @returns the definition, or none when the position is not in such a reference, or what it names is not set.
	 * @throws when resolving an include path or the merged configurations fails for any reason other than a path
	 *   that does not resolve, which is a defect.
	 */
	async getDefinition(position: Position): Promise<LocationLink[]> {
		const reference = this.referenceAt(position);
		if (!reference) return [];
		if (reference.type === 'local_reference') {
			const [name] = this.chain(reference);
			const attribute = name === undefined ? undefined : this.local(this.document, name);
			return attribute ? [this.attributeLink(reference, this.document, attribute)] : [];
		}
		if (reference.type === 'dependency_reference') {
			const name = reference.children.find(child => child.type === 'dependency_name')?.value;
			return typeof name === 'string' ? this.dependency(reference, name) : [];
		}
		return this.include(reference, this.chain(reference));
	}

	/** The innermost `local.…`, `dependency.…` or `include.…` reference containing the position. */
	private referenceAt(position: Position): Token | undefined {
		for (let token = this.document.findTokenAtPosition(position); token; token = token.parent) {
			if (token.type === 'local_reference' || token.type === 'dependency_reference') return token;
			if (token.type === 'reference' && token.value === 'include') return token;
		}
		return undefined;
	}

	/** The names a reference's access chain is made of, `root`, `locals`, `bucket` for `include.root.locals.bucket`. */
	private chain(reference: Token): string[] {
		return reference.children.find(child => child.type === 'access_chain')?.children
			.filter(child => child.type === 'reference_identifier')
			.map(child => child.getDisplayText()) ?? [];
	}

	private rootChildren(document: ParsedDocument): Token[] {
		return document.getTokens()[0]?.children ?? [];
	}

	private blocks(document: ParsedDocument, type: string): Token[] {
		return this.rootChildren(document).filter(child => child.type === 'block' && child.value === type);
	}

	private label(block: Token): Token | undefined {
		return block.children.find(child => child.type === 'parameter');
	}

	private local(document: ParsedDocument, name: string): Token | undefined {
		for (const block of this.blocks(document, 'locals')) {
			const attribute = block.children.find(child => child.type === 'attribute' && child.value === name);
			if (attribute) return attribute;
		}
		return undefined;
	}

	private async include(reference: Token, [label, section, key]: string[]): Promise<LocationLink[]> {
		const block = this.blocks(this.document, 'include').find(candidate => this.label(candidate)?.getDisplayText() === label);
		const pathValue = block?.children.find(child => child.type === 'attribute' && child.value === 'path')
			?.children.find(child => child.type !== 'attribute_identifier');
		if (!pathValue) return [];
		const workspace = this.document.getWorkspace();
		const target = await this.resolved(() => workspace.resolveIncludePath(pathValue, this.document.getUri()));
		// A path that resolves to a file that is not there reads as a path that does not resolve.
		const included = target === undefined ? undefined : await this.resolved(() => workspace.getParsedDocument(target));
		if (!included) return [];

		if (section === undefined) return [this.link(reference, included.getUri(), fileStart, fileStart)];
		if (section === 'locals' && key !== undefined) {
			const attribute = this.local(included, key);
			return attribute ? [this.attributeLink(reference, included, attribute)] : [];
		}
		if (section === 'inputs' && key !== undefined) {
			const inputs = included.getInputsAssignment();
			if (!inputs) return [];
			const value = inputs.children.find(child => child.type !== 'root_assignment_identifier');
			const attribute = value?.type === 'object'
				? value.children.find(child => child.type === 'attribute' && child.value === key)
				: undefined;
			if (attribute) return [this.attributeLink(reference, included, attribute)];
			// Keys set by an expression, such as merge(...), cannot be read; inputs is where they are set.
			return value?.type === 'object' ? [] : [this.attributeLink(reference, included, inputs)];
		}
		const named = this.rootChildren(included).find(child => child.value === section
			&& (child.type === 'block' || child.type === 'assignment' || child.type === 'attribute'));
		return named ? [this.attributeLink(reference, included, named)] : [];
	}

	private async dependency(reference: Token, name: string): Promise<LocationLink[]> {
		const workspace = this.document.getWorkspace();
		const merged = await this.resolved(() => workspace.getMergedConfigurations(this.document));
		// When what is merged cannot be determined -- an include path still being written, say -- only this
		// configuration's own blocks are known. The workspace reports why when the document is added.
		const uris = merged === undefined || 'reason' in merged ? [this.document.getUri()] : merged.configurations;
		for (const uri of uris) {
			const configuration = uri === this.document.getUri() ? this.document : await workspace.getParsedDocument(uri);
			if (!configuration) continue;
			const block = this.blocks(configuration, 'dependency').find(candidate => this.label(candidate)?.getDisplayText() === name);
			if (block) return [this.link(reference, configuration.getUri(), this.range(block), this.range(this.label(block) ?? block))];
		}
		return [];
	}

	/**
	 * Runs a resolution that rejects with a plain Error when a path does not resolve, such as one still being typed.
	 *
	 * @returns what it resolved to, or undefined when the path does not resolve.
	 * @throws what it rejected with when that is a defect and not a path that does not resolve.
	 */
	private async resolved<T>(resolve: () => Promise<T>): Promise<T | undefined> {
		try {
			return await resolve();
		} catch (error) {
			if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
			return undefined;
		}
	}

	/** A link to an attribute, block or assignment, selecting its name. */
	private attributeLink(reference: Token, document: ParsedDocument, target: Token): LocationLink {
		const name = target.children.find(child => child.type === 'attribute_identifier' || child.type === 'root_assignment_identifier'
			|| child.type === 'block_identifier');
		return this.link(reference, document.getUri(), this.range(target), this.range(name ?? target));
	}

	private link(reference: Token, targetUri: string, targetRange: Range, targetSelectionRange: Range): LocationLink {
		return { originSelectionRange: this.range(reference), targetUri, targetRange, targetSelectionRange };
	}

	private range(token: Token): Range {
		return { start: token.startPosition, end: token.endPosition };
	}
}
