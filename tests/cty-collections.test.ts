import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ctyDynamic, ctyNumber, ctyString, friendlyName, listOf, mapOf, objectOf, setOf, tupleOf } from '../src/cty-types';
import { unmarshalType, unmarshalValue } from '../src/cty-json';
import { ConfigEvaluator } from '../src/Evaluator';
import { makeNumberValue, makeObjectValue, makeSetValue, valueType } from '../src/functions/utils';
import { CtyNumber } from '../src/cty-number';
import { faults, includeTypes, includeValues, readConfig, readConfigTypes, typeNames, values } from './fixtures/cty-collections-reference';
import { plainValue } from './plain-values';

// Values keep go-cty's types as Terragrunt v1.2.2 gives them: a list, set or map apart from a tuple or object, each
// collection of one element type, and a null of a type. Every expected value, type name and message here is what
// v1.2.2 gave for the same expression (tests/fixtures/cty-collections-reference.ts).
describe('go-cty collection types as Terragrunt v1.2.2 gives them', () => {
	let root: string;
	let evaluator: ConfigEvaluator;

	before(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-cty-collections-')));
		evaluator = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
	});

	after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const evaluate = (expression: string) =>
		evaluator.evaluateUnit(path.join(root, 'terragrunt.hcl'), `inputs = {\n  x = ${expression}\n}\n`, root);

	it('names each value\'s type as go-cty does', async () => {
		for (const [expression, name] of typeNames) {
			const result = await evaluate(`"a\${${expression}}"`);
			assert.equal(result.error, `Cannot include the given value in a string template: string required, but have ${name}.`, expression);
		}
	});

	it('converts, compares and unifies values as go-cty does', async () => {
		for (const [expression, expected] of values) {
			const result = await evaluate(expression);
			assert.equal(result.error, undefined, expression);
			assert.deepEqual((plainValue(result.inputs!) as { x: unknown }).x, expected, expression);
		}
	});

	it('refuses what go-cty and HCL refuse, naming types as they do', async () => {
		for (const [expression, message] of faults) {
			const result = await evaluate(expression);
			assert.equal(result.valid, false, expression);
			assert.equal(result.error, message, expression);
		}
	});
});

// read_terragrunt_config() and an exposed include give a configuration as Terragrunt's TerragruntConfigAsCty does: the
// fields it holds in Go structs typed as gocty implies, lists and maps; locals, inputs and the backend's settings
// carried through JSON, so objects and tuples; mock outputs and a feature's default as written.
describe('configurations read as Terragrunt v1.2.2 gives them', () => {
	let root: string;

	before(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-cty-config-')));
		for (const unit of ['dep', 'dep2']) {
			await fs.mkdir(path.join(root, unit));
			await fs.writeFile(path.join(root, unit, 'terragrunt.hcl'), 'terraform {}\n');
		}
		await fs.writeFile(path.join(root, 'other.hcl'), readConfig);
		await fs.writeFile(path.join(root, 'parent.hcl'), 'locals {\n  l = tolist(["a"])\n}\ninputs = {\n  i = tomap({ a = 1 })\n}\n');
	});

	after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const typeError = (name: string) => `Cannot include the given value in a string template: string required, but have ${name}.`;

	it('types each field of a configuration read_terragrunt_config() reads as Terragrunt does', async () => {
		// The dependency has never been applied, so its outputs are its mocks, which render may see.
		const evaluator = new ConfigEvaluator({
			environmentVariables: {},
			terraformCommand: 'render',
			terraformCliArgs: [],
			workspaceTrusted: true,
			resolveDependency: async request => makeObjectValue(new Map([['outputs', request.mockOutputs!]]))
		});
		for (const [field, name] of readConfigTypes) {
			const content = `locals {\n  c = read_terragrunt_config("other.hcl")\n}\ninputs = {\n  a = "a\${local.c.${field}}"\n}\n`;
			const result = await evaluator.evaluateUnit(path.join(root, 'terragrunt.hcl'), content, root);
			assert.equal(result.error, typeError(name), field);
		}
	});

	it('carries an exposed include\'s locals and inputs through JSON, as Terragrunt does', async () => {
		const evaluator = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
		await fs.mkdir(path.join(root, 'child'), { recursive: true });
		for (const [field, name] of includeTypes) {
			const content = `include "root" {\n  path   = "../parent.hcl"\n  expose = true\n}\ninputs = {\n  a = "a\${include.root.${field}}"\n}\n`;
			const result = await evaluator.evaluateUnit(path.join(root, 'child', 'terragrunt.hcl'), content, root);
			assert.equal(result.error, typeError(name), field);
		}
		for (const [expression, expected] of includeValues) {
			const content = `include "root" {\n  path   = "../parent.hcl"\n  expose = true\n}\ninputs = {\n  a = include.root.${expression}\n}\n`;
			const result = await evaluator.evaluateUnit(path.join(root, 'child', 'terragrunt.hcl'), content, root);
			assert.equal(result.error, undefined, expression);
			assert.equal((plainValue(result.inputs!) as { a: unknown }).a, expected, expression);
		}
	});
});

describe('go-cty types in this port', () => {
	it('writes a collection of the dynamic pseudo-type as go-cty writes it, in a message and in a constraint', () => {
		assert.equal(friendlyName(listOf(mapOf(ctyString))), 'list of map of string');
		assert.equal(friendlyName(setOf(ctyDynamic)), 'set of dynamic');
		assert.equal(friendlyName(tupleOf([ctyString])), 'tuple');
		assert.equal(friendlyName(objectOf(new Map())), 'object');
	});

	it('keeps 0 and -0 apart in a set, -0 first, as go-cty hashes them apart', () => {
		const set = makeSetValue(ctyNumber, [makeNumberValue(CtyNumber.parse('0')), makeNumberValue(CtyNumber.parse('-0'))]);
		assert.deepEqual((set.value as { value: CtyNumber }[]).map(element => element.value.toString()), ['-0', '0']);
	});

	// `output -json` and a state file record each output's type, and Terragrunt decodes the value as of it.
	it('decodes an output as of the type recorded with it', () => {
		const list = unmarshalValue(['a', 'b'], unmarshalType(['list', 'string']));
		assert.equal(friendlyName(valueType(list)), 'list of string');
		const map = unmarshalValue({ a: CtyNumber.parse('1') }, unmarshalType(['map', 'number']));
		assert.equal(friendlyName(valueType(map)), 'map of number');
		const tuple = unmarshalValue(['a', CtyNumber.parse('1')], unmarshalType(['tuple', ['string', 'number']]));
		assert.equal(friendlyName(valueType(tuple)), 'tuple');
		const object = unmarshalValue({ a: null }, unmarshalType(['object', { a: ['set', 'string'], b: 'bool' }]));
		assert.equal(friendlyName(valueType(object)), 'object');
		assert.equal(friendlyName(valueType((object.value as Map<string, never>).get('b')!)), 'bool');
		assert.throws(() => unmarshalValue({ c: 1 }, unmarshalType(['object', { a: 'string' }])), /unsupported attribute "c"/);
		assert.throws(() => unmarshalValue(['a'], unmarshalType(['tuple', ['string', 'string']])), /not enough tuple elements \(need 2\)/);
	});
});
