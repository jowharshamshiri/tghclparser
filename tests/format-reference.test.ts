import { expect } from 'chai';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileGlob } from '../src/glob';
import { graphemeCount } from '../src/grapheme-clusters';
import { formatHclTokens } from '../src/hcl-format';
import { scanHclTokens } from '../src/hcl-scanner';
import { findHclSyntaxProblem } from '../src/hcl-syntax';

// Holds this package to what the software it replaces was recorded doing. Nothing in tests/fixtures/format-reference
// is expected output written by hand or produced by this package: the files are recorded from the HCL library's
// parser, scanner and formatter, from the glob library Terragrunt matches filter paths with, and from the Terragrunt
// binary, by the tghclp workspace's parity suite, which also checks that they still say what Terragrunt does.

interface Problem {
	summary: string;
	detail: string;
	/** The start line and column and the end line and column. */
	range: [number, number, number, number];
}

interface Vectors {
	syntax: { source: string; problems: Problem[] }[];
	tokens: { source: string; tokens: string[] }[];
	graphemes: { text: string; count: number }[];
	globs: { pattern: string; candidates: string[]; error: boolean; matched: string[] }[];
}

interface SourceReference {
	parses: boolean;
	format_sha256: string;
	tokens_sha256: string;
	/** For the first two errors the parser reports: the summary, and a digest of summary, detail and range. */
	problems: [string, string][];
}

interface Scenario {
	name: string;
	args: string[];
	env?: Record<string, string>;
	stdin?: string;
	files?: Record<string, string>;
}

interface ScenarioReference {
	name: string;
	failed: boolean;
	stdout: string;
	needs: string[];
	tree: Record<string, string>;
}

interface Tree {
	files: { path: string; base64: string; mode?: number }[];
	links: { path: string; target: string }[];
}

const fixtures = path.resolve('tests/fixtures/format-reference');

/** The name the reference parsed the sources under, which a few of its messages repeat. */
const filename = 'terragrunt.hcl';

/** The complaints a one-line block makes of itself, which the reference lists ahead of the failure inside it. */
const blockComplaints = ['Invalid single-argument block definition', 'Unclosed configuration block'];

function readLines<T>(name: string): T[] {
	return fs.readFileSync(path.join(fixtures, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function reported(source: string): Problem | undefined {
	const problem = findHclSyntaxProblem(source, filename);
	return problem && { summary: problem.summary, detail: problem.detail, range: [problem.start.line, problem.start.column, problem.end.line, problem.end.column] };
}

function expectNone(failures: string[]): void {
	expect(failures.slice(0, 10), `${failures.length} differ from the reference`).to.deep.equal([]);
}

describe('formatting, held to the recorded reference', function () {
	this.timeout(5 * 60 * 1000);

	const vectors = JSON.parse(fs.readFileSync(path.join(fixtures, 'vectors-reference.json'), 'utf8')) as Vectors;

	describe('syntax errors', () => {
		it('accepts what the HCL parser accepts and refuses what it refuses', () => {
			const accepted = vectors.syntax.filter(({ problems }) => problems.length === 0);
			const refused = vectors.syntax.filter(({ problems }) => problems.length > 0);
			expect(accepted.length).to.be.greaterThan(5);
			expect(refused.length).to.be.greaterThan(80);
			for (const { source } of accepted) expect(reported(source), JSON.stringify(source)).to.equal(undefined);
			for (const { source } of refused) expect(reported(source), JSON.stringify(source)).to.not.equal(undefined);
		});

		it('reports the first error the HCL parser reports, in its words and at its range', () => {
			const plain = vectors.syntax.filter(({ problems }) => problems.length > 0 && !(problems.length > 1 && blockComplaints.includes(problems[0].summary)));
			expect(plain.length).to.be.greaterThan(80);
			for (const { source, problems } of plain) expect(reported(source), JSON.stringify(source)).to.deep.equal(problems[0]);
		});

		it('reports the failure inside a one-line block, which the HCL parser lists after that block\'s own complaint', () => {
			const inside = vectors.syntax.filter(({ problems }) => problems.length > 1 && blockComplaints.includes(problems[0].summary));
			expect(inside.length).to.be.greaterThan(2);
			for (const { source, problems } of inside) expect(reported(source), JSON.stringify(source)).to.deep.equal(problems[1]);
		});

		it('reports a one-line block\'s own complaint when nothing inside it failed', () => {
			const alone = vectors.syntax.filter(({ problems }) => problems.length === 1 && blockComplaints.includes(problems[0].summary));
			expect(alone.length).to.be.greaterThan(1);
			for (const { source, problems } of alone) expect(reported(source), JSON.stringify(source)).to.deep.equal(problems[0]);
		});

		it('counts columns as the HCL scanner does: by grapheme cluster, token by token, not counting a byte order mark', () => {
			const byColumn = (source: string) => vectors.syntax.find(vector => vector.source === source)!;
			// The mark is not a column, so the invalid character after "a = " is in column 5.
			expect(byColumn('\u{FEFF}a = @\n').problems[0].range).to.deep.equal([1, 5, 1, 6]);
			expect(reported('\u{FEFF}a = @\n')!.range).to.deep.equal([1, 5, 1, 6]);
			// A family emoji of five code points is one column.
			const family = byColumn('a = "\u{1F468}‍\u{1F469}‍\u{1F467}\\u12"\n');
			expect(family.problems[0].range).to.deep.equal([1, 7, 1, 11]);
			expect(reported(family.source)!.range).to.deep.equal([1, 7, 1, 11]);
		});
	});

	it('cuts source into the tokens the HCL scanner cuts it into', () => {
		expect(vectors.tokens.length).to.be.greaterThan(15);
		for (const { source, tokens } of vectors.tokens) {
			expect(scanHclTokens(source).flatMap(token => [token.type, token.text]), JSON.stringify(source)).to.deep.equal(tokens);
		}
	});

	it('counts grapheme clusters as the layout\'s reference does', () => {
		expect(vectors.graphemes.length).to.be.greaterThan(20);
		for (const { text, count } of vectors.graphemes) expect(graphemeCount(text), JSON.stringify(text)).to.equal(count);
	});

	it('compiles and matches the named glob patterns as Terragrunt\'s filter paths do', () => {
		expect(vectors.globs.filter(glob => glob.error).length).to.be.greaterThan(3);
		for (const { pattern, candidates, error, matched } of vectors.globs) {
			let got: string[] | undefined;
			try {
				const glob = compileGlob(pattern);
				got = candidates.filter(candidate => glob.match(candidate));
			} catch {
				got = undefined;
			}
			expect(got, pattern).to.deep.equal(error ? undefined : matched);
		}
	});

	it('scans, accepts, reports and lays out adversarial sources as the reference does', () => {
		const sources = readLines<string>('sources.jsonl');
		const reference = readLines<SourceReference>('sources-reference.jsonl');
		expect(sources.length).to.equal(reference.length);
		expect(sources.length).to.be.greaterThan(700);
		expect(reference.filter(entry => entry.parses).length).to.be.within(100, sources.length - 100);
		const failures: string[] = [];
		sources.forEach((source, index) => {
			const want = reference[index];
			const tokens = scanHclTokens(source).map(token => `${token.type}\0${token.text}\0`).join('');
			if (sha256(tokens) !== want.tokens_sha256) failures.push(`tokens differ: ${JSON.stringify(source)}`);
			if (sha256(formatHclTokens(source)) !== want.format_sha256) failures.push(`layout differs: ${JSON.stringify(source)}`);
			const problem = reported(source);
			if ((problem === undefined) === want.parses) {
				if (!problem) return;
				const digest = sha256(`${problem.summary}\0${problem.detail}\0${problem.range[0]}:${problem.range[1]}-${problem.range[2]}:${problem.range[3]}`);
				const [first, second] = want.problems;
				const expected = second && blockComplaints.includes(first[0]) && problem.summary !== first[0] ? second : first;
				if (digest !== expected[1]) failures.push(`reported ${problem.summary} at ${problem.range.join(',')}, reference ${expected[0]}: ${JSON.stringify(source)}`);
			} else {
				failures.push(`${want.parses ? 'refused valid' : 'accepted invalid'} source: ${JSON.stringify(source)}`);
			}
		});
		expectNone(failures);
	});

	it('compiles and matches adversarial glob patterns as Terragrunt\'s filter paths do', () => {
		const cases = readLines<{ p: string; s: string[] }>('globs.jsonl');
		const reference = readLines<{ error: boolean; matches: boolean[] }>('globs-reference.jsonl');
		expect(cases.length).to.equal(reference.length);
		expect(cases.length).to.be.greaterThan(400);
		const failures: string[] = [];
		cases.forEach(({ p, s }, index) => {
			const want = reference[index];
			let matches: boolean[] | undefined;
			try {
				const glob = compileGlob(p);
				matches = s.map(candidate => glob.match(candidate));
			} catch {
				matches = undefined;
			}
			if ((matches === undefined) !== want.error) failures.push(`pattern ${JSON.stringify(p)}: ${want.error ? 'compiled' : 'refused'}, unlike the reference`);
			else if (matches && JSON.stringify(matches) !== JSON.stringify(want.matches)) failures.push(`pattern ${JSON.stringify(p)} matches differently`);
		});
		expectNone(failures);
	});

	it('does to a tree of files what the Terragrunt binary does, scenario by scenario', async () => {
		const suite = JSON.parse(fs.readFileSync(path.join(fixtures, 'cli.json'), 'utf8')) as { tree: Tree; scenarios: Scenario[] };
		const reference = readLines<ScenarioReference>('cli-reference.jsonl');
		expect(suite.scenarios.length).to.equal(reference.length);
		expect(suite.scenarios.length).to.be.greaterThan(150);
		const cli = path.resolve('dist/cli.cjs');

		const run = async (scenario: Scenario, want: ScenarioReference): Promise<string | undefined> => {
			expect(want.name).to.equal(scenario.name);
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tghclp-format-reference-')));
			try {
				const write = (relative: string, data: Buffer | string, mode = 0o644) => {
					const full = path.join(root, relative);
					fs.mkdirSync(path.dirname(full), { recursive: true });
					fs.writeFileSync(full, data);
					fs.chmodSync(full, mode);
				};
				for (const file of suite.tree.files) write(file.path, Buffer.from(file.base64, 'base64'), file.mode);
				for (const link of suite.tree.links) fs.symlinkSync(link.target, path.join(root, link.path));
				for (const [relative, content] of Object.entries(scenario.files ?? {})) write(relative, content);

				const env = { ...process.env };
				for (const [name, value] of Object.entries(scenario.env ?? {})) env[name] = value.split('{}').join(root);
				const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
					const child = spawn(process.execPath, [cli, 'hcl', ...scenario.args.map(argument => argument.split('{}').join(root))], { cwd: root, env });
					let stdout = '';
					let stderr = '';
					child.stdout.on('data', chunk => { stdout += chunk; });
					child.stderr.on('data', chunk => { stderr += chunk; });
					child.on('error', reject);
					child.on('close', status => resolve({ status, stdout, stderr }));
					child.stdin.end(scenario.stdin ?? '');
				});

				// Terragrunt formats files in parallel, so the reference holds the diffs of different files in name order.
				const [head, ...diffs] = result.stdout.split(root).join('<root>').split('diff old');
				const stdout = head + diffs.map(diff => `diff old${diff}`).sort().join('');
				const needs = [...new Set([...result.stderr.matchAll(/File '([^']*)' needs formatting/g)].map(found =>
					found[1].startsWith(root) ? found[1].slice(root.length).replace(/^[\\/]/, '').split(path.sep).join('/') : found[1]))].sort();
				const tree: Record<string, string> = {};
				const walk = (directory: string) => {
					for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
						const full = path.join(directory, entry.name);
						const relative = path.relative(root, full).split(path.sep).join('/');
						if (entry.isDirectory()) walk(full);
						else if (entry.isSymbolicLink()) tree[relative] = `link:${fs.readlinkSync(full)}`;
						else tree[relative] = `${sha256(fs.readFileSync(full)).slice(0, 16)} ${(fs.statSync(full).mode & 0o777).toString(8)}`;
					}
				};
				walk(root);

				const differences: string[] = [];
				if ((result.status !== 0) !== want.failed) differences.push(`exit status ${result.status}, where Terragrunt ${want.failed ? 'failed' : 'succeeded'}`);
				if (stdout !== want.stdout) differences.push(`printed ${JSON.stringify(stdout.slice(0, 200))}, Terragrunt ${JSON.stringify(want.stdout.slice(0, 200))}`);
				if (JSON.stringify(needs) !== JSON.stringify(want.needs)) differences.push(`reported ${JSON.stringify(needs)}, Terragrunt ${JSON.stringify(want.needs)}`);
				const changed = [...new Set([...Object.keys(tree), ...Object.keys(want.tree)])].filter(file => tree[file] !== want.tree[file]).sort();
				if (changed.length > 0) differences.push(`left these files different: ${changed.slice(0, 8).join(', ')}`);
				return differences.length > 0 ? `${scenario.name}: ${differences.join('; ')} [stderr: ${result.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200)}]` : undefined;
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		};

		const failures: string[] = [];
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(8, os.availableParallelism()) }, async () => {
			while (next < suite.scenarios.length) {
				const index = next++;
				const failure = await run(suite.scenarios[index], reference[index]);
				if (failure) failures.push(failure);
			}
		}));
		expectNone(failures.sort());
	});
});
