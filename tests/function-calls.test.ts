import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import bcryptjs from 'bcryptjs';

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

	describe('argument values', () => {
		it('hands a function an infinite number as it is', async () => {
			assert.equal(await value('format("%f", 1/0)'), '+Inf');
			assert.equal(await value('format("%f", -1/0)'), '-Inf');
		});
	});

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

		it('writes collections in block style, a sequence under a key at the key\'s indentation and a collection in a sequence on the dash\'s line', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode({ a = { b = { c = 1 }, d = "e" }, f = { g = true } })', '"a":\n  "b":\n    "c": 1\n  "d": "e"\n"f":\n  "g": true\n'],
				['yamlencode([[1, 2], [[3], []], "x"])', '- - 1\n  - 2\n- - - 3\n  - []\n- "x"\n'],
				['yamlencode([{ b = 1, A = 2 }, { c = { d = 1 }, e = [1, 2] }, {}])', '- "A": 2\n  "b": 1\n- "c":\n    "d": 1\n  "e":\n  - 1\n  - 2\n- {}\n'],
				['yamlencode({ k = ["a", "b"], m = { n = [{ o = 1, p = 2 }, [3, 4]] } })', '"k":\n- "a"\n- "b"\n"m":\n  "n":\n  - "o": 1\n    "p": 2\n  - - 3\n    - 4\n'],
				['yamlencode([[{ a = 1 }], { b = [{ c = 1 }] }])', '- - "a": 1\n- "b":\n  - "c": 1\n'],
				['yamlencode(toset(["b", "a", "B"]))', '- "B"\n- "a"\n- "b"\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('writes an empty collection in flow style', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode([])', '[]\n'],
				['yamlencode({})', '{}\n'],
				['yamlencode(tolist([]))', '[]\n'],
				['yamlencode(tomap({}))', '{}\n'],
				['yamlencode({ a = [], b = {}, c = [[], {}] })', '"a": []\n"b": {}\n"c":\n- []\n- {}\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('writes a null, bool or number plain, and ends the stream with ... after one that is the whole value', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode(1)', '1\n...\n'],
				['yamlencode(-0)', '-0\n...\n'],
				['yamlencode(true)', 'true\n...\n'],
				['yamlencode(false)', 'false\n...\n'],
				['yamlencode(null)', 'null\n...\n'],
				['yamlencode(1/0)', '+Inf\n...\n'],
				['yamlencode({ a = 1/0, b = -1/0 })', '"a": +Inf\n"b": -Inf\n'],
				['yamlencode([1, -1, 0.5, -0, 1e21, 1e-7, 0.000001, 123.456e5, 100000000000000000000, 1.5])', '- 1\n- -1\n- 0.5\n- -0\n- 1000000000000000000000\n- 0.0000001\n- 0.000001\n- 12345600\n- 100000000000000000000\n- 1.5\n'],
				['yamlencode({ a = null, b = false, c = true, d = 0, e = "" })', '"a": null\n"b": false\n"c": true\n"d": 0\n"e": ""\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('writes every other string double-quoted', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode("a")', '"a"\n'],
				['yamlencode("")', '""\n'],
				['yamlencode({ "" = "" })', '"": ""\n'],
				['yamlencode(["true", "null", "1", "- a", "#", "...", "---", "a: b", "\'", "\\"", "\\\\"])', '- "true"\n- "null"\n- "1"\n- "- a"\n- "#"\n- "..."\n- "---"\n- "a: b"\n- "\'"\n- "\\""\n- "\\\\"\n'],
				['yamlencode("say \\"hi\\" \\\\ bye")', '"say \\"hi\\" \\\\ bye"\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('writes a string holding a line feed as a literal block where libyaml allows one', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode("a\\nb\\n")', '|\n  a\n  b\n'],
				['yamlencode("a\\nb")', '|-\n  a\n  b\n'],
				['yamlencode("a\\n\\n")', '|+\n  a\n\n'],
				['yamlencode("\\n")', '|2+\n\n'],
				['yamlencode("\\n\\n")', '|2+\n\n\n'],
				['yamlencode("\\na")', '|2-\n\n  a\n'],
				['yamlencode(" a\\nb")', '|2-\n   a\n  b\n'],
				['yamlencode("a \\nb")', '"a \\nb"\n'],
				['yamlencode("a\\nb ")', '"a\\nb "\n'],
				['yamlencode("a\\n\\tb")', '"a\\n\\tb"\n'],
				['yamlencode("a\\r\\nb")', '"a\\r\\nb"\n'],
				['yamlencode({ k = "a\\nb\\n", l = "x\\n\\n", m = { n = "c\\nd" } })', '"k": |\n  a\n  b\n"l": |+\n  x\n\n"m":\n  "n": |-\n    c\n    d\n'],
				['yamlencode({ k = "x\\n\\n" })', '"k": |+\n  x\n\n'],
				['yamlencode(["a\\nb", "c", ["d\\ne\\n"]])', '- |-\n  a\n  b\n- "c"\n- - |\n    d\n    e\n'],
				['yamlencode({ "a\\nb" = 1, "c\\n" = [1], "d\\te\\n" = 2 })', '? |-\n  a\n  b\n: 1\n? |\n  c\n: - 1\n? "d\\te\\n"\n: 2\n'],
				['yamlencode("first line that is long enough to pass the eightieth column of the output by a good margin\\nsecond")', '|-\n  first line that is long enough to pass the eightieth column of the output by a good margin\n  second\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('folds a double-quoted string at a space past the eightieth column, and writes a key longer than 128 bytes after ?', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.")', '"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt\n  ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation\n  ullamco laboris nisi ut aliquip ex ea commodo consequat."\n'],
				['yamlencode({ outer = { inner = ["Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."] } })', '"outer":\n  "inner":\n  - "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor\n    incididunt ut labore et dolore magna aliqua."\n'],
				['yamlencode("0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 012345  6789   end  ")', '"0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 012345\n  \\ 6789   end  "\n'],
				['yamlencode("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx yyy")', '"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n  yyy"\n'],
				['yamlencode("éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé")', '"éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé éééééééééé\n  éééééééééé"\n'],
				['yamlencode("😀😀😀😀😀😀😀😀 😀😀😀😀😀😀😀😀 😀😀😀😀😀😀😀😀 😀😀😀😀😀😀😀😀 end")', '"\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\n  \\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\n  \\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\n  \\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\\U0001F600\n  end"\n'],
				['yamlencode("tab\\tseparated\\tvalues\\tthat\\tgo\\tpast\\tthe\\teightieth\\tcolumn\\tof\\tthe\\tline and then some words")', '"tab\\tseparated\\tvalues\\tthat\\tgo\\tpast\\tthe\\teightieth\\tcolumn\\tof\\tthe\\tline and\n  then some words"\n'],
				['yamlencode({ "a key that is longer than eighty columns but no longer than one hundred and twenty-eight bytes" = 1 })', '"a key that is longer than eighty columns but no longer than one hundred and twenty-eight bytes": 1\n'],
				['yamlencode({ "a key that is longer than one hundred and twenty-eight bytes, so the emitter cannot write it as a simple key and must use an explicit one" = { a = 1 } })', '? "a key that is longer than one hundred and twenty-eight bytes, so the emitter cannot\n  write it as a simple key and must use an explicit one"\n: "a": 1\n'],
				['yamlencode({ "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk" = [1, 2] })', '? "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"\n: - 1\n  - 2\n'],
				['yamlencode("a line with a trailing space \\nand a second line that is long enough to pass the eightieth column of the output")', '"a line with a trailing space \\nand a second line that is long enough to pass the\n  eightieth column of the output"\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('escapes what libyaml does not print, and every character of a string that begins with a byte order mark', async () => {
			const calls: Array<[string, string]> = [
				['yamlencode("😀")', '"\\U0001F600"\n'],
				['yamlencode({ "😀" = "x😀y" })', '"\\U0001F600": "x\\U0001F600y"\n'],
				['yamlencode("\\u0000\\u0001\\u0007\\u0008\\t\\u000b\\u000c\\r\\u001b\\u001f\\u007f")', '"\\0\\x01\\a\\b\\t\\v\\f\\r\\e\\x1F\\x7F"\n'],
				['yamlencode("\\u0080\\u0085\\u009f\\u00a0ÿ")', '"\\x80\\N\\x9F\u{a0}ÿ"\n'],
				['yamlencode("a\\u2028b\\u2029c")', '"a\\Lb\\Pc"\n'],
				['yamlencode({ "a\\u2028b" = 1 })', '? "a\\Lb"\n: 1\n'],
				['yamlencode("\\ue000\\ufeff\\ufffd\\ufffe\\uffff\\ud7ff")', '"\u{e000}\\uFEFF\u{fffd}\\uFFFE\\uFFFF\u{d7ff}"\n'],
				['yamlencode("\\ufeffab")', '"\\uFEFF\\x61\\x62"\n'],
				['yamlencode({ "\\ufeffk" = "v" })', '"\\uFEFF\\x6B": "v"\n'],
				['yamlencode("é中ｚ\\u00a1")', '"é中ｚ\u{a1}"\n']
			];
			for (const [call, encoded] of calls) assert.equal(await value(call), encoded, call);
		});

		it('encodes a sensitive value inside the value as the value it holds', async () => {
			assert.equal(await value('yamlencode({ a = sensitive("x"), b = [sensitive(1)] })'), '"a": "x"\n"b":\n- 1\n');
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

	describe('bcrypt', function () {
		// Each hash at the default cost takes a tenth of a second to write and as long to check.
		this.timeout(20000);

		// A hash Terragrunt v1.2.2 gave for bcrypt("hello", 5): the check below accepts what Go's bcrypt writes, so it is
		// the same check that holds each hash the parser writes. The salt is random, so no hash is compared as a whole.
		const goHash = '$2a$05$8du67BcaXK35tB1B4frdp.yAXPWH74Ty5i.nApeU4joFHsdI8RfGO';

		const hashOf = async (expression: string, password: string, cost: string) => {
			const hash = String(await value(expression));
			assert.match(hash, new RegExp(`^\\$2a\\$${cost}\\$[./A-Za-z0-9]{53}$`, 'u'), expression);
			assert.equal(bcryptjs.compareSync(password, hash), true, expression);
			// Changed at its start, since bcrypt reads no further than 72 bytes.
			assert.equal(bcryptjs.compareSync(`!${password.slice(1)}`, hash), false, expression);
		};

		it('checks hashes as Go\'s bcrypt writes them', () => {
			assert.equal(bcryptjs.compareSync('hello', goHash), true);
			assert.equal(bcryptjs.compareSync('hellp', goHash), false);
		});

		it('writes a $2a$ hash at cost 10 by default', async () => {
			await hashOf('bcrypt("hello")', 'hello', '10');
		});

		it('writes a $2a$ hash at the cost given', async () => {
			await hashOf('bcrypt("hello", 4)', 'hello', '04');
			await hashOf('bcrypt("hello", 5)', 'hello', '05');
			await hashOf('bcrypt("hello", "6")', 'hello', '06');
		});

		it('takes a cost below 4 as the default cost', async () => {
			for (const cost of ['3', '0', '-9223372036854775808']) await hashOf(`bcrypt("hello", ${cost})`, 'hello', '10');
		});

		it('hashes a number or a bool as the string it converts to', async () => {
			await hashOf('bcrypt(5, 4)', '5', '04');
			await hashOf('bcrypt(true, 4)', 'true', '04');
		});

		it('marks the hash sensitive when either argument is', async () => {
			assert.equal(await value('issensitive(bcrypt(sensitive("x"), 4))'), true);
			assert.equal(await value('issensitive(bcrypt("x", sensitive(4)))'), true);
			assert.equal(await value('issensitive(bcrypt("x", 4))'), false);
			await hashOf('nonsensitive(bcrypt(sensitive("x"), 4))', 'x', '04');
		});

		it('hashes a string of up to 72 bytes', async () => {
			await hashOf(`bcrypt("${'a'.repeat(72)}", 4)`, 'a'.repeat(72), '04');
			await hashOf(`bcrypt("${'é'.repeat(36)}", 4)`, 'é'.repeat(36), '04');
		});

		it('refuses what Go\'s bcrypt refuses', async () => {
			const calls: Array<[string, string]> = [
				['bcrypt("hello", 32)', 'error occurred generating password crypto/bcrypt: cost 32 is outside allowed inclusive range 4..31'],
				['bcrypt("hello", 9007199254740993)', 'error occurred generating password crypto/bcrypt: cost 9007199254740993 is outside allowed inclusive range 4..31'],
				[`bcrypt("${'a'.repeat(73)}")`, 'error occurred generating password bcrypt: password length exceeds 72 bytes'],
				[`bcrypt("${'é'.repeat(36)}e", 4)`, 'error occurred generating password bcrypt: password length exceeds 72 bytes'],
				[`bcrypt("${'a'.repeat(73)}", 32)`, 'error occurred generating password bcrypt: password length exceeds 72 bytes'],
				['bcrypt("hello", 4.5)', 'value must be a whole number, between -9223372036854775808 and 9223372036854775807'],
				['bcrypt("hello", 1e30)', 'value must be a whole number, between -9223372036854775808 and 9223372036854775807'],
				['bcrypt("hello", 9223372036854775808)', 'value must be a whole number, between -9223372036854775808 and 9223372036854775807'],
				['bcrypt("hello", 4.5, 5)', 'value must be a whole number, between -9223372036854775808 and 9223372036854775807'],
				['bcrypt(null)', 'Invalid value for "str" parameter: argument must not be null.'],
				['bcrypt("hello", "x")', 'Invalid value for "cost" parameter: a number is required.'],
				['bcrypt("hello", null)', 'Invalid value for "cost" parameter: argument must not be null.']
			];
			for (const [call, message] of calls) assert.equal(await failure(call), message, call);
		});
	});
});
