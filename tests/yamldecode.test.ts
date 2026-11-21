import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigEvaluator } from '../src/Evaluator';
import { plainValue } from './plain-values';

// Every expected value and message here was recorded from the Terragrunt v1.2.2 release binary, yamldecode reading
// each YAML source in a unit's inputs. A decoded value is given as jsonencode writes it, or as yamlencode writes it,
// marked Y:, where it holds an infinity, which JSON cannot hold; a refusal as the message after
// `Call to function "yamldecode" failed: `.
describe('yamldecode as Terragrunt evaluates it', () => {
	let root: string;
	let evaluator: ConfigEvaluator;

	before(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-yamldecode-')));
		evaluator = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
	});

	after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const hcl = (text: string) => JSON.stringify(text).replaceAll('${', '$${').replaceAll('%{', '%%{');

	const evaluate = (expression: string) =>
		evaluator.evaluateUnit(path.join(root, 'terragrunt.hcl'), `inputs = {\n  x = ${expression}\n}\n`, root);

	const decoded = async (yaml: string): Promise<string> => {
		const call = `yamldecode(${hcl(yaml)})`;
		// Inside a list, so that a value an input cannot hold, an infinity, is not refused as an input.
		const refused = (await evaluate(`length([${call}])`)).error;
		if (refused !== undefined) return `refused: ${refused}`;
		const result = await evaluate(`try(jsonencode(${call}), "Y:\${yamlencode(${call})}")`);
		assert.equal(result.error, undefined, yaml);
		return (plainValue(result.inputs!) as { x: string }).x;
	};

	const check = async (cases: Array<[string, string]>) => {
		for (const [yaml, expected] of cases) assert.equal(await decoded(yaml), expected, yaml);
	};

	it('reads a decimal integer exactly, with its sign and leading zeros, at any size', async () => {
		await check([
			['0', '0'],
			['1', '1'],
			['-1', '-1'],
			['+1', '1'],
			['007', '7'],
			['0755', '755'],
			['08', '8'],
			['00', '0'],
			['-0', '-0'],
			['+0', '0'],
			['12345678901234567890123456789', '12345678901234567890123456789'],
			['9007199254740993', '9007199254740993'],
			['-9223372036854775809', '-9223372036854775809']
		]);
	});

	it('reads a YAML 1.2 float exactly at 512 bits, and keeps a text that only looks like one a string', async () => {
		await check([
			['1.5', '1.5'],
			['-1.5', '-1.5'],
			['+1.5', '1.5'],
			['1.', '1'],
			['.5', '0.5'],
			['-.5', '-0.5'],
			['+.5', '0.5'],
			['1e3', '1000'],
			['1E3', '1000'],
			['1e+3', '1000'],
			['1e-3', '0.001'],
			['-1.5e-3', '-0.0015'],
			['1.5e300', '1500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'],
			['1e400', '10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'],
			['0.1', '0.1'],
			['0.30000000000000004', '0.30000000000000004'],
			['3.14159265358979323846264338327950288419716939937510', '3.1415926535897932384626433832795028841971693993751'],
			['6.8523015e+5', '685230.15'],
			['685.230_15e+03', '"685.230_15e+03"'],
			['1_000', '"1_000"'],
			['1e', '"1e"'],
			['e3', '"e3"'],
			['1.2.3', '"1.2.3"'],
			['1.5f', '"1.5f"'],
			['.', '"."'],
			['-.', '"-."'],
			['1.e5', '100000'],
			['-0.0', '-0'],
			['1e-400', '0.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001']
		]);
	});

	it('reads 0x hexadecimal up to a uint64 and refuses it beyond; a sign or 0X keeps it a string', async () => {
		await check([
			['0x10', '16'],
			['0xFF', '255'],
			['0xff', '255'],
			['0xDEADBEEF', '3735928559'],
			['0x7FFFFFFFFFFFFFFF', '9223372036854775807'],
			['0x8000000000000000', '9223372036854775808'],
			['0xFFFFFFFFFFFFFFFF', '18446744073709551615'],
			['0x10000000000000000', 'refused: cannot parse "0x10000000000000000" as tag:yaml.org,2002:int.'],
			['-0x10', '"-0x10"'],
			['+0x10', '"+0x10"'],
			['0X10', '"0X10"'],
			['0x', '"0x"'],
			['0xg', '"0xg"'],
			['0x0', '0']
		]);
	});

	it('reads 0o octal up to a uint64 and refuses it beyond; 0O, a sign, 0b or base 60 keeps it a string', async () => {
		await check([
			['0o17', '15'],
			['0o0', '0'],
			['0o1777777777777777777777', '18446744073709551615'],
			['0o2000000000000000000000', 'refused: cannot parse "0o2000000000000000000000" as tag:yaml.org,2002:int.'],
			['0o8', '"0o8"'],
			['0O17', '"0O17"'],
			['-0o17', '"-0o17"'],
			['0b101', '"0b101"'],
			['190:20:30', '"190:20:30"'],
			['1:30', '"1:30"']
		]);
	});

	it('reads the YAML infinities, refuses .nan, .NaN and .NAN, and keeps every other spelling a string', async () => {
		await check([
			['.inf', 'Y:+Inf\n...\n'],
			['.Inf', 'Y:+Inf\n...\n'],
			['.INF', 'Y:+Inf\n...\n'],
			['+.inf', 'Y:+Inf\n...\n'],
			['+.Inf', 'Y:+Inf\n...\n'],
			['-.inf', 'Y:-Inf\n...\n'],
			['-.Inf', 'Y:-Inf\n...\n'],
			['-.INF', 'Y:-Inf\n...\n'],
			['.iNf', '".iNf"'],
			['inf', '"inf"'],
			['Inf', '"Inf"'],
			['-inf', '"-inf"'],
			['+Inf', '"+Inf"'],
			['infinity', '"infinity"'],
			['.nan', 'refused: floating point NaN is not supported.'],
			['.NaN', 'refused: floating point NaN is not supported.'],
			['.NAN', 'refused: floating point NaN is not supported.'],
			['.Nan', '".Nan"'],
			['nan', '"nan"'],
			['NaN', '"NaN"'],
			['-.nan', '"-.nan"']
		]);
	});

	it('reads the YAML 1.1 booleans and nulls, and an empty value as null', async () => {
		await check([
			['true', 'true'],
			['True', 'true'],
			['TRUE', 'true'],
			['tRUE', '"tRUE"'],
			['false', 'false'],
			['False', 'false'],
			['FALSE', 'false'],
			['yes', 'true'],
			['Yes', 'true'],
			['YES', 'true'],
			['yEs', '"yEs"'],
			['y', 'true'],
			['Y', 'true'],
			['no', 'false'],
			['No', 'false'],
			['NO', 'false'],
			['n', 'false'],
			['N', 'false'],
			['on', 'true'],
			['On', 'true'],
			['ON', 'true'],
			['off', 'false'],
			['Off', 'false'],
			['OFF', 'false'],
			['o', '"o"'],
			['oN', '"oN"'],
			['null', 'null'],
			['Null', 'null'],
			['NULL', 'null'],
			['nULL', '"nULL"'],
			['~', 'null'],
			['a:', '{"a":null}'],
			['- ~\n- \n- null', '[null,null,null]']
		]);
	});

	it('writes a timestamp as Go writes it in RFC 3339, and keeps one Go cannot parse a string', async () => {
		await check([
			['2001-12-14', '"2001-12-14T00:00:00Z"'],
			['2002-1-2', '"2002-01-02T00:00:00Z"'],
			['2001-12-14t21:59:43.10-05:00', '"2001-12-14T21:59:43-05:00"'],
			['2001-12-14T21:59:43.10Z', '"2001-12-14T21:59:43Z"'],
			['2001-12-14 21:59:43.10', '"2001-12-14T21:59:43Z"'],
			['2001-12-14   21:59:43', '"2001-12-14T21:59:43Z"'],
			['2001-12-14 21:59:43.10 -5', '"2001-12-14 21:59:43.10 -5"'],
			['2001-02-29', '"2001-02-29"'],
			['2000-02-29', '"2000-02-29T00:00:00Z"'],
			['2001-13-01', '"2001-13-01"'],
			['2001-12-14T21:59:43+00:00', '"2001-12-14T21:59:43Z"'],
			['2001-12-14T21:59:43-00:00', '"2001-12-14T21:59:43Z"'],
			['2001-12-14T25:00:00Z', '"2001-12-14T25:00:00Z"'],
			['2001-12-14T1:2:3Z', '"2001-12-14T01:02:03Z"'],
			['2001-12-14T21:59:43,5Z', '"2001-12-14T21:59:43Z"'],
			['20011-12-14', '"20011-12-14"'],
			['2001-12-14T21:59:43+24:60', '"2001-12-14T21:59:43+25:00"'],
			['2001-12-14T21:59:43z', '"2001-12-14T21:59:43z"'],
			['2001-12-14T21:59:60Z', '"2001-12-14T21:59:60Z"'],
			['0000-02-29', '"0000-02-29T00:00:00Z"'],
			['2001-12-14T21:59Z', '"2001-12-14T21:59Z"'],
			['2001-012-14', '"2001-012-14"'],
			['2001-12-14 1:2:3', '"2001-12-14T01:02:03Z"'],
			['2001-12-14T21:59:43.123456789123Z', '"2001-12-14T21:59:43Z"'],
			['2001-12-14 ', '"2001-12-14T00:00:00Z"'],
			['2001-12-14T21:59:43+0530', '"2001-12-14T21:59:43+0530"']
		]);
	});

	it('keeps a quoted scalar a string, and resolves an explicit tag as go-cty-yaml does, a quoted scalar staying a string where its first character hints at a type', async () => {
		await check([
			['\'1\'', '"1"'],
			['"0x10"', '"0x10"'],
			['"true"', '"true"'],
			['\'~\'', '"~"'],
			['\'.inf\'', '".inf"'],
			['"2001-12-14"', '"2001-12-14"'],
			['\'\'', '""'],
			['!!int "12"', '"12"'],
			['!!int 0x1F', '31'],
			['!!int 1_000', '1000'],
			['!!float 1_000.5', '1000.5'],
			['!!int 1.5', '1.5'],
			['!!float .nan', 'refused: cannot parse ".nan" as tag:yaml.org,2002:float.'],
			['!!str 12', '"12"'],
			['!!str .inf', '".inf"'],
			['!!bool yes', 'true'],
			['!!bool 1', '1'],
			['!!bool "yes"', '"yes"'],
			['!!null x', 'null'],
			['!!timestamp 2001-12-14', '"2001-12-14T00:00:00Z"'],
			['!!timestamp foo', 'refused: cannot parse "foo" as tag:yaml.org,2002:timestamp.'],
			['!!binary aGVsbG8=', '"aGVsbG8="'],
			['!!binary abc!', 'refused: cannot parse "abc!" as tag:yaml.org,2002:binary: not valid base64.'],
			['!foo bar', 'refused: unsupported tag "!foo".'],
			['!!int 0b101', '5'],
			['!!int 0B101', '5'],
			['!!int 0X1F', '31'],
			['!!int -0x1F', '-31'],
			['!!int 1__0', '10'],
			['!!int 0x_1F', '31'],
			['!!float 1e3', '1000'],
			['!!int ""', '""'],
			['!!int', 'null'],
			['!!int 012', '12'],
			['!!int abc', 'refused: cannot parse "abc" as tag:yaml.org,2002:int.'],
			['!!float inf', 'Y:+Inf\n...\n'],
			['!!int 0o17', '15'],
			['!!int 017', '17'],
			['!!int 0x10000000000000000', 'refused: cannot parse "0x10000000000000000" as tag:yaml.org,2002:int.'],
			['!!int 99999999999999999999', '99999999999999999999'],
			['!!float -.inf', 'Y:-Inf\n...\n'],
			['!!str', '""'],
			['!!timestamp "2001-12-14"', '"2001-12-14"'],
			['!!int 0xFFFFFFFFFFFFFFFF', '18446744073709551615'],
			['!!int -0x8000000000000000', '-9223372036854775808'],
			['!!int +0x10', '16'],
			['!<tag:yaml.org,2002:int> 0x10', '16'],
			['! 12', 'refused: unsupported tag "!".']
		]);
	});

	it('keeps a block scalar\'s text, converting what an untagged one resolves to into a string and refusing it only when nothing else is refused', async () => {
		await check([
			['|\n  12\n', '"12\\n"'],
			['>\n  0x10\n', '"0x10\\n"'],
			['|-\n  12', '"12"'],
			['>-\n  0x10', '"16"'],
			['|-\n  true', '"true"'],
			['|-\n  ~', 'null'],
			['|-\n  .nan', 'refused: floating point NaN is not supported.'],
			['|-\n  2001-12-14', '"2001-12-14T00:00:00Z"'],
			['|-\n  1.50', '"1.5"'],
			['- |-\n  12\n- 3', '["12",3]'],
			['a: &x |-\n  12\nb: *x', '{"a":"12","b":"12"}'],
			['!!int |-\n  12', '12'],
			['|-\n  yes', '"true"'],
			['- >-\n  0o17', '["15"]'],
			['|-\n  .inf', '"+Inf"'],
			['|-\n  1e400', '"10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"'],
			['|-\n  0x10000000000000000', 'refused: cannot parse "0x10000000000000000" as tag:yaml.org,2002:int.'],
			['|-\n  ', 'null'],
			['a: |-\n  12\n<<: {a: 1}', '{"a":1}'],
			['a: &x |-\n  12\n<<: {b: *x}', '{"a":"12","b":"12"}'],
			['|-\n  !!int', '"!!int"'],
			['|-\n  -0', '"-0"'],
			['- |-\n  .nan\n- !!int abc', 'refused: on line 2, column 3: cannot parse "abc" as tag:yaml.org,2002:int.'],
			['- |-\n  .nan\n- >-\n  0x10000000000000000', 'refused: floating point NaN is not supported.'],
			['a: |-\n  .nan\nb: *x', 'refused: on line 2, column 4: reference to undefined anchor "x".'],
			['a: |-\n  .nan\n<<: 5', 'refused: on line 2, column 1: cannot merge number into mapping.']
		]);
	});

	it('resolves a mapping key and converts it to a string, refusing a null one', async () => {
		await check([
			['0x10: a', '{"16":"a"}'],
			['1.50: a', '{"1.5":"a"}'],
			['yes: a', '{"true":"a"}'],
			['~: a', 'refused: mapping key cannot be null.'],
			['.inf: a', '{"+Inf":"a"}'],
			['2001-12-14: a', '{"2001-12-14T00:00:00Z":"a"}'],
			['1e3: a', '{"1000":"a"}'],
			['"1.50": a', '{"1.50":"a"}'],
			['a: 1\na: 2', '{"a":2}'],
			['a: 1\n<<: {a: 2, b: 3}', '{"a":2,"b":3}'],
			['<<: {a: 2, b: 3}\na: 1', '{"a":1,"b":3}'],
			['<<: [{a: 1}, {a: 2, b: 2}]', '{"a":2,"b":2}'],
			['null: a', 'refused: mapping key cannot be null.'],
			['[a]: b', 'refused: only strings are allowed as mapping keys.']
		]);
	});

	it('resolves the scalars inside collections', async () => {
		await check([
			['[0x10, 1.5, .inf, yes, ~, 2001-12-14]', 'Y:- 16\n- 1.5\n- +Inf\n- true\n- null\n- "2001-12-14T00:00:00Z"\n'],
			['{a: 0o17, b: -.5, c: "1"}', '{"a":15,"b":-0.5,"c":"1"}']
		]);
	});

	it('refuses a stream without a document or with more than one', async () => {
		await check([
			['', 'refused: on line 1, column 1: missing start of document.'],
			['# comment', 'refused: on line 1, column 1: missing start of document.'],
			['---\n12\n...', '12'],
			['12\n---\n13', 'refused: on line 1, column 1: unexpected extra content after value.']
		]);
	});

	it('merges keys, follows anchors and refuses as go-cty-yaml does, citing the line from 0 and column from 1 past the first line', async () => {
		await check([
			['a: 1\nb: .nan', 'refused: on line 1, column 4: floating point NaN is not supported.'],
			['a: 1\nb:   !!int abc', 'refused: on line 1, column 6: cannot parse "abc" as tag:yaml.org,2002:int.'],
			['a: 1\nb: &x\n  !!int abc', 'refused: on line 1, column 4: cannot parse "abc" as tag:yaml.org,2002:int.'],
			['a: 1\nb: [1, !foo x]', 'refused: on line 1, column 8: unsupported tag "!foo".'],
			['a: 1\n.nan: x', 'refused: floating point NaN is not supported.'],
			['a: 1\n!!int x: y', 'refused: cannot parse "x" as tag:yaml.org,2002:int.'],
			['a: 1\nb: *nope', 'refused: on line 1, column 4: reference to undefined anchor "nope".'],
			['a: &x [1, *x]', 'refused: cannot refer to anchor "x" from inside its own definition.'],
			['a: 1\n<<: 5', 'refused: on line 1, column 1: cannot merge number into mapping.'],
			['a: 1\n<<: [{b: 1}, 2]', 'refused: on line 1, column 1: cannot merge number (from sequence) into mapping.'],
			['a: 1\n<<: ~', 'refused: on line 1, column 1: cannot merge dynamic into mapping.'],
			['a: 1\n"<<": {b: 2}', '{"a":1,"b":2}'],
			['a: 1\n!!merge x: {b: 2}', '{"a":1,"b":2}'],
			['a: &m {b: 1}\nc:\n  <<: *m\n  d: 2', '{"a":{"b":1},"c":{"b":1,"d":2}}'],
			['a: 1\n*x : b', 'refused: on line 1, column 1: only strings are allowed as mapping keys.'],
			['a: &k k\n*k : b', 'refused: on line 1, column 1: only strings are allowed as mapping keys.'],
			['a: 1\n[x]: b', 'refused: on line 1, column 1: only strings are allowed as mapping keys.'],
			['a: 1\n~: b', 'refused: on line 1, column 1: mapping key cannot be null.'],
			['a: 1\nb: !!set {x: 1}', 'refused: on line 1, column 4: can\'t interpret mapping as tag:yaml.org,2002:set.'],
			['a: 1\nb: !!omap [x]', 'refused: on line 1, column 4: can\'t interpret sequence as tag:yaml.org,2002:omap.'],
			['12\n...\n# c\n', '12'],
			['12\n...\n%YAML 1.1\n---\n13', 'refused: on line 2, column 1: unexpected extra content after value.'],
			['12\n---', 'refused: on line 1, column 1: unexpected extra content after value.'],
			['\n\n# c\n', 'refused: on line 3, column 1: missing start of document.'],
			['  \n', 'refused: on line 1, column 1: missing start of document.'],
			['---', 'null'],
			['--- !!int 5', '5'],
			['a: 1\r\nb: .nan', 'refused: on line 1, column 4: floating point NaN is not supported.'],
			['a: 1\rb: .nan', 'refused: on line 1, column 4: floating point NaN is not supported.'],
			['é: 1\nb: [é, .nan]', 'refused: on line 1, column 8: floating point NaN is not supported.'],
			['a: 1\n  # c\nb: !!int\n  abc', 'refused: on line 2, column 4: cannot parse "abc" as tag:yaml.org,2002:int.'],
			['a: 1\nb: |\n  x\nc: .NaN', 'refused: on line 3, column 4: floating point NaN is not supported.'],
			['- 1\n- !!binary "abc"', 'refused: on line 1, column 3: cannot parse "abc" as tag:yaml.org,2002:binary: not valid base64.'],
			['- 1\n- !!bool "1"', '[1,"1"]'],
			['.5p3', '4'],
			['!!float 1p3', '8'],
			['a: 1\nb: !!str', '{"a":1,"b":""}'],
			['a: 1\nb: !foo', 'refused: on line 1, column 4: unsupported tag "!foo".'],
			['a: !!binary |\n  aGVs\n  bG8=\n', '{"a":"aGVs\\nbG8=\\n"}'],
			['!!binary aGVs bG8=', 'refused: cannot parse "aGVs bG8=" as tag:yaml.org,2002:binary: not valid base64.'],
			['a: !!null', '{"a":null}'],
			['a: !!timestamp 12', '{"a":12}'],
			['!!null 12', '12'],
			['- !!int 1\n- !!int', '[1,null]'],
			['\'<<\': {a: 1}', '{"a":1}'],
			['x: 1\n? |\n  12\n: a', '{"12\\n":"a","x":1}'],
			['"a\\x00b"', '"a\\u0000b"'],
			['!!int "a\\tb"', 'refused: cannot parse "a\\tb" as tag:yaml.org,2002:int.'],
			['!!int a\tb', 'refused: cannot parse "a\\tb" as tag:yaml.org,2002:int.'],
			['a: 1\nb: !!map {x: 1}', '{"a":1,"b":{"x":1}}'],
			['a: 1\nb: !!seq [1]', '{"a":1,"b":[1]}'],
			['a: 1\nb: !!str [1]', 'refused: on line 1, column 4: can\'t interpret sequence as tag:yaml.org,2002:str.'],
			['a: 1\n<<: *m', 'refused: on line 1, column 5: reference to undefined anchor "m".'],
			['a: 1\nb:\n  - x\n  - !!int y', '{"a":1,"b":["x",true]}']
		]);
	});

	it('takes a lone carriage return as the end of a line', async () => {
		await check([
			['a: 1\rb: 2', '{"a":1,"b":2}'],
			['a: |\r  x\r  y\r', '{"a":"x\\ny\\n"}'],
			['a: "x\r  y"', '{"a":"x y"}'],
			['a: x\r  y', '{"a":"x y"}'],
			['- 0x10\r- !!int abc', 'refused: on line 1, column 3: cannot parse "abc" as tag:yaml.org,2002:int.'],
			['a: 1\r\rb: .inf', 'Y:"a": 1\n"b": +Inf\n']
		]);
	});
});
