import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { safeKnownPrefix } from '../src/cty-strings';
import { ConfigEvaluator } from '../src/Evaluator';
import { base64GzipCompat } from '../src/gzip-compat';
import { plainValue } from './plain-values';

// Every expected value and message here is what Terragrunt v1.2.2 gave for the same configuration.

const evaluate = (content: string, experiments: string[] = []) =>
	new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true, experiments })
		.evaluateUnit('/repo/app/terragrunt.hcl', content, '/repo/app');

const inputsOf = async (inputs: Record<string, string>, experiments: string[] = []) => {
	const body = Object.entries(inputs).map(([name, expression]) => `  ${name} = ${expression}`).join('\n');
	const result = await evaluate(`inputs = {\n${body}\n}\n`, experiments);
	expect(result.error).to.equal(undefined);
	return plainValue(result.inputs!) as Record<string, unknown>;
};

const failureOf = async (expression: string, experiments: string[] = []) => {
	const result = await evaluate(`inputs = {\n  x = ${expression}\n}\n`, experiments);
	expect(result.error, expression).to.be.a('string');
	return result.error!;
};

describe('OpenTofu functions of Terragrunt v1.2.2', () => {
	it('assumes equality, converting the actual value to the assumed one\'s type', async () => {
		expect(await inputsOf({
			equal: 'assumeequal("1", 1)',
			tuple: 'assumeequal(["a"], ["a"])',
			drops_secret: 'issensitive(assumeequal(sensitive("a"), "a"))',
			keeps_secret: 'issensitive(assumeequal("a", sensitive("a")))'
		})).to.deep.equal({ equal: 1, tuple: ['a'], drops_secret: false, keeps_secret: true });
		expect(await failureOf('assumeequal("a", "b")')).to.include('Invalid value for "actual_value" parameter: the actual value does not match the assumed value.');
		expect(await failureOf('assumeequal(["a"], "b")')).to.include('actual value type tuple does not match assumed value type string');
	});

	it('assumes a value is not null, and refuses the null keyword for having no type', async () => {
		expect(await inputsOf({ string: 'assumenotnull("x")', list: 'assumenotnull(["a"])' })).to.deep.equal({ string: 'x', list: ['a'] });
		expect(await failureOf('assumenotnull(null)')).to.include('given value must have a known type; consider using the \\"convert\\" function to specify a type to assume');
	});

	it('assumes a string prefix, comparing only the part of the prefix no later character could change', async () => {
		expect(await inputsOf({
			prefix: 'assumestringprefix("abc", "ab")',
			last_unsure: 'assumestringprefix("axc", "ab")',
			shorter: 'assumestringprefix("ab", "abc/")',
			number: 'assumestringprefix(12, "1")',
			nothing: 'assumestringprefix(null, "ab")',
			accent_unsure: 'assumestringprefix("zzz", "é")',
			secret: 'issensitive(assumestringprefix(sensitive("abc"), "a"))'
		})).to.deep.equal({ prefix: 'abc', last_unsure: 'axc', shorter: 'ab', number: '12', nothing: null, accent_unsure: 'zzz', secret: true });
		for (const call of ['assumestringprefix("xbc", "ab")', 'assumestringprefix("ab", "a/")', 'assumestringprefix("zzz", "é/")']) {
			expect(await failureOf(call), call).to.include('Invalid value for "value" parameter: assumption was not upheld.');
		}
		expect(await failureOf('assumestringprefix(["a"], "a")')).to.include('Invalid value for "value" parameter: string required.');
	});

	it('keeps a delimiter at the end of a prefix and drops any other last character, as go-cty does', () => {
		expect(safeKnownPrefix('ab')).to.equal('a');
		expect(safeKnownPrefix('a/')).to.equal('a/');
		expect(safeKnownPrefix('arn:aws:iam::')).to.equal('arn:aws:iam::');
		expect(safeKnownPrefix('é')).to.equal('');
		expect(safeKnownPrefix('éx')).to.equal('é');
		expect(safeKnownPrefix('')).to.equal('');
	});

	it('assumes collection lengths, converting to a list, set or map first', async () => {
		expect(await inputsOf({
			list: 'assumelistlength(["a", 1], 0, 5)',
			list_min_negative: 'assumelistlengthmin(["a"], -3)',
			list_max: 'assumelistlengthmax(["a", "b"], 2)',
			set: 'assumesetlength(["b", "a", "b"], 2, 2)',
			set_min: 'assumesetlengthmin(["c", "a"], 2)',
			map: 'assumemaplength({ a = 1, b = "x" }, 2, 2)',
			map_max: 'assumemaplengthmax({}, 0)'
		})).to.deep.equal({
			list: ['a', '1'],
			list_min_negative: ['a'],
			list_max: ['a', 'b'],
			set: ['a', 'b'],
			set_min: ['a', 'c'],
			map: { a: '1', b: 'x' },
			map_max: {}
		});
		for (const call of [
			'assumelistlength(["a"], 2, 3)',
			'assumelistlength(["a", "b", "c", "d"], 2, 3)',
			'assumelistlengthmax(["a"], -1)',
			'assumelistlength([], 3, 1)',
			'assumelistlength(null, 0, 3)',
			'assumesetlengthmax(["a", "b", "c"], 2)',
			'assumesetlength(["a", "a"], 2, 2)',
			'assumemaplengthmin({ a = 1 }, 2)'
		]) {
			expect(await failureOf(call), call).to.include('Invalid value for "value" parameter: assumption was not upheld.');
		}
		expect(await failureOf('assumelistlength(["a"], 0.5, 3)')).to.include('Invalid value for "min_length" parameter: must be a whole number between 0 and 9223372036854775807.');
		expect(await failureOf('assumelistlengthmin(["a"], 0.5)')).to.include('Invalid value for "value" parameter: must be a whole number between 0 and 9223372036854775807.');
		expect(await failureOf('assumelistlength({ a = 1 }, 0, 3)')).to.include('Invalid value for "value" parameter: list of any single type required.');
		expect(await failureOf('assumelistlength(["a", {}], 0, 3)')).to.include('list of any single type required');
		expect(await failureOf('assumemaplength(["a"], 0, 3)')).to.include('map of any single type required');
		expect(await failureOf('assumemaplength({ a = "x", b = ["y"] }, 0, 3)')).to.include('map of any single type required');
	});

	it('reports only a value\'s own sensitivity, and passes values through ephemeralasnull', async () => {
		expect(await inputsOf({
			sensitive: 'issensitive(sensitive("a"))',
			plain: 'issensitive("a")',
			element: 'issensitive(["a", sensitive("b")])',
			nothing: 'issensitive(null)',
			ephemeral: 'ephemeralasnull("x")',
			ephemeral_null: 'ephemeralasnull(null)',
			ephemeral_secret: 'issensitive(ephemeralasnull(sensitive("x")))'
		})).to.deep.equal({ sensitive: true, plain: false, element: false, nothing: false, ephemeral: 'x', ephemeral_null: null, ephemeral_secret: true });
	});

	it('refuses every call to list and map, which Terraform v0.12 removed', async () => {
		expect(await failureOf('list(1, 2)')).to.include('the "list" function was deprecated in Terraform v0.12 and is not available in OpenTofu; use tolist([ ... ]) syntax to write a literal list');
		expect(await failureOf('map("a", 1)')).to.include('the "map" function was deprecated in Terraform v0.12 and is not available in OpenTofu; use tomap({ ... }) syntax to write a literal map');
		expect(await failureOf('list()')).to.include('the "list" function was deprecated');
	});

	it('decodes gzip, URLs and CIDR containment as Go does', async () => {
		expect(await inputsOf({
			gunzipped: 'base64gunzip("H4sIAAAAAAAA/8pIzcnJBwQAAP//hqYQNgUAAAA=")',
			url: 'urldecode("a+b%20c%2Fd")',
			cidr_address: 'cidrcontains("10.0.0.0/8", "10.1.2.3")',
			cidr_prefix: 'cidrcontains("10.0.0.0/8", "10.1.0.0/16")',
			cidr_wider: 'cidrcontains("10.0.0.0/16", "10.0.0.0/8")',
			cidr_ipv6: 'cidrcontains("fd00::/8", "fd00::1")',
			cidr_mapped: 'cidrcontains("1.2.3.0/24", "::ffff:1.2.3.4")',
			cidr_zeros: 'cidrcontains("010.0.0.0/8", "10.0.0.1")'
		})).to.deep.equal({
			gunzipped: 'hello',
			url: 'a b c/d',
			cidr_address: true,
			cidr_prefix: true,
			cidr_wider: false,
			cidr_ipv6: true,
			cidr_mapped: true,
			cidr_zeros: true
		});
		expect(await failureOf('base64gunzip("aGVsbG8=")')).to.include('failed to gunzip bytestream');
		expect(await failureOf('base64gunzip("not base64")')).to.include('failed to decode base64 data not base64');
		expect(await failureOf('urldecode("%zz")')).to.include('failed to decode URL \'\': invalid URL escape "%zz"');
		expect(await failureOf('cidrcontains("10.0.0.0/8", "fd00::1")')).to.include('address family mismatch: 10.0.0.0/8 vs. fd00::1');
		expect(await failureOf('cidrcontains("10.0.0.0/8", "nope")')).to.include('invalid IP address or prefix: nope');
		expect(await failureOf('cidrcontains("10.0.0.1", "10.0.0.1")')).to.include('invalid CIDR address: 10.0.0.1');
	});

	it('renders a template string, giving a lone interpolation\'s value as it is', async () => {
		expect(await inputsOf({
			template: 'templatestring("Hello, $${name}!", { name = "world" })',
			value: 'templatestring("$${count}", { count = 5 })'
		})).to.deep.equal({ template: 'Hello, world!', value: 5 });
		expect(await failureOf('templatestring("a", ["x"])')).to.include('Invalid value for "vars" parameter: invalid vars value: must be a map.');
		await failureOf('templatestring("$${x}", {})');
	});

	it('renders a template file the same way, as both render through one template renderer', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclp-template-'));
		try {
			await fs.writeFile(path.join(directory, 'count.tpl'), '${count}');
			await fs.writeFile(path.join(directory, 'line.tpl'), 'count: ${count}');
			const result = await new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
				.evaluateUnit(path.join(directory, 'terragrunt.hcl'), 'inputs = {\n  value = templatefile("count.tpl", { count = 5 })\n  line  = templatefile("line.tpl", { count = 5 })\n}\n', directory);
			expect(result.error).to.equal(undefined);
			expect(plainValue(result.inputs!)).to.deep.equal({ value: 5, line: 'count: 5' });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	// A template a function renders converts its interpolations as a quoted string does: one that is a single
	// interpolation passes its value through, and any other refuses null and collections in HCL's words.
	describe('template values', () => {
		const nullValue = 'The expression result is null. Cannot include a null value in a string template.';
		const tuple = 'Cannot include the given value in a string template: string required, but have tuple.';
		const object = 'Cannot include the given value in a string template: string required, but have object.';

		it('refuses null and collections in a longer template string', async () => {
			for (const [call, message] of [
				['templatestring("a$${x}", { x = null })', nullValue],
				['templatestring("a$${x}", { x = ["b"] })', tuple],
				['templatestring("a$${x}", { x = { b = 1 } })', object],
				['templatestring(" $${~ x }", { x = ["b"] })', tuple]
			]) {
				expect(await failureOf(call), call).to.include(message);
			}
		});

		it('refuses them in a directive\'s branch or loop, each a template of its own', async () => {
			for (const [call, message] of [
				['templatestring("%%{ if true }$${x}%%{ endif }", { x = ["b"] })', tuple],
				['templatestring("%%{ if true }$${x}%%{ endif }", { x = null })', nullValue],
				['templatestring("%%{ for v in x }$${v}%%{ endfor }", { x = [null] })', nullValue],
				['templatestring("%%{ for v in x }$${v}%%{ endfor }", { x = [["a"]] })', tuple]
			]) {
				expect(await failureOf(call), call).to.include(message);
			}
			expect(await inputsOf({
				branch: 'templatestring("%%{ if true }$${x}%%{ endif }", { x = 2 })',
				loop: 'templatestring("%%{ for v in x }$${v}%%{ endfor }", { x = ["a", 1] })'
			})).to.deep.equal({ branch: '2', loop: 'a1' });
		});

		it('converts numbers and bools, and passes a lone interpolation\'s value through', async () => {
			expect(await inputsOf({
				longer: 'templatestring("a$${x}b$${y}", { x = 2, y = true })',
				tuple: 'templatestring("$${x}", { x = ["b"] })',
				nothing: 'templatestring("$${x}", { x = null })',
				stripped: 'templatestring("$${~ x ~}", { x = ["b"] })'
			})).to.deep.equal({ longer: 'a2btrue', tuple: ['b'], nothing: null, stripped: ['b'] });
		});

		it('takes a strip marker on either side of an interpolation or directive out of its expression', async () => {
			expect(await inputsOf({
				interpolation: 'templatestring("a $${~ x ~} b", { x = "c" })',
				branch: 'templatestring("a %%{~ if true ~} b %%{~ endif ~} c", {})',
				loop: 'templatestring("[ %%{~ for v in x ~} $${v} %%{~ endfor ~} ]", { x = ["a", "b"] })'
			})).to.deep.equal({ interpolation: 'acb', branch: 'abc', loop: '[ab]' });
		});

		it('keeps a sensitive value sensitive, passed through or rendered into a string', async () => {
			expect(await inputsOf({
				rendered: 'issensitive(templatestring("a$${x}", { x = sensitive("b") }))',
				passed: 'issensitive(templatestring("$${x}", { x = sensitive(["b"]) }))',
				looped: 'issensitive(templatestring("%%{ for v in x }$${v}%%{ endfor }", { x = [sensitive("a")] }))'
			})).to.deep.equal({ rendered: true, passed: true, looped: true });
		});

		it('holds a template file to the same, and reads $${ and %%{ in it as a literal ${ and %{', async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclp-template-'));
			try {
				await fs.writeFile(path.join(directory, 't.tpl'), 'a${x}b');
				await fs.writeFile(path.join(directory, 'lone.tpl'), '${x}');
				await fs.writeFile(path.join(directory, 'if.tpl'), '%{ if true }${x}%{ endif }');
				await fs.writeFile(path.join(directory, 'for.tpl'), '%{ for v in x }${v}%{ endfor }');
				await fs.writeFile(path.join(directory, 'escaped.tpl'), 'a$${x}%%{ if true }');
				const evaluateIn = (expression: string) => new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true })
					.evaluateUnit(path.join(directory, 'terragrunt.hcl'), `inputs = {\n  x = ${expression}\n}\n`, directory);
				for (const [call, message] of [
					['templatefile("t.tpl", { x = null })', nullValue],
					['templatefile("t.tpl", { x = ["b"] })', tuple],
					['templatefile("t.tpl", { x = { b = 1 } })', object],
					['templatefile("if.tpl", { x = null })', nullValue],
					['templatefile("if.tpl", { x = ["b"] })', tuple],
					['templatefile("for.tpl", { x = [{ a = 1 }] })', object],
					['templatefile("for.tpl", { x = [null] })', nullValue]
				]) {
					const result = await evaluateIn(call);
					expect(result.error, call).to.be.a('string').and.include(message);
				}
				for (const [call, value] of [
					['templatefile("lone.tpl", { x = ["b"] })', ['b']],
					['templatefile("lone.tpl", { x = null })', null],
					['templatefile("lone.tpl", { x = { b = 1 } })', { b: 1 }],
					['templatefile("escaped.tpl", { x = "b" })', 'a${x}%{ if true }']
				] as const) {
					const result = await evaluateIn(call);
					expect(result.error, call).to.equal(undefined);
					expect((plainValue(result.inputs!) as Record<string, unknown>).x, call).to.deep.equal(value);
				}
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	});
});

describe('base64gzip_compat of Terragrunt v1.2.2', () => {
	const digests = Array.from({ length: 1024 }, (_, index) => `${index}-${createHash('md5').update(String(index)).digest('hex')};`).join('');
	const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

	it('writes the gzip stream base64gzip wrote in Terragrunt v1.1.3', () => {
		expect(base64GzipCompat('')).to.equal('H4sIAAAAAAAA/wAAAP//AQAA//8AAAAAAAAAAA==');
		expect(base64GzipCompat('hello')).to.equal('H4sIAAAAAAAA/8pIzcnJBwAAAP//AQAA//+GphA2BQAAAA==');
		expect(base64GzipCompat('hello hello hello hello hello hello')).to.equal('H4sIAAAAAAAA/8pIzcnJV8BLAgAAAP//AQAA//9XN2KFIwAAAA==');
		expect(base64GzipCompat('abcab'.repeat(400))).to.equal('H4sIAAAAAAAA/0pMSk5MGiVGiVFilBglRolRYkgTAAAAAP//AQAA///kCZkM0AcAAA==');
		expect(base64GzipCompat('héllo wörld ✓ héllo wörld ✓')).to.equal('H4sIAAAAAAAA/8o4vDInJ1+h/PC2opwUhUdzJitgiAAAAAD//wEAAP//oK4tMSMAAAA=');
	});

	it('writes dynamic blocks, and slides its window over input larger than it, as Terragrunt does', () => {
		const once = base64GzipCompat(digests);
		expect(once.length).to.equal(26956);
		expect(sha256(once)).to.equal('7fecadc5f0fb835b82c41b086ef34a79fdb9d6d42383a62cc4edd1451eb00135');
		const thrice = base64GzipCompat(digests.repeat(3));
		expect(thrice.length).to.equal(81084);
		expect(sha256(thrice)).to.equal('1fdac1967584519c94841e27e39ebdcace81a6aac51d8821ac7a4f8cc919f8f5');
	});

	it('is called only with the base64gzip-compat experiment', async () => {
		expect(await failureOf('base64gzip_compat("hello")')).to.include('base64gzip_compat in /repo/app/terragrunt.hcl requires the \'base64gzip-compat\' experiment; enable it with --experiment base64gzip-compat');
		expect(await inputsOf({ compressed: 'base64gzip_compat("hello")' }, ['base64gzip-compat'])).to.deep.equal({
			compressed: 'H4sIAAAAAAAA/8pIzcnJBwAAAP//AQAA//+GphA2BQAAAA=='
		});
	});
});
