import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { URI } from 'vscode-uri';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';
import { Workspace } from '../src/Workspace';

// Every answer here is what Terragrunt v1.2.2 (109a529e, its release binary)
// gave on this fixture: a repository `real/base` holding the unit `a/b/app`
// and the `a/root.hcl` it includes, a file beside the repository's parent,
// and the unit entered through the link `link` to `real`. The fixture lies in
// a directory reached through no link, so a path is resolved only where the
// link is.
describe('the Git repository root, as Terragrunt finds it', () => {
	let directory: string;
	let real: string;
	let link: string;
	let unitDirectory: string;
	let unitPath: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tghclparser-git-root-'));
		real = path.join(directory, 'real');
		link = path.join(directory, 'link');
		await fs.mkdir(path.join(real, 'base', '.git'), { recursive: true });
		await fs.mkdir(path.join(real, 'base', 'a', 'b', 'app'), { recursive: true });
		await fs.writeFile(path.join(directory, 'outside.yaml'), 'top: 1');
		await fs.writeFile(path.join(real, 'base', 'shared.yaml'), 'shared: 1');
		await fs.writeFile(path.join(real, 'base', 'a', 'root.hcl'), `locals {
  root = get_repo_root()
  from = get_path_from_repo_root()
  to   = get_path_to_repo_root()
}`);
		await fs.symlink(real, link);
		unitDirectory = path.join(link, 'base', 'a', 'b', 'app');
		unitPath = path.join(unitDirectory, 'terragrunt.hcl');
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const list = (...entries: string[]) => entries.join(path.delimiter);
	const ceiling = (value: string | undefined): Record<string, string> => value === undefined ? {} : { GIT_CEILING_DIRECTORIES: value };
	const evaluate = (content: string, environmentVariables: Record<string, string>) => new ConfigEvaluator({
		environmentVariables, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true
	}).evaluateUnit(unitPath, content, unitDirectory);

	describe('mark_glob_as_read', () => {
		const pattern = '../../../../../*.yaml';
		const refusal = () => `mark_glob_as_read pattern ${JSON.stringify(pattern)} resolves outside the boundary ${JSON.stringify(path.join(real, 'base'))}; `
			+ 'widen the boundary by passing --terragrunt-boundary as the first argument, '
			+ `for example mark_glob_as_read("--terragrunt-boundary=/", ${JSON.stringify(pattern)}): `
			+ `glob pattern resolves outside the configured boundary: ${JSON.stringify(directory)} is outside ${JSON.stringify(path.join(real, 'base'))}`;

		// Each GIT_CEILING_DIRECTORIES, and whether the walk still finds the
		// repository and so bounds the glob by it.
		const cases: Array<[string, () => string | undefined, boolean]> = [
			['unset', () => undefined, true],
			['empty', () => '', true],
			['a directory below the root, named through the link', () => path.join(link, 'base', 'a'), false],
			['the root itself', () => path.join(real, 'base'), false],
			['a directory above the root', () => real, true],
			['the unit itself', () => path.join(real, 'base', 'a', 'b', 'app'), true],
			['after an empty entry, through the link as written', () => list('', path.join(link, 'base', 'a')), true],
			['after an empty entry, as resolved', () => list('', path.join(real, 'base', 'a')), false],
			['through the link, then an entry above kept as written', () => list(path.join(link, 'base', 'a'), '', real), false],
			['a relative entry, then one above the root', () => list(path.join('base', 'a'), real), true],
			['one above the root, then one below it through the link', () => list(real, path.join(link, 'base', 'a')), false],
			['with a trailing separator', () => `${path.join(real, 'base', 'a')}${path.sep}`, false],
			['after an empty entry, with a trailing separator', () => list('', `${path.join(real, 'base', 'a')}/`), false],
			['a prefix of a component', () => path.join(real, 'bas'), true],
			['after an empty entry, a prefix of a component', () => list('', path.join(real, 'bas')), true],
			['a missing directory below the root', () => path.join(real, 'base', 'a', 'nope'), true],
			['with dot segments', () => `${real}/base/a/b/../../a`, false],
			['after an empty entry, with dot segments', () => list('', `${real}/base/a/b/..`), true]
		];
		for (const [label, value, bounded] of cases) {
			it(`${bounded ? 'refuses' : 'expands'} a pattern above the repository with GIT_CEILING_DIRECTORIES ${label}`, async () => {
				const result = await evaluate(`inputs = { files = mark_glob_as_read(${JSON.stringify(pattern)}) }`, ceiling(value()));
				if (bounded) {
					expect(result.valid).to.equal(false);
					expect(result.error).to.include(refusal());
				} else {
					expect(result.error).to.equal(undefined);
					expect(runtimeValueToPlain(result.inputs!)).to.deep.equal({ files: [path.join(directory, 'outside.yaml')] });
				}
			});
		}

		it('bounds a glob the workspace reads by the root its environment allows', async () => {
			await fs.writeFile(unitPath, `locals {
  files = mark_glob_as_read(${JSON.stringify(pattern)})
}`);
			const saved = process.env.GIT_CEILING_DIRECTORIES;
			try {
				delete process.env.GIT_CEILING_DIRECTORIES;
				const bounded = new Workspace();
				bounded.setWorkspaceRoot(URI.file(path.join(link, 'base')).toString());
				let message = '';
				await bounded.refreshDependencyTree().catch((error: Error) => { message = error.message; });
				expect(message).to.include(refusal());

				process.env.GIT_CEILING_DIRECTORIES = path.join(link, 'base', 'a');
				const unbounded = new Workspace();
				unbounded.setWorkspaceRoot(URI.file(path.join(link, 'base')).toString());
				const graph = await unbounded.refreshDependencyTree();
				const app = graph?.children.find(node => node.name.endsWith(path.join('a', 'b', 'app', 'terragrunt.hcl')));
				expect(app?.data.reading?.map(uri => URI.parse(uri).fsPath)).to.deep.equal([path.join(directory, 'outside.yaml')]);
			} finally {
				if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
				else process.env.GIT_CEILING_DIRECTORIES = saved;
			}
		});
	});

	describe('get_repo_root, get_path_from_repo_root and get_path_to_repo_root', () => {
		const unit = `include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}
inputs = {
  root     = get_repo_root()
  from     = get_path_from_repo_root()
  to       = get_path_to_repo_root()
  inc_root = include.root.locals.root
  inc_from = include.root.locals.from
  inc_to   = include.root.locals.to
}`;
		// The root comes resolved and the unit's directory as written, in the
		// unit and in the configuration it includes alike.
		const answers = () => {
			const root = path.join(real, 'base');
			const from = path.join('..', '..', 'link', 'base', 'a', 'b', 'app');
			const to = path.join('..', '..', '..', '..', '..', 'real', 'base');
			return { root, from, to, inc_root: root, inc_from: from, inc_to: to };
		};
		const found: Array<[string, () => string | undefined]> = [
			['unset', () => undefined],
			['above the root', () => real],
			['naming the unit itself', () => path.join(real, 'base', 'a', 'b', 'app')],
			['after an empty entry, through the link as written', () => list('', path.join(link, 'base', 'a'))]
		];
		for (const [label, value] of found) {
			it(`answers for the unit's directory with GIT_CEILING_DIRECTORIES ${label}`, async () => {
				const result = await evaluate(unit, ceiling(value()));
				expect(result.error).to.equal(undefined);
				expect(runtimeValueToPlain(result.inputs!)).to.deep.equal(answers());
			});
		}

		const refused: Array<[string, string]> = [
			['get_repo_root', 'go_repo_root: no enclosing git repository'],
			['get_path_from_repo_root', 'getting git top level dir: go_repo_root: no enclosing git repository'],
			['get_path_to_repo_root', 'getting git top level dir: go_repo_root: no enclosing git repository']
		];
		for (const [name, message] of refused) {
			it(`refuses ${name} when GIT_CEILING_DIRECTORIES hides the root`, async () => {
				const result = await evaluate(`inputs = { v = ${name}() }`, ceiling(path.join(link, 'base', 'a')));
				expect(result.valid).to.equal(false);
				expect(result.error).to.include(message);
			});
		}

		it('reads through the root the workspace environment allows', async () => {
			await fs.writeFile(unitPath, `locals {
  shared = mark_as_read("\${get_repo_root()}/shared.yaml")
}`);
			const saved = process.env.GIT_CEILING_DIRECTORIES;
			try {
				delete process.env.GIT_CEILING_DIRECTORIES;
				const visible = new Workspace();
				visible.setWorkspaceRoot(URI.file(path.join(link, 'base')).toString());
				const graph = await visible.refreshDependencyTree();
				const app = graph?.children.find(node => node.name.endsWith(path.join('a', 'b', 'app', 'terragrunt.hcl')));
				expect(app?.data.reading?.map(uri => URI.parse(uri).fsPath)).to.deep.equal([path.join(real, 'base', 'shared.yaml')]);

				process.env.GIT_CEILING_DIRECTORIES = path.join(link, 'base', 'a');
				const hidden = new Workspace();
				hidden.setWorkspaceRoot(URI.file(path.join(link, 'base')).toString());
				let message = '';
				await hidden.refreshDependencyTree().catch((error: Error) => { message = error.message; });
				expect(message).to.include('go_repo_root: no enclosing git repository');
			} finally {
				if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
				else process.env.GIT_CEILING_DIRECTORIES = saved;
			}
		});
	});

	// A run keeps the roots it found by the directories it walked to them, so a
	// repository made in the unit while the run goes on is not seen: neither by
	// get_repo_root nor by the boundary of mark_glob_as_read.
	it('answers a directory the run has walked from its memo', async () => {
		const realUnit = path.join(real, 'base', 'a', 'b', 'app');
		await fs.writeFile(path.join(real, 'base', 'a', 'b', 'sibling.yaml'), 'x: 1');
		const content = `locals {
  first  = get_repo_root()
  made   = run_cmd("--terragrunt-quiet", "sh", "-c", "mkdir -p .git && echo \${local.first}")
  second = "\${local.made}|\${get_repo_root()}"
  glob   = "\${local.made}|\${jsonencode(mark_glob_as_read("../*.yaml"))}"
}
inputs = {
  first  = local.first
  second = local.second
  glob   = local.glob
}`;
		const result = await new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
			.evaluateUnit(path.join(realUnit, 'terragrunt.hcl'), content, realUnit);
		expect(result.error).to.equal(undefined);
		const root = path.join(real, 'base');
		expect(runtimeValueToPlain(result.inputs!)).to.deep.equal({
			first: root,
			second: `${root}|${root}`,
			glob: `${root}|${JSON.stringify([path.join(real, 'base', 'a', 'b', 'sibling.yaml')])}`
		});
		await fs.access(path.join(realUnit, '.git'));
	});

	// The walk examines 1024 directories at most, the start among them, as
	// internal/git/repo_root.go bounds it; a macOS path cannot be deep enough
	// for a release binary to show it there.
	it('finds a root 1023 directories above the unit, and gives up one further', async () => {
		const root = path.join(real, 'base');
		const within = path.join(root, ...Array.from({ length: 1023 }, () => 'd'));
		const beyond = path.join(within, 'd');
		await fs.mkdir(beyond, { recursive: true });
		const repoRoot = (unit: string) => new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
			.evaluateUnit(path.join(unit, 'terragrunt.hcl'), 'inputs = { root = get_repo_root() }', unit);

		const found = await repoRoot(within);
		expect(found.error).to.equal(undefined);
		expect(runtimeValueToPlain(found.inputs!)).to.deep.equal({ root });
		const refused = await repoRoot(beyond);
		expect(refused.valid).to.equal(false);
		expect(refused.error).to.include('go_repo_root: depth 1024: repository-root walk exceeded max depth');
	});

	// Terragrunt's walk ends on any failure to describe a `.git` entry but its
	// absence: a start that is a file meets "not a directory" there, where Go's
	// os.ErrNotExist matches only ENOENT. No Terragrunt command starts the walk
	// at a file, so this follows internal/git/repo_root.go rather than a run.
	it('ends the walk at a start that is a file, saying why', async () => {
		const { goRepoRoot } = await import('../src/functions/git_repo_root');
		const file = path.join(real, 'base', 'shared.yaml');
		let message = '';
		await goRepoRoot(file, {}).catch((error: Error) => { message = error.message; });
		expect(message).to.equal(`go_repo_root: stat ${path.join(file, '.git')}: not a directory`);
	});
});
