import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';

// Every expected value and message here is what Terragrunt v1.2.2 (release binary, commit 109a529e) gave for the same
// configuration: each input as the TF_VAR_ text `terragrunt run` passes to OpenTofu, which carries a number's every
// digit, and `render --json` output as it printed it. Numbers are compared as the JSON text the evaluator writes for
// them, so that a digit a float64 cannot hold is compared too.

const evaluate = (content: string) =>
	new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
		.evaluateUnit('/repo/app/terragrunt.hcl', content, '/repo/app');

/** Each input's value as JSON text. */
const jsonOf = async (inputs: Record<string, string>): Promise<Record<string, string>> => {
	const body = Object.entries(inputs).map(([name, expression]) => `  ${name} = ${expression}`).join('\n');
	const result = await evaluate(`inputs = {\n${body}\n}\n`);
	expect(result.error).to.equal(undefined);
	const plain = runtimeValueToPlain(result.inputs!) as Record<string, unknown>;
	return Object.fromEntries(Object.entries(plain).map(([name, value]) => [name, JSON.stringify(value)]));
};

const failureOf = async (expression: string): Promise<string> => {
	const result = await evaluate(`inputs = {\n  x = ${expression}\n}\n`);
	expect(result.error, expression).to.be.a('string');
	return result.error!;
};

const third = '0.33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333335';
const twoThirds = '0.6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666667';

describe('numbers as Terragrunt v1.2.2 computes them', () => {
	it('adds, subtracts, multiplies, divides and takes remainders of decimals at 512 bits', async () => {
		expect(await jsonOf({
			decimal_sum: '0.1 + 0.2',
			third: '1 / 3',
			two_thirds: '2 / 3',
			third_tripled: '1 / 3 * 3',
			quotient: '10 / 4',
			modulo_decimal: '7.5 % 2',
			modulo_negative: '-7 % 3',
			modulo_third: '1 % (1 / 3)',
			modulo_zero: '-7.5 % 0',
			negative_zero: '-0',
			string_operand: '"1.5" + 1'
		})).to.deep.equal({
			decimal_sum: '0.3',
			third,
			two_thirds: twoThirds,
			third_tripled: '1',
			quotient: '2.5',
			modulo_decimal: '1.5',
			modulo_negative: '-1',
			modulo_third: '0',
			modulo_zero: '-7.5',
			negative_zero: '-0',
			string_operand: '2.5'
		});
	});

	it('keeps every digit of a large integer', async () => {
		expect(await jsonOf({
			big_sum: '12345678901234567890 + 1',
			big_product: '9007199254740993 * 9007199254740993',
			big_difference: '100000000000000000000000000001 - 1',
			big_text: '"${12345678901234567890 * 10}"',
			max_big: 'max(9007199254740993, 9007199254740992)',
			ceil_big: 'ceil(12345678901234567890.5)',
			parseint_big: 'parseint("123456789012345678901234567890", 10)',
			jsondecode_numbers: 'jsondecode("[12345678901234567890123, 0.1]")'
		})).to.deep.equal({
			big_sum: '12345678901234567891',
			big_product: '81129638414606699710187514626049',
			big_difference: '100000000000000000000000000000',
			big_text: '123456789012345678900',
			max_big: '9007199254740993',
			ceil_big: '12345678901234567891',
			parseint_big: '123456789012345678901234567890',
			jsondecode_numbers: '[12345678901234567890123,0.1]'
		});
	});

	it('holds each number at its own precision: a count at 64 bits, a float64 result at 53', async () => {
		expect(await jsonOf({
			count_ratio: 'length("a") / length("abc")',
			float_doubled: 'pow(2, 0.5) * 2',
			pow_large: 'pow(3, 40)',
			pow_root: 'pow(2, 0.5)'
		})).to.deep.equal({
			count_ratio: '0.33333333333333333334',
			float_doubled: '2.828427124746190290949243717477656900882720947265625',
			pow_large: '12157665459056929000',
			pow_root: '1.4142135623730951'
		});
	});

	it('reads number literals as decimals: a leading zero is not octal', async () => {
		expect(await jsonOf({ leading_zero: '0755', exponent: '1.5e3' })).to.deep.equal({ leading_zero: '755', exponent: '1500' });
	});

	it('compares numbers exactly, and as go-cty equality decides', async () => {
		expect(await jsonOf({
			decimal_equal: '0.1 + 0.2 == 0.3',
			third_equal: '1 / 3 * 3 == 1',
			big_less: '9007199254740992 < 9007199254740993',
			big_equal: '9007199254740993 == 9007199254740992',
			string_greater: '"10" > "9"',
			decimal_at_most: '0.1 + 0.2 <= 0.3'
		})).to.deep.equal({
			decimal_equal: 'true',
			third_equal: 'true',
			big_less: 'true',
			big_equal: 'false',
			string_greater: 'true',
			decimal_at_most: 'true'
		});
	});

	it('computes the numeric functions as go-cty and OpenTofu do', async () => {
		expect(await jsonOf({
			abs_decimal: 'abs(-0.1)',
			floor_close: 'floor(2.0000000000000000001)',
			ceil_close: 'ceil(2.0000000000000000001)',
			floor_negative: 'floor(-0.5)',
			ceil_negative: 'ceil(-0.5)',
			min_decimal: 'min(0.30000000000000001, 0.3)',
			logs: '[log(10, 100), log(100, 10), log(8, 2), log(1000, 10), log(10, 3)]',
			pows: '[pow(2, 10), pow(10, 23), pow(2, -3), pow(1.5, 2.5)]',
			parseint_base62: 'parseint("Zz", 62)',
			sum_decimal: 'sum([0.1, 0.2, 0.3])',
			tonumber_sum: 'tonumber("0.1") + tonumber("0.2")',
			range_tenths: 'range(0, 1, 0.1)',
			range_thirds: 'range(0, 1, 1 / 3)',
			sort_numbers: 'sort([10, 9, 1.5])'
		})).to.deep.equal({
			abs_decimal: '0.1',
			floor_close: '2',
			ceil_close: '3',
			floor_negative: '-1',
			ceil_negative: '0',
			min_decimal: '0.3',
			logs: '[0.5,2,3,2.9999999999999996,2.095903274289385]',
			pows: '[1024,100000000000000000000000,0.125,2.7556759606310752]',
			parseint_base62: '3817',
			sum_decimal: '0.6',
			tonumber_sum: '0.3',
			range_tenths: '[0,0.1,0.2,0.3,0.4,0.5,0.6,0.70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006,0.8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001,0.9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001]',
			range_thirds: `[0,${third},${twoThirds}]`,
			sort_numbers: '["1.5","10","9"]'
		});
	});

	it('writes numbers into strings with every digit and no exponent', async () => {
		expect(await jsonOf({
			sum: '"a${0.1 + 0.2}"',
			third: '"a${1 / 3}"',
			negative_zero: '"a${-0}"',
			large: '"a${1e21}"',
			small: '"a${1e-7}"',
			infinity: '"a${1 / 0}"',
			tostring_third: 'tostring(1 / 3)',
			jsonencode_numbers: 'jsonencode([100000000000000000000000000001 - 1, 2 / 3, 7.5 % 2])'
		})).to.deep.equal({
			sum: '"a0.3"',
			third: `"a${third}"`,
			negative_zero: '"a-0"',
			large: '"a1000000000000000000000"',
			small: '"a0.0000001"',
			infinity: '"a+Inf"',
			tostring_third: `"${third}"`,
			jsonencode_numbers: JSON.stringify(`[100000000000000000000000000000,${twoThirds},1.5]`)
		});
	});

	it('formats numbers as Go formats a big.Float or a big.Int', async () => {
		expect(await jsonOf({
			big: 'format("%d", 12345678901234567890)',
			fixed: 'format("%.30f", 1 / 3)',
			fixed_default: 'format("%f", 2 / 3)',
			exponent: 'format("%e", 1 / 3)',
			general: 'format("%g", 1 / 3)',
			value_large: 'format("%v", 1e21)',
			value_small: 'format("%v", 0.00001)',
			value_width: 'format("%5.2v", 3.14159)',
			string_int: 'format("%d", "42")',
			flags: 'format("%08.3f|%-8.2f|%+.1e|%G|%x|%X|%o|%b|%#o|%#b|% d|%5d|%-5d|%05d|%.3d|%.0d", 3.14159, 2.5, 12345.678, 1e-10, 255, 255, 8, 5, 8, 5, 7, 42, 42, 42, 7, 0)',
			general_precision: 'format("%.3g|%10.4f|%e|%f|%g", 2 / 3, 1 / 3, 0, -0, 100000)',
			values: 'format("%v|%v|%v|%#v", 0.1 + 0.2, 1e-5, 123456789, 1 / 3)',
			list: 'formatlist("%.2f", [1 / 3, 2 / 3])'
		})).to.deep.equal({
			big: '"12345678901234567890"',
			fixed: '"0.333333333333333333333333333333"',
			fixed_default: '"0.666667"',
			exponent: '"3.333333e-01"',
			general: `"${third}"`,
			value_large: '"1e+21"',
			value_small: '"1e-05"',
			value_width: '"3.14159"',
			string_int: '"42"',
			flags: '"0003.142|2.50    |+1.2e+04|1E-10|ff|FF|10|101|010|0b101| 7|   42|42   |00042|007|"',
			general_precision: '"0.667|    0.3333|0.000000e+00|-0.000000|100000"',
			values: `"0.3|1e-05|1.23456789e+08|${third}"`,
			list: '["0.33","0.67"]'
		});
	});

	it('refuses what Terragrunt refuses, in its words', async () => {
		const refusals: Record<string, string> = {
			'format("%d", 1.5)': 'unsupported value for "%d" at 0: an integer is required',
			'format("%d", true)': 'unsupported value for "%d" at 0: number required, but have bool',
			'[1, 2, 3][1.5]': 'The given key does not identify an element in this collection value: indexing a sequence requires a whole number, but the given index has a fractional part.',
			'[1, 2, 3][-1]': 'The given key does not identify an element in this collection value: a negative number is not a valid index for a sequence.',
			'[1, 2, 3][3]': 'The given key does not identify an element in this collection value: the given index is greater than or equal to the length of the collection.',
			'signum(0.5)': 'value must be a whole number, between -9223372036854775808 and 9223372036854775807',
			'tonumber("abc")': 'Invalid value for "v" parameter: cannot convert "abc" to number; given string must be a decimal representation of a number.',
			'parseint("12", 1)': 'Invalid value for "base" parameter: base must be a whole number between 2 and 62 inclusive.',
			'1 + true': 'Unsuitable value for right operand: number required, but have bool.',
			'"x" < 1': 'Unsuitable value for left operand: a number is required.',
			'abs(null)': 'Invalid value for "num" parameter: argument must not be null.',
			'5 % (1 / 0)': "Error during operation: can't use modulo with zero and infinity.",
			'1 / 0': 'failed to serialize value: cannot serialize infinity as JSON',
			'1e5000': 'number is outside the supported range of 1e-4096 to 1e4096',
			'1e4000 * 1e4000': 'x: number is outside the supported range of 1e-4096 to 1e4096',
			'[1 / 0, 1e4000 * 1e4000]': 'x[1]: number is outside the supported range of 1e-4096 to 1e4096'
		};
		for (const [expression, message] of Object.entries(refusals)) {
			expect(await failureOf(expression), expression).to.include(message);
		}
	});

	describe('render --json', function () {
		this.timeout(20000);
		let root: string;

		before(async () => {
			root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-render-numbers-')));
		});

		after(async () => {
			await fs.rm(root, { recursive: true, force: true });
		});

		const render = async (inputs: string) => {
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), `inputs = {\n${inputs}\n}\n`);
			return spawnSync(process.execPath, [path.resolve('dist/cli.cjs'), 'render', '--json', '--working-dir', root], { encoding: 'utf8' });
		};

		it('writes each number as Go writes the float64 nearest it', async () => {
			const result = await render([
				'  decimal_sum = 0.1 + 0.2',
				'  third = 1 / 3',
				'  max_big = max(9007199254740993, 9007199254740992)',
				'  big_sum = 12345678901234567890 + 1',
				'  big_difference = 100000000000000000000000000001 - 1',
				'  big_product = 9007199254740993 * 9007199254740993',
				'  negative_zero = -0',
				'  tiny = 1e-400',
				'  smallest = 5e-324',
				'  small = 1e-7',
				'  negative_small = -0.0000001',
				'  edge = 0.000001',
				'  large = 1e21',
				'  rounds_up = 999999999999999999999',
				'  scaled = 123456789e15'
			].join('\n'));
			expect(result.status, result.stderr).to.equal(0);
			const inputs = /"inputs":(\{[^}]*\})/u.exec(result.stdout)?.[1];
			expect(inputs).to.equal('{"big_difference":1e+29,"big_product":8.11296384146067e+31,"big_sum":12345678901234567000,'
				+ '"decimal_sum":0.3,"edge":0.000001,"large":1e+21,"max_big":9007199254740992,"negative_small":-1e-7,'
				+ '"negative_zero":-0,"rounds_up":1e+21,"scaled":1.23456789e+23,"small":1e-7,"smallest":5e-324,'
				+ '"third":0.3333333333333333,"tiny":0}');
		});

		it('refuses a number beyond the largest float64, as Go refuses to read it', async () => {
			const result = await render('  x = [1, { y = 1e300 * 1e300 }]');
			expect(result.status).to.not.equal(0);
			expect(result.stderr).to.include(`json: cannot unmarshal number 1${'0'.repeat(600)} into Go struct field CtyJSONOutput.value.inputs.x.1.y of type float64`);
		});
	});
});
