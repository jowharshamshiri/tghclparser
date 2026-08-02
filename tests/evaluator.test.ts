import assert from 'node:assert/strict';

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
});
