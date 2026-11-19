import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DependencyRequest } from '../src/Evaluator';
import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';
import { makeObjectValue } from '../src/functions/utils';

/**
 * A dependency is resolved the way Terragrunt resolves it for a unit: its block is found in the configurations
 * merged into the unit, its attributes are evaluated where they are written, and config_path is resolved against the
 * unit's directory. The resolver is asked only for the outputs of a dependency found that way.
 */
describe('dependency resolution', () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-dependencies-')));
		await fs.mkdir(path.join(root, '.git'));
		for (const unit of ['vpc', 'network', 'app']) {
			await fs.mkdir(path.join(root, unit));
			await fs.writeFile(path.join(root, unit, 'terragrunt.hcl'), 'inputs = {}\n');
		}
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	/** An evaluator whose resolver records every request and answers with the outputs given for each target. */
	const recording = (outputs: Record<string, Record<string, string>> = {}) => {
		const requests: DependencyRequest[] = [];
		const evaluator = new ConfigEvaluator({
			environmentVariables: {},
			terraformCommand: '',
			terraformCliArgs: [],
			workspaceTrusted: true,
			resolveDependency: async request => {
				requests.push(request);
				const values = outputs[path.basename(request.targetDir)];
				if (!values) return undefined;
				return makeObjectValue(new Map([['outputs', makeObjectValue(new Map(
					Object.entries(values).map(([key, value]) => [key, { type: 'string', value }])
				))]]));
			}
		});
		return { evaluator, requests };
	};

	const write = (file: string, lines: string[]) => fs.writeFile(path.join(root, file), lines.join('\n'));
	const evaluate = async (evaluator: ConfigEvaluator) => {
		const unit = path.join(root, 'app', 'terragrunt.hcl');
		return evaluator.evaluateUnit(unit, await fs.readFile(unit, 'utf8'), path.join(root, 'app'));
	};
	const plain = (request: DependencyRequest) => ({
		name: request.name,
		declaredIn: path.relative(root, request.declaredIn),
		targetConfigPath: path.relative(root, request.targetConfigPath),
		targetDir: path.relative(root, request.targetDir),
		mockOutputs: request.mockOutputs === undefined ? undefined : runtimeValueToPlain(request.mockOutputs),
		mockOutputsAllowedTerraformCommands: request.mockOutputsAllowedTerraformCommands
	});

	it('reports a declared dependency with no outputs as unresolved rather than as a fault', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const result = await evaluate(recording().evaluator);
		assert.equal(result.valid, false);
		assert.equal(result.unresolved, true);
		assert.match(result.error ?? '', /Dependency "vpc" has no evaluated outputs/);
	});

	it('reports a fault written beside a dependency with no outputs yet', async () => {
		const cases: Record<string, string> = {
			template: '"${dependency.vpc.outputs.id}-${local.nope}"',
			call: 'format("%s-%s", dependency.vpc.outputs.id, local.nope)',
			list: '[dependency.vpc.outputs.id, local.nope]',
			object: '{ id = dependency.vpc.outputs.id, name = local.nope }',
			arithmetic: 'dependency.vpc.outputs.count + local.nope',
			comparison: 'dependency.vpc.outputs.id == local.nope',
			index: 'dependency.vpc.outputs.ids[local.nope]'
		};
		for (const [name, expression] of Object.entries(cases)) {
			await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', `inputs = { x = ${expression} }`]);
			const result = await evaluate(recording().evaluator);
			assert.equal(result.unresolved, undefined, name);
			assert.match(result.error ?? '', /Undefined local value "nope"/, name);
		}
	});

	it('reports an expression that only reads dependencies with no outputs yet as unresolved', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { x = "${dependency.vpc.outputs.id}-${dependency.vpc.outputs.name}-${upper("a")}" }']);
		const result = await evaluate(recording().evaluator);
		assert.equal(result.unresolved, true, result.error);
	});

	it('does not evaluate the branch a condition with no outputs yet would choose', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { x = dependency.vpc.outputs.id == "" ? local.nope : "ok" }']);
		const result = await evaluate(recording().evaluator);
		assert.equal(result.unresolved, true, result.error);
	});

	it('decides && and || by a side that is known when the other has no outputs yet, as HCL does', async () => {
		const inputs = async (expression: string) => {
			await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', `inputs = { x = ${expression} }`]);
			return evaluate(recording().evaluator);
		};
		for (const [expression, known] of [
			['dependency.vpc.outputs.on && false', false],
			['false && dependency.vpc.outputs.on', false],
			['dependency.vpc.outputs.on || true', true],
			['true || dependency.vpc.outputs.on', true]
		] as const) {
			const result = await inputs(expression);
			assert.equal(result.valid, true, `${expression}: ${result.error}`);
			assert.deepEqual(runtimeValueToPlain(result.inputs!), { x: known }, expression);
		}
		for (const expression of ['dependency.vpc.outputs.on && true', 'false || dependency.vpc.outputs.on', '!dependency.vpc.outputs.on']) {
			assert.equal((await inputs(expression)).unresolved, true, expression);
		}
		assert.match((await inputs('dependency.vpc.outputs.on && 1')).error ?? '', /Unsuitable value for right operand: bool required, but have number\./);
	});

	const localsOnly =(root: string) => `Locals can only reference these variables: local, include, feature, values. This expression references "${root}".`;

	it('refuses a local that reads a dependency, as Terragrunt does, even one nothing reads and with outputs to give', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'locals {', '  id = dependency.vpc.outputs.id', '}', '', 'inputs = { name = "app" }']);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-1' } });
		const result = await evaluate(evaluator);
		assert.equal(result.valid, false);
		assert.equal(result.unresolved, undefined);
		assert.equal(result.error, localsOnly('dependency'));
		assert.deepEqual(result.problems, [{
			message: localsOnly('dependency'),
			filePath: path.join(root, 'app', 'terragrunt.hcl'),
			range: { start: { line: 5, character: 7 }, end: { line: 5, character: 32 } }
		}]);
		assert.deepEqual(requests, []);
	});

	it('refuses a local that reads a dependency in a branch it would not take, since the reference alone decides', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'locals {', '  id = true ? "fixed" : dependency.vpc.outputs.id', '}']);
		const result = await evaluate(recording({ vpc: { id: 'vpc-1' } }).evaluator);
		assert.equal(result.error, localsOnly('dependency'));
	});

	it('refuses, in an included configuration, a local that reads a dependency another include declares', async () => {
		await write('root.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}']);
		await write('common.hcl', ['locals {', '  id = dependency.vpc.outputs.id', '}']);
		await write('app/terragrunt.hcl', [
			'include "common" {', '  path = find_in_parent_folders("common.hcl")', '}',
			'include "root" {', '  path = find_in_parent_folders("root.hcl")', '}', '',
			'inputs = { name = "app" }'
		]);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-1' } });
		const result = await evaluate(evaluator);
		assert.equal(result.error, localsOnly('dependency'));
		assert.equal(result.problems?.[0]?.filePath, path.join(root, 'common.hcl'));
		assert.deepEqual(requests, []);
	});

	it('refuses a local that reads a local which reads a dependency', async () => {
		await write('app/terragrunt.hcl', [
			'dependency "vpc" {', '  config_path = "../vpc"', '}', '',
			'locals {', '  id   = dependency.vpc.outputs.id', '  name = "app-${local.id}"', '}', '',
			'inputs = { name = local.name }'
		]);
		const result = await evaluate(recording({ vpc: { id: 'vpc-1' } }).evaluator);
		assert.equal(result.error, localsOnly('dependency'));
	});

	it('refuses every variable a local cannot see, naming each', async () => {
		await write('app/terragrunt.hcl', ['locals {', '  a = var.region', '  b = terraform.workspace', '  c = nothing', '}']);
		const result = await evaluate(recording().evaluator);
		assert.deepEqual(result.problems?.map(problem => problem.message), [localsOnly('var'), localsOnly('terraform'), localsOnly('nothing')]);
	});

	it('lets a local read what locals can see, and a for expression\'s own variables whatever they are called', async () => {
		await write('root.hcl', ['locals {', '  region = "eu-west-1"', '}']);
		await write('app/terragrunt.hcl', [
			'include "root" {', '  path   = find_in_parent_folders("root.hcl")', '  expose = true', '}', '',
			'locals {',
			'  region = include.root.locals.region',
			'  names  = [for dependency in ["a", "b"] : "${dependency}-${local.region}"]',
			'  keyed  = { for var, value in { x = 1 } : var => value }',
			'}', '',
			'inputs = { names = local.names, keyed = local.keyed }'
		]);
		const result = await evaluate(recording().evaluator);
		assert.equal(result.valid, true, result.error);
		assert.deepEqual(runtimeValueToPlain(result.inputs!), { names: ['a-eu-west-1', 'b-eu-west-1'], keyed: { x: 1 } });
	});

	it('reports a dependency declared nowhere the unit merges as a fault, without asking the resolver', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { id = dependency.vcp.outputs.id }']);
		const { evaluator, requests } = recording();
		const result = await evaluate(evaluator);
		assert.equal(result.unresolved, undefined);
		assert.equal(result.error, `No dependency "vcp" block in ${path.join(root, 'app', 'terragrunt.hcl')} or the configurations it includes`);
		assert.deepEqual(requests, []);
	});

	it('reports what the resolver throws as a fault', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const evaluator = new ConfigEvaluator({
			environmentVariables: {},
			terraformCommand: '',
			terraformCliArgs: [],
			workspaceTrusted: true,
			resolveDependency: async () => { throw new Error('state backend unreachable'); }
		});
		const result = await evaluate(evaluator);
		assert.equal(result.unresolved, undefined);
		assert.equal(result.error, 'state backend unreachable');
	});

	it('finds a block declared in an include, and resolves its config_path against the unit', async () => {
		await write('root.hcl', [
			'locals {', '  fake = "vpc-mock"', '}', '',
			'dependency "vpc" {', '  config_path = "../vpc"',
			'  mock_outputs = { id = local.fake }', '  mock_outputs_allowed_terraform_commands = ["plan"]', '}'
		]);
		await write('app/terragrunt.hcl', ['include "root" {', '  path = "../root.hcl"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-123' } });
		const result = await evaluate(evaluator);
		assert.equal(result.valid, true, result.error);
		assert.deepEqual(runtimeValueToPlain(result.inputs!), { id: 'vpc-123' });
		assert.deepEqual(requests.map(plain), [{
			name: 'vpc',
			declaredIn: 'root.hcl',
			targetConfigPath: path.join('vpc', 'terragrunt.hcl'),
			targetDir: 'vpc',
			mockOutputs: { id: 'vpc-mock' },
			mockOutputsAllowedTerraformCommands: ['plan']
		}]);
	});

	it('resolves a dependency an include reads but the unit declares', async () => {
		await write('root.hcl', ['inputs = { vpc_id = dependency.vpc.outputs.id }']);
		await write('app/terragrunt.hcl', ['include "root" {', '  path = "../root.hcl"', '}', '', 'dependency "vpc" {', '  config_path = "../vpc"', '}']);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-123' } });
		const result = await evaluate(evaluator);
		assert.equal(result.valid, true, result.error);
		assert.deepEqual(runtimeValueToPlain(result.inputs!), { vpc_id: 'vpc-123' });
		assert.deepEqual(requests.map(request => path.relative(root, request.declaredIn)), [path.join('app', 'terragrunt.hcl')]);
	});

	it('lets the unit replace a shallow include\'s block whole', async () => {
		await write('root.hcl', ['dependency "vpc" {', '  config_path = "../network"', '  mock_outputs = { from = "root" }', '  mock_outputs_allowed_terraform_commands = ["plan"]', '}']);
		await write('app/terragrunt.hcl', ['include "root" {', '  path = "../root.hcl"', '}', '', 'dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-123' } });
		await evaluate(evaluator);
		assert.deepEqual(requests.map(plain), [{
			name: 'vpc', declaredIn: path.join('app', 'terragrunt.hcl'), targetConfigPath: path.join('vpc', 'terragrunt.hcl'),
			targetDir: 'vpc', mockOutputs: undefined, mockOutputsAllowedTerraformCommands: undefined
		}]);
	});

	it('merges a deep include\'s block attribute by attribute', async () => {
		await write('root.hcl', [
			'dependency "vpc" {', '  config_path = "../vpc"',
			'  mock_outputs = { a = "root", nested = { x = "root" } }', '  mock_outputs_allowed_terraform_commands = ["plan"]', '}'
		]);
		await write('app/terragrunt.hcl', [
			'include "root" {', '  path           = "../root.hcl"', '  merge_strategy = "deep"', '}', '',
			'dependency "vpc" {', '  mock_outputs = { b = "unit", nested = { y = "unit" } }', '  mock_outputs_allowed_terraform_commands = ["validate"]', '}', '',
			'inputs = { id = dependency.vpc.outputs.id }'
		]);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-123' } });
		await evaluate(evaluator);
		assert.deepEqual(requests.map(plain), [{
			name: 'vpc', declaredIn: path.join('app', 'terragrunt.hcl'), targetConfigPath: path.join('vpc', 'terragrunt.hcl'), targetDir: 'vpc',
			mockOutputs: { a: 'root', b: 'unit', nested: { x: 'root', y: 'unit' } },
			mockOutputsAllowedTerraformCommands: ['plan', 'validate']
		}]);
	});

	it('takes nothing from an include with no_merge', async () => {
		await write('root.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}']);
		await write('app/terragrunt.hcl', ['include "root" {', '  path           = "../root.hcl"', '  merge_strategy = "no_merge"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const result = await evaluate(recording({ vpc: { id: 'vpc-123' } }).evaluator);
		assert.match(result.error ?? '', /No dependency "vpc" block in .* or the configurations it includes/);
	});

	it('lets the autoinclude replace the unit\'s block', async () => {
		await write('app/terragrunt.autoinclude.hcl', ['dependency "vpc" {', '  config_path = "../network"', '}']);
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../vpc"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const { evaluator, requests } = recording({ network: { id: 'net-1' } });
		const result = await evaluate(evaluator);
		assert.deepEqual(runtimeValueToPlain(result.inputs!), { id: 'net-1' });
		assert.deepEqual(requests.map(request => path.relative(root, request.targetDir)), ['network']);
	});

	it('asks the resolver once however often a dependency is read', async () => {
		await write('app/terragrunt.hcl', [
			'dependency "vpc" {', '  config_path = "../vpc"', '}', '',
			'inputs = { a = dependency.vpc.outputs.id, b = upper(dependency.vpc.outputs.id), c = "${dependency.vpc.outputs.id}-x" }'
		]);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-123' } });
		const result = await evaluate(evaluator);
		assert.deepEqual(runtimeValueToPlain(result.inputs!), { a: 'vpc-123', b: 'VPC-123', c: 'vpc-123-x' });
		assert.equal(requests.length, 1);
	});

	it('refuses a dependency block that reads a dependency, as Terragrunt does', async () => {
		await write('app/terragrunt.hcl', [
			'dependency "network" {', '  config_path = "../network"', '}', '',
			'dependency "vpc" {', '  config_path = "../vpc"',
			'  mock_outputs = { id = dependency.network.outputs.id }', '  mock_outputs_allowed_terraform_commands = ["plan"]', '}', '',
			'inputs = { id = dependency.vpc.outputs.id }'
		]);
		const result = await evaluate(recording({ network: { id: 'net-1' }, vpc: { id: 'vpc-1' } }).evaluator);
		assert.equal(result.error, 'dependency "vpc" reads dependency.network: a dependency block cannot read dependency outputs, since they are evaluated before any outputs exist');
	});

	it('refuses a config_path that names nothing', async () => {
		await write('app/terragrunt.hcl', ['dependency "vpc" {', '  config_path = "../missing"', '}', '', 'inputs = { id = dependency.vpc.outputs.id }']);
		const result = await evaluate(recording().evaluator);
		assert.equal(result.error, `dependency "vpc" in ${path.join(root, 'app', 'terragrunt.hcl')}: config_path ${path.join(root, 'missing')} does not exist`);
	});

	it('refuses the merge strategies Terragrunt refuses on an include, rather than taking them for shallow', async () => {
		await write('root.hcl', ['inputs = {}']);
		for (const [strategy, message] of [
			['deep_map_only', 'merge_strategy "deep_map_only" is not supported on include blocks'],
			['sideways', 'merge_strategy "sideways" is not one of no_merge, shallow or deep']
		]) {
			await write('app/terragrunt.hcl', ['include "root" {', '  path           = "../root.hcl"', `  merge_strategy = "${strategy}"`, '}']);
			const result = await evaluate(recording().evaluator);
			assert.equal(result.error, `include "root" in ${path.join(root, 'app', 'terragrunt.hcl')}: ${message}`);
		}
	});
});
