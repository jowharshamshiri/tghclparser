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
			'locals {', '  id = dependency.vpc.outputs.id', '}', '',
			'inputs = { a = dependency.vpc.outputs.id, b = local.id, c = "${dependency.vpc.outputs.id}-x" }'
		]);
		const { evaluator, requests } = recording({ vpc: { id: 'vpc-123' } });
		const result = await evaluate(evaluator);
		assert.deepEqual(runtimeValueToPlain(result.inputs!), { a: 'vpc-123', b: 'vpc-123', c: 'vpc-123-x' });
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
