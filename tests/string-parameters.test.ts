import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { URI } from 'vscode-uri';

import type { CtyType } from '../src/cty-types';
import { ConfigEvaluator } from '../src/Evaluator';
import { EXPRESSION_CLOSURE, readSignature } from '../src/function-signature';
import functionsJson from '../src/functions.json';
import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';
import { plainValue } from './plain-values';
import { faults, values } from './fixtures/string-parameters-reference';

interface WrittenFunction {
	name: string;
	parameters: Array<Record<string, unknown>>;
	returnType: Record<string, unknown>;
	signature: unknown;
}

const written = (functionsJson as { functions: WrittenFunction[] }).functions;

// HCL converts each argument to its parameter's type before the function sees it, so a number or bool given for a
// string parameter is the string go-cty writes for it, in every function. Every expected value and message here is what
// Terragrunt v1.2.2 gave for the same call (tests/fixtures/string-parameters-reference.ts).
describe('string parameters as Terragrunt v1.2.2 converts their arguments', function () {
	// Each test evaluates a unit for every case in its table.
	this.timeout(60000);
	let root: string;
	let unit: string;
	let evaluator: ConfigEvaluator;

	before(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-string-parameters-')));
		unit = path.join(root, 'unit');
		await fs.mkdir(unit);
		await fs.writeFile(path.join(unit, '1'), 'inputs = { a = "one" }\n');
		await fs.writeFile(path.join(unit, 'true'), 'yes');
		evaluator = new ConfigEvaluator({
			environmentVariables: { 1: 'envone', true: 'envtrue' },
			terraformCommand: '',
			terraformCliArgs: [],
			workspaceTrusted: true
		});
	});

	after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const evaluate = (expression: string) =>
		evaluator.evaluateUnit(path.join(unit, 'terragrunt.hcl'), `inputs = {\n  x = ${expression}\n}\n`, unit);

	it('converts a number or bool to the string go-cty writes for it', async () => {
		for (const [expression, expected] of values) {
			const result = await evaluate(expression);
			assert.equal(result.error, undefined, expression);
			assert.deepEqual((plainValue(result.inputs!) as { x: unknown }).x, expected, expression);
		}
	});

	it('refuses what go-cty and HCL refuse, in their words', async () => {
		for (const [expression, message] of faults) {
			const result = await evaluate(expression);
			assert.equal(result.valid, false, expression);
			assert.equal(result.error, message, expression);
		}
	});

	it('calls every function that has a string parameter', () => {
		const takesStrings = (type: CtyType): boolean =>
			type.kind === 'string' || ((type.kind === 'list' || type.kind === 'set' || type.kind === 'map') && takesStrings(type.element));
		const called = [...values, ...faults].map(([expression]) => expression);
		const uncalled = written
			.filter(definition => {
				const signature = readSignature(definition.name, definition.signature);
				return [...signature.params, ...(signature.varParam ? [signature.varParam] : [])]
					.some(parameter => parameter.type !== EXPRESSION_CLOSURE && takesStrings(parameter.type));
			})
			.map(definition => definition.name)
			.filter(name => !called.some(expression => new RegExp(`\\b${name}\\(`, 'u').test(expression)));
		assert.deepEqual(uncalled, []);
	});
});

// functions.json describes each function for hover and completion, and holds it to nothing but its go-cty signature,
// which HCL and go-cty enforce: it states no validation that no function enforces.
describe('functions.json and the hover it gives', () => {
	it('states no validation for any parameter or result', () => {
		const validated = written.flatMap(definition => [
			...definition.parameters.filter(parameter => 'validation' in parameter).map(parameter => `${definition.name} ${String(parameter.name)}`),
			...('validation' in definition.returnType ? [`${definition.name} result`] : [])
		]);
		assert.deepEqual(validated, []);
	});

	const hover = async (name: string): Promise<string> => {
		const content = `inputs = { x = ${name}() }`;
		const document = new ParsedDocument(new Workspace(), URI.file(path.join(os.tmpdir(), 'terragrunt.hcl')).toString(), content);
		const shown = await document.getHoverInfo({ line: 0, character: content.indexOf(name) + 1 });
		return String((shown as { value: string }).value);
	};

	it('shows each parameter\'s go-cty type and what HCL converts to it', async () => {
		const shown: Array<[string, string]> = [
			['file', '- *Type:* `string` (a number or bool is converted to a string)'],
			['templatefile', '- *Type:* `string` (a number or bool is converted to a string)'],
			['abs', '- *Type:* `number` (a string that holds a number is converted to it)'],
			['alltrue', '- *Type:* `list of bool` (a tuple or set is converted to a list, each element to bool)'],
			['join', '- *Type:* `list of string` (a tuple or set is converted to a list, each element to string) (variadic)'],
			['setunion', '- *Type:* `set of any single type` (a tuple or list is converted to a set, its elements to one type) (variadic)'],
			['transpose', '- *Type:* `map of list of string` (an object is converted to a map, each element to list of string)'],
			['lookup', '- *Type:* `any type`'],
			['try', '- *Type:* `expression closure` (the expression itself, which the function evaluates)']
		];
		for (const [name, line] of shown) assert.ok((await hover(name)).split('\n').includes(line), `${name}: ${line}`);
	});

	it('shows a type for every parameter of every function, and no constraint beyond it', async () => {
		for (const definition of written) {
			const text = await hover(definition.name);
			assert.equal(text.split('\n').filter(line => line.startsWith('- *Type:* ')).length, definition.parameters.length, definition.name);
			assert.ok(!text.includes('*Pattern:*') && !text.includes('*Allowed values:*'), definition.name);
		}
	});
});
