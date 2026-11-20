import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ConfigEvaluatorOptions, DependencyRequest } from '../src/Evaluator';
import { ConfigEvaluator } from '../src/Evaluator';
import { makeObjectValue, makeStringValue } from '../src/functions/utils';
import { terragruntConfigAsCty } from '../src/terragrunt-config';
import { terragruntConfigAsHcl } from '../src/terragrunt-config-hcl';
import { plainValue } from './plain-values';

/**
 * A `dependency` block that nests an `expansion` block is read once per element of its `count` or `for_each`, as
 * Terragrunt v1.2.2 reads it (pkg/config/hclparse/expansion.go): each element is a dependency addressed by its key,
 * whose body reads `count.index`, or `each.key` and `each.value`, and `dependency.<name>[key]` reads one element.
 */
describe('dependency expansion', () => {
	let root: string;
	let unitPath: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-expansion-')));
		await fs.mkdir(path.join(root, '.git'));
		for (const unit of ['app', 'aurora-web', 'aurora-api', 'shard-0', 'shard-1', 'site-a', 'site-b']) {
			await fs.mkdir(path.join(root, unit));
			await fs.writeFile(path.join(root, unit, 'terragrunt.hcl'), 'inputs = {}\n');
		}
		unitPath = path.join(root, 'app', 'terragrunt.hcl');
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	/**
	 * An evaluator whose resolver records every request and answers with the outputs `id` and `from`: the directory it
	 * reads, and the request's address.
	 */
	const recording = (options: Partial<ConfigEvaluatorOptions> = {}) => {
		const requests: DependencyRequest[] = [];
		const warnings: string[] = [];
		const evaluator = new ConfigEvaluator({
			environmentVariables: {},
			terraformCommand: 'plan',
			terraformCliArgs: [],
			workspaceTrusted: true,
			warn: message => warnings.push(message),
			resolveDependency: async request => {
				requests.push(request);
				if (!request.target) {
					const mocks = request.mockOutputs;
					return mocks === undefined ? makeObjectValue(new Map()) : makeObjectValue(new Map([['outputs', mocks]]));
				}
				return makeObjectValue(new Map([['outputs', makeObjectValue(new Map([
					['id', makeStringValue(path.basename(request.target.dir))],
					['from', makeStringValue(request.name)]
				]))]]));
			},
			...options
		});
		return { evaluator, requests, warnings };
	};

	const write = async (lines: string[]): Promise<string> => {
		const content = lines.join('\n') + '\n';
		await fs.writeFile(unitPath, content);
		return content;
	};
	const inputs = async (evaluator: ConfigEvaluator, content: string) => {
		const result = await evaluator.evaluateUnit(unitPath, content, path.join(root, 'app'));
		assert.equal(result.valid, true, result.error);
		return plainValue(result.inputs!);
	};
	const render = async (evaluator: ConfigEvaluator, content: string) => evaluator.evaluateRenderedConfig(unitPath, content, root, true);
	const refusal = async (lines: string[], options: Partial<ConfigEvaluatorOptions> = {}): Promise<string> => {
		const content = await write(lines);
		try {
			await render(recording(options).evaluator, content);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		assert.fail('the configuration was accepted');
	};

	describe('elements and their addresses', () => {
		it('expands a set into one dependency per element, keyed by it, each reading each.key', async () => {
			const content = await write([
				'dependency "aurora" {',
				'  expansion {',
				'    for_each = toset(["web", "api"])',
				'  }',
				'',
				'  config_path = "../aurora-${each.key}"',
				'}',
				'',
				'inputs = {',
				'  web  = dependency.aurora["web"].outputs.id',
				'  api  = dependency.aurora["api"].outputs.from',
				'  keys = keys(dependency.aurora)',
				'}'
			]);
			const { evaluator, requests } = recording();
			assert.deepEqual(await inputs(evaluator, content), { web: 'aurora-web', api: 'aurora[api]', keys: ['api', 'web'] });
			assert.deepEqual(requests.map(request => [request.name, path.relative(root, request.target!.dir)]), [
				['aurora[api]', 'aurora-api'],
				['aurora[web]', 'aurora-web']
			]);
		});

		it('expands count into one dependency per index, read by a number or its text', async () => {
			const content = await write([
				'locals {',
				'  shards = 2',
				'}',
				'',
				'dependency "shard" {',
				'  expansion {',
				'    count = local.shards',
				'  }',
				'',
				'  config_path = "../shard-${count.index}"',
				'}',
				'',
				'inputs = {',
				'  first  = dependency.shard[0].outputs.id',
				'  second = dependency.shard["1"].outputs.from',
				'  total  = length(dependency.shard)',
				'}'
			]);
			assert.deepEqual(await inputs(recording().evaluator, content), { first: 'shard-0', second: 'shard[1]', total: 2 });
		});

		it('expands a map by its keys in the order of their bytes, each reading each.value', async () => {
			const content = await write([
				'dependency "site" {',
				'  expansion {',
				'    for_each = { second = "b", first = "a" }',
				'  }',
				'',
				'  config_path = "../site-${each.value}"',
				'}',
				'',
				'inputs = {',
				'  sites = [for key, site in dependency.site : "${key}=${site.outputs.id}"]',
				'}'
			]);
			assert.deepEqual(await inputs(recording().evaluator, content), { sites: ['first=site-a', 'second=site-b'] });
		});

		it('keys a set of numbers by their decimal text', async () => {
			const content = await write([
				'dependency "node" {',
				'  expansion {',
				'    for_each = toset([10, 2])',
				'  }',
				'',
				'  config_path  = "../node-${each.key}"',
				'  skip_outputs = true',
				'  mock_outputs = { key = each.key, value = each.value }',
				'}',
				'',
				'inputs = {',
				'  ten = dependency.node[10].outputs',
				'  two = dependency.node["2"].outputs.value',
				'}'
			]);
			const { evaluator } = recording({ terraformCommand: 'render' });
			assert.deepEqual(await inputs(evaluator, content), { ten: { key: '10', value: 10 }, two: 2 });
		});

		it('checks the config_path of an element only when it reads its outputs', async () => {
			const content = await write([
				'dependency "node" {',
				'  expansion {',
				'    for_each = toset(["on", "off", "skipped"])',
				'  }',
				'',
				'  config_path  = "../absent-${each.key}"',
				'  enabled      = each.key != "off"',
				'  skip_outputs = each.key != "on"',
				'  mock_outputs = { name = "mock-${each.key}" }',
				'}',
				'',
				'inputs = {',
				'  off = dependency.node["off"].outputs.name',
				'}'
			]);
			const { evaluator, requests } = recording();
			// "on" reads its outputs, so its config_path has to exist.
			const result = await evaluator.evaluateUnit(unitPath, content, path.join(root, 'app'));
			assert.match(result.error ?? '', /dependency "node\[on\]" in .*: config_path .*absent-on does not exist/);
			// The elements are read in the order of their keys: "off" gave its mocks before "on" was refused.
			assert.deepEqual(requests.map(request => [request.name, request.target]), [['node[off]', undefined]]);
		});

		it('gives a disabled element its mocks and says so to the resolver', async () => {
			const content = await write([
				'dependency "node" {',
				'  expansion {',
				'    for_each = toset(["web", "off"])',
				'  }',
				'',
				'  config_path  = each.key == "off" ? "../absent" : "../aurora-${each.key}"',
				'  enabled      = each.key != "off"',
				'  mock_outputs = { id = "mock-${each.key}" }',
				'}',
				'',
				'inputs = {',
				'  off = dependency.node["off"].outputs.id',
				'  web = dependency.node["web"].outputs.id',
				'}'
			]);
			const { evaluator, requests } = recording();
			assert.deepEqual(await inputs(evaluator, content), { off: 'mock-off', web: 'aurora-web' });
			assert.deepEqual(requests.map(request => [request.name, request.enabled, request.target === undefined]), [
				['node[off]', false, true],
				['node[web]', true, false]
			]);
		});

		it('merges an included element into the unit\'s element of the same key', async () => {
			await fs.writeFile(path.join(root, 'root.hcl'), [
				'dependency "site" {',
				'  expansion {',
				'    for_each = toset(["a", "b"])',
				'  }',
				'',
				'  config_path  = "../absent-${each.key}"',
				'  mock_outputs = { root = each.key }',
				'}'
			].join('\n'));
			const content = await write([
				'include "root" {',
				'  path           = find_in_parent_folders("root.hcl")',
				'  merge_strategy = "deep"',
				'}',
				'',
				'dependency "site" {',
				'  expansion {',
				'    for_each = toset(["a", "b"])',
				'  }',
				'',
				'  config_path  = "../site-${each.key}"',
				'  mock_outputs = { unit = each.key }',
				'}',
				'',
				'inputs = {',
				'  b = dependency.site["b"].outputs.id',
				'}'
			]);
			const { evaluator, requests } = recording();
			assert.deepEqual(await inputs(evaluator, content), { b: 'site-b' });
			assert.deepEqual(requests.map(request => [request.name, path.relative(root, request.target!.dir), plainValue(request.mockOutputs!)]), [
				['site[a]', 'site-a', { root: 'a', unit: 'a' }],
				['site[b]', 'site-b', { root: 'b', unit: 'b' }]
			]);
		});

		it('expands into nothing with count = 0, leaving the label unread', async () => {
			const content = await write([
				'dependency "none" {',
				'  expansion {',
				'    count = 0',
				'  }',
				'',
				'  config_path = "../none-${count.index}"',
				'}'
			]);
			const config = await render(recording().evaluator, content);
			assert.deepEqual(config.dependencyBlocks, []);
			assert.equal(terragruntConfigAsHcl(config), '');
		});

		it('knows an element\'s key when its outputs cannot be known yet', async () => {
			const lines = (reference: string) => [
				'dependency "a" {',
				'  expansion {',
				'    for_each = toset(["x"])',
				'  }',
				'',
				'  config_path = "../site-a"',
				'}',
				'',
				`inputs = { id = ${reference} }`
			];
			const evaluator = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
			const unknown = await evaluator.evaluateUnit(unitPath, await write(lines('dependency.a["x"].outputs.id')), path.join(root, 'app'));
			assert.deepEqual([unknown.valid, unknown.unresolved, unknown.error], [false, true, 'Dependency "a[x]" has no evaluated outputs']);
			const missing = await evaluator.evaluateUnit(unitPath, await write(lines('dependency.a["y"].outputs.id')), path.join(root, 'app'));
			assert.deepEqual([missing.valid, missing.unresolved, missing.error], [false, undefined, 'Missing key "y"']);
		});

		it('refuses to read an expanded dependency without a key', async () => {
			const content = await write([
				'dependency "a" {',
				'  expansion {',
				'    count = 1',
				'  }',
				'',
				'  config_path = "../shard-${count.index}"',
				'}',
				'',
				'inputs = {',
				'  id = dependency.a.outputs.id',
				'}'
			]);
			const result = await recording().evaluator.evaluateUnit(unitPath, content, path.join(root, 'app'));
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /Missing attribute "outputs"/);
		});
	});

	describe('render', () => {
		it('writes an expanded block as it is written, then its elements as a comment', async () => {
			const content = await write([
				'dependency "vpc" {',
				'  config_path  = "../vpc"',
				'  skip_outputs = true',
				'}',
				'',
				'# Not part of the block.',
				'dependency "aurora" {',
				'  expansion { for_each = toset(["web", "api"]) }',
				'  # Part of the block.',
				'  config_path = "../aurora-${each.key}"',
				'  skip_outputs = true',
				'}'
			]);
			assert.equal(terragruntConfigAsHcl(await render(recording({ terraformCommand: 'render' }).evaluator, content)), [
				'dependency "vpc" {',
				'  config_path  = "../vpc"',
				'  skip_outputs = true',
				'}',
				'dependency "aurora" {',
				'  expansion { for_each = toset(["web", "api"]) }',
				'  # Part of the block.',
				'  config_path  = "../aurora-${each.key}"',
				'  skip_outputs = true',
				'}',
				'',
				'# Expands to:',
				'#',
				'# dependency "aurora" {',
				'#   config_path  = "../aurora-api"',
				'#   skip_outputs = true',
				'# }',
				'#',
				'# dependency "aurora" {',
				'#   config_path  = "../aurora-web"',
				'#   skip_outputs = true',
				'# }',
				'',
				''
			].join('\n'));
		});

		it('gives an expanded block as JSON as it is written, each reference a template', async () => {
			const content = await write([
				'locals {',
				'  n = 2',
				'}',
				'',
				'dependency "shard" {',
				'  expansion {',
				'    count = local.n',
				'  }',
				'',
				'  config_path  = "../shard-${count.index}"',
				'  skip_outputs = true',
				'  mock_outputs = {',
				'    index   = count.index',
				'    literal = "$${count.index} 100%%{x}"',
				'    list    = [1, "two", null, (count.index)]',
				'    whole   = { (local.n) = 1 }',
				'    sum     = 1 + 2',
				'  }',
				'}'
			]);
			const config = terragruntConfigAsCty(await render(recording({ terraformCommand: 'render' }).evaluator, content));
			// Through JSON, which writes each number as its value.
			const dependency = JSON.parse(JSON.stringify((config.dependency as Record<string, unknown>).shard));
			assert.deepEqual(dependency, {
				expansion: { count: '${local.n}' },
				config_path: '../shard-${count.index}',
				skip_outputs: true,
				mock_outputs: {
					index: '${count.index}',
					literal: '$${count.index} 100%%{x}',
					list: [1, 'two', null, '${(count.index)}'],
					whole: '${{ (local.n) = 1 }}',
					sum: 3
				}
			});
		});
	});

	describe('faults, in Terragrunt v1.2.2\'s words', () => {
		const expansion = (inner: string[], body: string[] = ['  config_path = "../shard-0"']) => [
			'dependency "a" {',
			'  expansion {',
			...inner.map(line => `    ${line}`),
			'  }',
			...body,
			'}'
		];

		it('refuses both meta-arguments, and neither, at the expansion block', async () => {
			assert.equal(await refusal(expansion(['for_each = toset(["x"])', 'count    = 1'])),
				`${unitPath}:2,3-12: the expansion block sets both for_each and count; set exactly one`);
			assert.equal(await refusal(expansion([])),
				`${unitPath}:2,3-12: the expansion block sets neither for_each nor count; set exactly one`);
		});

		it('refuses a second expansion block, at the second', async () => {
			assert.equal(await refusal(['dependency "a" {', '  expansion {', '    count = 1', '  }', '  expansion {', '    count = 2', '  }', '  config_path = "../shard-0"', '}']),
				`${unitPath}:5,3-12: the dependency block declares more than one expansion block; a block may declare at most one`);
		});

		it('refuses a label, an argument and a block the expansion block does not take, as HCL refuses them', async () => {
			assert.equal(await refusal(['dependency "a" {', '  expansion "x" {', '    count = 1', '  }', '  config_path = "../shard-0"', '}']),
				`${unitPath}:2,13-16: Extraneous label for expansion; No labels are expected for expansion blocks.`);
			assert.equal(await refusal(expansion(['count = 1', 'index = 2'])),
				`${unitPath}:4,5-10: Unsupported argument; An argument named "index" is not expected here.`);
			assert.equal(await refusal(expansion(['cont = 1'])),
				`${unitPath}:3,5-9: Unsupported argument; An argument named "cont" is not expected here. Did you mean "count"?`);
			assert.equal(await refusal(expansion(['count {', '}'])),
				`${unitPath}:3,5-10: Unsupported block type; Blocks of type "count" are not expected here. Did you mean to define argument "count"? If so, use the equals sign to assign it a value.`);
		});

		it('refuses a count that is null, not a whole number or negative, at the attribute', async () => {
			assert.equal(await refusal(expansion(['count = null'])), `${unitPath}:3,5-17: count is null; it must resolve to a concrete value`);
			assert.equal(await refusal(expansion(['count = "two"'])), `${unitPath}:3,5-18: count must be a whole number: number value is required`);
			assert.equal(await refusal(expansion(['count = 1.5'])),
				`${unitPath}:3,5-16: count must be a whole number: value must be a whole number, between -9223372036854775808 and 9223372036854775807`);
			assert.equal(await refusal(expansion(['count = -1'])), `${unitPath}:3,5-15: count is -1; it must not be negative`);
		});

		it('refuses a for_each that is null or no collection, and a key that is neither a string nor a number', async () => {
			const body = ['  config_path = "../shard-${each.key}"'];
			assert.equal(await refusal(expansion(['for_each = null'], body)), `${unitPath}:3,5-20: for_each is null; it must resolve to a concrete value`);
			assert.equal(await refusal(expansion(['for_each = "x"'], body)), `${unitPath}:3,5-19: for_each must be a set or a map, but got string`);
			assert.equal(await refusal(expansion(['for_each = 1'], body)), `${unitPath}:3,5-17: for_each must be a set or a map, but got number`);
			assert.equal(await refusal(expansion(['for_each = toset([true, false])'], body)),
				`${unitPath}:3,5-36: for_each keys must be strings or numbers, but got bool`);
		});

		it('refuses a misspelled expansion block, which would otherwise leave the block unexpanded', async () => {
			assert.equal(await refusal(['dependency "a" {', '  Expanson {', '    count = 1', '  }', '  config_path = "../shard-0"', '}']),
				`the dependency "a" block in ${unitPath} declares a "Expanson" block, which Terragrunt does not recognize; did you mean "expansion"?`);
		});

		it('refuses a label declared both with and without an expansion', async () => {
			assert.equal(await refusal([...expansion(['count = 1'], ['  config_path = "../shard-${count.index}"']), 'dependency "a" {', '  config_path = "../vpc"', '}']),
				'dependency "a" is declared both with and without an expansion, so the block and its instances claim the same address; rename one of them');
		});

		it('warns of two blocks claiming one address, and refuses them under the duplicate-dependency-labels strict control', async () => {
			const lines = [
				'dependency "a" {', '  expansion {', '    for_each = toset(["x"])', '  }', '  config_path = "../site-a"', '}',
				'dependency "a" {', '  expansion {', '    for_each = toset(["x"])', '  }', '  config_path = "../site-b"', '}'
			];
			const message = `${unitPath}: dependency a[x] is declared more than once; every dependency needs an address of its own`;
			assert.equal(await refusal(lines, { strictControls: ['duplicate-dependency-labels'] }), message);
			const content = await write(lines);
			const { evaluator, warnings } = recording();
			await render(evaluator, content);
			assert.deepEqual(warnings, [
				'Two `dependency` blocks address the same dependency, by sharing a label or a `config_path`. Only the last block with a given label can be referenced, and two blocks for one `config_path` declare the same unit twice. Declare each dependency once. In a future version of Terragrunt, this will result in an error.',
				message
			]);
		});

		it('warns of two elements pointing at one config_path', async () => {
			const content = await write(expansion(['for_each = toset(["x", "y"])'], ['  config_path = "../site-a"']));
			const { evaluator, warnings } = recording();
			await render(evaluator, content);
			assert.equal(warnings[1], `${unitPath}: dependencies a[x] and a[y] both point at ../site-a; declare that dependency once and reference it under one name`);
		});
	});
});
