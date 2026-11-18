import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { URI } from 'vscode-uri';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';
import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';

// Each argument form Terragrunt v1.2.2 gives mark_glob_as_read, evaluated in a
// unit two levels below a Git repository's root, with a file beside the
// repository so a boundary can be widened past it.
describe('mark_glob_as_read argument forms', () => {
	let directory: string;
	let repository: string;
	let unitDirectory: string;
	let unitPath: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-glob-'));
		repository = path.join(directory, 'repo');
		unitDirectory = path.join(repository, 'live', 'app');
		unitPath = path.join(unitDirectory, 'terragrunt.hcl');
		await fs.mkdir(path.join(repository, '.git'), { recursive: true });
		await fs.mkdir(path.join(repository, 'shared'));
		await fs.mkdir(path.join(unitDirectory, 'config'), { recursive: true });
		await fs.writeFile(path.join(directory, 'outside.yaml'), 'top: 1');
		await fs.writeFile(path.join(repository, 'shared', 'a.yaml'), 'a: 1');
		await fs.writeFile(path.join(repository, 'shared', 'b.yaml'), 'b: 1');
		await fs.writeFile(path.join(unitDirectory, 'config', 'c.yaml'), 'c: 1');
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const content = (call: string) => `inputs = { files = mark_glob_as_read(${call}) }`;
	const evaluate = (call: string) => new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
		.evaluateUnit(unitPath, content(call), unitDirectory);
	const diagnostics = (call: string) => new ParsedDocument(new Workspace(), URI.file(unitPath).toString(), content(call))
		.getDiagnostics().map(diagnostic => diagnostic.message);

	it('marks what each accepted form matches', async () => {
		const accepted: Array<[string, string[]]> = [
			['"config/*.yaml"', [path.join(unitDirectory, 'config', 'c.yaml')]],
			['"--terragrunt-boundary=../..", "../../shared/*.yaml"', [path.join(repository, 'shared', 'a.yaml'), path.join(repository, 'shared', 'b.yaml')]],
			['"--terragrunt-boundary", "../..", "../../shared/*.yaml"', [path.join(repository, 'shared', 'a.yaml'), path.join(repository, 'shared', 'b.yaml')]],
			['"--terragrunt-boundary", "../..", "../../shared/a.yaml"', [path.join(repository, 'shared', 'a.yaml')]],
			['"--terragrunt-boundary", "/", "../../../*.yaml"', [path.join(directory, 'outside.yaml')]],
			['""', []],
			['"--terragrunt-boundary", "../..", ""', []]
		];
		for (const [call, files] of accepted) {
			expect(diagnostics(call), call).to.deep.equal([]);
			const result = await evaluate(call);
			expect(result.error, call).to.equal(undefined);
			expect(runtimeValueToPlain(result.inputs!), call).to.deep.equal({ files });
		}
	});

	it('refuses what Terragrunt refuses, saying why', async () => {
		const refused: Array<[string, string]> = [
			['', 'Expected 1 params for function mark_glob_as_read, but got 0'],
			['"config/*.yaml", "config/*.yaml"', 'Expected 1 params for function mark_glob_as_read, but got 2'],
			['"--terragrunt-boundary"', '--terragrunt-boundary requires a directory value'],
			['"--terragrunt-boundary", "", "config/*.yaml"', '--terragrunt-boundary requires a non-empty directory value'],
			['"--terragrunt-boundary=", "config/*.yaml"', '--terragrunt-boundary requires a non-empty directory value'],
			['"--terragrunt-boundaryx", "config/*.yaml"', 'unrecognized flag "--terragrunt-boundaryx" for mark_glob_as_read'],
			['"--terragrunt-boundary", "../..", "config/*.yaml", "config/*.yaml"', 'Expected 1 params for function mark_glob_as_read, but got 2'],
			['"--terragrunt-boundary=../.."', 'Expected 1 params for function mark_glob_as_read, but got 0'],
			['"--terragrunt-boundary", "../.."', 'Expected 1 params for function mark_glob_as_read, but got 0'],
			['"--terragrunt-boundary", ".", "../../shared/*.yaml"', 'starts outside Terragrunt boundary'],
			['"../../../*.yaml"', 'starts outside Terragrunt boundary']
		];
		for (const [call, message] of refused) {
			const result = await evaluate(call);
			expect(result.valid, call).to.equal(false);
			expect(result.error, call).to.include(message);
		}
	});

	it('flags a call with no arguments, or more than the boundary and pattern', () => {
		expect(diagnostics('')).to.deep.equal(['Function "mark_glob_as_read" requires at least 1 argument']);
		expect(diagnostics('"--terragrunt-boundary", "../..", "config/*.yaml", "config/*.yaml"'))
			.to.deep.equal(['Function "mark_glob_as_read" accepts at most 3 arguments']);
	});

	it('reads the files the separate boundary form matches into the unit', async () => {
		await fs.writeFile(unitPath, `locals {
  shared = mark_glob_as_read("--terragrunt-boundary", "../..", "../../shared/*.yaml")
}`);
		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(repository).toString());

		const graph = await workspace.refreshDependencyTree();
		const app = graph?.children.find(node => node.name.endsWith(path.join('live', 'app', 'terragrunt.hcl')));
		expect(app?.data.reading?.map(uri => URI.parse(uri).fsPath)).to.deep.equal([
			path.join(repository, 'shared', 'a.yaml'),
			path.join(repository, 'shared', 'b.yaml')
		]);
	});
});
