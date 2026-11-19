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
// repository so a boundary can be widened past it, and two links in the unit:
// one to a folder outside the repository and one to a folder inside it.
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
		await fs.mkdir(path.join(repository, 'order', 'a'), { recursive: true });
		await fs.mkdir(path.join(unitDirectory, 'config'), { recursive: true });
		await fs.mkdir(path.join(directory, 'elsewhere'));
		await fs.writeFile(path.join(directory, 'outside.yaml'), 'top: 1');
		await fs.writeFile(path.join(directory, 'elsewhere', 'e.yaml'), 'e: 1');
		await fs.writeFile(path.join(repository, 'shared', 'a.yaml'), 'a: 1');
		await fs.writeFile(path.join(repository, 'shared', 'b.yaml'), 'b: 1');
		await fs.writeFile(path.join(repository, 'order', 'a.yaml'), 'a: 1');
		await fs.writeFile(path.join(repository, 'order', 'a', 'x.yaml'), 'x: 1');
		await fs.writeFile(path.join(unitDirectory, 'config', 'c.yaml'), 'c: 1');
		await fs.symlink(path.join(directory, 'elsewhere'), path.join(unitDirectory, 'escape'));
		await fs.symlink(path.join(repository, 'shared'), path.join(unitDirectory, 'inside'));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const content = (call: string) => `inputs = { files = mark_glob_as_read(${call}) }`;
	const evaluate = (call: string) => new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
		.evaluateUnit(unitPath, content(call), unitDirectory);
	const diagnostics = (call: string) => new ParsedDocument(new Workspace(), URI.file(unitPath).toString(), content(call))
		.getDiagnostics().map(diagnostic => diagnostic.message);

	// Each call, and the files it marks; the fixture's paths are read once it is made.
	const accepted: Array<[string, () => string[]]> = [
		['"config/*.yaml"', () => [path.join(unitDirectory, 'config', 'c.yaml')]],
		['"--terragrunt-boundary=../..", "../../shared/*.yaml"', () => [path.join(repository, 'shared', 'a.yaml'), path.join(repository, 'shared', 'b.yaml')]],
		['"--terragrunt-boundary", "../..", "../../shared/*.yaml"', () => [path.join(repository, 'shared', 'a.yaml'), path.join(repository, 'shared', 'b.yaml')]],
		['"--terragrunt-boundary", "../..", "../../shared/a.yaml"', () => [path.join(repository, 'shared', 'a.yaml')]],
		['"--terragrunt-boundary", "/", "../../../*.yaml"', () => [path.join(directory, 'outside.yaml')]],
		['""', () => []],
		['"--terragrunt-boundary", "../..", ""', () => []],
		// A brace or an escape after the pattern's first separator leaves the
		// walk rooted inside the boundary.
		['"--terragrunt-boundary", "config", "config/{c,d}.yaml"', () => [path.join(unitDirectory, 'config', 'c.yaml')]],
		['"--terragrunt-boundary", "config", "config/c\\\\.yaml"', () => [path.join(unitDirectory, 'config', 'c.yaml')]],
		// A pattern with nothing to expand is its own root, so naming the
		// boundary itself is inside it, and a folder is no file.
		['"--terragrunt-boundary", "config", "config"', () => []],
		// The walk does not follow a link at its root; a named path does.
		['"inside/*.yaml"', () => []],
		['"inside/a.yaml"', () => [path.join(unitDirectory, 'inside', 'a.yaml')]],
		// The files come in the order the walk meets them: a folder's entries
		// by name, each folder's files before the next entry.
		['"../../order/**.yaml"', () => [path.join(repository, 'order', 'a', 'x.yaml'), path.join(repository, 'order', 'a.yaml')]]
	];
	for (const [call, files] of accepted) {
		it(`marks what mark_glob_as_read(${call}) matches`, async () => {
			expect(diagnostics(call)).to.deep.equal([]);
			const result = await evaluate(call);
			expect(result.error).to.equal(undefined);
			expect(runtimeValueToPlain(result.inputs!)).to.deep.equal({ files: files() });
		});
	}

	// Terragrunt's refusal of a walk that starts outside the boundary.
	const outside = (pattern: string, boundary: string, root: string) => `mark_glob_as_read pattern ${JSON.stringify(pattern)} `
		+ `resolves outside the boundary ${JSON.stringify(boundary)}; widen the boundary by passing --terragrunt-boundary as the first argument, `
		+ `for example mark_glob_as_read("--terragrunt-boundary=/", ${JSON.stringify(pattern)}): `
		+ `glob pattern resolves outside the configured boundary: ${JSON.stringify(root)} is outside ${JSON.stringify(boundary)}`;
	// The Git root is named with its links resolved; a walk root as written.
	const gitRoot = () => fs.realpath(repository);
	const refused: Array<[string, () => string | Promise<string>]> = [
		['', () => 'Expected 1 params for function mark_glob_as_read, but got 0'],
		['"config/*.yaml", "config/*.yaml"', () => 'Expected 1 params for function mark_glob_as_read, but got 2'],
		['"--terragrunt-boundary"', () => '--terragrunt-boundary requires a directory value'],
		['"--terragrunt-boundary", "", "config/*.yaml"', () => '--terragrunt-boundary requires a non-empty directory value'],
		['"--terragrunt-boundary=", "config/*.yaml"', () => '--terragrunt-boundary requires a non-empty directory value'],
		['"--terragrunt-boundaryx", "config/*.yaml"', () => 'unrecognized flag "--terragrunt-boundaryx" for mark_glob_as_read'],
		['"--terragrunt-boundary", "../..", "config/*.yaml", "config/*.yaml"', () => 'Expected 1 params for function mark_glob_as_read, but got 2'],
		['"--terragrunt-boundary=../.."', () => 'Expected 1 params for function mark_glob_as_read, but got 0'],
		['"--terragrunt-boundary", "../.."', () => 'Expected 1 params for function mark_glob_as_read, but got 0'],
		// A named path below a file is no missing file.
		['"--terragrunt-boundary", "config", "config/c.yaml/x"', () => `could not expand glob "config/c.yaml/x": stat ${path.join(unitDirectory, 'config', 'c.yaml', 'x')}: not a directory`],
		['"--terragrunt-boundary", ".", "../../shared/*.yaml"', () => outside('../../shared/*.yaml', unitDirectory, path.join(repository, 'shared'))],
		['"../../../*.yaml"', async () => outside('../../../*.yaml', await gitRoot(), directory)],
		['"/{*.yaml}"', async () => outside('/{*.yaml}', await gitRoot(), '/')],
		// A brace or an escape before the pattern's first separator roots the
		// walk above the boundary, whatever the braces expand to.
		['"--terragrunt-boundary", "config", "{config/c,config/d}.yaml"', () => outside('{config/c,config/d}.yaml', path.join(unitDirectory, 'config'), unitDirectory)],
		['"--terragrunt-boundary", "config", "co\\\\nfig/c.yaml"', () => outside('co\\nfig/c.yaml', path.join(unitDirectory, 'config'), unitDirectory)],
		// A link inside the boundary that leads out of it is outside it.
		['"escape/*.yaml"', async () => outside('escape/*.yaml', await gitRoot(), path.join(unitDirectory, 'escape'))]
	];
	for (const [call, message] of refused) {
		it(`refuses mark_glob_as_read(${call}) as Terragrunt does`, async () => {
			const result = await evaluate(call);
			expect(result.valid).to.equal(false);
			expect(result.error).to.include(await message());
		});
	}


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
