import assert from 'node:assert/strict';
import { generateKeyPairSync, publicEncrypt, constants } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';

describe('semantic configuration evaluation', () => {
	const evaluator = new ConfigEvaluator({
		environmentVariables: {},
		terraformCommand: '',
		terraformCliArgs: [],
		workspaceTrusted: true
	});
	const configPath = `${process.cwd()}/tests/evaluator-fixture.hcl`;

	it('evaluates functions and values at their authored source position', async () => {
		const content = [
			'locals {',
			'  service = "api"',
			'}',
		'',
		'inputs = {',
		'  name = upper(local.service)',
		'}'
		].join('\n');

		const result = await evaluator.evaluateAtPosition(configPath, content, process.cwd(), { line: 5, character: 10 });
		assert.deepEqual(result, { type: 'string', value: 'API' });

		const functionNameResult = await evaluator.evaluateAtPosition(configPath, content, process.cwd(), { line: 5, character: 9 });
		assert.deepEqual(functionNameResult, { type: 'string', value: 'API' });

		const keyResult = await evaluator.evaluateAtPosition(configPath, content, process.cwd(), { line: 5, character: 2 });
		assert.deepEqual(keyResult, { type: 'string', value: 'API' });
	});

	it('reports an explicit semantic error for an unknown function', async () => {
		const result = await evaluator.evaluateUnit(
			configPath,
			'inputs = { value = function_that_does_not_exist() }',
			process.cwd()
		);
		assert.equal(result.valid, false);
		assert.match(result.error ?? '', /Unknown function/);
	});

	it('denies semantic evaluation until the caller establishes workspace trust', async () => {
		const evaluator = new ConfigEvaluator({
			environmentVariables: { SECRET_VALUE: 'must-not-be-exposed' },
			terraformCommand: '',
			terraformCliArgs: []
		});
		const result = await evaluator.evaluateUnit(
			configPath,
			'inputs = { value = run_cmd("echo", "untrusted") }',
			process.cwd()
		);
		assert.equal(result.valid, false);
		assert.match(result.error ?? '', /disabled until the workspace is trusted/);
	});

	it('anchors parent-file resolution at the project root marker when evaluation starts in a child directory', async () => {
		const projectRoot = `${process.cwd()}/../tghclparser_testenv/showcase/current`;
		const configPath = `${projectRoot}/environments/prod/app/terragrunt.hcl`;
		const result = await evaluator.evaluateUnit(
			configPath,
			'inputs = { root = find_in_parent_folders("root.hcl") }',
			`${projectRoot}/environments/prod/app`
		);
		assert.equal(result.valid, true);
		assert.deepEqual(result.inputs ? runtimeValueToPlain(result.inputs) : undefined, {
			root: path.resolve(`${projectRoot}/root.hcl`)
		});
	});

	it('requires and evaluates the deep-merge experiment explicitly', async () => {
		const content = [
			'inputs = {',
			'  merged = deep_merge({ service = { retries = 1, mode = "safe" }, values = [1] }, { service = { retries = 3 }, values = [2] })',
			'}'
		].join('\n');
		const disabled = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.equal(disabled.valid, false);
		assert.match(disabled.error ?? '', /deep-merge experiment/);

		const enabledEvaluator = new ConfigEvaluator({
			environmentVariables: {},
			terraformCommand: '',
			terraformCliArgs: [],
			experiments: ['deep-merge'],
			workspaceTrusted: true
		});
		const enabled = await enabledEvaluator.evaluateUnit(configPath, content, process.cwd());
		assert.equal(enabled.valid, true);
		assert.deepEqual(enabled.inputs ? runtimeValueToPlain(enabled.inputs) : undefined, {
			merged: {
				service: { retries: 3, mode: 'safe' },
				values: [1, 2]
			}
		});
	});

	it('matches the accepted gzip, bcrypt, timestamp, and RSA function contracts', async () => {
		const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
		const ciphertext = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from('secret')).toString('base64');
		const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		const content = `inputs = {
  compressed = base64gzip("hello")
  password_hash = bcrypt("hello")
  generated_at = timestamp()
  decrypted = rsadecrypt(${JSON.stringify(ciphertext)}, ${JSON.stringify(privatePem)})
}`;
		const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.equal(result.valid, true);
		const plain = result.inputs ? runtimeValueToPlain(result.inputs) as Record<string, unknown> : {};
		assert.equal(typeof plain.compressed, 'string');
		assert.equal(gunzipSync(Buffer.from(String(plain.compressed), 'base64')).toString(), 'hello');
		assert.match(String(plain.password_hash), /^\$2[aby]\$10\$/u);
		assert.match(String(plain.generated_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
		assert.equal(plain.decrypted, 'secret');
	});

	it('searches PARENT folders, so a unit including terragrunt.hcl does not include itself', async () => {
		// The near-universal call is `find_in_parent_folders("terragrunt.hcl")`
		// written in a unit's own terragrunt.hcl. Searching from the unit's own
		// directory matched that very file: the unit included itself and
		// evaluation recursed until the process was killed by hand, at full CPU,
		// having printed nothing. A whole real workspace was unusable.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-parent-'));
		try {
			// A repository, because that is what bounds the upward search when a
			// workspace has no `root.hcl` -- the case for every configuration
			// written before that convention.
			await fs.mkdir(path.join(root, '.git'));
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), 'locals {\n  marker = "the-parent"\n}\n');
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const unit = [
				'include "root" {',
				'  path = find_in_parent_folders("terragrunt.hcl")',
				'}',
				'',
				'inputs = {',
				'  here = get_terragrunt_dir()',
				'}'
			].join('\n');
			await fs.writeFile(unitPath, unit);

			// Evaluating AT ALL is the claim. Before the fix this never
			// returned: the include resolved to `unitPath` itself and the
			// evaluator recursed forever. A cycle error would be a failure too
			// -- the include must land on the parent, not on this file.
			const result = await evaluator.evaluateUnit(unitPath, unit, unitDir);
			assert.equal(result.valid, true, result.error);
			assert.doesNotMatch(result.error ?? '', /Include cycle/u, 'the unit must not include itself');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('reports an include cycle instead of evaluating until it is killed', async () => {
		// The guard that stops any OTHER way a configuration can refer back to
		// itself. Named rather than counted: "a includes b includes a" is a
		// sentence somebody can act on, where "maximum depth exceeded" sends
		// them looking for a depth to raise.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-cycle-'));
		try {
			const a = path.join(root, 'a.hcl');
			const b = path.join(root, 'b.hcl');
			await fs.writeFile(a, 'include "b" {\n  path = "' + b.replace(/\\/gu, '/') + '"\n}\n');
			await fs.writeFile(b, 'include "a" {\n  path = "' + a.replace(/\\/gu, '/') + '"\n}\n');

			const content = await fs.readFile(a, 'utf8');
			const result = await evaluator.evaluateUnit(a, content, root);
			assert.equal(result.valid, false, 'a cycle is not a valid configuration');
			assert.match(result.error ?? '', /Include cycle/u);
			assert.match(result.error ?? '', /a\.hcl/u, 'and the message names the files that form it');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('renders generate blocks inherited through an include', async () => {
		// The blocks live in a root configuration and units include it, which
		// is how essentially every workspace is arranged. Reading only a
		// unit's OWN blocks rendered nothing, so the generated .tf files were
		// never written and OpenTofu ran against a directory whose committed
		// main.tf referenced locals that no file defined.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-generate-'));
		try {
			await fs.mkdir(path.join(root, '.git'));
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), [
				'locals {',
				'  region = "eu-west-1"',
				'}',
				'',
				'generate "provider" {',
				'  path      = "provider.tf"',
				'  if_exists = "overwrite_terragrunt"',
				'  contents  = "provider \\"aws\\" { region = \\"${local.region}\\" }"',
				'}'
			].join('\n'));
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const unit = [
				'include "root" {',
				'  path = find_in_parent_folders("terragrunt.hcl")',
				'}'
			].join('\n');
			await fs.writeFile(unitPath, unit);

			const rendered = runtimeValueToPlain(
				await evaluator.evaluateRenderedConfig(unitPath, unit, unitDir)
			) as Record<string, unknown>;
			const generate = rendered.generate as Record<string, Record<string, unknown>>;
			assert.ok(generate.provider, 'the included block is part of what the unit renders');
			assert.equal(generate.provider.path, 'provider.tf');
			assert.equal(
				generate.provider.contents,
				'provider "aws" { region = "eu-west-1" }',
				'and its contents interpolate the locals of the file that DECLARED it'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('reads outside the workspace only for a directory that was allowed', async () => {
		// The workspace boundary is this tool's own, from its life as a
		// language server; Terragrunt has none. A deployment plan kept in a
		// sibling checkout is a normal arrangement and was refused outright,
		// so the boundary stays and `--allow-path` names the exceptions.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-allow-')));
		try {
			const workspace = path.join(base, 'workspace');
			const outside = path.join(base, 'outside');
			await fs.mkdir(workspace);
			await fs.mkdir(path.join(workspace, '.git'));
			await fs.mkdir(outside);
			await fs.writeFile(path.join(outside, 'plan.json'), '{"name":"from-outside"}');
			const configPath = path.join(workspace, 'terragrunt.hcl');
			const content = `inputs = { name = jsondecode(file(${JSON.stringify(path.join(outside, 'plan.json'))})).name }`;
			await fs.writeFile(configPath, content);

			const blocked = await evaluator.evaluateUnit(configPath, content, workspace);
			assert.equal(blocked.valid, false, 'outside the workspace is refused by default');
			assert.match(blocked.error ?? '', /is blocked/u);
			assert.match(blocked.error ?? '', /--allow-path/u, 'and the message says how to permit it');

			const permitting = new ConfigEvaluator({
				environmentVariables: {},
				terraformCommand: '',
				terraformCliArgs: [],
				workspaceTrusted: true,
				allowedPaths: [outside]
			});
			const allowed = await permitting.evaluateUnit(configPath, content, workspace);
			assert.equal(allowed.valid, true, allowed.error);
			const plain = allowed.inputs ? runtimeValueToPlain(allowed.inputs) as Record<string, unknown> : {};
			assert.equal(plain.name, 'from-outside');

			// Permitting one directory does not permit its neighbours.
			const elsewhere = path.join(base, 'elsewhere');
			await fs.mkdir(elsewhere);
			await fs.writeFile(path.join(elsewhere, 'plan.json'), '{"name":"not-allowed"}');
			const otherContent = `inputs = { name = jsondecode(file(${JSON.stringify(path.join(elsewhere, 'plan.json'))})).name }`;
			await fs.writeFile(configPath, otherContent);
			const stillBlocked = await permitting.evaluateUnit(configPath, otherContent, workspace);
			assert.equal(stillBlocked.valid, false, 'an allowed path is one directory, not a general opening');
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it('reduces the template escapes the way Terragrunt does', async () => {
		// `$${` and `%%{` each stand for the sequence without the doubling, and
		// a generate block is where it shows: the produced .tf file is meant to
		// contain a real `${...}` for OpenTofu to evaluate later.
		//
		// `$${` was returned as itself, so `file_id = "$${profile.name}.img"`
		// reached the Proxmox provider as that literal string. `%%{` was not
		// matched at all, fell through to the single-character alternative, and
		// everything after the `%` was re-scanned as a directive -- `a = %{if x}`
		// came out as `a = %`, losing the rest of the line silently.
		//
		// Every expectation here was taken from terragrunt 0.67.1 rendering the
		// same input, not from reading the specification.
		const cases: Array<[string, string]> = [
			['a = $${foo.bar}', 'a = ${foo.bar}'],
			['a = %%{if x}', 'a = %{if x}'],
			['a = $${a}$${b}', 'a = ${a}${b}'],
			['a = $$${x}', 'a = $${x}'],
			['a = $${outer{inner}}', 'a = ${outer{inner}}'],
			// Not escapes: a doubled sigil with no brace after it is literal.
			['a = $$foo', 'a = $$foo'],
			['a = %foo', 'a = %foo'],
			['a = $$', 'a = $$'],
			['a = %%', 'a = %%']
		];
		for (const [authored, expected] of cases) {
			// Written as HCL source verbatim. Passing it through
			// JSON.stringify would collapse the doubled sigil before the
			// grammar ever saw it, and the test would then pass against a
			// parser that does not handle the escape at all.
			const content = `inputs = { value = "${authored}" }`;
			const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
			assert.equal(result.valid, true, `${authored}: ${result.error}`);
			const plain = result.inputs ? runtimeValueToPlain(result.inputs) as Record<string, unknown> : {};
			assert.equal(plain.value, expected, `authored ${authored}`);
		}

		// A heredoc reaches the escapes through a different rule than a quoted
		// string does, and a generate block's contents are almost always a
		// heredoc -- so the path that actually carried the bug is this one.
		const heredoc = [
			'inputs = {',
			'  value = <<-EOT',
			'    a = $${foo.bar}',
			'    b = %%{if y}',
			'  EOT',
			'}'
		].join('\n');
		const result = await evaluator.evaluateUnit(configPath, heredoc, process.cwd());
		assert.equal(result.valid, true, result.error);
		const plain = result.inputs ? runtimeValueToPlain(result.inputs) as Record<string, unknown> : {};
		assert.match(String(plain.value), /a = \$\{foo\.bar\}/u, 'the interpolation escape is reduced in a heredoc');
		assert.match(String(plain.value), /b = %\{if y\}/u, 'and so is the directive escape');
	});

	it('resolves file() against the declaring file, not the including unit', async () => {
		// Two directories that answer different questions, and terragrunt keeps
		// them apart: `file("x.yml")` written in a root config resolves next to
		// THAT file, while `get_terragrunt_dir()` reports the unit being
		// rendered. Rendering an inherited generate block with both pointed at
		// the unit made the same relative path name a different file, silently
		// -- the kind of divergence that makes this unusable as a drop-in.
		//
		// Checked against terragrunt 0.67.1, which reads the root-relative file
		// and still reports the unit's own directory.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-filedir-')));
		try {
			await fs.mkdir(path.join(root, '.git'));
			await fs.writeFile(path.join(root, 'beside.yml'), 'value: "FROM-ROOT-DIR"\n');
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), [
				'generate "g" {',
				'  path      = "out.tf"',
				'  if_exists = "overwrite_terragrunt"',
				'  contents  = "${yamldecode(file("beside.yml")).value}|${basename(get_terragrunt_dir())}"',
				'}'
			].join('\n'));
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			// A DIFFERENT file of the same name beside the unit: if resolution
			// used the unit's directory, this is what would be read.
			await fs.writeFile(path.join(unitDir, 'beside.yml'), 'value: "FROM-UNIT-DIR"\n');
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const unit = 'include "root" {\n  path = find_in_parent_folders("terragrunt.hcl")\n}\n';
			await fs.writeFile(unitPath, unit);

			const rendered = runtimeValueToPlain(
				await evaluator.evaluateRenderedConfig(unitPath, unit, unitDir)
			) as Record<string, unknown>;
			const generate = rendered.generate as Record<string, Record<string, unknown>>;
			assert.equal(
				generate.g.contents,
				'FROM-ROOT-DIR|unit',
				'file() reads the root-relative file; get_terragrunt_dir() still reports the unit'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
