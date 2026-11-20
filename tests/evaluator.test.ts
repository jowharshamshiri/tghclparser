import assert from 'node:assert/strict';
import { generateKeyPairSync, publicEncrypt, constants } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { ConfigEvaluator } from '../src/Evaluator';
import { makeArrayValue, makeSensitiveValue, makeStringValue } from '../src/functions/utils';
import type { RuntimeValue, ValueType } from '../src/model';
import { plainValue } from './plain-values';
import { ENCRYPTED_SOPS_JSON, ENCRYPTED_SOPS_YAML, withoutSops, withoutSopsKey } from './sops-fixture';

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
		assert.equal(result.unresolved, undefined);
	});

	describe('for expressions', () => {
		const forInputs = async (expression: string): Promise<unknown> => {
			const content = [
				'locals {',
				'  containers = { A = { provider = "AWS" }, B = { provider = "GCP" } }',
				'}',
				'inputs = {',
				`  x = ${expression}`,
				'}'
			].join('\n');
			const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
			assert.equal(result.error, undefined);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};

		it('reads an attribute of the variable', async () => {
			assert.deepEqual(
				await forInputs('[for c in values(local.containers) : { name = c.provider }]'),
				[{ name: 'AWS' }, { name: 'GCP' }]
			);
		});

		it('binds the key and value of an object', async () => {
			assert.deepEqual(
				await forInputs('[for k, c in local.containers : "${k}=${c.provider}"]'),
				['A=AWS', 'B=GCP']
			);
		});

		it('binds the index and value of a list', async () => {
			assert.deepEqual(await forInputs('{for i, v in ["a", "b"] : v => i}'), { a: 0, b: 1 });
		});

		it('keeps only the elements that pass the condition', async () => {
			assert.deepEqual(await forInputs('[for v in [1, 2, 3] : v if v > 1]'), [2, 3]);
			assert.deepEqual(
				await forInputs('{for k, c in local.containers : k => c.provider if k != "A"}'),
				{ B: 'GCP' }
			);
		});

		it('groups values by key with ...', async () => {
			assert.deepEqual(
				await forInputs('{for v in ["a", "b", "a"] : v => v ... if v != "b"}'),
				{ a: ['a', 'a'] }
			);
		});

		it('rejects a duplicate key without ...', async () => {
			const result = await evaluator.evaluateUnit(
				configPath,
				'inputs = { x = {for v in ["a", "a"] : v => v} }',
				process.cwd()
			);
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /Duplicate key "a"/);
		});

		it('reports a missing attribute of the variable', async () => {
			const result = await evaluator.evaluateUnit(
				configPath,
				'inputs = { x = [for c in [{ a = 1 }] : c.b] }',
				process.cwd()
			);
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /Missing attribute "b" on "c"/);
		});

		it('visits the keys of an object in lexical order, as HCL does', async () => {
			assert.deepEqual(await forInputs('[for k, v in { b = 1, a = 2, "10" = 3, "9" = 4 } : k]'), ['10', '9', 'a', 'b']);
			assert.deepEqual(await forInputs('[for v in { b = 1, a = 2 } : v]'), [2, 1]);
		});

		it('takes a condition that converts to a bool', async () => {
			assert.deepEqual(await forInputs('[for v in [1, 2] : v if v > 1 ? "true" : "false"]'), [2]);
		});

		const forError = async (expression: string): Promise<string> => {
			const result = await evaluator.evaluateUnit(configPath, `inputs = { x = ${expression} }`, process.cwd());
			assert.equal(result.valid, false);
			return result.error ?? '';
		};

		it('rejects a condition that is not a bool', async () => {
			assert.match(await forError('[for v in [1, 2] : v if v]'), /"if" clause of a for expression must be a bool, got number/);
			assert.match(await forError('[for v in [1, 2] : v if "yes"]'), /"if" clause of a for expression must be a bool, got string "yes"/);
			assert.match(await forError('[for v in [1, 2] : v if null]'), /"if" clause of a for expression must not be null/);
		});

		it('takes a key that converts to a string, and rejects any other', async () => {
			assert.deepEqual(await forInputs('{for v in [true, 2] : v => v}'), { true: true, '2': 2 });
			assert.match(await forError('{for v in [{ n = "x" }] : v => v}'), /key of a for expression must be a string, got object/);
			assert.match(await forError('{for v in [null] : v => 1}'), /key of a for expression must not be null/);
		});

		it('lets a variable shadow a namespace of the same name', async () => {
			assert.deepEqual(await forInputs('[for local in [{ provider = "x" }] : local.provider]'), ['x']);
		});

		it('takes the strings "1" and "0" as a condition, as HCL converts them', async () => {
			assert.deepEqual(await forInputs('[for v in [1, 2] : v if v > 1 ? "1" : "0"]'), [2]);
		});
	});

	describe('bool operands and conditions', () => {
		const evaluate = (expression: string) => evaluator.evaluateUnit(configPath, `inputs = {\n  x = ${expression}\n}\n`, process.cwd());
		const value = async (expression: string): Promise<unknown> => {
			const result = await evaluate(expression);
			assert.equal(result.error, undefined, expression);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};
		/** The one fault an expression has, and the columns of line 2 it is written at. */
		const fault = async (expression: string): Promise<[string, number, number]> => {
			const result = await evaluate(expression);
			assert.equal(result.valid, false, expression);
			assert.equal(result.unresolved, undefined, expression);
			assert.equal(result.problems?.length, 1, `${expression}: ${result.error}`);
			const [problem] = result.problems!;
			assert.equal(problem.range.start.line, 1, expression);
			return [problem.message, problem.range.start.character, problem.range.end.character];
		};

		it('takes a bool, and the strings HCL converts to one', async () => {
			assert.equal(await value('true && "true"'), true);
			assert.equal(await value('"1" && true'), true);
			assert.equal(await value('!"0"'), true);
			assert.equal(await value('"false" || "0"'), false);
			assert.equal(await value('"1" ? "a" : "b"'), 'a');
			assert.equal(await value('"0" ? "a" : "b"'), 'b');
		});

		it('takes null in && and || where the other side decides, as HCL does', async () => {
			assert.equal(await value('null && true'), false);
			assert.equal(await value('true && null'), false);
			assert.equal(await value('null || true'), true);
		});

		it('drops a fault on the side that && or || does not need, as HCL does', async () => {
			assert.equal(await value('false && local.nope'), false);
			assert.equal(await value('local.nope && false'), false);
			assert.equal(await value('true || local.nope'), true);
			assert.match((await fault('true && local.nope'))[0], /Undefined local value "nope"/);
		});

		it('refuses an operand that is not a bool, where the operand is written', async () => {
			assert.deepEqual(await fault('1 && true'), ['Unsuitable value for left operand: bool required, but have number.', 6, 7]);
			assert.deepEqual(await fault('true || 0'), ['Unsuitable value for right operand: bool required, but have number.', 14, 15]);
			assert.deepEqual(await fault('!1'), ['Unsuitable value for unary operand: bool required, but have number.', 7, 8]);
			assert.deepEqual(await fault('"x" && true'), ['Unsuitable value for left operand: a bool is required.', 6, 9]);
			assert.deepEqual(await fault('"TRUE" && true'), ['Unsuitable value for left operand: a bool is required; to convert from string, use lowercase "true".', 6, 12]);
			assert.deepEqual(await fault('[] && true'), ['Unsuitable value for left operand: bool required, but have tuple.', 6, 8]);
			assert.deepEqual(await fault('{} || false'), ['Unsuitable value for left operand: bool required, but have object.', 6, 8]);
		});

		it('refuses an operand that is not a bool even when the other side decides', async () => {
			assert.deepEqual(await fault('false && 1'), ['Unsuitable value for right operand: bool required, but have number.', 15, 16]);
			assert.deepEqual(await fault('true || 1'), ['Unsuitable value for right operand: bool required, but have number.', 14, 15]);
		});

		it('refuses both operands when neither is a bool', async () => {
			const result = await evaluate('1 && "x"');
			assert.deepEqual(result.problems?.map(problem => problem.message), [
				'Unsuitable value for left operand: bool required, but have number.',
				'Unsuitable value for right operand: a bool is required.'
			]);
		});

		it('refuses null where nothing else decides', async () => {
			assert.deepEqual(await fault('!null'), ['Error during operation: argument must not be null.', 6, 11]);
			assert.deepEqual(await fault('null || false'), ['Error during operation: argument must not be null.', 6, 19]);
		});

		it('refuses a condition that is not a bool, or is null, where the condition is written', async () => {
			assert.deepEqual(await fault('1 ? "a" : "b"'), ['The condition expression must be of type bool.', 6, 7]);
			assert.deepEqual(await fault('"x" ? "a" : "b"'), ['The condition expression must be of type bool.', 6, 9]);
			assert.deepEqual(await fault('"False" ? "a" : "b"'), ['The condition expression must be of type bool.', 6, 13]);
			assert.deepEqual(await fault('[true] ? "a" : "b"'), ['The condition expression must be of type bool.', 6, 12]);
			assert.deepEqual(await fault('null ? "a" : "b"'), ['The condition value is null. Conditions must either be true or false.', 6, 10]);
		});

		describe('in a template', () => {
			let dir: string;
			before(async () => {
				const os = await import('node:os');
				const fs = await import('node:fs/promises');
				dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-template-bool-')));
			});
			after(async () => {
				const fs = await import('node:fs/promises');
				await fs.rm(dir, { recursive: true, force: true });
			});
			const render = async (template: string) => {
				const fs = await import('node:fs/promises');
				await fs.writeFile(path.join(dir, 't.tpl'), template);
				return evaluator.evaluateUnit(path.join(dir, 'terragrunt.hcl'), 'inputs = { x = templatefile("t.tpl", {}) }', dir);
			};
			const rendered = async (template: string) => {
				const result = await render(template);
				assert.equal(result.error, undefined, template);
				return (plainValue(result.inputs!) as Record<string, unknown>).x;
			};
			const refused = async (template: string) => {
				const result = await render(template);
				assert.equal(result.valid, false, template);
				return result.error ?? '';
			};

			it('renders the branch an if takes, and only that one', async () => {
				assert.equal(await rendered('%{ if true }yes%{ else }no%{ endif }'), 'yes');
				assert.equal(await rendered('%{ if false }yes%{ else }no%{ endif }'), 'no');
				assert.equal(await rendered('%{ if false }yes%{ endif }'), '');
				assert.match(await refused('%{ if true }a%{ else }b%{ else }c%{ endif }'), /Unexpected else directive; Already in the else clause for the if/);
			});

			it('holds conditions and operators to the same', async () => {
				assert.equal(await rendered('%{ if "1" }yes%{ else }no%{ endif }'), 'yes');
				assert.equal(await rendered('${!"true"}'), false);
				assert.equal(await rendered('${null && true}'), false);
				assert.match(await refused('%{ if 1 }yes%{ else }no%{ endif }'), /The condition expression must be of type bool\./);
				assert.match(await refused('%{ if null }yes%{ endif }'), /The condition value is null\. Conditions must either be true or false\./);
				assert.match(await refused('${1 && true}'), /Unsuitable value for left operand: bool required, but have number\./);
				assert.match(await refused('${"x" ? "a" : "b"}'), /The condition expression must be of type bool\./);
				assert.match(await refused('${!null}'), /Error during operation: argument must not be null\./);
			});
		});
	});

	// Each case is what Terragrunt v1.2.2 renders, or refuses, for the same source.
	describe('template directives', () => {
		const evaluate = (content: string) => evaluator.evaluateUnit(configPath, content, process.cwd());
		const rendered = async (content: string): Promise<unknown> => {
			const result = await evaluate(content);
			assert.equal(result.error, undefined, content);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};
		const value = (expression: string) => rendered(`inputs = {\n  x = ${expression}\n}\n`);
		/** The one fault an expression has, and the columns of line 2 it is written at. */
		const fault = async (expression: string): Promise<[string, number, number]> => {
			const result = await evaluate(`inputs = {\n  x = ${expression}\n}\n`);
			assert.equal(result.valid, false, expression);
			assert.equal(result.problems?.length, 1, `${expression}: ${result.error}`);
			const [problem] = result.problems!;
			assert.equal(problem.range.start.line, 1, expression);
			return [problem.message, problem.range.start.character, problem.range.end.character];
		};

		it('renders the branch an if takes, and nothing for a false if with no else', async () => {
			assert.equal(await value('"%{ if true }yes%{ endif }"'), 'yes');
			assert.equal(await value('"%{ if false }yes%{ endif }"'), '');
			assert.equal(await value('"a%{ if false }yes%{ else }no%{ endif }b"'), 'anob');
			assert.equal(await value('"%{ if "true" }yes%{ else }no%{ endif }"'), 'yes');
		});

		it('leaves the branch an if does not take unevaluated', async () => {
			assert.equal(await value('"%{ if true }ok%{ else }${local.missing}%{ endif }"'), 'ok');
		});

		it('renders a for once for each element, in the collection\'s order, and joins the renderings', async () => {
			assert.equal(await value('"%{ for x in ["a", "b"] }${x};%{ endfor }"'), 'a;b;');
			assert.equal(await value('"%{ for i, x in ["a", "b"] }${i}=${x} %{ endfor }"'), '0=a 1=b ');
			assert.equal(await value('"%{ for k, v in { b = 2, a = 1 } }${k}${v}%{ endfor }"'), 'a1b2');
			assert.equal(await value('"[%{ for x in [] }${x}%{ endfor }]"'), '[]');
			assert.equal(await value('"%{ for x in [1, 2] }%{ if x == 2 }two%{ else }${x},%{ endif }%{ endfor }"'), '1,two');
		});

		it('binds a for variable in a local without taking it for a variable the local reads', async () => {
			assert.equal(await rendered([
				'locals {',
				'  letters = ["a", "b"]',
				'  joined  = "%{ for letter in local.letters }${letter}%{ endfor }"',
				'}',
				'inputs = { x = local.joined }'
			].join('\n')), 'ab');
		});

		it('strips the space beside a sequence its ~ marks, escapes decoded first', async () => {
			assert.equal(await value('"a  %{~ if true ~}  b  %{~ endif ~}  c"'), 'abc');
			assert.equal(await value('"a ${~ "x" ~} b"'), 'axb');
			assert.equal(await value('"a\\n%{~ if true ~}\\n b%{ endif }"'), 'ab');
		});

		it('evaluates directives in a heredoc, where a strip marker reaches only to the end of its line', async () => {
			assert.equal(await value('<<EOT\n%{ for x in ["a", "b"] ~}\n- ${x}\n%{ endfor ~}\nEOT\n'), '- a\n- b\n');
			assert.equal(await value('<<EOT\na\n%{ if true ~}\n  b\n%{~ endif }\nEOT\n'), 'a\n  b\n');
		});

		it('refuses an if condition that is not a bool, or is null, where the condition is written', async () => {
			assert.deepEqual(await fault('"%{ if 1 }yes%{ endif }"'), ['The condition expression must be of type bool.', 13, 14]);
			assert.deepEqual(await fault('"%{ if null }yes%{ endif }"'), ['The condition value is null. Conditions must either be true or false.', 13, 17]);
		});

		it('refuses a for collection that is null or not a collection, where the collection is written', async () => {
			assert.deepEqual(await fault('"%{ for x in "ab" }${x}%{ endfor }"'), ['A value of type string cannot be used as the collection in a \'for\' expression.', 19, 23]);
			assert.deepEqual(await fault('"%{ for x in 1 }${x}%{ endfor }"'), ['A value of type number cannot be used as the collection in a \'for\' expression.', 19, 20]);
			assert.deepEqual(await fault('"%{ for x in null }${x}%{ endfor }"'), ['A null value cannot be used as the collection in a \'for\' expression.', 19, 23]);
		});
	});

	// Each case is what Terragrunt v1.2.2 gives, or refuses, for the same source: its HCL passes a template that is one
	// interpolation and nothing else through as that interpolation's value, and converts every interpolation of any
	// other template to a string, refusing what does not convert.
	describe('template values', () => {
		const evaluate = (content: string) => evaluator.evaluateUnit(configPath, content, process.cwd());
		const rendered = async (content: string): Promise<unknown> => {
			const result = await evaluate(content);
			assert.equal(result.error, undefined, content);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};
		const value = (expression: string) => rendered(`inputs = {\n  x = ${expression}\n}\n`);
		/** The one fault an expression has, and the columns of line 2 it is written at. */
		const fault = async (expression: string): Promise<[string, number, number]> => {
			const result = await evaluate(`inputs = {\n  x = ${expression}\n}\n`);
			assert.equal(result.valid, false, expression);
			assert.equal(result.problems?.length, 1, `${expression}: ${result.error}`);
			const [problem] = result.problems!;
			assert.equal(problem.range.start.line, 1, expression);
			return [problem.message, problem.range.start.character, problem.range.end.character];
		};
		const nullValue = 'The expression result is null. Cannot include a null value in a string template.';
		const tuple = 'Cannot include the given value in a string template: string required, but have tuple.';
		const object = 'Cannot include the given value in a string template: string required, but have object.';

		it('gives a template that is one interpolation the value of its expression, with its type', async () => {
			assert.deepEqual(await value('"${["a", 1]}"'), ['a', 1]);
			assert.deepEqual(await value('"${ { a = 1 } }"'), { a: 1 });
			assert.equal(await value('"${2}"'), 2);
			assert.equal(await value('"${true}"'), true);
			assert.equal(await value('"${null}"'), null);
			assert.deepEqual(await value('"${~ ["a"] ~}"'), ['a']);
			assert.deepEqual(await rendered([
				'locals {',
				'  zones = ["a", "b"]',
				'  copy  = "${local.zones}"',
				'}',
				'inputs = { x = local.copy }'
			].join('\n')), ['a', 'b']);
		});

		it('converts the values of a longer template to strings', async () => {
			assert.equal(await value('"a${2}b${true}"'), 'a2btrue');
			assert.equal(await value('"${"a"}${"b"}"'), 'ab');
		});

		it('refuses null in a longer template, where its expression is written', async () => {
			assert.deepEqual(await fault('"a${null}"'), [nullValue, 10, 14]);
			assert.deepEqual(await fault('"${null}b"'), [nullValue, 9, 13]);
		});

		it('refuses a collection in a longer template, where its expression is written', async () => {
			assert.deepEqual(await fault('"a${["b"]}"'), [tuple, 10, 15]);
			assert.deepEqual(await fault('"a${ { b = 1 } }"'), [object, 11, 20]);
			// v1.2.2 says "list of string" and "map of string": values keep no list or map type of their own until the
			// card "values keep cty's collection types" (PVTI_lAHOAHykxc4BqpFPzhKISso) gives them one.
			assert.deepEqual(await fault('"a${tolist(["b"])}"'), [tuple, 10, 23]);
			assert.deepEqual(await fault('"a${tomap({ b = "c" })}"'), [object, 10, 28]);
		});

		it('takes a literal a strip marker empties for a part, so the template is no longer one interpolation', async () => {
			assert.deepEqual(await fault('" ${~ ["a"] }"'), [tuple, 12, 17]);
			assert.deepEqual(await fault('"${ ["a"] ~} "'), [tuple, 10, 15]);
		});

		it('converts a heredoc\'s interpolation, its last line break being a part', async () => {
			assert.equal(await value('<<EOT\n${2}\nEOT\n'), '2\n');
			const result = await evaluate('inputs = {\n  x = <<EOT\n${["a"]}\nEOT\n}\n');
			assert.equal(result.valid, false);
			assert.equal(result.problems?.[0]?.message, tuple);
		});

		it('converts a lone interpolation in a directive\'s branch or loop, which is a template of its own', async () => {
			assert.equal(await value('"%{ if true }${2}%{ endif }"'), '2');
			assert.deepEqual(await fault('"%{ if true }${["a"]}%{ endif }"'), [tuple, 21, 26]);
			assert.deepEqual(await fault('"%{ if true }${null}%{ endif }"'), [nullValue, 21, 25]);
			assert.deepEqual(await fault('"%{ for x in [["a"]] }${x}%{ endfor }"'), [tuple, 30, 31]);
			assert.deepEqual(await fault('"%{ for x in [null] }${x}%{ endfor }"'), [nullValue, 29, 30]);
		});

		it('keeps a sensitive value sensitive, passed through or rendered into a string', async () => {
			const raw = async (expression: string) => {
				const result = await evaluate(`inputs = {\n  x = ${expression}\n}\n`);
				assert.equal(result.error, undefined, expression);
				return (result.inputs!.value as Map<string, RuntimeValue<ValueType>>).get('x');
			};
			assert.deepEqual(await raw('"${sensitive(["a"])}"'), makeSensitiveValue(makeArrayValue([makeStringValue('a')])));
			assert.deepEqual(await raw('"a${sensitive("b")}"'), makeSensitiveValue(makeStringValue('ab')));
			assert.deepEqual(await raw('"%{ for x in ["a"] }${sensitive(x)}%{ endfor }"'), makeSensitiveValue(makeStringValue('a')));
		});
	});

	// Each case is what Terragrunt v1.2.2 renders for the same source.
	describe('<<- heredocs', () => {
		/** The value of a `<<-EOT` heredoc of these lines, closed by a marker line indented by `markerIndent`. */
		const flush = async (lines: string[], markerIndent = '  '): Promise<unknown> => {
			const content = `inputs = {\n  x = <<-EOT\n${lines.join('\n')}\n${markerIndent}EOT\n}\n`;
			const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
			assert.equal(result.error, undefined, content);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};

		it('strips the smallest indent its lines share, keeping their relative indentation', async () => {
			assert.equal(await flush(['      deeper', '    base', '        deepest']), '  deeper\nbase\n    deepest\n');
			assert.equal(await flush(['a', '    b']), 'a\n    b\n');
		});

		it('takes no account of the closing marker\'s indent', async () => {
			assert.equal(await flush(['  a', '    b'], '        '), 'a\n  b\n');
			assert.equal(await flush(['      a', '      b'], ''), 'a\nb\n');
		});

		it('counts each space character as one, a tab and a no-break space as much as a space', async () => {
			assert.equal(await flush(['\t\tx', '    y', '\t  z']), 'x\n  y\n z\n');
			assert.equal(await flush(['\u00a0\u00a0x', '   y']), 'x\n y\n');
		});

		it('leaves blank lines out of the indent and as they are written', async () => {
			assert.equal(await flush(['      a', '', '  ', '          ', '      b']), 'a\n\n  \n          \nb\n');
		});

		it('counts the indent before an interpolation, and none for one that starts its line', async () => {
			assert.equal(await flush(['    a', '    ${"word"}', '    b']), 'a\nword\nb\n');
			assert.equal(await flush(['    a', '${"word"}', '    b']), '    a\nword\n    b\n');
			assert.equal(await flush(['    a', '%{ if true }yes%{ endif }', '    b']), '    a\nyes\n    b\n');
		});

		it('never counts the space an interpolation renders', async () => {
			assert.equal(await flush(['    a', '    ${"      word"}']), 'a\n      word\n');
		});

		it('reads an escaped sequence at the start of a line as text', async () => {
			assert.equal(await flush(['    a', '      $${b}']), 'a\n  ${b}\n');
			assert.equal(await flush(['    a', '$${b}']), '    a\n${b}\n');
		});

		it('strips after the strip markers, so a line a marker joins to the one before keeps its indent', async () => {
			assert.equal(await flush([
				'    %{ for x in ["a", "b"] ~}',
				'      - ${x}',
				'    %{ endfor ~}',
				'    done'
			]), '      - a\n      - b\n    done\n');
			assert.equal(await flush(['      a', '      ${~ "word"}', '    b']), '      a\nword\n    b\n');
			assert.equal(await flush(['      a', '      ${"word" ~}', '    b']), 'a\nword    b\n');
		});
	});

	describe('substr', () => {
		const substr = async (args: string): Promise<unknown> => {
			const result = await evaluator.evaluateUnit(configPath, `inputs = {\n  x = substr(${args})\n}\n`, process.cwd());
			assert.equal(result.error, undefined);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};

		it('takes a length from an offset', async () => {
			assert.equal(await substr('"hello world", 1, 4'), 'ello');
			assert.equal(await substr('"hello", 0, 10'), 'hello');
			assert.equal(await substr('"hello", 1, 0'), '');
		});

		it('counts a negative offset from the end, and starts at the beginning when it reaches past it', async () => {
			assert.equal(await substr('"hello world", -5, 3'), 'wor');
			assert.equal(await substr('"live/gcp/app", -63, -1'), 'live/gcp/app');
			assert.equal(await substr('"hello", -10, 2'), 'he');
		});

		it('takes the rest of the string for a negative length', async () => {
			assert.equal(await substr('"hello world", 6, -1'), 'world');
			assert.equal(await substr('"hello", -3, -5'), 'llo');
		});

		it('takes the rest of the string for a length of 0 after a negative offset', async () => {
			assert.equal(await substr('"hello", -3, 0'), 'llo');
		});

		it('returns an empty string for an offset at or past the end', async () => {
			assert.equal(await substr('"hello", 5, 2'), '');
			assert.equal(await substr('"hello", 9, -1'), '');
			assert.equal(await substr('"", 0, 1'), '');
		});

		it('rejects an offset or a length that is not a whole number', async () => {
			for (const args of ['"hello", 1.5, 2', '"hello", 1, 2.5', '"hello", -0.5, -1']) {
				const result = await evaluator.evaluateUnit(configPath, `inputs = {\n  x = substr(${args})\n}\n`, process.cwd());
				assert.equal(result.valid, false, args);
				assert.equal(result.error, 'value must be a whole number, between -9223372036854775808 and 9223372036854775807', args);
			}
		});

		it('counts grapheme clusters', async () => {
			assert.equal(await substr('"\u{1F1EC}\u{1F1E7}e\u0301x", 1, 1'), '\u00e9');
			assert.equal(await substr('"a👍🏽b", -2, 1'), '👍🏽');
		});
	});

	// Every expected value and message below is what Terragrunt 1.2.2 renders for the same expression.
	describe('strings and functions as Terragrunt evaluates them', () => {
		const render = async (expression: string): Promise<unknown> => {
			const result = await evaluator.evaluateUnit(configPath, `inputs = {\n  x = ${expression}\n}\n`, process.cwd());
			assert.equal(result.error, undefined, expression);
			return (plainValue(result.inputs!) as Record<string, unknown>).x;
		};
		const failure = async (expression: string): Promise<string> => {
			const result = await evaluator.evaluateUnit(configPath, `inputs = {\n  x = ${expression}\n}\n`, process.cwd());
			assert.equal(result.valid, false, expression);
			return result.error ?? '';
		};

		it('reads \\u and \\U escapes in a quoted string as the characters they name', async () => {
			assert.equal(await render('"caf\\u00e9"'), 'caf\u00e9');
			assert.equal(await render('"\\U0001F600"'), '\u{1F600}');
			assert.equal(await render('"%%{x}\\u00e9"'), '%{x}\u00e9');
			assert.equal(await render('"a\\\\u00e9"'), 'a\\u00e9');
			assert.deepEqual(await render('{ "caf\\u00e9" = 1 }'), { 'caf\u00e9': 1 });
		});

		it('normalizes every string to NFC, as written and as functions make it', async () => {
			assert.equal(await render('"e\\u0301"'), '\u00e9');
			assert.equal(await render('"e\u0301"'), '\u00e9');
			assert.equal(await render('"x${"e\\u0301"}"'), 'x\u00e9');
			assert.equal(await render('"\\u212b"'), '\u00c5');
			assert.equal(await render('"\\u00e9" == "e\\u0301"'), true);
			assert.equal(await render('length("e\\u0301")'), 1);
			assert.equal(await render('join("", ["e", "\\u0301"])'), '\u00e9');
			assert.equal(await render('upper("e\\u0301")'), '\u00c9');
			assert.equal(await render('format("%s%s", "e", "\\u0301")'), '\u00e9');
			assert.deepEqual(await render('{ "e\\u0301" = 1, "\\u00e9" = 2 }'), { '\u00e9': 2 });
			assert.deepEqual(await render('{ e\u0301 = 1 }'), { '\u00e9': 1 });
			assert.deepEqual(await render('keys({ "b" = 1, "e\\u0301" = 2, "a" = 3 })'), ['a', 'b', '\u00e9']);
		});

		it('merges past a null argument, and names the type of any argument that is not an object', async () => {
			assert.deepEqual(await render('merge(null)'), {});
			assert.deepEqual(await render('merge(null, null)'), {});
			assert.deepEqual(await render('merge(null, { a = 1 })'), { a: 1 });
			assert.deepEqual(await render('merge({ a = 1 }, null, { b = 2 })'), { a: 1, b: 2 });
			assert.equal(await failure('merge({ a = 1 }, "x")'), 'arguments must be maps or objects, got "string"');
		});

		it('refuses concat, max, min, setunion and setintersection with no argument', async () => {
			assert.equal(await failure('concat()'), 'at least one argument is required');
			assert.equal(await failure('max()'), 'must pass at least one number');
			assert.equal(await failure('min()'), 'must pass at least one number');
			for (const name of ['setunion', 'setintersection']) {
				assert.equal(await failure(`${name}()`), `Not enough function arguments; Function "${name}" expects at least 1 argument(s). Missing value for "first_set".`);
			}
			assert.deepEqual(await render('concat(["a"])'), ['a']);
			assert.equal(await render('max(1)'), 1);
			assert.equal(await render('min(1)'), 1);
			assert.deepEqual(await render('setunion(["a"])'), ['a']);
			assert.deepEqual(await render('setintersection(["a"])'), ['a']);
		});

		it('formats each verb as go-cty does', async () => {
			const cases: Array<[string, string]> = [
				['"%d|%5d|%-5d|%05d|%+d|% d|%.3d|%x|%X|%#x|%o|%#o|%b|%#b", 42, 42, 42, 42, 42, 42, 42, 255, 255, 255, 8, 8, 5, 5', '42|   42|42   |00042|+42| 42|042|ff|FF|0xff|10|010|101|0b101'],
				['"%d|%x|%5.3d", -42, -255, -7', '-42|-ff| -007'],
				['"%e|%E|%.2e|%10.3e|%-12e|%+e|%012.2e", 1234.5678, 1234.5678, 1234.5678, 1234.5678, 1234.5678, 1234.5678, -1234.5678', '1.234568e+03|1.234568E+03|1.23e+03| 1.235e+03|1.234568e+03|+1.234568e+03|-0001.23e+03'],
				['"%f|%.2f|%8.3f|%-8.1f|%+.1f|% .1f|%08.2f|%.0f|%.0f|%.0f", 3.14159, 3.14159, 3.14159, 3.14159, 3.14159, 3.14159, -3.14159, 2.5, 3.5, 0.5', '3.141590|3.14|   3.142|3.1     |+3.1| 3.1|-0003.14|2|4|0'],
				['"%.2f|%.2f|%.1f|%.1f|%.0f", 1.005, 2.675, 0.25, 0.35, 0.6', '1.00|2.67|0.2|0.3|1'],
				['"%g|%g|%g|%g|%g|%.3g|%G|%g", 1234567, 1000000, 100000, 0.0001, 0.00001, 3.14159, 0.00001, 1.5', '1.234567e+06|1e+06|100000|0.0001|1e-05|3.14|1E-05|1.5'],
				['"%v|%v|%v|%v|%v|%v|%v", 1234567, 1000000, 0.00001, 1.5, "str", true, null', '1.234567e+06|1e+06|1e-05|1.5|str|true|null'],
				['"%v|%#v|%#v|%v|%v", [1, "a"], "str", 1.5, { a = 1 }, ["x"]', '[1,"a"]|"str"|1.5|{"a":1}|["x"]'],
				['"%q|%10q|%-6q|%s|%5s|%-5s|%05s|%.2s|%.0s|%s|%s", "a\\"b", "hi", "hi", 1.5, "ab", "ab", "ab", "hello", "hello", true, 100000000000000000000', '"a\\"b"|      "hi"|"hi"  |1.5|   ab|ab   |000ab|he|hello|true|100000000000000000000'],
				['"%t|%t|%t|%t", true, false, "true", "0"', 'true|false|true|false'],
				['"%d", "12"', '12'],
				['"%5.1f|%-8.3s|%8s", 3.14159, "abcdef", "\u{1F600}ab"', '  3.1|abc     |     \u{1F600}ab'],
				['"%.3s|%3s", "e\\u0301e\\u0301e\\u0301x", "e\\u0301"', '\u00e9\u00e9\u00e9|  \u00e9'],
				['"%.f|%.e|%.g", 2.5, 2.5, 25', '2|2e+00|2e+01'],
				['"%f", 1e21', '1000000000000000000000.000000'],
				['"%v|%g|%e", 1e21, 1e21, 0', '1e+21|1e+21|0.000000e+00'],
				['"%v|%f|%d", 0.1, 0.1, 0', '0.1|0.100000|0'],
				['"%#e|%#g|%#f", 1.5, 1.5, 1.5', '1.500000e+00|1.5|1.500000'],
				['"%+s|%+v|% s", "a", "b", "c"', 'a|b|c'],
				['"%3t|%-3v|%03v|%03s", true, true, 7, "a"', 'true|true|007|00a']
			];
			for (const [args, expected] of cases) assert.equal(await render(`format(${args})`), expected, args);
		});

		it('refuses what go-cty cannot format, with its messages', async () => {
			const cases: Array<[string, string]> = [
				['"%d", 1.5', 'unsupported value for "%d" at 0: an integer is required'],
				['"%t", "yes"', 'unsupported value for "%t" at 0: a bool is required'],
				['"%t", 1', 'unsupported value for "%t" at 0: bool required, but have number'],
				['"%d", "abc"', 'unsupported value for "%d" at 0: a number is required'],
				['"%d", true', 'unsupported value for "%d" at 0: number required, but have bool'],
				['"%s", [1]', 'unsupported value for "%s" at 0: string required, but have tuple'],
				['"%s", null', 'unsupported value for "%s" at 0: null value cannot be formatted'],
				['"%d", null', 'unsupported value for "%d" at 0: null value cannot be formatted'],
				['"%y", 1', 'unsupported format verb \'y\' in "%y" at offset 0'],
				['"%!", 1', 'unrecognized format character \'!\' at offset 1'],
				['"abc %", 1', 'invalid format string starting at offset 5'],
				['"%[2]s %s %[1]s", "a", "b"', 'not enough arguments for "%s" at 6: need index 3 but have 2 total'],
				['"%d %d", 1', 'not enough arguments for "%d" at 3: need index 2 but have 1 total'],
				['"%d", 1, 2', 'too many arguments; only 1 used by format string'],
				['"no verbs", 1', 'too many arguments; no verbs in format string']
			];
			for (const [args, message] of cases) assert.equal(await failure(`format(${args})`), message, args);
		});

		it('formats a list from list arguments of one length, using any other argument in every string', async () => {
			assert.deepEqual(await render('formatlist("%s-%s", ["a", "b"], "x")'), ['a-x', 'b-x']);
			assert.deepEqual(await render('formatlist("%s-%s", "x", ["a", "b"])'), ['x-a', 'x-b']);
			assert.deepEqual(await render('formatlist("%s-%s", ["a", "b"], ["c", "d"])'), ['a-c', 'b-d']);
			assert.deepEqual(await render('formatlist("%s", "x")'), ['x']);
			assert.deepEqual(await render('formatlist("%s %s", "x", "y")'), ['x y']);
			assert.deepEqual(await render('formatlist("%s", [])'), []);
			assert.deepEqual(await render('formatlist("%s %s", [], "x")'), []);
			assert.deepEqual(await render('formatlist("%v", null)'), ['null']);
			assert.deepEqual(await render('formatlist("%v", { a = 1 })'), ['{"a":1}']);
			assert.deepEqual(await render('formatlist("plain")'), ['plain']);
			const failures: Array<[string, string]> = [
				['"%s-%s", ["a", "b"], ["c"]', 'argument 2 has length 1, which is inconsistent with argument 1 of length 2'],
				['"%s-%s", ["a"], ["c", "d"]', 'argument 2 has length 2, which is inconsistent with argument 1 of length 1'],
				['"%s %s", [], ["a"]', 'argument 2 has length 1, which is inconsistent with argument 1 of length 0'],
				['"%s", null', 'error on format iteration 0: unsupported value for "%s" at 0: null value cannot be formatted'],
				['"%d", [1, 1.5]', 'error on format iteration 1: unsupported value for "%d" at 0: an integer is required'],
				['"%s", [["a"]]', 'error on format iteration 0: unsupported value for "%s" at 0: string required, but have tuple'],
				['"%s=%s", { a = 1 }, ["x"]', 'error on format iteration 0: unsupported value for "%s" at 0: string required, but have object']
			];
			for (const [args, message] of failures) assert.equal(await failure(`formatlist(${args})`), message, args);
		});

		it('refuses an index or a size that is not a whole number', async () => {
			const whole = 'value must be a whole number, between -9223372036854775808 and 9223372036854775807';
			assert.equal(await failure('slice(["a", "b", "c"], 0.5, 2)'), `invalid start index: ${whole}`);
			assert.equal(await failure('slice(["a", "b", "c"], 0, 1.5)'), `invalid end index: ${whole}`);
			assert.equal(await failure('chunklist(["a", "b"], 1.5)'), `invalid size: ${whole}`);
			assert.equal(await failure('element(["a", "b"], 1.5)'), `invalid index: ${whole}`);
			assert.deepEqual(await render('slice(["a", "b", "c"], 1, 3)'), ['b', 'c']);
			assert.deepEqual(await render('chunklist(["a", "b", "c"], 2)'), [['a', 'b'], ['c']]);
			assert.equal(await render('element(["a", "b"], 3)'), 'b');
			assert.equal(await render('element(["a", "b"], -1)'), 'b');
		});
	});

	it('places a missing local and a missing attribute where they are written, and reports both', async () => {
		const content = [
			'locals {',
			'  a = { b = 1 }',
			'}',
			'inputs = {',
			'  x = local.missing',
			'  y = local.a.z',
			'}'
		].join('\n');

		const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.equal(result.valid, false);
		assert.equal(result.error, 'Undefined local value "missing"');
		assert.equal(result.unresolved, undefined);
		assert.deepEqual(result.problems, [
			{
				message: 'Undefined local value "missing"',
				filePath: configPath,
				range: { start: { line: 4, character: 6 }, end: { line: 4, character: 19 } }
			},
			{
				message: 'Missing attribute "z" on "a"',
				filePath: configPath,
				range: { start: { line: 5, character: 6 }, end: { line: 5, character: 15 } }
			}
		]);
	});

	it('reports a broken local once, where it is written, however many inputs read it', async () => {
		const content = [
			'locals {',
			'  a = { b = 1 }',
			'  c = local.a.z',
			'}',
			'inputs = {',
			'  x = local.c',
			'  y = local.c',
			'}'
		].join('\n');

		const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.deepEqual(result.problems, [
			{
				message: 'Missing attribute "z" on "a"',
				filePath: configPath,
				range: { start: { line: 2, character: 6 }, end: { line: 2, character: 15 } }
			}
		]);
	});

	it('places a fault where the expression at fault is written, not where a reference reads it', async () => {
		const content = [
			'locals {',
			'  a = nosuchfn()',
			'  b = 1 + "x"',
			'}',
			'inputs = {',
			'  x = local.a',
			'  y = "${local.b}"',
			'}'
		].join('\n');

		const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.deepEqual(result.problems, [
			{
				message: 'Unknown function "nosuchfn"',
				filePath: configPath,
				range: { start: { line: 1, character: 6 }, end: { line: 1, character: 16 } }
			},
			{
				message: 'Unsuitable value for right operand: a number is required.',
				filePath: configPath,
				range: { start: { line: 2, character: 6 }, end: { line: 2, character: 13 } }
			}
		]);
	});

	it('places a fault inherited through an include in the included configuration', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-located-')));
		try {
			const rootPath = path.join(root, 'root.hcl');
			await fs.writeFile(rootPath, 'inputs = {\n  x = local.missing\n}\n');
			const unitDir = path.join(root, 'app');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const content = 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n';
			await fs.writeFile(unitPath, content);

			const result = await evaluator.evaluateUnit(unitPath, content, unitDir);
			assert.deepEqual(result.problems, [
				{
					message: 'Undefined local value "missing"',
					filePath: rootPath,
					range: { start: { line: 1, character: 6 }, end: { line: 1, character: 19 } }
				}
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	describe('include paths', () => {
		const withUnit = async (files: Record<string, string>, check: (root: string, result: Awaited<ReturnType<ConfigEvaluator['evaluateUnit']>>) => void) => {
			const os = await import('node:os');
			const fs = await import('node:fs/promises');
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-include-paths-')));
			try {
				await fs.mkdir(path.join(root, '.git'));
				for (const [file, content] of Object.entries(files)) {
					await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
					await fs.writeFile(path.join(root, file), content);
				}
				const unitPath = path.join(root, 'live', 'app', 'terragrunt.hcl');
				check(root, await evaluator.evaluateUnit(unitPath, files['live/app/terragrunt.hcl'], path.dirname(unitPath)));
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		};

		it('answers in an included configuration\'s locals with that configuration\'s directory', async () => {
			await withUnit({
				'root.hcl': [
					'locals {',
					'  relative = path_relative_to_include()',
					'  from     = path_relative_from_include()',
					'  parent   = get_parent_terragrunt_dir()',
					'}',
					'inputs = {',
					'  relative = local.relative',
					'  from     = local.from',
					'  parent   = local.parent',
					'  key      = "${path_relative_to_include()}/terraform.tfstate"',
					'}'
				].join('\n'),
				'live/app/terragrunt.hcl': 'include "root" {\n  path   = find_in_parent_folders("root.hcl")\n  expose = true\n}\ninputs = { exposed = include.root.locals.relative }\n'
			}, (root, result) => {
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), {
					relative: 'live/app',
					from: '../..',
					parent: root,
					key: 'live/app/terraform.tfstate',
					exposed: 'live/app'
				});
			});
		});

		it('takes an expose HCL converts to a bool, null as false, and refuses any other, as Terragrunt does', async () => {
			const unit = (expose: string) => ({
				'root.hcl': 'locals {\n  a = 1\n}\n',
				'live/app/terragrunt.hcl': `include "root" {\n  path   = find_in_parent_folders("root.hcl")\n  expose = ${expose}\n}\n`
			});
			for (const expose of ['"1"', 'null', '"false"']) {
				await withUnit(unit(expose), (_root, result) => assert.equal(result.valid, true, `${expose}: ${result.error}`));
			}
			for (const [expose, message, start, end] of [
				['"yes"', 'Unsuitable value: a bool is required', 11, 16],
				['1', 'Unsuitable value: bool required, but have number', 11, 12]
			] as const) {
				await withUnit(unit(expose), (_root, result) => {
					assert.deepEqual(result.problems?.map(problem => [problem.message, problem.range.start.line, problem.range.start.character, problem.range.end.character]),
						[[message, 2, start, end]], expose);
				});
			}
		});

		it('answers in the unit with the directory of the configuration it includes', async () => {
			await withUnit({
				'root.hcl': 'inputs = {}\n',
				'live/app/terragrunt.hcl': 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\ninputs = { relative = path_relative_to_include(), parent = get_parent_terragrunt_dir() }\n'
			}, (root, result) => {
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), { relative: 'live/app', parent: root });
			});
		});

		it('answers with the unit\'s own directory when it includes nothing, or a configuration beside it', async () => {
			const inputs = 'inputs = { relative = path_relative_to_include(), from = path_relative_from_include(), parent = get_parent_terragrunt_dir() }\n';
			await withUnit({ 'live/app/terragrunt.hcl': inputs }, (root, result) => {
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), { relative: '.', from: '.', parent: path.join(root, 'live', 'app') });
			});
			await withUnit({
				'live/app/common.hcl': inputs,
				'live/app/terragrunt.hcl': 'include "common" {\n  path = "common.hcl"\n}\n'
			}, (root, result) => {
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), { relative: '.', from: '.', parent: path.join(root, 'live', 'app') });
			});
		});

		it('answers about the include a unit with several names, and in each included configuration about that configuration', async () => {
			const answers = (prefix: string) => `${prefix}_relative = path_relative_to_include("root")\n  ${prefix}_from = path_relative_from_include("root")\n  ${prefix}_parent = get_parent_terragrunt_dir("root")\n`;
			await withUnit({
				'root.hcl': `inputs = {\n  ${answers('root')}}\n`,
				'live/env.hcl': `inputs = {\n  ${answers('env')}}\n`,
				'live/app/terragrunt.hcl': [
					'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}',
					'include "env" {\n  path = find_in_parent_folders("env.hcl")\n}',
					'inputs = {',
					'  unit_env_relative = path_relative_to_include("env")',
					'  unit_env_from     = path_relative_from_include("env")',
					'  unit_env_parent   = get_parent_terragrunt_dir("env")',
					'  unit_root         = path_relative_to_include("root")',
					'}'
				].join('\n')
			}, (root, result) => {
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), {
					root_relative: 'live/app',
					root_from: '../..',
					root_parent: root,
					env_relative: 'app',
					env_from: '..',
					env_parent: path.join(root, 'live'),
					unit_env_relative: 'app',
					unit_env_from: '..',
					unit_env_parent: path.join(root, 'live'),
					unit_root: 'live/app'
				});
			});
		});

		it('needs the label of an include the unit has when it has several, and takes its only include whatever the label', async () => {
			const twoIncludes = (call: string) => ({
				'root.hcl': 'inputs = {}\n',
				'live/env.hcl': 'inputs = {}\n',
				'live/app/terragrunt.hcl': `include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\ninclude "env" {\n  path = find_in_parent_folders("env.hcl")\n}\ninputs = { value = ${call} }\n`
			});
			await withUnit(twoIncludes('path_relative_to_include()'), (_root, result) => {
				assert.equal(result.valid, false);
				assert.match(result.error ?? '', /path_relative_to_include needs the label of one of the configuration's 2 include blocks/);
			});
			await withUnit(twoIncludes('get_parent_terragrunt_dir("region")'), (_root, result) => {
				assert.equal(result.valid, false);
				assert.match(result.error ?? '', /There is no include block in the current config with the label 'region'/);
			});
			await withUnit({
				'root.hcl': 'inputs = {}\n',
				'live/app/terragrunt.hcl': 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\ninputs = { value = path_relative_to_include("region") }\n'
			}, (_root, result) => {
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), { value: 'live/app' });
			});
		});
	});

	it('reports a broken local nothing reads, in the unit and in a configuration it includes, before a broken input', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-located-')));
		try {
			const rootPath = path.join(root, 'root.hcl');
			await fs.writeFile(rootPath, 'locals {\n  unread = local.gone\n}\n');
			const unitDir = path.join(root, 'app');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const content = [
				'include "root" {',
				'  path = find_in_parent_folders("root.hcl")',
				'}',
				'locals {',
				'  unread = local.missing',
				'}',
				'inputs = {',
				'  x = local.absent',
				'}'
			].join('\n');
			await fs.writeFile(unitPath, content);

			const result = await evaluator.evaluateUnit(unitPath, content, unitDir);
			assert.deepEqual(result.problems, [
				{
					message: 'Undefined local value "missing"',
					filePath: unitPath,
					range: { start: { line: 4, character: 11 }, end: { line: 4, character: 24 } }
				},
				{
					message: 'Undefined local value "gone"',
					filePath: rootPath,
					range: { start: { line: 1, character: 11 }, end: { line: 1, character: 21 } }
				},
				{
					message: 'Undefined local value "absent"',
					filePath: unitPath,
					range: { start: { line: 7, character: 6 }, end: { line: 7, character: 18 } }
				}
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
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

	it('anchors parent-file resolution at the project root marker when evaluation starts in a child directory', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-project-root-')));
		try {
			await fs.mkdir(path.join(projectRoot, '.git'));
			await fs.writeFile(path.join(projectRoot, 'root.hcl'), 'locals { marker = "root" }\n');
			const unitDir = path.join(projectRoot, 'environments', 'prod', 'app');
			await fs.mkdir(unitDir, { recursive: true });
			const configPath = path.join(unitDir, 'terragrunt.hcl');
			const content = 'inputs = { root = find_in_parent_folders("root.hcl") }';
			await fs.writeFile(configPath, content);

			const result = await evaluator.evaluateUnit(configPath, content, unitDir);
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(result.inputs ? plainValue(result.inputs) : undefined, {
				root: path.join(projectRoot, 'root.hcl')
			});
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true });
		}
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
		assert.deepEqual(enabled.inputs ? plainValue(enabled.inputs) : undefined, {
			merged: {
				service: { retries: 3, mode: 'safe' },
				values: [1, 2]
			}
		});
	});

	it('matches the accepted gzip, bcrypt, timestamp, and RSA function contracts', async () => {
		const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
		const ciphertext = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from('secret')).toString('base64');
		const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		const content = `inputs = {
  compressed = base64gzip("hello")
  password_hash = bcrypt("hello")
  generated_at = timestamp()
  decrypted = rsadecrypt(${JSON.stringify(ciphertext)}, ${JSON.stringify(privatePem)})
}`;
		const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.equal(result.valid, true);
		const plain = result.inputs ? plainValue(result.inputs) as Record<string, unknown> : {};
		assert.equal(typeof plain.compressed, 'string');
		assert.equal(gunzipSync(Buffer.from(String(plain.compressed), 'base64')).toString(), 'hello');
		assert.match(String(plain.password_hash), /^\$2[aby]\$10\$/u);
		assert.match(String(plain.generated_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
		assert.equal(plain.decrypted, 'secret');
	});

	it('searches PARENT folders, so a unit including terragrunt.hcl does not include itself', async () => {
		// The near-universal call is `find_in_parent_folders("terragrunt.hcl")`
		// written in a unit's own terragrunt.hcl. Searching from the unit's own
		// directory matched that very file: the unit included itself and
		// evaluation recursed until the process was killed by hand, at full CPU,
		// having printed nothing. A whole real workspace was unusable.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-parent-'));
		try {
			// A repository, because that is what bounds the upward search when a
			// workspace has no `root.hcl` -- the case for every configuration
			// written before that convention.
			await fs.mkdir(path.join(root, '.git'));
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), 'locals {\n  marker = "the-parent"\n}\n');
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const unit = [
				'include "root" {',
				'  path = find_in_parent_folders("terragrunt.hcl")',
				'}',
				'',
				'inputs = {',
				'  here = get_terragrunt_dir()',
				'}'
			].join('\n');
			await fs.writeFile(unitPath, unit);

			// Evaluating AT ALL is the claim. Before the fix this never
			// returned: the include resolved to `unitPath` itself and the
			// evaluator recursed forever. A cycle error would be a failure too
			// -- the include must land on the parent, not on this file.
			const result = await evaluator.evaluateUnit(unitPath, unit, unitDir);
			assert.equal(result.valid, true, result.error);
			assert.doesNotMatch(result.error ?? '', /Include cycle/u, 'the unit must not include itself');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('evaluates one unit several times at once without mistaking the overlap for an include cycle', async () => {
		// A language server evaluates a file for its diagnostics, its underlines and its hovers, and those overlap.
		const content = 'locals {\n  a = upper("x")\n}\n\ninputs = {\n  a = local.a\n}';
		const results = await Promise.all([0, 1, 2].map(() => evaluator.evaluateUnit(configPath, content, process.cwd())));
		for (const result of results) {
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(plainValue(result.inputs!), { a: 'X' });
		}
	});

	it('reports an include cycle instead of evaluating until it is killed', async () => {
		// The guard that stops any OTHER way a configuration can refer back to
		// itself. Named rather than counted: "a includes b includes a" is a
		// sentence somebody can act on, where "maximum depth exceeded" sends
		// them looking for a depth to raise.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-cycle-'));
		try {
			const a = path.join(root, 'a.hcl');
			const b = path.join(root, 'b.hcl');
			await fs.writeFile(a, 'include "b" {\n  path = "' + b.replace(/\\/gu, '/') + '"\n}\n');
			await fs.writeFile(b, 'include "a" {\n  path = "' + a.replace(/\\/gu, '/') + '"\n}\n');

			const content = await fs.readFile(a, 'utf8');
			const result = await evaluator.evaluateUnit(a, content, root);
			assert.equal(result.valid, false, 'a cycle is not a valid configuration');
			assert.match(result.error ?? '', /Include cycle/u);
			assert.match(result.error ?? '', /a\.hcl/u, 'and the message names the files that form it');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('renders generate blocks inherited through an include', async () => {
		// The blocks live in a root configuration and units include it, which
		// is how essentially every workspace is arranged. Reading only a
		// unit's OWN blocks rendered nothing, so the generated .tf files were
		// never written and OpenTofu ran against a directory whose committed
		// main.tf referenced locals that no file defined.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-generate-'));
		try {
			await fs.mkdir(path.join(root, '.git'));
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), [
				'locals {',
				'  region = "eu-west-1"',
				'}',
				'',
				'generate "provider" {',
				'  path      = "provider.tf"',
				'  if_exists = "overwrite_terragrunt"',
				'  contents  = "provider \\"aws\\" { region = \\"${local.region}\\" }"',
				'}'
			].join('\n'));
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const unit = [
				'include "root" {',
				'  path = find_in_parent_folders("terragrunt.hcl")',
				'}'
			].join('\n');
			await fs.writeFile(unitPath, unit);

			const rendered = plainValue(
				await evaluator.evaluateRenderedConfig(unitPath, unit, unitDir)
			) as Record<string, unknown>;
			const generate = rendered.generate as Record<string, Record<string, unknown>>;
			assert.ok(generate.provider, 'the included block is part of what the unit renders');
			assert.equal(generate.provider.path, 'provider.tf');
			assert.equal(
				generate.provider.contents,
				'provider "aws" { region = "eu-west-1" }',
				'and its contents interpolate the locals of the file that DECLARED it'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('reads outside the workspace only for a directory that was allowed', async () => {
		// The workspace boundary is this tool's own, from its life as a
		// language server; Terragrunt has none. A deployment plan kept in a
		// sibling checkout is a normal arrangement and was refused outright,
		// so the boundary stays and `--allow-path` names the exceptions.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-allow-')));
		try {
			const workspace = path.join(base, 'workspace');
			const outside = path.join(base, 'outside');
			await fs.mkdir(workspace);
			await fs.mkdir(path.join(workspace, '.git'));
			await fs.mkdir(outside);
			await fs.writeFile(path.join(outside, 'plan.json'), '{"name":"from-outside"}');
			const configPath = path.join(workspace, 'terragrunt.hcl');
			const content = `inputs = { name = jsondecode(file(${JSON.stringify(path.join(outside, 'plan.json'))})).name }`;
			await fs.writeFile(configPath, content);

			const blocked = await evaluator.evaluateUnit(configPath, content, workspace);
			assert.equal(blocked.valid, false, 'outside the workspace is refused by default');
			assert.match(blocked.error ?? '', /is blocked/u);
			assert.match(blocked.error ?? '', /--allow-path/u, 'and the message says how to permit it');

			const permitting = new ConfigEvaluator({
				environmentVariables: {},
				terraformCommand: '',
				terraformCliArgs: [],
				workspaceTrusted: true,
				allowedPaths: [outside]
			});
			const allowed = await permitting.evaluateUnit(configPath, content, workspace);
			assert.equal(allowed.valid, true, allowed.error);
			const plain = allowed.inputs ? plainValue(allowed.inputs) as Record<string, unknown> : {};
			assert.equal(plain.name, 'from-outside');

			// Permitting one directory does not permit its neighbours.
			const elsewhere = path.join(base, 'elsewhere');
			await fs.mkdir(elsewhere);
			await fs.writeFile(path.join(elsewhere, 'plan.json'), '{"name":"not-allowed"}');
			const otherContent = `inputs = { name = jsondecode(file(${JSON.stringify(path.join(elsewhere, 'plan.json'))})).name }`;
			await fs.writeFile(configPath, otherContent);
			const stillBlocked = await permitting.evaluateUnit(configPath, otherContent, workspace);
			assert.equal(stillBlocked.valid, false, 'an allowed path is one directory, not a general opening');
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	// What Terragrunt v1.2.2 renders for the same heredocs.
	it('keeps the line break that ends a heredoc\'s last line', async () => {
		const content = [
			'inputs = {',
			'  plain = <<EOT',
			'a',
			'b',
			'EOT',
			'  flush = <<-EOT',
			'    a',
			'    b',
			'    EOT',
			'  empty = <<EOT',
			'EOT',
			'}'
		].join('\n');
		const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
		assert.equal(result.error, undefined);
		assert.deepEqual(plainValue(result.inputs!), { plain: 'a\nb\n', flush: 'a\nb\n', empty: '' });
	});

	it('reduces the template escapes the way Terragrunt does', async () => {
		// `$${` and `%%{` each stand for the sequence without the doubling, and
		// a generate block is where it shows: the produced .tf file is meant to
		// contain a real `${...}` for OpenTofu to evaluate later.
		//
		// `$${` was returned as itself, so `file_id = "$${profile.name}.img"`
		// reached the Proxmox provider as that literal string. `%%{` was not
		// matched at all, fell through to the single-character alternative, and
		// everything after the `%` was re-scanned as a directive -- `a = %{if x}`
		// came out as `a = %`, losing the rest of the line silently.
		//
		// Every expectation here was taken from terragrunt 0.67.1 rendering the
		// same input, not from reading the specification.
		const cases: Array<[string, string]> = [
			['a = $${foo.bar}', 'a = ${foo.bar}'],
			['a = %%{if x}', 'a = %{if x}'],
			['a = $${a}$${b}', 'a = ${a}${b}'],
			['a = $$${x}', 'a = $${x}'],
			['a = $${outer{inner}}', 'a = ${outer{inner}}'],
			// Not escapes: a doubled sigil with no brace after it is literal.
			['a = $$foo', 'a = $$foo'],
			['a = %foo', 'a = %foo'],
			['a = $$', 'a = $$'],
			['a = %%', 'a = %%']
		];
		for (const [authored, expected] of cases) {
			// Written as HCL source verbatim. Passing it through
			// JSON.stringify would collapse the doubled sigil before the
			// grammar ever saw it, and the test would then pass against a
			// parser that does not handle the escape at all.
			const content = `inputs = { value = "${authored}" }`;
			const result = await evaluator.evaluateUnit(configPath, content, process.cwd());
			assert.equal(result.valid, true, `${authored}: ${result.error}`);
			const plain = result.inputs ? plainValue(result.inputs) as Record<string, unknown> : {};
			assert.equal(plain.value, expected, `authored ${authored}`);
		}

		// A heredoc reaches the escapes through a different rule than a quoted
		// string does, and a generate block's contents are almost always a
		// heredoc -- so the path that actually carried the bug is this one.
		const heredoc = [
			'inputs = {',
			'  value = <<-EOT',
			'    a = $${foo.bar}',
			'    b = %%{if y}',
			'  EOT',
			'}'
		].join('\n');
		const result = await evaluator.evaluateUnit(configPath, heredoc, process.cwd());
		assert.equal(result.valid, true, result.error);
		const plain = result.inputs ? plainValue(result.inputs) as Record<string, unknown> : {};
		assert.match(String(plain.value), /a = \$\{foo\.bar\}/u, 'the interpolation escape is reduced in a heredoc');
		assert.match(String(plain.value), /b = %\{if y\}/u, 'and so is the directive escape');
	});

	it('resolves file() against the declaring file, not the including unit', async () => {
		// Two directories that answer different questions, and terragrunt keeps
		// them apart: `file("x.yml")` written in a root config resolves next to
		// THAT file, while `get_terragrunt_dir()` reports the unit being
		// rendered. Rendering an inherited generate block with both pointed at
		// the unit made the same relative path name a different file, silently
		// -- the kind of divergence that makes this unusable as a drop-in.
		//
		// Checked against terragrunt 0.67.1, which reads the root-relative file
		// and still reports the unit's own directory.
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-filedir-')));
		try {
			await fs.mkdir(path.join(root, '.git'));
			await fs.writeFile(path.join(root, 'beside.yml'), 'value: "FROM-ROOT-DIR"\n');
			await fs.writeFile(path.join(root, 'terragrunt.hcl'), [
				'generate "g" {',
				'  path      = "out.tf"',
				'  if_exists = "overwrite_terragrunt"',
				'  contents  = "${yamldecode(file("beside.yml")).value}|${basename(get_terragrunt_dir())}"',
				'}'
			].join('\n'));
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			// A DIFFERENT file of the same name beside the unit: if resolution
			// used the unit's directory, this is what would be read.
			await fs.writeFile(path.join(unitDir, 'beside.yml'), 'value: "FROM-UNIT-DIR"\n');
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			const unit = 'include "root" {\n  path = find_in_parent_folders("terragrunt.hcl")\n}\n';
			await fs.writeFile(unitPath, unit);

			const rendered = plainValue(
				await evaluator.evaluateRenderedConfig(unitPath, unit, unitDir)
			) as Record<string, unknown>;
			const generate = rendered.generate as Record<string, Record<string, unknown>>;
			assert.equal(
				generate.g.contents,
				'FROM-ROOT-DIR|unit',
				'file() reads the root-relative file; get_terragrunt_dir() still reports the unit'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('searches parent folders from the including unit, not from the included root', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-unitdir-'));
		try {
			await fs.writeFile(path.join(root, 'root.hcl'), [
				'locals {',
				'  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))',
				'}'
			].join('\n'));
			const accountDir = path.join(root, 'live', 'prod');
			const unitDir = path.join(accountDir, 'eu-west-2', 'app');
			await fs.mkdir(unitDir, { recursive: true });
			await fs.writeFile(path.join(accountDir, 'account.hcl'), 'locals {\n  account_id = "123456789012"\n}\n');

			const unit = [
				'include "root" {',
				'  path   = find_in_parent_folders("root.hcl")',
				'  expose = true',
				'}',
				'',
				'inputs = {',
				'  id = include.root.locals.account_vars.locals.account_id',
				'}'
			].join('\n');
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			await fs.writeFile(unitPath, unit);

			const result = await evaluator.evaluateUnit(unitPath, unit, root);
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(result.inputs ? plainValue(result.inputs) : undefined, {
				id: '123456789012'
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('resolves one local read by sibling expressions without reporting a cycle', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-concurrent-'));
		try {
			await fs.writeFile(path.join(root, 'account.hcl'), [
				'locals {',
				'  region  = "eu-west-2"',
				'  account = "platform"',
				'}'
			].join('\n'));
			const unit = [
				'locals {',
				'  account_vars = read_terragrunt_config("${get_terragrunt_dir()}/account.hcl").locals',
				'}',
				'',
				'inputs = {',
				'  tags = [',
				'    "account:${local.account_vars.account}",',
				'    "region:${local.account_vars.region}"',
				'  ]',
				'}'
			].join('\n');
			const unitPath = path.join(root, 'terragrunt.hcl');
			await fs.writeFile(unitPath, unit);

			const result = await evaluator.evaluateUnit(unitPath, unit, root);
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(result.inputs ? plainValue(result.inputs) : undefined, {
				tags: ['account:platform', 'region:eu-west-2']
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('still reports a local that genuinely refers to itself', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-realcycle-'));
		try {
			const unit = [
				'locals {',
				'  a = local.b',
				'  b = local.a',
				'}',
				'',
				'inputs = { value = local.a }'
			].join('\n');
			const unitPath = path.join(root, 'terragrunt.hcl');
			await fs.writeFile(unitPath, unit);

			const result = await evaluator.evaluateUnit(unitPath, unit, root);
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /Cycle detected in locals/u);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('reports a local cycle that crosses an asynchronous expression boundary', async () => {
		const content = [
			'locals {',
			'  a = true ? local.b : "unused"',
			'  b = local.a',
			'}',
			'',
			'inputs = { value = local.a }'
		].join('\n');
		const evaluation = evaluator.evaluateUnit(configPath, content, process.cwd());
		let timeout: NodeJS.Timeout | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error('local cycle evaluation did not terminate')), 500);
		});
		let result;
		try {
			result = await Promise.race([evaluation, timedOut]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}

		assert.equal(result.valid, false);
		assert.match(result.error ?? '', /Cycle detected in locals/u);
	});

	it('exposes the whole locals map of an include addressed without a name', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-barelocals-'));
		try {
			await fs.writeFile(path.join(root, 'shared.hcl'), [
				'locals {',
				'  site    = "datadoghq.eu"',
				'  regions = ["eu-west-2"]',
				'}'
			].join('\n'));
			const unit = [
				'include "shared" {',
				'  path   = find_in_parent_folders("shared.hcl")',
				'  expose = true',
				'}',
				'',
				'locals {',
				'  shared_vars = include.shared.locals',
				'}',
				'',
				'inputs = {',
				'  site = local.shared_vars.site',
				'}'
			].join('\n');
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			await fs.writeFile(unitPath, unit);

			const result = await evaluator.evaluateUnit(unitPath, unit, root);
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(result.inputs ? plainValue(result.inputs) : undefined, {
				site: 'datadoghq.eu'
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('resolves a relative read in an included config from the including unit', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-relative-read-'));
		try {
			await fs.writeFile(path.join(root, 'root.hcl'), [
				'locals {',
				'  unit_vars = read_terragrunt_config("unit.hcl")',
				'}'
			].join('\n'));
			const unitDir = path.join(root, 'live', 'app');
			await fs.mkdir(unitDir, { recursive: true });
			await fs.writeFile(path.join(unitDir, 'unit.hcl'), 'locals { marker = "from-unit" }\n');
			const unit = [
				'include "root" {',
				'  path   = find_in_parent_folders("root.hcl")',
				'  expose = true',
				'}',
				'',
				'inputs = { marker = include.root.locals.unit_vars.locals.marker }'
			].join('\n');
			const unitPath = path.join(unitDir, 'terragrunt.hcl');

			const result = await evaluator.evaluateUnit(unitPath, unit, root);
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(result.inputs ? plainValue(result.inputs) : undefined, {
				marker: 'from-unit'
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('uses the including unit repository for repository functions in an external include', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-unit-repo-'));
		try {
			await fs.writeFile(path.join(root, 'root.hcl'), [
				'locals {',
				'  global = read_terragrunt_config("${get_repo_root()}/global.hcl")',
				'}'
			].join('\n'));
			const repository = path.join(root, 'repository');
			const unitDir = path.join(repository, 'live', 'app');
			await fs.mkdir(path.join(repository, '.git'), { recursive: true });
			await fs.mkdir(unitDir, { recursive: true });
			await fs.writeFile(path.join(repository, 'global.hcl'), 'locals { marker = "unit-repository" }\n');
			const unit = [
				'include "root" {',
				'  path   = "../../../root.hcl"',
				'  expose = true',
				'}',
				'',
				'inputs = { marker = include.root.locals.global.locals.marker }'
			].join('\n');

			const result = await evaluator.evaluateUnit(path.join(unitDir, 'terragrunt.hcl'), unit, root);
			assert.equal(result.valid, true, result.error);
			assert.deepEqual(result.inputs ? plainValue(result.inputs) : undefined, {
				marker: 'unit-repository'
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('collects inline functions through a unit-relative nested include', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-inline-unitdir-'));
		try {
			await fs.writeFile(path.join(root, 'root.hcl'), `include "environment" {
  path = find_in_parent_folders("environment.hcl")
}`);
			const environmentDir = path.join(root, 'live', 'prod');
			const unitDir = path.join(environmentDir, 'app');
			await fs.mkdir(unitDir, { recursive: true });
			await fs.writeFile(path.join(environmentDir, 'environment.hcl'), 'function environment() { return "prod"; }\n');
			const unit = `include "root" {
  path = find_in_parent_folders("root.hcl")
}`;
			const unitPath = path.join(unitDir, 'terragrunt.hcl');

			const inherited = await evaluator.collectInheritedInlineFunctions(unitPath, unit, root);
			assert.equal(inherited.has('environment'), true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('evaluates the hovered expression when another part of the file cannot be evaluated', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-hover-'));
		try {
			const unit = [
				'dependency "unapplied" {',
				'  config_path = "../unapplied"',
				'}',
				'',
				'locals {',
				'  region = "eu-west-2"',
				'}',
				'',
				'inputs = {',
				'  from_dependency = dependency.unapplied.outputs.id',
				'}'
			].join('\n');
			const unitDir = path.join(root, 'unit');
			await fs.mkdir(unitDir);
			const unitPath = path.join(unitDir, 'terragrunt.hcl');
			await fs.writeFile(unitPath, unit);

			const whole = await evaluator.evaluateUnit(unitPath, unit, root);
			assert.equal(whole.valid, false, 'the whole-file evaluation must still fail');

			const hovered = await evaluator.evaluateAtPosition(unitPath, unit, root, { line: 5, character: 13 });
			assert.deepEqual(hovered, { type: 'string', value: 'eu-west-2' });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	const sopsUnit = [
		'locals {',
		'  yaml = yamldecode(sops_decrypt_file("${get_terragrunt_dir()}/secrets.sops.yaml"))',
		'  json = jsondecode(sops_decrypt_file("${get_terragrunt_dir()}/secrets.sops.json"))',
		'}',
		'',
		'inputs = {',
		'  yaml  = local.yaml',
		'  json  = local.json',
		'  token = local.yaml.token',
		'}'
	].join('\n');

	async function sopsWorkspace(): Promise<string> {
		const os = await import('node:os');
		const fs = await import('node:fs/promises');
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-sops-')));
		await fs.mkdir(path.join(root, '.git'));
		await fs.writeFile(path.join(root, 'secrets.sops.yaml'), ENCRYPTED_SOPS_YAML);
		await fs.writeFile(path.join(root, 'secrets.sops.json'), ENCRYPTED_SOPS_JSON);
		await fs.writeFile(path.join(root, 'terragrunt.hcl'), sopsUnit);
		return root;
	}

	it('reads the keys of a sops file it cannot decrypt when asked to, and never shows an encrypted value', async () => {
		const fs = await import('node:fs/promises');
		const root = await sopsWorkspace();
		try {
			const reader = new ConfigEvaluator({
				environmentVariables: {},
				terraformCommand: '',
				terraformCliArgs: [],
				workspaceTrusted: true,
				readEncryptedSops: true
			});
			const unitPath = path.join(root, 'terragrunt.hcl');
			const result = await withoutSopsKey(() => reader.evaluateUnit(unitPath, sopsUnit, root));
			assert.equal(result.valid, true, result.error);
			const masked = { token: '(encrypted)', db: { password: '(encrypted)' } };
			assert.deepEqual(plainValue(result.inputs!), { yaml: masked, json: masked, token: '(encrypted)' });
			const inputs = result.inputs!.value as Map<string, unknown>;
			assert.deepEqual(inputs.get('token'), { type: 'string', value: 'ENC[AES256_GCM,data:nq2Z7w==,iv:A1B2,tag:C3D4,type:str]', encrypted: true });

			const spans = await withoutSopsKey(() => reader.evaluatedSpans(unitPath, sopsUnit, root));
			const shown = spans.map(span => sopsUnit.slice(span.start, span.end));
			assert.ok(shown.includes('yaml') && shown.includes('local.yaml'), shown.join(', '));
			assert.ok(!shown.includes('token') && !shown.includes('local.yaml.token'), shown.join(', '));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('still fails on a sops file it cannot decrypt unless asked to read its keys', async () => {
		const fs = await import('node:fs/promises');
		const root = await sopsWorkspace();
		try {
			const result = await withoutSopsKey(() => evaluator.evaluateUnit(path.join(root, 'terragrunt.hcl'), sopsUnit, root));
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /Failed to get the data key/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	describe('without sops installed', () => {
		const missing = (root: string, file: string) =>
			`sops_decrypt_file cannot decrypt ${path.join(root, file)}: the sops program is not on PATH. ` +
			'Install sops (https://github.com/getsops/sops/releases) and put it on PATH, or validate offline with ' +
			'"hcl validate --offline" to read the file as written.';
		const withEvaluator = async (options: { partialRender?: boolean; readEncryptedSops?: boolean }, check: (root: string, result: Awaited<ReturnType<ConfigEvaluator['evaluateUnit']>>) => void) => {
			const fs = await import('node:fs/promises');
			const root = await sopsWorkspace();
			try {
				const reader = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true, ...options });
				check(root, await withoutSops(root, () => reader.evaluateUnit(path.join(root, 'terragrunt.hcl'), sopsUnit, root)));
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		};

		it('fails naming sops and how to provide it', async () => {
			await withEvaluator({}, (root, result) => {
				assert.equal(result.valid, false);
				assert.equal(result.unresolved, undefined);
				assert.equal(result.error, missing(root, 'secrets.sops.yaml'));
			});
		});

		it('fails a render too, rather than leaving the secrets out', async () => {
			await withEvaluator({ partialRender: true }, (root, result) => {
				assert.equal(result.unresolved, undefined);
				assert.equal(result.error, missing(root, 'secrets.sops.yaml'));
			});
		});

		it('reads the file as written when validating offline, which needs no sops', async () => {
			await withEvaluator({ readEncryptedSops: true }, (_root, result) => assert.equal(result.valid, true, result.error));
		});

		it('fails offline on a file with no sops metadata to read as written, naming sops', async () => {
			const fs = await import('node:fs/promises');
			const root = await sopsWorkspace();
			try {
				await fs.writeFile(path.join(root, 'secrets.sops.yaml'), 'token: plain\n');
				const reader = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true, readEncryptedSops: true });
				const result = await withoutSops(root, () => reader.evaluateUnit(path.join(root, 'terragrunt.hcl'), sopsUnit, root));
				assert.equal(result.error, `sops_decrypt_file cannot decrypt ${path.join(root, 'secrets.sops.yaml')}: the sops program is not on PATH. ` +
					'Install sops (https://github.com/getsops/sops/releases) and put it on PATH.');
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	});

	it('still fails on a file sops cannot decrypt that holds no sops metadata, even when asked to read keys', async () => {
		const fs = await import('node:fs/promises');
		const root = await sopsWorkspace();
		try {
			await fs.writeFile(path.join(root, 'secrets.sops.yaml'), 'token: plain\n');
			const reader = new ConfigEvaluator({
				environmentVariables: {},
				terraformCommand: '',
				terraformCliArgs: [],
				workspaceTrusted: true,
				readEncryptedSops: true
			});
			const result = await withoutSopsKey(() => reader.evaluateUnit(path.join(root, 'terragrunt.hcl'), sopsUnit, root));
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /Failed to get the data key/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	describe('a value read from a sops file it could not decrypt', () => {
		const secrets = 'yamldecode(sops_decrypt_file("${get_terragrunt_dir()}/secrets.sops.yaml"))';

		function encryptedReader(partialRender = false): ConfigEvaluator {
			return new ConfigEvaluator({
				environmentVariables: {},
				terraformCommand: '',
				terraformCliArgs: [],
				workspaceTrusted: true,
				readEncryptedSops: true,
				partialRender
			});
		}

		async function evaluateWithoutKey(root: string, unit: string) {
			const fs = await import('node:fs/promises');
			const unitPath = path.join(root, 'terragrunt.hcl');
			await fs.writeFile(unitPath, unit);
			return withoutSopsKey(() => encryptedReader().evaluateUnit(unitPath, unit, root));
		}

		// An evaluation runs sops once, so each case is a test of its own: one evaluation keeps well within a test's time
		// on a loaded machine, where all of them in one test did not.
		describe('makes everything computed from it unresolved, never a value computed from the encrypted text', () => {
			const computed: Record<string, string> = {
				template: '"https://${local.secrets.token}@example.com"',
				call: 'upper(local.secrets.token)',
				conversion: 'tonumber(local.secrets.token)',
				encoding: 'jsonencode(local.secrets)',
				comparison: 'local.secrets.token == "x"',
				arithmetic: 'local.secrets.token + 1',
				negation: '!local.secrets.token',
				condition: 'local.secrets.token ? "a" : "b"',
				index: '{ a = 1 }[local.secrets.token]',
				key: '{ (local.secrets.token) = 1 }',
				lookup_key: 'lookup({ a = 1 }, local.secrets.token, 0)',
				inline_function: 'shout(local.secrets.token)',
				list_comprehension: '[for item in [local.secrets.token] : "${item}!"]',
				comprehension_key: '{ for item in [local.secrets.token] : item => 1 }'
			};
			for (const [name, expression] of Object.entries(computed)) {
				it(`${name}: ${expression}`, async () => {
					const fs = await import('node:fs/promises');
					const root = await sopsWorkspace();
					try {
						const unit = [
							'function shout(value) { return value.toUpperCase(); }',
							`locals { secrets = ${secrets} }`,
							`inputs = { ${name} = ${expression} }`
						].join('\n');
						const result = await evaluateWithoutKey(root, unit);
						assert.equal(result.valid, false, JSON.stringify(result.inputs ? plainValue(result.inputs) : null));
						assert.equal(result.unresolved, true, result.error);
						assert.match(result.error ?? '', /could not be decrypted/);
					} finally {
						await fs.rm(root, { recursive: true, force: true });
					}
				});
			}
		});

		it('passes it through as it is, still encrypted, where nothing is computed from it', async () => {
			const fs = await import('node:fs/promises');
			const root = await sopsWorkspace();
			try {
				const unit = [
					`locals { secrets = ${secrets} }`,
					'inputs = {',
					'  merged    = merge(local.secrets, { region = "eu-west-2" })',
					'  looked_up = lookup(local.secrets, "token", "")',
					'  element   = element([local.secrets.token], 0)',
					'  listed    = concat([local.secrets.token], ["plain"])',
					'  flattened = flatten([[local.secrets.token]])',
					'  valued    = values({ a = local.secrets.token })',
					'  as_list   = tolist([local.secrets.token])',
					'  as_map    = tomap({ a = local.secrets.token })',
					'  tried     = try(local.secrets.missing, local.secrets.token)',
					'  chosen    = true ? local.secrets.token : "plain"',
					'  named     = [for key, value in local.secrets : key]',
					'}'
				].join('\n');
				const result = await evaluateWithoutKey(root, unit);
				assert.equal(result.valid, true, result.error);
				assert.deepEqual(plainValue(result.inputs!), {
					merged: { token: '(encrypted)', db: { password: '(encrypted)' }, region: 'eu-west-2' },
					looked_up: '(encrypted)',
					element: '(encrypted)',
					listed: ['(encrypted)', 'plain'],
					flattened: ['(encrypted)'],
					valued: ['(encrypted)'],
					as_list: ['(encrypted)'],
					as_map: { a: '(encrypted)' },
					tried: '(encrypted)',
					chosen: '(encrypted)',
					named: ['db', 'token']
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});

		// One evaluation for each way of passing it, as above.
		describe('never runs a command given it, however it is passed', () => {
			const record = (ran: string, label: string) => `"echo ${label} >> ${ran}"`;
			const calls: Record<string, (ran: string) => string> = {
				argument: ran => `run_cmd("sh", "-c", ${record(ran, 'argument')}, local.secrets.token)`,
				template: ran => `run_cmd("sh", "-c", "echo template >> ${ran}; echo \${local.secrets.token}")`,
				computed: ran => `run_cmd("sh", "-c", ${record(ran, 'computed')}, lower(local.secrets.token))`,
				passed_through: ran => `run_cmd("sh", "-c", ${record(ran, 'passed_through')}, lookup(local.secrets, "token", ""))`,
				collection: ran => `run_cmd("sh", "-c", ${record(ran, 'collection')}, jsonencode(local.secrets.db))`
			};
			for (const [name, call] of Object.entries(calls)) {
				it(name, async () => {
					const fs = await import('node:fs/promises');
					const root = await sopsWorkspace();
					try {
						const ran = path.join(root, 'ran');
						const result = await evaluateWithoutKey(root, [`locals { secrets = ${secrets} }`, `inputs = { ${name} = ${call(ran)} }`].join('\n'));
						assert.equal(result.unresolved, true, result.error);
						await assert.rejects(fs.readFile(ran, 'utf8'), { code: 'ENOENT' });
					} finally {
						await fs.rm(root, { recursive: true, force: true });
					}
				});
			}

			it('while it runs one given nothing from it', async () => {
				const fs = await import('node:fs/promises');
				const root = await sopsWorkspace();
				try {
					const ran = path.join(root, 'ran');
					const plain = await evaluateWithoutKey(root, [`locals { secrets = ${secrets} }`, `inputs = { plain = run_cmd("sh", "-c", ${record(ran, 'plain')}) }`].join('\n'));
					assert.equal(plain.valid, true, plain.error);
					assert.equal(await fs.readFile(ran, 'utf8'), 'plain\n');
				} finally {
					await fs.rm(root, { recursive: true, force: true });
				}
			});
		});

		it('renders no generate block or remote_state that would write it to a file', async () => {
			const fs = await import('node:fs/promises');
			const root = await sopsWorkspace();
			try {
				const unit = [
					`locals { secrets = ${secrets} }`,
					'generate "secret" {',
					'  path     = "secret.txt"',
					'  contents = local.secrets.token',
					'}',
					'generate "plain" {',
					'  path     = "plain.txt"',
					'  contents = "plain"',
					'}',
					'remote_state {',
					'  backend = "s3"',
					'  generate = { path = "backend.tf", if_exists = "overwrite" }',
					'  config  = { bucket = "state", key = local.secrets.db.password }',
					'}'
				].join('\n');
				const unitPath = path.join(root, 'terragrunt.hcl');
				await fs.writeFile(unitPath, unit);
				const reader = encryptedReader(true);
				const rendered = await withoutSopsKey(() => reader.evaluateRenderedConfig(unitPath, unit, root));
				const plain = plainValue(rendered) as Record<string, unknown>;
				assert.deepEqual(plain.generate, { secret: { path: 'secret.txt' }, plain: { path: 'plain.txt', contents: 'plain' } });
				assert.equal(Object.prototype.hasOwnProperty.call(plain, 'remote_state'), false, JSON.stringify(plain.remote_state));
				assert.deepEqual(reader.unresolvedRenderFields().map(issue => issue.field).sort(), ['generate.secret.contents', 'remote_state']);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	});
});
