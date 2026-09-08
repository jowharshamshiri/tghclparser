import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigEvaluator, runtimeValueToPlain } from '../src/Evaluator';
import { ParsedDocument } from '../src/ParsedDocument';
import { parse } from '../src/parser';
import { Workspace } from '../src/Workspace';

function evaluator(): ConfigEvaluator {
	return new ConfigEvaluator({
		environmentVariables: { INLINE_FN_TEST: 'set' },
		terraformCommand: '',
		terraformCliArgs: [],
		workspaceTrusted: true
	});
}

/** Evaluates a single configuration in a scratch directory and returns its inputs. */
async function evaluateInputs(content: string): Promise<unknown> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-fn-'));
	try {
		const configPath = path.join(dir, 'terragrunt.hcl');
		await fs.writeFile(configPath, content);
		const result = await evaluator().evaluateUnit(configPath, content, dir);
		if (!result.valid) throw new Error(result.error ?? 'evaluation failed');
		return result.inputs === null ? null : runtimeValueToPlain(result.inputs);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/** Evaluates a configuration expected to fail, returning the reported message. */
async function evaluationError(content: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-fn-'));
	try {
		const configPath = path.join(dir, 'terragrunt.hcl');
		await fs.writeFile(configPath, content);
		const result = await evaluator().evaluateUnit(configPath, content, dir);
		assert.equal(result.valid, false, 'expected evaluation to fail');
		return result.error ?? '';
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/** Evaluates a unit that includes a parent configuration, returning its inputs. */
async function evaluateWithParent(rootHcl: string, unitHcl: string): Promise<unknown> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-fn-parent-'));
	try {
		const unitDir = path.join(root, 'app');
		await fs.mkdir(unitDir, { recursive: true });
		await fs.writeFile(path.join(root, 'root.hcl'), rootHcl);
		const configPath = path.join(unitDir, 'terragrunt.hcl');
		await fs.writeFile(configPath, unitHcl);
		const result = await evaluator().evaluateUnit(configPath, unitHcl, root);
		if (!result.valid) throw new Error(result.error ?? 'evaluation failed');
		return result.inputs === null ? null : runtimeValueToPlain(result.inputs);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function diagnostics(content: string, uri = 'file:///repo/terragrunt.hcl'): string[] {
	return new ParsedDocument(new Workspace(), uri, content).getDiagnostics().map(item => item.message);
}

describe('inline function declarations', () => {
	it('captures a body verbatim, including braces inside strings, templates, comments, and regexes', () => {
		const bodies = new Map<string, string>();
		const source = [
			'function inString(a) {',
			'  return "}" + a;',
			'}',
			'',
			'function inTemplate(a) {',
			'  return `x${a}y`;',
			'}',
			'',
			'function inNestedTemplate(a) {',
			'  return `x${ {k: a}.k }y`;',
			'}',
			'',
			'function inLineComment(a) {',
			'  // }',
			'  return a;',
			'}',
			'',
			'function inBlockComment(a) {',
			'  /* } */',
			'  return a;',
			'}',
			'',
			'function inRegex(a) {',
			'  return /[}]/.test(a);',
			'}',
			'',
			'function nestedFunction(a) {',
			'  function inner(x) { return x * 2; }',
			'  return inner(a);',
			'}'
		].join('\n');

		const ast: any = parse(source, { grammarSource: 'test.hcl', tracer: { trace() {} } });
		for (const node of ast.children) {
			if (node.type !== 'inline_function') continue;
			bodies.set(String(node.value), String(node.children.find((c: any) => c.type === 'js_body').value));
		}

		assert.equal(bodies.size, 7);
		assert.match(bodies.get('inString')!, /return "\}" \+ a;/);
		assert.match(bodies.get('inTemplate')!, /return `x\$\{a\}y`;/);
		assert.match(bodies.get('inNestedTemplate')!, /return `x\$\{ \{k: a\}\.k \}y`;/);
		assert.match(bodies.get('inLineComment')!, /\/\/ \}/);
		assert.match(bodies.get('inBlockComment')!, /\/\* \} \*\//);
		assert.match(bodies.get('inRegex')!, /\/\[\}\]\/\.test\(a\)/);
		assert.match(bodies.get('nestedFunction')!, /function inner\(x\) \{ return x \* 2; \}/);
	});

	it('captures an empty body without consuming the closing brace', () => {
		const ast: any = parse('function empty() {}\n', { grammarSource: 'test.hcl', tracer: { trace() {} } });
		const fn = ast.children.find((node: any) => node.type === 'inline_function');
		assert.equal(fn.value, 'empty');
		assert.equal(String(fn.children.find((c: any) => c.type === 'js_body').value), '');
	});

	it('distinguishes division from a regular expression literal', () => {
		const ast: any = parse('function f(a) {\n  const b = a / 2;\n  return b / 3;\n}\n', {
			grammarSource: 'test.hcl',
			tracer: { trace() {} }
		});
		const body = String(ast.children[0].children.find((c: any) => c.type === 'js_body').value);
		assert.match(body, /const b = a \/ 2;/);
		assert.match(body, /return b \/ 3;/);
	});

	it('records parameter defaults, variadics, and type annotations', () => {
		const ast: any = parse('function f(a: string, b: number = 3, ...rest) { return a; }\n', {
			grammarSource: 'test.hcl',
			tracer: { trace() {} }
		});
		const params = ast.children[0].children.filter((c: any) => c.type === 'inline_param');
		assert.deepEqual(params.map((p: any) => p.value), ['a', 'b', 'rest']);
		assert.deepEqual(params.map((p: any) => p.variadic === true), [false, false, true]);
		assert.deepEqual(
			params.map((p: any) => (p.children ?? []).map((c: any) => c.type)),
			[['param_type'], ['param_type', 'param_default'], []]
		);
	});

	it('rejects signatures that could not be bound unambiguously', () => {
		const cases: Array<[string, RegExp]> = [
			['function f(a, a) { return a; }\n', /Duplicate parameter "a"/],
			['function f(a = 1, b) { return b; }\n', /Required parameter "b" in function "f" follows an optional parameter/],
			['function f(...a, b) { return b; }\n', /Parameter "b" in function "f" follows a variadic parameter/],
			['function f(...a = 1) { return a; }\n', /Variadic parameter "a" in function "f" cannot have a default/],
			// A parameter named for the configuration binding would shadow it and
			// silently discard the caller's argument.
			['function f(tg) { return tg; }\n', /Parameter "tg" in function "f" collides with the configuration binding/]
		];
		for (const [source, expected] of cases) {
			assert.throws(
				() => parse(source, { grammarSource: 'test.hcl', tracer: { trace() {} } }),
				expected,
				source
			);
		}
	});

	it('does not treat a `function`-prefixed identifier as a declaration', () => {
		const ast: any = parse('functional_value = 1\n', { grammarSource: 'test.hcl', tracer: { trace() {} } });
		assert.equal(ast.children[0].type, 'assignment');
		assert.equal(ast.children[0].value, 'functional_value');
	});
});

describe('inline function evaluation', () => {
	it('calls a declared function exactly as a built-in is called', async () => {
		assert.deepEqual(
			await evaluateInputs('function greet(name) {\n  return "hello " + name;\n}\n\ninputs = { g = greet("world") }\n'),
			{ g: 'hello world' }
		);
	});

	it('applies declared defaults, evaluating them in the declaring scope', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'locals { fallback = "eu-west-1" }',
				'',
				'function region(name = local.fallback) { return name; }',
				'',
				'inputs = { a = region(), b = region("us-east-1") }'
			].join('\n')),
			{ a: 'eu-west-1', b: 'us-east-1' }
		);
	});

	it('collects trailing arguments into a variadic parameter', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function total(first, ...rest) {',
				'  return first + rest.reduce((sum, n) => sum + n, 0);',
				'}',
				'',
				'inputs = { t = total(1, 2, 3, 4) }'
			].join('\n')),
			{ t: 10 }
		);
	});

	it('supports imperative control flow that HCL expressions cannot express', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function shard_plan(units, shards = 3) {',
				'  const plan = {};',
				'  for (const [index, unit] of units.entries()) {',
				'    plan[unit] = { shard: index % shards, primary: index === 0 };',
				'  }',
				'  return plan;',
				'}',
				'',
				'inputs = { p = shard_plan(["api", "worker", "cron", "web"]) }'
			].join('\n')),
			{
				p: {
					api: { shard: 0, primary: true },
					worker: { shard: 1, primary: false },
					cron: { shard: 2, primary: false },
					web: { shard: 0, primary: false }
				}
			}
		);
	});

	it('awaits an asynchronous body without an await at the call site', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function slow(n) {',
				'  await new Promise(resolve => setTimeout(resolve, 1));',
				'  return n * 2;',
				'}',
				'',
				'inputs = { s = slow(21) }'
			].join('\n')),
			{ s: 42 }
		);
	});

	it('round-trips every representable value type across the boundary', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function echo(value) { return value; }',
				'',
				'function build() {',
				'  return { list: [1, "two", true, null], nested: { deep: [{ k: "v" }] } };',
				'}',
				'',
				'inputs = {',
				'  s = echo("text"),',
				'  n = echo(42),',
				'  b = echo(true),',
				'  z = echo(null),',
				'  l = echo([1, 2]),',
				'  o = echo({ a = 1 }),',
				'  built = build()',
				'}'
			].join('\n')),
			{
				s: 'text',
				n: 42,
				b: true,
				z: null,
				l: [1, 2],
				o: { a: 1 },
				built: { list: [1, 'two', true, null], nested: { deep: [{ k: 'v' }] } }
			}
		);
	});

	it('resolves calls inside interpolations and locals', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function tag(env) { return "tag-" + env; }',
				'function double(n) { return n * 2; }',
				'',
				'locals { doubled = double(21) }',
				'',
				'inputs = {',
				'  interpolated = "prefix-${tag("prod")}-suffix",',
				'  fromLocal = local.doubled',
				'}'
			].join('\n')),
			{ interpolated: 'prefix-tag-prod-suffix', fromLocal: 42 }
		);
	});

	it('reads sibling locals when called from inside a locals block', async () => {
		// A function invoked while a local is being evaluated must still see the
		// scope's other locals; only the local currently resolving is withheld.
		assert.deepEqual(
			await evaluateInputs([
				'function scale(n) { return n * tg.local.factor; }',
				'',
				'locals {',
				'  factor = 3',
				'  scaled = scale(14)',
				'}',
				'',
				'inputs = { v = local.scaled }'
			].join('\n')),
			{ v: 42 }
		);
	});

	it('reports a function that reads the very local it is being called from', async () => {
		assert.match(
			await evaluationError([
				'function selfish(n) { return n + tg.local.value; }',
				'',
				'locals { value = selfish(1) }',
				'',
				'inputs = { v = local.value }'
			].join('\n')),
			/Inline function "selfish" was called while resolving local "value", which it also reads/
		);
	});
});

describe('inline function argument binding', () => {
	it('reports too few and too many arguments against the declared signature', async () => {
		assert.match(
			await evaluationError('function key(a, b) { return a; }\n\ninputs = { k = key(1) }\n'),
			/Inline function "key" requires at least 2 arguments, got 1/
		);
		assert.match(
			await evaluationError('function key(a) { return a; }\n\ninputs = { k = key(1, 2) }\n'),
			/Inline function "key" accepts at most 1 argument, got 2/
		);
	});

	it('checks annotated parameters against their declared type', async () => {
		assert.match(
			await evaluationError('function key(env: string) { return env; }\n\ninputs = { k = key(42) }\n'),
			/Inline function "key" argument "env" must be a string, got number/
		);
		assert.match(
			await evaluationError('function key(n: number) { return n; }\n\ninputs = { k = key("x") }\n'),
			/Inline function "key" argument "n" must be a number, got string/
		);
		assert.match(
			await evaluationError('function key(flag: bool) { return flag; }\n\ninputs = { k = key(1) }\n'),
			/Inline function "key" argument "flag" must be a bool, got number/
		);
	});

	it('checks structural types through their elements', async () => {
		assert.match(
			await evaluationError('function f(items: list(string)) { return items; }\n\ninputs = { k = f(["a", 2]) }\n'),
			/Inline function "f" argument "items"\[1\] must be a string, got number/
		);
		assert.deepEqual(
			await evaluateInputs('function f(items: list(string)) { return items.length; }\n\ninputs = { k = f(["a", "b"]) }\n'),
			{ k: 2 }
		);
		assert.match(
			await evaluationError('function f(m: map(number)) { return m; }\n\ninputs = { k = f({ a = "x" }) }\n'),
			/Inline function "f" argument "m"\["a"\] must be a number, got string/
		);
		assert.match(
			await evaluationError('function f(t: tuple(string, number)) { return t; }\n\ninputs = { k = f(["a"]) }\n'),
			/Inline function "f" argument "t" must be a tuple of 2 elements, got 1/
		);
		assert.match(
			await evaluationError('function f(o: object(a = string,)) { return o; }\n\ninputs = { k = f({ b = 1 }) }\n'),
			/Inline function "f" argument "o" is missing attribute "a"/
		);
		assert.deepEqual(
			await evaluateInputs('function f(o: object(a = string,)) { return o.a; }\n\ninputs = { k = f({ a = "x" }) }\n'),
			{ k: 'x' }
		);
	});

	it('checks every element of a typed variadic parameter', async () => {
		assert.match(
			await evaluationError('function f(...names: string) { return names; }\n\ninputs = { k = f("a", 2) }\n'),
			/Inline function "f" argument "names"\[1\] must be a string, got number/
		);
	});

	it('accepts any value for an unannotated parameter', async () => {
		assert.deepEqual(
			await evaluateInputs('function f(v) { return typeof v; }\n\ninputs = { a = f(1), b = f("x"), c = f(true) }\n'),
			{ a: 'number', b: 'string', c: 'boolean' }
		);
	});
});

describe('inline function scoping', () => {
	it('inherits declarations through an include', async () => {
		assert.deepEqual(
			await evaluateWithParent(
				'locals { org = "acme" }\n\nfunction state_key(env) {\n  return tg.local.org + "/" + env;\n}\n',
				'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\ninputs = { k = state_key("prod") }\n'
			),
			{ k: 'acme/prod' }
		);
	});

	it('prefers a local declaration over an inherited one of the same name', async () => {
		assert.deepEqual(
			await evaluateWithParent(
				'function which() { return "parent"; }\n',
				'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nfunction which() { return "child"; }\n\ninputs = { w = which() }\n'
			),
			{ w: 'child' }
		);
	});

	it('resolves a body against the declaring file, not the calling one', async () => {
		assert.deepEqual(
			await evaluateWithParent(
				'locals { org = "parent-org" }\n\nfunction name() { return tg.local.org; }\n',
				'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nlocals { org = "child-org" }\n\ninputs = { n = name() }\n'
			),
			{ n: 'parent-org' }
		);
	});

	it('rejects a declaration that shadows a built-in function', async () => {
		assert.match(
			await evaluationError('function join(a) { return a; }\n\ninputs = { k = 1 }\n'),
			/Inline function "join" shadows a built-in function/
		);
	});

	it('rejects the same name declared twice in one file', async () => {
		assert.match(
			await evaluationError('function f(a) { return a; }\nfunction f(b) { return b; }\n\ninputs = { k = 1 }\n'),
			/Inline function "f" is defined more than once/
		);
	});

	it('still reports a genuinely unknown function', async () => {
		assert.match(
			await evaluationError('function f() { return 1; }\n\ninputs = { k = not_declared_anywhere() }\n'),
			/Unknown function "not_declared_anywhere"/
		);
	});
});

describe('inline function configuration access', () => {
	it('reads locals of the declaring file through tg.local', async () => {
		assert.deepEqual(
			await evaluateInputs('locals { org = "acme" }\n\nfunction name(env) { return tg.local.org + "-" + env; }\n\ninputs = { n = name("prod") }\n'),
			{ n: 'acme-prod' }
		);
	});

	it('fails on an undefined local rather than yielding undefined', async () => {
		assert.match(
			await evaluationError('locals { org = "acme" }\n\nfunction name() { return tg.local.missing; }\n\ninputs = { n = name() }\n'),
			/Inline function "name" referenced undefined local "missing"/
		);
	});

	it('invokes built-in functions through tg.call', async () => {
		assert.deepEqual(
			await evaluateInputs('function shout(s) { return await tg.call("upper", s); }\n\ninputs = { u = shout("abc") }\n'),
			{ u: 'ABC' }
		);
	});

	it('invokes other inline functions through tg.call', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function double(n) { return n * 2; }',
				'function quad(n) { return await tg.call("double", await tg.call("double", n)); }',
				'',
				'inputs = { q = quad(3) }'
			].join('\n')),
			{ q: 12 }
		);
	});

	it('fails when tg.call names a function that does not exist', async () => {
		assert.match(
			await evaluationError('function f(s) { return await tg.call("no_such_function", s); }\n\ninputs = { k = f("a") }\n'),
			/tg\.call in inline function "f" named unknown function "no_such_function"/
		);
	});

	it('exposes an exposed include and refuses an unexposed one', async () => {
		assert.deepEqual(
			await evaluateWithParent(
				'locals { region = "eu-west-1" }\n',
				[
					'include "root" {',
					'  path   = find_in_parent_folders("root.hcl")',
					'  expose = true',
					'}',
					'',
					'function region() { return tg.include.root.locals.region; }',
					'',
					'inputs = { r = region() }'
				].join('\n')
			),
			{ r: 'eu-west-1' }
		);

		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-fn-unexposed-'));
		try {
			const unitDir = path.join(root, 'app');
			await fs.mkdir(unitDir, { recursive: true });
			await fs.writeFile(path.join(root, 'root.hcl'), 'locals { region = "eu-west-1" }\n');
			const unitHcl = [
				'include "root" {',
				'  path = find_in_parent_folders("root.hcl")',
				'}',
				'',
				'function region() { return tg.include.root.locals.region; }',
				'',
				'inputs = { r = region() }'
			].join('\n');
			const configPath = path.join(unitDir, 'terragrunt.hcl');
			await fs.writeFile(configPath, unitHcl);
			const result = await evaluator().evaluateUnit(configPath, unitHcl, root);
			assert.equal(result.valid, false);
			assert.match(result.error ?? '', /referenced unexposed or undefined include "root"/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('exposes the evaluation context', async () => {
		const result = await evaluateInputs([
			'function describe() {',
			'  return {',
			'    hasDir: tg.context.terragruntDir.length > 0,',
			'    env: tg.context.environmentVariables.INLINE_FN_TEST,',
			'  };',
			'}',
			'',
			'inputs = { d = describe() }'
		].join('\n')) as { d: { hasDir: boolean; env: string } };
		assert.equal(result.d.hasDir, true);
		assert.equal(result.d.env, 'set');
	});
});

describe('inline function failure reporting', () => {
	it('reports a body syntax error against the declaration', async () => {
		const message = await evaluationError('function f() { return ( ; }\n\ninputs = { k = f() }\n');
		assert.match(message, /Inline function "f" .*has an invalid body/);
		assert.match(message, /terragrunt\.hcl:1/);
	});

	it('reports a thrown error with the function and its position', async () => {
		const message = await evaluationError('function f() {\n  throw new Error("boom");\n}\n\ninputs = { k = f() }\n');
		assert.match(message, /Inline function "f" .*terragrunt\.hcl:1.* failed: boom/);
	});

	it('rejects a return value with no HCL representation', async () => {
		assert.match(
			await evaluationError('function f() { return () => 1; }\n\ninputs = { k = f() }\n'),
			/Inline function "f" return value is function, which has no HCL representation/
		);
		assert.match(
			await evaluationError('function f() { return { n: NaN }; }\n\ninputs = { k = f() }\n'),
			/Inline function "f" return value\.n is NaN, which has no HCL representation/
		);
		assert.match(
			await evaluationError('function f() {\n  const o = {};\n  o.self = o;\n  return o;\n}\n\ninputs = { k = f() }\n'),
			/circular reference, which has no HCL representation/
		);
	});

	it('supports bounded recursion and stops runaway recursion with one clear message', async () => {
		assert.deepEqual(
			await evaluateInputs([
				'function fact(n) {',
				'  if (n <= 1) return 1;',
				'  return n * await tg.call("fact", n - 1);',
				'}',
				'',
				'inputs = { f = fact(5) }'
			].join('\n')),
			{ f: 120 }
		);

		const message = await evaluationError('function loop(n) { return await tg.call("loop", n + 1); }\n\ninputs = { l = loop(0) }\n');
		assert.match(message, /Inline function "loop" exceeded maximum call depth of 128/);
		// The message names the cause once rather than one wrapper per frame.
		assert.equal(message.match(/exceeded maximum call depth/g)?.length, 1);
		assert.ok(message.length < 200, `expected a concise message, got ${message.length} characters`);
	});
});

describe('inline function language service', () => {
	it('accepts calls to declared functions and still flags unknown ones', () => {
		assert.deepEqual(diagnostics('function key(env) { return env; }\n\ninputs = { k = key("prod") }\n'), []);
		assert.deepEqual(
			diagnostics('function key(env) { return env; }\n\ninputs = { k = nope("prod") }\n'),
			['Unknown function: nope']
		);
	});

	it('checks call arity against the declared signature', () => {
		assert.deepEqual(
			diagnostics('function key(a, b) { return a; }\n\ninputs = { k = key(1) }\n'),
			['Function "key" requires at least 2 arguments']
		);
		assert.deepEqual(
			diagnostics('function key(a) { return a; }\n\ninputs = { k = key(1, 2) }\n'),
			['Function "key" accepts at most 1 argument']
		);
		assert.deepEqual(diagnostics('function key(a, b = 2) { return a; }\n\ninputs = { k = key(1) }\n'), []);
		assert.deepEqual(diagnostics('function key(a, ...rest) { return a; }\n\ninputs = { k = key(1, 2, 3) }\n'), []);
	});

	it('reports declarations the evaluator would reject', () => {
		assert.deepEqual(
			diagnostics('function join(a) { return a; }\n\ninputs = { k = 1 }\n'),
			['Inline function "join" shadows a built-in function']
		);
		assert.deepEqual(
			diagnostics('function f(a) { return a; }\nfunction f(b) { return b; }\n\ninputs = { k = 1 }\n'),
			['Inline function "f" is defined more than once']
		);
	});

	it('does not interpret a JavaScript body as HCL', () => {
		assert.deepEqual(
			diagnostics('function f(a) {\n  return not_an_hcl_function(a);\n}\n\ninputs = { k = f(1) }\n'),
			[]
		);
	});

	it('synthesizes signature metadata from the declaration', () => {
		const document = new ParsedDocument(
			new Workspace(),
			'file:///repo/terragrunt.hcl',
			'function state_key(environment: string, component: string = "app", ...tags) { return environment; }\n'
		);
		const definition = document.getInlineFunctions().get('state_key');
		assert.ok(definition, 'expected metadata for state_key');
		assert.deepEqual(
			definition.parameters.map(parameter => ({
				name: parameter.name,
				types: parameter.types,
				required: parameter.required,
				variadic: parameter.variadic === true
			})),
			[
				{ name: 'environment', types: ['string'], required: true, variadic: false },
				{ name: 'component', types: ['string'], required: false, variadic: false },
				{ name: 'tags', types: ['string', 'number', 'boolean', 'array', 'object', 'null'], required: false, variadic: true }
			]
		);
		assert.equal(document.getInlineFunctionBody('state_key'), ' return environment; ');
	});

	it('offers declared functions in expression completions, ranked before built-ins', async () => {
		const content = 'function state_key(environment) { return environment; }\n\ninputs = { k = st }\n';
		const document = new ParsedDocument(new Workspace(), 'file:///repo/terragrunt.hcl', content);
		const completions = await document.getCompletionsAtPosition({ line: 2, character: 18 });
		const inline = completions.find(item => item.label === 'state_key');
		assert.ok(inline, 'expected state_key among completions');
		assert.ok(
			String(inline.sortText).startsWith('1-'),
			`expected inline functions to sort before built-ins, got ${inline.sortText}`
		);
		const builtin = completions.find(item => item.label === 'startswith');
		if (builtin) {
			assert.ok(String(inline.sortText) < String(builtin.sortText), 'expected inline function to rank first');
		}
	});

	it('documents a declared function on hover, including its body', async () => {
		const content = 'function state_key(environment: string) { return environment; }\n\ninputs = { k = state_key("prod") }\n';
		const document = new ParsedDocument(new Workspace(), 'file:///repo/terragrunt.hcl', content);
		const hover = await document.getHoverInfo({ line: 2, character: 20 });
		assert.ok(hover, 'expected hover content');
		const value = String((hover as { value: string }).value);
		assert.match(value, /state_key\(environment: string\)/);
		assert.match(value, /Inline function defined in this configuration/);
		assert.match(value, /return environment;/);
	});
});

describe('inline functions and existing configurations', () => {
	it('leaves a configuration without declarations unchanged', () => {
		const content = [
			'locals {',
			'  region = "eu-west-1"',
			'}',
			'',
			'inputs = {',
			'  name = upper(local.region)',
			'}'
		].join('\n');
		assert.deepEqual(diagnostics(content), []);
		const document = new ParsedDocument(new Workspace(), 'file:///repo/terragrunt.hcl', content);
		assert.equal(document.getInlineFunctions().size, 0);
	});

	it('treats `function` as an ordinary identifier where a declaration cannot appear', () => {
		assert.deepEqual(
			diagnostics('locals {\n  function = "still an attribute"\n}\n'),
			[]
		);
	});
});
