import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { URI } from 'vscode-uri';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';
import { runtimeToPlain } from '../src/functions/utils';
import type { RuntimeValue, ValueType } from '../src/model';
import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';

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
		['fileset("missing", "*")', []],
		// An empty directory is the configuration's own.
		['fileset("", "fs/*.txt")', ['fs/.dot.txt', 'fs/one.txt']]
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

	// A sensitive directory or pattern is searched as any other, and the
	// files it answers, none included, are sensitive too.
	const sensitive: Array<[string, string[]]> = [
		['fileset(sensitive("fs"), "*")', ['.dot.txt', 'one.txt']],
		['fileset("fs", sensitive("sub/*"))', ['sub/two.txt']],
		['fileset(sensitive("fs"), sensitive("*.txt"))', ['.dot.txt', 'one.txt']],
		['fileset(sensitive("missing"), "*")', []]
	];
	for (const [call, files] of sensitive) {
		it(`answers ${call} as a sensitive value`, async () => {
			const result = await evaluate(call);
			expect(result.error).to.equal(undefined);
			const answered = (result.inputs!.value as Map<string, RuntimeValue<ValueType>>).get('files')!;
			expect(answered.type).to.equal('sensitive');
			expect(runtimeToPlain(answered)).to.deep.equal(files);
			const revealed = await evaluate(`nonsensitive(${call})`);
			expect(runtimeValueToPlain(revealed.inputs!)).to.deep.equal({ files });
		});
	}

	// Terragrunt takes any string as the directory, so neither the diagnostics
	// nor the documentation restrict it.
	it('takes any string as its directory', async () => {
		for (const directory of ['""', '"C:\\\\"', '"a:b|c"']) {
			const content = `inputs = { files = fileset(${directory}, "*") }`;
			const document = new ParsedDocument(new Workspace(), URI.file(unitPath).toString(), content);
			expect(document.getDiagnostics().map(diagnostic => diagnostic.message)).to.deep.equal([]);
			const hover = await document.getHoverInfo({ line: 0, character: content.indexOf('fileset') + 1 });
			const shown = String((hover as { value: string }).value);
			expect(shown).to.include('**path** (required)');
			expect(shown).not.to.include('*Pattern:*');
		}
	});

	// The files the unit reads, as the workspace reports them.
	const reading = async () => {
		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(repository).toString());
		const graph = await workspace.refreshDependencyTree();
		const app = graph?.children.find(node => node.name.endsWith(path.join('live', 'app', 'terragrunt.hcl')));
		return app?.data.reading?.map(uri => URI.parse(uri).fsPath).sort();
	};

	// Terragrunt records each file fileset answers as read where its discovery
	// evaluates the call: the locals, exclude and the other blocks it decodes,
	// not inputs or generate. A sensitive directory is read all the same, and a
	// matched HCL file is read, not parsed.
	it('reads the files it answers where Terragrunt discovery evaluates it', async () => {
		await fs.writeFile(path.join(unitDirectory, 'config', 'broken.hcl'), 'locals {');
		await fs.writeFile(unitPath, `locals {
  configs = fileset("config", "*")
  secret  = fileset(sensitive("fs"), "sub/*")
}

exclude {
  if      = length(fileset("fs", "one.txt")) > 0
  actions = ["plan"]
}

generate "listing" {
  path      = "listing.txt"
  if_exists = "overwrite"
  contents  = join(",", fileset("fs", ".dot.txt"))
}

inputs = {
  files = fileset("fs", "**")
}
`);
		expect(await reading()).to.deep.equal([
			path.join(unitDirectory, 'config', 'broken.hcl'),
			path.join(unitDirectory, 'config', 'c.yaml'),
			path.join(unitDirectory, 'fs', 'one.txt'),
			path.join(unitDirectory, 'fs', 'sub', 'two.txt')
		].sort());
	});

	// A directory only evaluation gives costs its own reads, not the unit's.
	it('still reads the other files when a directory needs the configuration evaluated', async () => {
		await fs.writeFile(unitPath, `locals {
  configs = fileset("config", "*.yaml")
  chosen  = fileset(true ? "fs" : "config", "*")
}
`);
		expect(await reading()).to.include(path.join(unitDirectory, 'config', 'c.yaml'));
	});

	// In an included file fileset searches from that file's directory.
	it('reads what an included file answers, from that file\'s directory', async () => {
		await fs.writeFile(path.join(repository, 'root.hcl'), 'locals {\n  shared = fileset("shared", "*.yaml")\n}\n');
		await fs.writeFile(unitPath, 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n');
		expect(await reading()).to.include.members([
			path.join(repository, 'shared', 'a.yaml'),
			path.join(repository, 'shared', 'b.yaml')
		]);
	});

	// A refusal names a sensitive directory or pattern as Terragrunt does.
	for (const call of ['fileset(sensitive("fs"), "[")', 'fileset("fs", sensitive("["))']) {
		it(`refuses ${call} without showing the sensitive value`, async () => {
			const result = await evaluate(call);
			expect(result.valid).to.equal(false);
			expect(result.error).to.include('failed to glob pattern (sensitive value): syntax error in pattern');
			expect(result.error).not.to.include(path.join(unitDirectory, 'fs'));
		});
	}
});
