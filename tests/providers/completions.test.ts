import { expect } from 'chai';
import type { Position } from 'vscode-languageserver';

import type { ParsedDocument } from '../../src/ParsedDocument';
import { CompletionsProvider } from '../../src/providers/CompletionsProvider';
import { Schema } from '../../src/Schema';

const positionAtEnd = (text: string): Position => {
	const lines = text.split('\n');
	return { line: lines.length - 1, character: lines.at(-1)!.length };
};

const sourceAtCursor = (source: string): { text: string; position: Position } => {
	const marker = '<|>';
	const markerOffset = source.indexOf(marker);
	if (markerOffset < 0 || markerOffset !== source.lastIndexOf(marker)) {
		throw new Error('Completion source must contain exactly one <|> cursor marker');
	}
	const beforeCursor = source.slice(0, markerOffset);
	return {
		text: source.slice(0, markerOffset) + source.slice(markerOffset + marker.length),
		position: positionAtEnd(beforeCursor)
	};
};

const documentFor = (uri: string): ParsedDocument => ({ getUri: () => uri }) as ParsedDocument;

describe('current Terragrunt completions', () => {
	const provider = new CompletionsProvider(Schema.getInstance());

	it('offers only stack constructs at the root of terragrunt.stack.hcl', async () => {
		const text = '';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.stack.hcl'));
		const labels = items.map(item => item.label);
		expect(labels).to.include.members(['unit', 'stack', 'include', 'locals']);
		expect(labels).not.to.include.members(['terraform', 'remote_state', 'inputs']);
	});

	it('offers current terraform attributes and nested hooks', async () => {
		const text = 'terraform {\n  ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.hcl'));
		const labels = items.map(item => item.label);
		expect(labels).to.include.members(['source', 'version', 'mutable', 'update_source_with_cas', 'error_hook']);
		expect(labels).not.to.include('retryable_errors');
	});

	it('completes declared local, dependency, include, feature, unit, and stack symbols', async () => {
		const unitSource = `locals { region = "eu-west-1" }
dependency "network" { config_path = "../network" }
include "root" { path = find_in_parent_folders("root.hcl") expose = true }
feature "deploy" { default = true }
inputs = { reference = REFERENCE }`;
		const unitCases = [
			['local.<|>region', ['region']],
			['dependency.<|>network.outputs.id', ['network']],
			['include.<|>root.locals', ['root']],
			['feature.<|>deploy.value', ['deploy']]
		] as const;
		for (const [reference, expected] of unitCases) {
			const { text, position } = sourceAtCursor(unitSource.replace('REFERENCE', reference));
			const items = await provider.getCompletions(text, position, null, documentFor('file:///repo/terragrunt.hcl'));
			expect(items.map(item => item.label), reference).to.deep.equal(expected);
		}

		const stackSource = `unit "network" { source = "../network" path = "network" }
stack "shared" { source = "../shared" path = "shared" }
locals { reference = REFERENCE }`;
		const stackCases = [
			['unit.<|>network.path', ['network']],
			['stack.<|>shared.path', ['shared']]
		] as const;
		for (const [reference, expected] of stackCases) {
			const { text, position } = sourceAtCursor(stackSource.replace('REFERENCE', reference));
			const items = await provider.getCompletions(text, position, null, documentFor('file:///repo/terragrunt.stack.hcl'));
			expect(items.map(item => item.label), reference).to.deep.equal(expected);
		}
	});

	it('completes dependency outputs after a declared dependency name', async () => {
		const { text, position } = sourceAtCursor('dependency "network" { config_path = "../network" }\ninputs = { id = dependency.network.<|>outputs.id }');
		const items = await provider.getCompletions(text, position, null, documentFor('file:///repo/terragrunt.hcl'));
		expect(items.map(item => item.label)).to.deep.equal(['outputs']);
	});

	it('completes generated component metadata used by stack autoinclude blocks', async () => {
		const { text, position } = sourceAtCursor('unit "network" { source = "../network" path = "network" }\nlocals { target = unit.network.<|>path }');
		const items = await provider.getCompletions(text, position, null, documentFor('file:///repo/terragrunt.stack.hcl'));
		expect(items.map(item => item.label)).to.deep.equal(['path', 'name']);
	});

	it('recognizes current Terragrunt functions', () => {
		const text = 'locals { parent = find_in_parent_folders(';
		expect(provider.isFunctionContext(text, positionAtEnd(text))).to.equal(true);
	});

	it('does not offer completions inside comments', async () => {
		const text = '# terr';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.hcl'));
		expect(items).to.deep.equal([]);
	});
});
