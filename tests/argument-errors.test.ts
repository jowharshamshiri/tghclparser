import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { URI } from 'vscode-uri';

import { ConfigEvaluator } from '../src/Evaluator';
import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';
import { plainValue } from './plain-values';
import { conversions, faults, templateFiles, templates, values } from './fixtures/argument-errors-reference';

// HCL words every argument a function refuses the same way, whichever refuses it: HCL itself when the argument does not
// convert to the parameter's type or is a null the parameter does not take, or the function, which names the argument
// by its position and leaves HCL to name the parameter. Every expected value and message here is what Terragrunt v1.2.2
// gave for the same call (tests/fixtures/argument-errors-reference.ts).
describe('function arguments refused as Terragrunt v1.2.2 refuses them', function () {
	// Each test evaluates a unit for every case in its table.
	this.timeout(60000);
	let unit: string;
	let evaluator: ConfigEvaluator;

	before(async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-argument-errors-')));
		unit = path.join(root, 'unit');
		for (const [name, content] of Object.entries(templateFiles)) {
			await fs.mkdir(path.dirname(path.join(unit, name)), { recursive: true });
			await fs.writeFile(path.join(unit, name), content);
		}
		evaluator = new ConfigEvaluator({ environmentVariables: { A: 'a' }, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
	});

	after(async () => {
		await fs.rm(path.dirname(unit), { recursive: true, force: true });
	});

	// The unit's configuration is written where it is read, as Terragrunt reads it, so that the file functions find it.
	const evaluate = async (expression: string) => {
		const content = `inputs = {\n  x = ${expression}\n}\n`;
		const configPath = path.join(unit, 'terragrunt.hcl');
		await fs.writeFile(configPath, content);
		return evaluator.evaluateUnit(configPath, content, unit);
	};

	const refuses = async (table: Array<[string, string]>) => {
		for (const [expression, message] of table) {
			const result = await evaluate(expression);
			assert.equal(result.valid, false, expression);
			assert.equal(result.error, message.replaceAll('<unit>', unit), expression);
		}
	};

	it('refuses an argument that does not convert to its parameter, or a null, in HCL\'s words', () => refuses(conversions));

	it('refuses what a function refuses in an argument as HCL words it, by the parameter at the position it gives', () => refuses(faults));

	it('gives what Terragrunt gives where the functions check their arguments', async () => {
		for (const [expression, expected] of values) {
			const result = await evaluate(expression);
			assert.equal(result.error, undefined, expression);
			assert.deepEqual((plainValue(result.inputs!) as { x: unknown }).x, expected, expression);
		}
	});

	it('refuses the variables of a template before rendering it, naming where a template file refers to one it lacks', async () => {
		for (const [expression, expected] of templates) {
			const result = await evaluate(expression);
			if ('error' in expected) {
				assert.equal(result.error, expected.error.replaceAll('<unit>', unit), expression);
			} else {
				assert.equal(result.error, undefined, expression);
				assert.deepEqual((plainValue(result.inputs!) as { x: unknown }).x, expected.value, expression);
			}
		}
	});

	// go-cty reports a pattern RE2 cannot compile as an argument error on the pattern; the reason it gives is RE2's,
	// which tghclparser, compiling patterns as JavaScript does, does not yet give.
	it('refuses a pattern that does not compile as an argument error on the pattern', async () => {
		for (const expression of ['regex("[", "a")', 'regexall("(", "a")']) {
			const result = await evaluate(expression);
			assert.match(result.error ?? '', /^Invalid function argument; Invalid value for "pattern" parameter: invalid regexp pattern: .+\.$/u, expression);
		}
	});
});

// The editor's own reading of a document calls the functions as the evaluator does, so an argument is refused there
// in the same words.
describe('function arguments refused alike on every path that calls a function', () => {
	const localsOf = async (content: string) => {
		const workspace = new Workspace();
		const document = new ParsedDocument(workspace, URI.file(path.join(os.tmpdir(), 'terragrunt.hcl')).toString(), content);
		return document.getAllLocals();
	};

	it('converts and counts the arguments of a call in a document\'s locals as HCL does', async () => {
		await assert.rejects(localsOf('locals {\n  a = abs("x")\n}\n'), { message: conversions.find(([expression]) => expression === 'abs("x")')![1] });
		await assert.rejects(localsOf('locals {\n  a = abs()\n}\n'), { message: 'Not enough function arguments; Function "abs" expects 1 argument(s). Missing value for "num".' });
		await assert.rejects(localsOf('locals {\n  a = parseint("x", 10)\n}\n'), { message: faults.find(([expression]) => expression === 'parseint("x", 10)')![1] });
	});
});
