import assert from 'node:assert/strict';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';

describe('evaluated spans', () => {
	const evaluator = new ConfigEvaluator({
		environmentVariables: {},
		terraformCommand: '',
		terraformCliArgs: [],
		workspaceTrusted: true
	});
	const configPath = `${process.cwd()}/tests/evaluated-spans-fixture.hcl`;

	async function spans(content: string): Promise<Array<{ kind: string; text: string; value: unknown }>> {
		const found = await evaluator.evaluatedSpans(configPath, content, process.cwd());
		return found.map(span => ({ kind: span.kind, text: content.slice(span.start, span.end), value: runtimeValueToPlain(span.value) }));
	}

	it('marks what had to be worked out and nothing the source already spells out', async () => {
		const content = [
			'locals {',
			'  env      = "prod"',
			'  cidr     = "10.11.0.0/16"',
			'  replicas = 3',
			'  enabled  = true',
			'  nothing  = null',
			'  neg      = -1',
			'  ratio    = 1.50',
			'  quoted   = "say \\"hi\\""',
			'  tags     = { team = "core", "ids" = [1, 2] }',
			'  name     = "svc-${local.env}"',
			'  shouted  = upper(local.env)',
			'  owner    = { team = local.env }',
			'  sum      = 1 + 2',
			'}',
			'',
			'inputs = {',
			'  cidr = local.cidr',
			'}'
		].join('\n');

		assert.deepEqual(await spans(content), [
			{ kind: 'name', text: 'name', value: 'svc-prod' },
			{ kind: 'expression', text: '"svc-${local.env}"', value: 'svc-prod' },
			{ kind: 'expression', text: 'local.env', value: 'prod' },
			{ kind: 'name', text: 'shouted', value: 'PROD' },
			{ kind: 'expression', text: 'upper(local.env)', value: 'PROD' },
			{ kind: 'expression', text: 'local.env', value: 'prod' },
			{ kind: 'name', text: 'owner', value: { team: 'prod' } },
			{ kind: 'name', text: 'team', value: 'prod' },
			{ kind: 'expression', text: 'local.env', value: 'prod' },
			{ kind: 'name', text: 'sum', value: 3 },
			{ kind: 'expression', text: '1 + 2', value: 3 },
			{ kind: 'name', text: 'cidr', value: '10.11.0.0/16' },
			{ kind: 'expression', text: 'local.cidr', value: '10.11.0.0/16' }
		]);
	});

	it('gives each expression its own value rather than that of the first operand it starts with', async () => {
		const content = [
			'locals {',
			'  flag   = true',
			'  picked = local.flag ? "yes" : "no"',
			'  scaled = 2 * 21',
			'}'
		].join('\n');

		const found = await spans(content);
		assert.deepEqual(found.find(span => span.text === 'local.flag ? "yes" : "no"'), { kind: 'expression', text: 'local.flag ? "yes" : "no"', value: 'yes' });
		assert.deepEqual(found.find(span => span.text === '2 * 21'), { kind: 'expression', text: '2 * 21', value: 42 });
	});

	it('leaves a heredoc unmarked when its body is its value, and marks one whose indent was stripped', async () => {
		const content = [
			'locals {',
			'  plain = <<EOT',
			'as written',
			'EOT',
			'  trimmed = <<-EOT',
			'    indented',
			'    EOT',
			'}'
		].join('\n');

		assert.deepEqual(await spans(content), [
			{ kind: 'name', text: 'trimmed', value: 'indented' },
			{ kind: 'expression', text: '<<-EOT\n    indented\n    EOT', value: 'indented' }
		]);
	});

	it('leaves out an expression that cannot be evaluated in the file scope, and keeps the one around it', async () => {
		const content = [
			'locals {',
			'  names = ["a", "b"]',
			'  loud  = [for name in local.names : upper(name)]',
			'}'
		].join('\n');

		assert.deepEqual(await spans(content), [
			{ kind: 'name', text: 'loud', value: ['A', 'B'] },
			{ kind: 'expression', text: '[for name in local.names : upper(name)]', value: ['A', 'B'] },
			{ kind: 'expression', text: 'local.names', value: ['a', 'b'] }
		]);
	});

	it('still marks the locals when the inputs fail to evaluate', async () => {
		const content = [
			'locals {',
			'  env  = "prod"',
			'  name = local.env',
			'}',
			'',
			'inputs = {',
			'  broken = function_that_does_not_exist()',
			'}'
		].join('\n');

		assert.deepEqual(await spans(content), [
			{ kind: 'name', text: 'name', value: 'prod' },
			{ kind: 'expression', text: 'local.env', value: 'prod' }
		]);
	});

	it('refuses until the workspace is trusted', async () => {
		const untrusted = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [] });
		await assert.rejects(
			untrusted.evaluatedSpans(configPath, 'locals {\n  a = upper("x")\n}', process.cwd()),
			/disabled until the workspace is trusted/
		);
	});
});
