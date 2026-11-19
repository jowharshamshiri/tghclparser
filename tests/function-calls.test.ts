import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigEvaluator } from '../src/Evaluator';
import { plainValue } from './plain-values';

// Every expected value and message here is what Terragrunt v1.2.2 gives for the same expression in a unit's inputs.
// A failure is stated the way Terragrunt states it: a refused count as its summary and detail, and any other failed
// call as the message after `Call to function "<name>" failed: `.
describe('function calls as Terragrunt evaluates them', () => {
	let root: string;
	let evaluator: ConfigEvaluator;

	before(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-function-calls-')));
		await fs.writeFile(path.join(root, 'x.tfvars'), '');
		evaluator = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
	});

	after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const evaluate = (expression: string) =>
		evaluator.evaluateUnit(path.join(root, 'terragrunt.hcl'), `inputs = {\n  x = ${expression}\n}\n`, root);

	const value = async (expression: string): Promise<unknown> => {
		const result = await evaluate(expression);
		assert.equal(result.error, undefined, expression);
		return (plainValue(result.inputs!) as { x: unknown }).x;
	};

	const failure = async (expression: string): Promise<string> => {
		const result = await evaluate(expression);
		assert.equal(result.valid, false, expression);
		return result.error ?? '';
	};

	describe('argument counts', () => {
		it('refuses more arguments than a function has parameters', async () => {
			assert.equal(await failure('upper("a", "b")'), 'Too many function arguments; Function "upper" expects only 1 argument(s).');
			assert.equal(await failure('can(1, 2)'), 'Too many function arguments; Function "can" expects only 1 argument(s).');
			assert.equal(await failure('get_terragrunt_dir(1)'), 'Too many function arguments; Function "get_terragrunt_dir" expects only 0 argument(s).');
		});

		it('refuses fewer arguments than a function has parameters, naming the first one missing', async () => {
			assert.equal(await failure('upper()'), 'Not enough function arguments; Function "upper" expects 1 argument(s). Missing value for "str".');
			assert.equal(await failure('can()'), 'Not enough function arguments; Function "can" expects 1 argument(s). Missing value for "expression".');
			assert.equal(await failure('substr("abc")'), 'Not enough function arguments; Function "substr" expects 3 argument(s). Missing value for "offset".');
		});

		it('counts only the parameters before a variadic one as required', async () => {
			assert.equal(await failure('join()'), 'Not enough function arguments; Function "join" expects at least 1 argument(s). Missing value for "separator".');
			assert.equal(await failure('format()'), 'Not enough function arguments; Function "format" expects at least 1 argument(s). Missing value for "format".');
			assert.equal(await failure('setunion()'), 'Not enough function arguments; Function "setunion" expects at least 1 argument(s). Missing value for "first_set".');
			assert.equal(await failure('lookup({ a = 1 })'), 'Not enough function arguments; Function "lookup" expects at least 2 argument(s). Missing value for "key".');
			assert.equal(await failure('read_terragrunt_config()'), 'Not enough function arguments; Function "read_terragrunt_config" expects at least 1 argument(s). Missing value for "".');
			assert.equal(await value('join(",", ["a"], ["b"])'), 'a,b');
			assert.equal(await value('try(1)'), 1);
			assert.equal(await value('try(nope.x, nope.y, 3)'), 3);
		});

		it('counts the arguments before it evaluates any of them', async () => {
			assert.equal(await failure('upper(nope.x, "b")'), 'Too many function arguments; Function "upper" expects only 1 argument(s).');
		});

		it('keeps the messages of functions that count their own arguments', async () => {
			const calls: Array<[string, string]> = [
				['range()', 'range must have one, two, or three arguments'],
				['range(1, 2, 3, 4)', 'range must have one, two, or three arguments'],
				['lookup({ a = 1 }, "a", 2, 3)', 'lookup() takes two or three arguments, got 4'],
				['bcrypt("a", 4, 5)', 'bcrypt() takes no more than two arguments'],
				['constraint_check("1.0.0")', 'Expected 2 params for function constraint_check, but got 1'],
				['constraint_check("1.0.0", ">=1", "x")', 'Expected 2 params for function constraint_check, but got 3'],
				['find_in_parent_folders("a", "b", "c")', 'Expected 0, 1, or 2 params for function find_in_parent_folders, but got 3'],
				['get_env()', 'parsing get_env parameters: InvalidGetEnvParamsError: Expected one or two parameters (getEnv("<NAME>", "[DEFAULT]")) for get_env but got 0.'],
				['get_env("A", "b", "c")', 'parsing get_env parameters: InvalidGetEnvParamsError: Expected one or two parameters (getEnv("<NAME>", "[DEFAULT]")) for get_env but got 3.'],
				['mark_as_read()', 'Expected 1 params for function mark_as_read, but got 0'],
				['mark_as_read("x.tfvars", "b")', 'Expected 1 params for function mark_as_read, but got 2'],
				['read_terragrunt_config("a", {}, 3)', 'Expected 1 or 2 params for function read_terragrunt_config, but got 3'],
				['read_tfvars_file()', 'Expected 1 params for function read_tfvars_file, but got 0'],
				['read_tfvars_file("x.tfvars", 2)', 'Expected 1 params for function read_tfvars_file, but got 2'],
				['sops_decrypt_file()', 'Expected 1 params for function sops_decrypt_file, but got 0'],
				['sops_decrypt_file("a", "b")', 'Expected 1 params for function sops_decrypt_file, but got 2'],
				['try()', 'at least one argument is required']
			];
			for (const [call, message] of calls) assert.equal(await failure(call), message, call);
		});

		it('counts an expanded final argument as its elements', async () => {
			assert.equal(await value('upper(["a"]...)'), 'A');
			assert.equal(await value('upper("a", []...)'), 'A');
			assert.equal(await value('upper(toset(["a"])...)'), 'A');
			assert.deepEqual(await value('concat([["a"], ["b"]]...)'), ['a', 'b']);
			assert.equal(await value('can([1]...)'), true);
			assert.equal(await failure('upper(["a", "b"]...)'), 'Too many function arguments; Function "upper" expects only 1 argument(s).');
			assert.equal(await failure('upper([]...)'), 'Not enough function arguments; Function "upper" expects 1 argument(s). Missing value for "str".');
		});

		it('expands only a list, a set or a tuple', async () => {
			assert.equal(await failure('upper("a"...)'), 'Invalid expanding argument value; The expanding argument (indicated by ...) must be of a tuple, list, or set type.');
			assert.equal(await failure('upper({ a = 1 }...)'), 'Invalid expanding argument value; The expanding argument (indicated by ...) must be of a tuple, list, or set type.');
			assert.equal(await failure('upper(null...)'), 'Invalid expanding argument value; The expanding argument (indicated by ...) must not be null.');
		});
	});

	describe('jsonencode', () => {
		it('orders object and map keys by their bytes', async () => {
			assert.equal(await value('jsonencode({ "b" = 1, "B" = 2, "a" = 3, "￿" = 4, "😀" = 5, "10" = 6, "9" = 7 })'), '{"10":6,"9":7,"B":2,"a":3,"b":1,"￿":4,"😀":5}');
			assert.equal(await value('jsonencode(tomap({ "b" = 1, "B" = 2, "10" = 6, "9" = 7 }))'), '{"10":6,"9":7,"B":2,"b":1}');
			assert.equal(await value('jsonencode({ a = { "z" = [], "y" = {} } })'), '{"a":{"y":{},"z":[]}}');
		});

		it('escapes what Go escapes in a string', async () => {
			assert.equal(await value('jsonencode("<a>&\'\\"\u2028")'), '"\\u003ca\\u003e\\u0026\'\\"\\u2028"');
			assert.equal(
				await value('jsonencode(["\u0008\u000c\\n\\r\\t\u0001\u001f\u007f", "\u2029", "<>&", "\\\\\\""])'),
				'["\\b\\f\\n\\r\\t\\u0001\\u001f\u007f","\\u2029","\\u003c\\u003e\\u0026","\\\\\\""]'
			);
		});

		it('writes a number in full, without an exponent', async () => {
			assert.equal(
				await value('jsonencode([null, true, 1.5, -0, 1e21, 1e-7, 0.000001, 123.456e5, 0.5, 100, 100000000000000000000])'),
				'[null,true,1.5,-0,1000000000000000000000,0.0000001,0.000001,12345600,0.5,100,100000000000000000000]'
			);
			assert.equal(await value('jsonencode(5e-324)'), `0.${'0'.repeat(323)}5`);
			assert.equal(await value('jsonencode(1.7976931348623157e308)'), `17976931348623157${'0'.repeat(292)}`);
		});
	});

	describe('sort', () => {
		it('orders strings by their bytes', async () => {
			assert.deepEqual(
				await value('sort(["b", "B", "a", "￿", "😀", "10", "9", "é", "e", "Z", "_", " ", "ab", "a"])'),
				[' ', '10', '9', 'B', 'Z', '_', 'a', 'a', 'ab', 'b', 'e', 'é', '￿', '😀']
			);
			assert.deepEqual(
				await value('sort(["b", "B", "a", "😀", "", "ｚ", "10", "9", "é", "e"])'),
				['', '10', '9', 'B', 'a', 'b', 'e', 'é', 'ｚ', '😀']
			);
			assert.deepEqual(await value('sort(toset(["b", "a", "B"]))'), ['B', 'a', 'b']);
			assert.deepEqual(await value('sort([])'), []);
		});

		it('sorts numbers and bools as the strings they convert to', async () => {
			assert.deepEqual(
				await value('sort([10, 9, 1, 2.5, -1, 100, 0.5, 1e21, -0, 0.1])'),
				['-0', '-1', '0.1', '0.5', '1', '10', '100', '1000000000000000000000', '2.5', '9']
			);
			assert.deepEqual(await value('sort(tolist([3, 1, 20, 2]))'), ['1', '2', '20', '3']);
			assert.deepEqual(await value('sort(toset([3, 1, 20, 2]))'), ['1', '2', '20', '3']);
			assert.deepEqual(await value('sort([true, "a", 1, false, "B"])'), ['1', 'B', 'a', 'false', 'true']);
		});

		it('refuses a list it cannot convert to a list of strings', async () => {
			const calls: Array<[string, string]> = [
				['sort(null)', 'argument must not be null.'],
				['sort("a")', 'list of string required, but have string.'],
				['sort(1)', 'list of string required, but have number.'],
				['sort(true)', 'list of string required, but have bool.'],
				['sort({ a = 1 })', 'list of string required.'],
				['sort([1, [2]])', 'element 1: string required, but have tuple.'],
				['sort(["a", { b = 1 }])', 'element 1: string required, but have object.'],
				['sort([[1], null])', 'element 0: string required, but have tuple.'],
				['sort([null, [1]])', 'element 1: string required, but have tuple.']
			];
			for (const [call, message] of calls) assert.equal(await failure(call), `Invalid function argument; Invalid value for "list" parameter: ${message}`, call);
		});

		it('refuses a null element', async () => {
			assert.equal(await failure('sort(["b", null])'), 'given list element 1 is null; a null string cannot be sorted.');
			assert.equal(await failure('sort([1, null, 2])'), 'given list element 1 is null; a null string cannot be sorted.');
			assert.equal(await failure('sort([null])'), 'given list element 0 is null; a null string cannot be sorted.');
		});
	});

	describe('sets', () => {
		it('hold strings in the order of their bytes and numbers by value', async () => {
			assert.deepEqual(await value('toset(["b", "B", "a", "é", "e", "😀", "ｚ", "10", "9"])'), ['10', '9', 'B', 'a', 'b', 'e', 'é', 'ｚ', '😀']);
			assert.deepEqual(await value('setunion(["b", "é"], ["B", "a", "10", "9"])'), ['10', '9', 'B', 'a', 'b', 'é']);
			assert.deepEqual(await value('setintersection(["b", "B", "a", "é"], ["é", "a", "B", "b"])'), ['B', 'a', 'b', 'é']);
			assert.deepEqual(await value('setsubtract(["b", "B", "a", "é", "x"], ["x"])'), ['B', 'a', 'b', 'é']);
			assert.deepEqual(await value('toset([10, 9, 1, 2.5])'), [1, 2.5, 9, 10]);
		});
	});

	describe('yamlencode', () => {
		it('orders object and map keys by their bytes', async () => {
			assert.equal(
				await value('yamlencode({ "b" = 1, "B" = 2, "a" = 3, "10" = 6, "9" = 7, "é" = 8, "e" = 9, "_" = 10, "Z" = 11, "中" = 12, "ｚ" = 13 })'),
				'"10": 6\n"9": 7\n"B": 2\n"Z": 11\n"_": 10\n"a": 3\n"b": 1\n"e": 9\n"é": 8\n"中": 12\n"ｚ": 13\n'
			);
			assert.equal(await value('yamlencode(tomap({ "b" = 1, "B" = 2, "10" = 6, "9" = 7 }))'), '"10": 6\n"9": 7\n"B": 2\n"b": 1\n');
			assert.equal(
				await value('yamlencode({ outer = { "z" = 1, "Y" = 2, "y" = 3 }, "Outer" = { "b" = 1, "A" = 2 } })'),
				'"Outer":\n  "A": 2\n  "b": 1\n"outer":\n  "Y": 2\n  "y": 3\n  "z": 1\n'
			);
		});
	});

	describe('keys, values and for expressions', () => {
		it('take an object\'s keys in the order of their bytes', async () => {
			const object = '{ "b" = 1, "B" = 2, "a" = 3, "￿" = 4, "😀" = 5, "10" = 6, "9" = 7 }';
			assert.deepEqual(await value(`keys(${object})`), ['10', '9', 'B', 'a', 'b', '￿', '😀']);
			assert.deepEqual(await value(`values(${object})`), [6, 7, 2, 3, 1, 4, 5]);
			assert.deepEqual(await value(`[for k, v in ${object} : k]`), ['10', '9', 'B', 'a', 'b', '￿', '😀']);
		});
	});

	describe('length', () => {
		it('counts a string\'s grapheme clusters', async () => {
			const lengths: Array<[string, number]> = [
				['"👍🏽"', 1],
				['"🇺🇸🇬🇧"', 2],
				['"é"', 1],
				['"👨‍👩‍👧"', 1],
				['"क्षि"', 1],
				['"\\r\\n"', 1],
				['""', 0]
			];
			for (const [text, count] of lengths) assert.equal(await value(`length(${text})`), count, text);
		});
	});
});
