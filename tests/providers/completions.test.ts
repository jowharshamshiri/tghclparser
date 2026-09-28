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

const documentFor = (uri: string, extras: Partial<ParsedDocument> = {}): ParsedDocument => ({ getUri: () => uri, ...extras }) as ParsedDocument;

const moduleDocument = (ownKeys: string[] = []): ParsedDocument => documentFor('file:///repo/live/app/terragrunt.hcl', {
	getModuleVariables: () => ({
		status: 'loaded',
		moduleDir: '/repo/modules/app',
		sourceText: '../../modules/app',
		sourceInThisFile: true,
		files: ['/repo/modules/app/variables.tf'],
		inheritedInputKeys: new Set(),
		inheritedInputsKnown: true,
		variables: [
			{ name: 'region', hasDefault: true, typeText: 'string', typeKind: 'string', defaultText: '"eu-west-1"', file: '/repo/modules/app/variables.tf', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
			{ name: 'name', hasDefault: false, typeText: 'string', typeKind: 'string', description: 'Service name', file: '/repo/modules/app/variables.tf', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
			{ name: 'tags', hasDefault: true, typeText: 'map(string)', typeKind: 'map', type: { kind: 'map', element: { kind: 'primitive', name: 'string', text: 'string' }, text: 'map(string)' }, file: '/repo/modules/app/variables.tf', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
			{
				name: 'ipam', hasDefault: true, typeText: 'object({...})', typeKind: 'object', file: '/repo/modules/app/variables.tf', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				type: {
					kind: 'object', text: 'object({...})', attributes: [
						{ name: 'enable', type: { kind: 'primitive', name: 'bool', text: 'bool' }, optional: true, defaultText: 'false' },
						{ name: 'description', type: { kind: 'primitive', name: 'string', text: 'string' }, optional: false },
						{ name: 'rules', type: { kind: 'list', text: 'list(object({ id = string }))', element: { kind: 'object', text: 'object({ id = string })', attributes: [{ name: 'id', type: { kind: 'primitive', name: 'string', text: 'string' }, optional: false }] } }, optional: true },
						{ name: 'accounts', type: { kind: 'map', text: 'map(object({ id = string }))', element: { kind: 'object', text: 'object({ id = string })', attributes: [{ name: 'id', type: { kind: 'primitive', name: 'string', text: 'string' }, optional: false }] } }, optional: true }
					]
				}
			}
		]
	}),
	getOwnInputKeys: () => ownKeys,
	getInputsAssignment: () => undefined,
	getInlineFunctions: () => new Map()
});

describe('current Terragrunt completions', () => {
	const provider = new CompletionsProvider(Schema.getInstance());

	it('offers only stack constructs at the root of terragrunt.stack.hcl', async () => {
		const text = '';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.stack.hcl'));
		const labels = items.map(item => item.label);
		expect(labels).to.include.members(['unit', 'stack', 'include', 'locals']);
		expect(labels).not.to.include.members(['terraform', 'remote_state', 'inputs']);
	});

	it('offers the attributes of a labeled block inside it', async () => {
		const text = 'include "root" {\n  ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.hcl'));
		const labels = items.map(item => item.label);
		expect(labels).to.include.members(['path', 'expose', 'merge_strategy']);
		expect(labels).not.to.include.members(['terraform', 'locals']);
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

	it('offers module variables at the top level of inputs, required first, without root constructs', async () => {
		const text = 'terraform {\n  source = "../../modules/app"\n}\n\ninputs = {\n  ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument());
		const sorted = [...items].sort((left, right) => (left.sortText ?? '').localeCompare(right.sortText ?? ''));
		expect(sorted.map(item => item.label)).to.deep.equal(['name', 'ipam', 'region', 'tags']);
		expect(sorted[0].detail).to.equal('string · required');
		expect(sorted[0].insertText).to.equal('name = "${1:value}"');
		expect(sorted[3].insertText).to.equal('tags = {\n\t${1}\n}');
		expect(items.map(item => item.label)).not.to.include.members(['terraform', 'locals', 'inputs']);
	});

	it('leaves out inputs keys the unit already assigns', async () => {
		const text = 'inputs = {\n  name = "api"\n  ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument(['name']));
		expect(items.map(item => item.label)).to.deep.equal(['region', 'tags', 'ipam']);
	});

	it('offers the attributes of an object-typed variable inside its value', async () => {
		const text = 'inputs = {\n  ipam = {\n    enable = true\n    ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument());
		const sorted = [...items].sort((left, right) => (left.sortText ?? '').localeCompare(right.sortText ?? ''));
		expect(sorted.map(item => item.label)).to.deep.equal(['description', 'accounts', 'enable', 'rules']);
		expect(sorted[0].detail).to.equal('string · required');
		expect(sorted[2].documentation).to.deep.equal({ kind: 'markdown', value: 'Default: `false`' });
		expect(sorted[3].insertText).to.equal('rules = [${1}]');
	});

	it('descends through list elements and map values to nested objects', async () => {
		for (const text of [
			'inputs = {\n  ipam = {\n    rules = [{\n      ',
			'inputs = {\n  ipam = {\n    rules = [\n      {\n        ',
			'inputs = {\n  ipam = {\n    accounts = {\n      "prod" = {\n        ',
			'inputs = {\n  ipam = {\n    accounts = {\n      prod = {\n        '
		]) {
			const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument());
			expect(items.map(item => item.label), JSON.stringify(text)).to.deep.equal(['id']);
		}
	});

	it('offers nothing for a key the type does not describe or inside a merge call', async () => {
		for (const text of [
			'inputs = {\n  ipam = {\n    unknown = {\n      ',
			'inputs = {\n  ipam = merge(local.defaults, {\n    ',
			'inputs = {\n  ipam = {\n    rules = [\n      '
		]) {
			const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument());
			expect(items, JSON.stringify(text)).to.deep.equal([]);
		}
	});

	it('offers nothing structural inside a nested inputs value', async () => {
		const text = 'inputs = {\n  tags = {\n    ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument());
		expect(items).to.deep.equal([]);
	});

	it('still offers functions after an equals sign inside inputs', async () => {
		const text = 'inputs = {\n  name = get_';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, moduleDocument());
		expect(items.map(item => item.label)).to.include('get_env');
		expect(items.map(item => item.label)).not.to.include('region');
	});

	it('offers no root constructs inside inputs when no module is known', async () => {
		const text = 'inputs = {\n  ';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.hcl'));
		expect(items).to.deep.equal([]);
	});

	it('does not offer completions inside comments', async () => {
		const text = '# terr';
		const items = await provider.getCompletions(text, positionAtEnd(text), null, documentFor('file:///repo/terragrunt.hcl'));
		expect(items).to.deep.equal([]);
	});
});
