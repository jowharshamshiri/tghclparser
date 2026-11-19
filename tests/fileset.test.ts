import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';

// fileset as Terragrunt v1.2.2 answers it, evaluated in a unit two levels
// below a Git repository's root, with a file beside the repository and a
// folder of files, dotfiles and a link to a folder outside the repository.
describe('fileset', () => {
	let directory: string;
	let repository: string;
	let unitDirectory: string;
	let unitPath: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-fileset-'));
		repository = path.join(directory, 'repo');
		unitDirectory = path.join(repository, 'live', 'app');
		unitPath = path.join(unitDirectory, 'terragrunt.hcl');
		await fs.mkdir(path.join(repository, '.git'), { recursive: true });
		await fs.mkdir(path.join(repository, 'shared'));
		await fs.mkdir(path.join(unitDirectory, 'config'), { recursive: true });
		await fs.mkdir(path.join(unitDirectory, 'fs', 'sub'), { recursive: true });
		await fs.mkdir(path.join(unitDirectory, 'fs', '.hidden-dir'));
		await fs.mkdir(path.join(directory, 'elsewhere'));
		await fs.writeFile(path.join(directory, 'outside.yaml'), 'top: 1');
		await fs.writeFile(path.join(directory, 'elsewhere', 'e.yaml'), 'e: 1');
		await fs.writeFile(path.join(repository, 'shared', 'a.yaml'), 'a: 1');
		await fs.writeFile(path.join(repository, 'shared', 'b.yaml'), 'b: 1');
		await fs.writeFile(path.join(unitDirectory, 'config', 'c.yaml'), 'c: 1');
		await fs.writeFile(path.join(unitDirectory, 'fs', 'one.txt'), 'one');
		await fs.writeFile(path.join(unitDirectory, 'fs', 'sub', 'two.txt'), 'two');
		await fs.writeFile(path.join(unitDirectory, 'fs', '.dot.txt'), 'dot');
		await fs.writeFile(path.join(unitDirectory, 'fs', '.hidden-dir', 'h.txt'), 'hid');
		await fs.symlink(path.join(directory, 'elsewhere'), path.join(unitDirectory, 'fs', 'linked'));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const evaluate = (call: string) => new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
		.evaluateUnit(unitPath, `inputs = { files = ${call} }`, unitDirectory);

	// Each call, and the files it answers relative to the directory searched,
	// in lexical order.
	const answered: Array<[string, string[]]> = [
		['fileset(".", "config/*.yaml")', ['config/c.yaml']],
		['fileset("config", "*.yaml")', ['c.yaml']],
		// No boundary applies: the folder above the repository is searched.
		['fileset("../../..", "*.yaml")', ['outside.yaml']],
		// A doublestar segment spans no folder as well as several.
		['fileset("../..", "shared/**/*.yaml")', ['shared/a.yaml', 'shared/b.yaml']],
		['fileset("../..", "{shared/a,live/app/config/c}.yaml")', ['live/app/config/c.yaml', 'shared/a.yaml']],
		['fileset("fs", "{sub/two,one}.txt")', ['one.txt', 'sub/two.txt']],
		// A star matches a leading dot, and stays within one folder.
		['fileset("fs", "*")', ['.dot.txt', 'one.txt']],
		['fileset("fs", "*/two.txt")', ['sub/two.txt']],
		['fileset("fs", "[!o]*.txt")', ['.dot.txt']],
		// A doublestar that is not a whole segment is a single star.
		['fileset("fs", "**.txt")', ['.dot.txt', 'one.txt']],
		['fileset("fs", "sub/**")', ['sub/two.txt']],
		// A link to a folder is walked as though the folder lived there.
		['fileset("fs", "**")', ['.dot.txt', '.hidden-dir/h.txt', 'linked/e.yaml', 'one.txt', 'sub/two.txt']],
		['fileset("fs", "**/*.txt")', ['.dot.txt', '.hidden-dir/h.txt', 'one.txt', 'sub/two.txt']],
		['fileset("fs", "linked/*.yaml")', ['linked/e.yaml']],
		['fileset("missing", "*")', []]
	];
	for (const [call, files] of answered) {
		it(`answers ${call}`, async () => {
			const result = await evaluate(call);
			expect(result.error).to.equal(undefined);
			expect(runtimeValueToPlain(result.inputs!)).to.deep.equal({ files });
		});
	}

	// A malformed pattern is refused, named joined to the directory.
	const refused: Array<[string, () => string]> = [
		['fileset("fs", "[")', () => path.join(unitDirectory, 'fs', '[')],
		['fileset("fs", "a\\\\")', () => path.join(unitDirectory, 'fs', 'a\\')]
	];
	for (const [call, joined] of refused) {
		it(`refuses ${call} as Terragrunt does`, async () => {
			const result = await evaluate(call);
			expect(result.valid).to.equal(false);
			expect(result.error).to.include(`failed to glob pattern ${JSON.stringify(joined())}: syntax error in pattern`);
		});
	}
});
