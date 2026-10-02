import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

// `tghclp hcl format` stands in for `terragrunt hcl format`. What each case expects is what Terragrunt 1.1.5 does
// with the same tree and arguments: which files it rewrites, what it prints, and how it exits.
describe('CLI hcl format', function () {
	this.timeout(30000);

	const cli = path.resolve('dist/cli.cjs');
	const unformatted = 'inputs = {\n  a   = 1\n  long_name = "x"\n}\nlocals {\nx="y"\n}\n';
	const formatted = 'inputs = {\n  a         = 1\n  long_name = "x"\n}\nlocals {\n  x = "y"\n}\n';
	let root: string;

	const write = async (file: string, content: string | Uint8Array) => {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), content);
	};
	const read = (file: string) => fs.readFile(path.join(root, file), 'utf8');
	const format = (args: string[], input?: string) =>
		spawnSync(process.execPath, [cli, 'hcl', 'format', ...args], { encoding: 'utf8', input });

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclp-format-')));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('rewrites every .hcl file under the working directory and nothing else', async () => {
		await write('app/terragrunt.hcl', unformatted);
		await write('root.hcl', 'x   =   1\n');
		await write('deep/a/b/anything.hcl', 'y=[1,2]\n');
		await write('app/tidy.hcl', formatted);
		await write('app/notes.txt', 'x   =   1\n');
		await write('app/terragrunt.hcl.json', '{"inputs":   {}}\n');
		for (const skipped of ['.terragrunt-cache/m', '.boilerplate', '.terragrunt-stack/unit']) await write(`${skipped}/terragrunt.hcl`, 'x   =   1\n');

		const result = format(['--working-dir', root]);
		expect(result.status, result.stderr).to.equal(0);
		expect(result.stdout).to.equal('');
		expect(await read('app/terragrunt.hcl')).to.equal(formatted);
		expect(await read('root.hcl')).to.equal('x = 1\n');
		expect(await read('deep/a/b/anything.hcl')).to.equal('y = [1, 2]\n');
		expect(await read('app/tidy.hcl')).to.equal(formatted);
		expect(await read('app/notes.txt')).to.equal('x   =   1\n');
		expect(await read('app/terragrunt.hcl.json')).to.equal('{"inputs":   {}}\n');
		for (const skipped of ['.terragrunt-cache/m', '.boilerplate', '.terragrunt-stack/unit']) expect(await read(`${skipped}/terragrunt.hcl`), skipped).to.equal('x   =   1\n');

		expect(format(['--check', '--working-dir', root]).status).to.equal(0);
	});

	it('with --check names what needs formatting, fails, and changes nothing', async () => {
		await write('app/terragrunt.hcl', unformatted);
		await write('app/tidy.hcl', formatted);
		const result = format(['--check', '--working-dir', root]);
		expect(result.status).to.equal(1);
		expect(result.stderr).to.equal(`File '${path.join(root, 'app/terragrunt.hcl')}' needs formatting\n`);
		expect(result.stdout).to.equal('');
		expect(await read('app/terragrunt.hcl')).to.equal(unformatted);
	});

	it('with --diff prints the change and still makes it, unless --check is given too', async () => {
		await write('app/terragrunt.hcl', unformatted);
		const file = path.join(root, 'app/terragrunt.hcl');
		const label = file.split(path.sep).join('/');
		const diff = [
			`diff old${label} new${label}`,
			`--- old${label}`,
			`+++ new${label}`,
			'@@ -1,7 +1,7 @@',
			' inputs = {',
			'-  a   = 1',
			'+  a         = 1',
			'   long_name = "x"',
			' }',
			' locals {',
			'-x="y"',
			'+  x = "y"',
			' }',
			''
		].join('\n');

		const checked = format(['--diff', '--check', '--working-dir', root]);
		expect(checked.status).to.equal(1);
		expect(checked.stdout).to.equal(diff);
		expect(await read('app/terragrunt.hcl')).to.equal(unformatted);

		const applied = format(['--diff', '--working-dir', root]);
		expect(applied.status, applied.stderr).to.equal(0);
		expect(applied.stdout).to.equal(diff);
		expect(await read('app/terragrunt.hcl')).to.equal(formatted);
	});

	it('formats only the file named, or leaves out the directories excluded', async () => {
		await write('app/terragrunt.hcl', unformatted);
		await write('other/terragrunt.hcl', unformatted);
		await write('vendor/x/terragrunt.hcl', unformatted);

		expect(format(['--file', 'app/terragrunt.hcl', '--working-dir', root]).status).to.equal(0);
		expect(await read('app/terragrunt.hcl')).to.equal(formatted);
		expect(await read('other/terragrunt.hcl')).to.equal(unformatted);

		expect(format(['--exclude-dir', 'vendor', '--working-dir', root]).status).to.equal(0);
		expect(await read('other/terragrunt.hcl')).to.equal(formatted);
		expect(await read('vendor/x/terragrunt.hcl')).to.equal(unformatted);

		expect(format([path.join('vendor', 'x', 'terragrunt.hcl'), '--working-dir', root]).status).to.equal(0);
		expect(await read('vendor/x/terragrunt.hcl')).to.equal(formatted);
	});

	it('reports a file that does not parse, leaves it alone, and still formats the rest', async () => {
		await write('broken/terragrunt.hcl', 'inputs = {\n  a = \n}\n');
		await write('zeta/terragrunt.hcl', unformatted);
		const result = format(['--working-dir', root]);
		expect(result.status).to.equal(1);
		expect(result.stderr).to.equal(`Error parsing ${path.join(root, 'broken/terragrunt.hcl')}: line 3, column 1: unexpected "}"\n`);
		expect(await read('broken/terragrunt.hcl')).to.equal('inputs = {\n  a = \n}\n');
		expect(await read('zeta/terragrunt.hcl')).to.equal(formatted);
	});

	it('refuses a file that is not UTF-8 rather than rewriting its bytes', async () => {
		const bytes = Buffer.from([0x61, 0x20, 0x20, 0x3d, 0x20, 0x22, 0xff, 0xfe, 0x22, 0x0a]);
		await write('latin/terragrunt.hcl', bytes);
		const result = format(['--working-dir', root]);
		expect(result.status).to.equal(1);
		expect(result.stderr).to.contain('is not valid UTF-8');
		expect((await fs.readFile(path.join(root, 'latin/terragrunt.hcl'))).equals(bytes)).to.equal(true);
	});

	it('keeps the permissions of a file it rewrites', async function () {
		if (process.platform === 'win32') this.skip();
		await write('app/terragrunt.hcl', unformatted);
		await fs.chmod(path.join(root, 'app/terragrunt.hcl'), 0o640);
		expect(format(['--working-dir', root]).status).to.equal(0);
		expect((await fs.stat(path.join(root, 'app/terragrunt.hcl'))).mode & 0o777).to.equal(0o640);
	});

	it('formats standard input to standard output', () => {
		const printed = format(['--stdin'], unformatted);
		expect(printed.status, printed.stderr).to.equal(0);
		expect(printed.stdout).to.equal(formatted);

		const checked = format(['--stdin', '--check'], unformatted);
		expect(checked.status).to.equal(1);
		expect(checked.stdout).to.equal('');
		expect(checked.stderr).to.equal("File 'stdin' needs formatting\n");
		expect(format(['--stdin', '--check'], formatted).status).to.equal(0);

		const diffed = format(['--stdin', '--diff'], 'a   = 1\n');
		expect(diffed.status).to.equal(0);
		expect(diffed.stdout).to.equal('diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -1,1 +1,1 @@\n-a   = 1\n+a = 1\n');

		const broken = format(['--stdin'], 'a = \n');
		expect(broken.status).to.equal(1);
		expect(broken.stdout).to.equal('');
		expect(broken.stderr).to.equal('error parsing hcl from stdin: line 2, column 1: unexpected end of input\n');

		const both = format(['--stdin', '--file', 'terragrunt.hcl'], unformatted);
		expect(both.status).to.not.equal(0);
		expect(both.stderr).to.contain('both stdin and path flags are specified');
	});
});
