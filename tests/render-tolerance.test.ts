import {expect} from 'chai';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// tghclp render decodes a configuration as Terragrunt v1.2.2's render does: where an attribute a value does not have
// is among a file's errors, it goes on past all of them, renders each value it could not know as "" or null, logs each
// error and exits 0. Every expected output here is what Terragrunt v1.2.2 printed for the same files.

const cli = path.resolve('dist/cli.cjs');

/** Writes files into a fresh folder, and gives its real path. */
async function tree(files: Record<string, string>): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclp-render-tolerance-')));
	for (const [name, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true});
		await fs.writeFile(path.join(root, name), content);
	}
	return root;
}

/** Runs tghclp render in a folder, without the environment variables that set Terragrunt's flags. */
function render(directory: string, args: string[] = []) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TG_') && !name.startsWith('TERRAGRUNT_')));
	return spawnSync(process.execPath, [cli, 'render', ...args], {cwd: directory, encoding: 'utf8', env});
}

const UNKNOWN_LOCAL = 'locals {\n  region = "eu-west-1"\n}\n\ninputs = {\n  region = local.region\n  zone   = local.nope\n}\n';

describe('render, past an attribute a value does not have', function () {
	this.timeout(60000);

	it('renders an unknown local as "", logs its error and exits 0', async () => {
		const root = await tree({'terragrunt.hcl': UNKNOWN_LOCAL});
		try {
			const hcl = render(root);
			expect(hcl.status).to.equal(0, hcl.stderr);
			expect(hcl.stdout).to.equal('locals {\n  region = "eu-west-1"\n}\ninputs = {\n  region = "eu-west-1"\n  zone   = ""\n}\n');
			expect(hcl.stderr).to.equal([
				'Error: Unsupported attribute',
				`  on ${root}/terragrunt.hcl line 7:`,
				'   7:   zone   = local.nope',
				'This object does not have an attribute named "nope".',
				''
			].join('\n'));
			const json = render(root, ['--json']);
			expect(json.status).to.equal(0, json.stderr);
			expect(json.stdout).to.equal('{"dependencies":null,"dependency":{},"download_dir":"","feature":{},"generate":{},"iam_assume_role_duration":null,'
				+ '"iam_assume_role_session_name":"","iam_role":"","iam_web_identity_token":"","inputs":{"region":"eu-west-1","zone":""},'
				+ '"locals":{"region":"eu-west-1"},"terraform_binary":"","terraform_version_constraint":"","terragrunt_version_constraint":""}\n');
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('logs at the debug level that the error was let pass, as Go writes the diagnostics', async () => {
		const root = await tree({'terragrunt.hcl': UNKNOWN_LOCAL});
		try {
			const result = render(root, ['--log-level', 'debug']);
			expect(result.status).to.equal(0, result.stderr);
			expect(result.stderr.split('\n')).to.include(
				`Deferred attribute access error to autoinclude merge: ${root}/terragrunt.hcl:7,17-22: Unsupported attribute; This object does not have an attribute named "nope".`
			);
			const quiet = render(root, ['--log-level', 'stdout']);
			expect(quiet.status).to.equal(0, quiet.stderr);
			expect(quiet.stderr).to.equal('');
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('renders an unknown output of a mocked dependency as ""', async () => {
		const root = await tree({
			'vpc/terragrunt.hcl': 'inputs = {\n  name = "vpc"\n}\n',
			'app/terragrunt.hcl': 'dependency "vpc" {\n  config_path = "../vpc"\n  mock_outputs = {\n    vpc_id = "vpc-mock"\n  }\n}\n\n'
				+ 'inputs = {\n  vpc_id  = dependency.vpc.outputs.vpc_id\n  subnets = dependency.vpc.outputs.nope\n}\n'
		});
		try {
			const result = render(path.join(root, 'app'), ['--json']);
			expect(result.status).to.equal(0, result.stderr);
			const rendered = JSON.parse(result.stdout);
			expect(rendered.inputs).to.deep.equal({subnets: '', vpc_id: 'vpc-mock'});
			// Terragrunt's render reads a dependency's outputs but does not render them.
			expect(rendered.dependency.vpc.outputs).to.equal(null);
			expect(result.stderr).to.contain([
				'Error: Unsupported attribute',
				`  on ${root}/app/terragrunt.hcl line 10:`,
				'  10:   subnets = dependency.vpc.outputs.nope',
				'This object does not have an attribute named "nope".'
			].join('\n'));
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('renders an unknown attribute of an include, and one in the included file, as "", logging each error once', async () => {
		const root = await tree({
			'root.hcl': 'locals {\n  team = "platform"\n}\n\ninputs = {\n  team  = local.team\n  owner = local.nope\n}\n',
			'app/terragrunt.hcl': 'include "root" {\n  path   = find_in_parent_folders("root.hcl")\n  expose = true\n}\n\n'
				+ 'inputs = {\n  team    = include.root.inputs.team\n  missing = include.root.nope\n  absent  = include.root.inputs.nope\n}\n'
		});
		try {
			const result = render(path.join(root, 'app'));
			expect(result.status).to.equal(0, result.stderr);
			expect(result.stdout).to.equal('inputs = {\n  absent  = ""\n  missing = ""\n  owner   = ""\n  team    = "platform"\n}\n');
			const blocks = result.stderr.split('Error: ').filter(Boolean).map(block => `Error: ${block}`).sort();
			expect(blocks).to.deep.equal([
				`Error: Unsupported attribute\n  on ${root}/app/terragrunt.hcl line 8:\n   8:   missing = include.root.nope\nThis object does not have an attribute named "nope".\n`,
				`Error: Unsupported attribute\n  on ${root}/app/terragrunt.hcl line 9:\n   9:   absent  = include.root.inputs.nope\nThis object does not have an attribute named "nope".\n`,
				`Error: Unsupported attribute\n  on ${root}/root.hcl line 7:\n   7:   owner = local.nope\nThis object does not have an attribute named "nope".\n`
			]);
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('gives each expression what HCL gives where a part of it has errors', async () => {
		const root = await tree({
			'terragrunt.hcl': [
				'locals {',
				'  text    = "text"',
				'  objects = [{ id = 1 }]',
				'}',
				'',
				'inputs = {',
				'  template    = "x-${local.nope}"',
				'  length      = length(local.nope)',
				'  sum         = local.nope + 1',
				'  negated     = !local.nope',
				'  equal       = local.nope == "a"',
				'  choice      = local.nope ? "a" : "b"',
				'  number      = local.nope ? 1 : 2',
				'  tuple       = [1, local.nope]',
				'  object      = { a = local.nope, b = 2 }',
				'  splat       = local.objects[*].nope',
				'  tried       = try(local.nope, "fallback")',
				'  can         = can(local.nope)',
				'  primitive   = local.text.x',
				'  and         = false && local.nope',
				'  other       = false ? local.nope : "b"',
				'  tuple_index = [local.nope, 1][1]',
				'  for_body    = [for x in [1, 2] : local.nope]',
				'  try_operand = try(1 + "a", local.nope, "c")',
				'  json        = jsonencode({ a = local.nope })',
				'}',
				''
			].join('\n')
		});
		try {
			const result = render(root, ['--json']);
			expect(result.status).to.equal(0, result.stderr);
			expect(JSON.parse(result.stdout).inputs).to.deep.equal({
				and: false, can: false, choice: '', equal: null, for_body: ['', ''], json: '', length: '', negated: null, number: null,
				object: {a: '', b: 2}, other: 'b', primitive: '', splat: null, sum: null, template: '', tried: 'fallback', try_operand: 'c',
				tuple: [1, ''], tuple_index: 1
			});
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('lets every error of the file pass with it, writing the values an operand read', async () => {
		const root = await tree({
			'terragrunt.hcl': 'locals {\n  text  = "text"\n  count = 2\n}\n\ninputs = {\n  zone = local.nope\n  sum  = local.text + local.count\n'
				+ '  multi = (\n    1 +\n    "a"\n  )\n  call = upper(local.text, local.count)\n  region = var.nope\n}\n'
		});
		try {
			const result = render(root);
			expect(result.status).to.equal(0, result.stderr);
			expect(result.stdout).to.equal('locals {\n  count = 2\n  text  = "text"\n}\ninputs = {\n  call   = ""\n  multi  = null\n  region = ""\n  sum    = null\n  zone   = ""\n}\n');
			expect(result.stderr).to.contain([
				'Error: Invalid operand',
				`  on ${root}/terragrunt.hcl line 8:`,
				'   8:   sum  = local.text + local.count',
				'with ',
				'local.text as "text"',
				'.',
				'Unsuitable value for left operand: a number is required.'
			].join('\n'));
			expect(result.stderr).to.contain([
				'Error: Invalid operand',
				`  on ${root}/terragrunt.hcl line 11:`,
				'  10:     1 +',
				'  11:     "a"',
				'Unsuitable value for right operand: a number is required.'
			].join('\n'));
			expect(result.stderr).to.contain([
				'Error: Too many function arguments',
				`  on ${root}/terragrunt.hcl line 13:`,
				'  13:   call = upper(local.text, local.count)',
				'with ',
				'local.count as 2',
				',',
				'     ',
				'local.text as "text"',
				'.',
				'Function "upper" expects only 1 argument(s).'
			].join('\n'));
			expect(result.stderr).to.contain('Error: Unknown variable\n');
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('leaves a field of a Go type its zero value where its value is not known, and settles one kept as a cty value', async () => {
		const root = await tree({
			'terragrunt.hcl': [
				'generate "provider" {',
				'  path      = local.nope',
				'  if_exists = "overwrite"',
				'  contents  = "provider"',
				'}',
				'',
				'remote_state {',
				'  backend = "local"',
				'  config = {',
				'    path = local.nope',
				'  }',
				'}',
				'',
				'dependencies {',
				'  paths = ["../a", local.nope]',
				'}',
				'',
				'iam_assume_role_duration = local.nope',
				'download_dir             = "${local.nope}/cache"',
				''
			].join('\n')
		});
		try {
			const result = render(root, ['--json']);
			expect(result.status).to.equal(0, result.stderr);
			const rendered = JSON.parse(result.stdout);
			expect(rendered.generate.provider.path).to.equal('');
			expect(rendered.remote_state.config).to.deep.equal({path: ''});
			expect(rendered.dependencies).to.deep.equal({paths: null});
			expect(rendered.iam_assume_role_duration).to.equal(0);
			expect(rendered.download_dir).to.equal('');
			expect(result.stderr).to.contain([
				'Error: Unsuitable value type',
				`  on ${root}/terragrunt.hcl line 2, in generate "provider":`,
				'   2:   path      = local.nope',
				'Unsuitable value: value must be known'
			].join('\n'));
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('reads a configuration with read_terragrunt_config() past such an error without logging it', async () => {
		const root = await tree({
			'other.hcl': 'inputs = {\n  a = local.nope\n  b = "b"\n}\n',
			'terragrunt.hcl': 'inputs = {\n  other = read_terragrunt_config("other.hcl").inputs\n}\n'
		});
		try {
			const result = render(root);
			expect(result.status).to.equal(0, result.stderr);
			expect(result.stdout).to.equal('inputs = {\n  other = {\n    a = ""\n    b = "b"\n  }\n}\n');
			expect(result.stderr).to.equal('');
		} finally {
			await fs.rm(root, {recursive: true, force: true});
		}
	});

	it('fails on every other error, and on an attribute missing where Terragrunt does not go on past it', async () => {
		const cases: Record<string, string> = {
			'an index a map does not have': 'locals {\n  settings = { region = "eu-west-1" }\n}\n\ninputs = {\n  zone = local.settings["nope"]\n}\n',
			'an element a map does not have': 'inputs = {\n  zone = tomap({ a = "1" }).nope\n}\n',
			'a variable there is not': 'inputs = {\n  zone = var.nope\n}\n',
			'an attribute of null': 'locals {\n  nothing = null\n}\n\ninputs = {\n  zone = local.nothing.nope\n}\n',
			'an attribute missing in a local': 'locals {\n  settings = { region = "eu-west-1" }\n  zone     = local.settings.nope\n}\n\ninputs = {\n  zone = local.zone\n}\n',
			'an attribute missing in iam_role': 'iam_role = local.nope\n\ninputs = {\n  kept = "kept"\n}\n',
			'an attribute missing in prevent_destroy': 'prevent_destroy = local.nope\n\ninputs = {\n  kept = "kept"\n}\n'
		};
		for (const [what, content] of Object.entries(cases)) {
			const root = await tree({'terragrunt.hcl': content});
			try {
				const result = render(root);
				expect(result.status, what).to.equal(1, result.stderr);
				expect(result.stdout, what).to.equal('');
			} finally {
				await fs.rm(root, {recursive: true, force: true});
			}
		}
	});
});
