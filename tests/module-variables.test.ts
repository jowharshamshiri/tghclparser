import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { formatModuleType, ModuleVariableCache, readModuleVariables, splitModuleSource, summarizeModuleType } from '../src/module-variables';

describe('Terraform module variables', () => {
	let moduleDir: string;

	beforeEach(async () => {
		moduleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-module-'));
	});

	afterEach(async () => {
		await fs.rm(moduleDir, { recursive: true, force: true });
	});

	const write = (name: string, content: string) => fs.writeFile(path.join(moduleDir, name), content);

	it('reads declarations, defaults, sensitivity and nullability from top-level files only', async () => {
		await write('variables.tf', `variable "settings" {
  description = <<-EOT
    Service
    settings
  EOT
  type = object({
    name = string
    replicas = number
  })
}

variable "tags" {
  type    = map(string)
  default = {
    team = "platform"
  }
}

variable "token" {
  type      = string
  sensitive = true
  default   = null
}

variable "region" {
  type     = string
  nullable = false
  default  = "eu-west-1"
}`);
		await fs.mkdir(path.join(moduleDir, 'sub'));
		await fs.writeFile(path.join(moduleDir, 'sub', 'nested.tf'), 'variable "nested" {}');
		await write('broken.tf', 'variable "broken" {');
		await write('.hidden.tf', 'variable "hidden" {}');

		const result = await readModuleVariables(moduleDir);

		expect(result.files.map(file => path.basename(file))).to.deep.equal(['broken.tf', 'variables.tf']);
		expect(result.variables.map(variable => variable.name)).to.deep.equal(['settings', 'tags', 'token', 'region']);

		const [settings, tags, token, region] = result.variables;
		expect(settings.description).to.equal('Service\nsettings');
		expect(settings.typeText).to.equal('object({ name = string replicas = number })');
		expect(settings.typeKind).to.equal('object');
		expect(settings.type).to.deep.equal({
			kind: 'object',
			text: 'object({ name = string replicas = number })',
			attributes: [
				{ name: 'name', type: { kind: 'primitive', name: 'string', text: 'string' }, optional: false },
				{ name: 'replicas', type: { kind: 'primitive', name: 'number', text: 'number' }, optional: false }
			]
		});
		expect(settings.hasDefault).to.equal(false);
		expect(settings.file).to.equal(path.join(moduleDir, 'variables.tf'));
		expect(settings.range.start).to.deep.equal({ line: 0, character: 0 });

		expect(tags.typeKind).to.equal('map');
		expect(tags.hasDefault).to.equal(true);
		expect(tags.defaultText).to.equal('{ team = "platform" }');

		expect(token.sensitive).to.equal(true);
		expect(token.hasDefault).to.equal(true);
		expect(token.defaultText).to.equal('null');

		expect(region.nullable).to.equal(false);
		expect(region.sensitive).to.equal(undefined);
	});

	it('reads optional attributes, collections and unknown types', async () => {
		await write('variables.tf', `variable "ipam" {
  type = object({
    enable  = optional(bool, false)
    regions = optional(list(string))
    rules   = list(object({ id = string }))
    tags    = map(any)
    pair    = tuple([string, number])
    other   = something_else
  })
}`);

		const [ipam] = (await readModuleVariables(moduleDir)).variables;

		expect(ipam.type?.kind).to.equal('object');
		if (ipam.type?.kind !== 'object') return;
		expect(ipam.type.attributes).to.deep.equal([
			{ name: 'enable', type: { kind: 'primitive', name: 'bool', text: 'bool' }, optional: true, defaultText: 'false' },
			{ name: 'regions', type: { kind: 'list', element: { kind: 'primitive', name: 'string', text: 'string' }, text: 'list(string)' }, optional: true, defaultText: undefined },
			{ name: 'rules', type: { kind: 'list', element: { kind: 'object', attributes: [{ name: 'id', type: { kind: 'primitive', name: 'string', text: 'string' }, optional: false }], text: 'object({ id = string })' }, text: 'list(object({ id = string }))' }, optional: false },
			{ name: 'tags', type: { kind: 'map', element: { kind: 'primitive', name: 'any', text: 'any' }, text: 'map(any)' }, optional: false },
			{ name: 'pair', type: { kind: 'tuple', elements: [{ kind: 'primitive', name: 'string', text: 'string' }, { kind: 'primitive', name: 'number', text: 'number' }], text: 'tuple([string, number])' }, optional: false },
			{ name: 'other', type: { kind: 'primitive', name: 'any', text: 'something_else' }, optional: false }
		]);
	});

	it('formats a type as a declaration and summarizes it in one line', async () => {
		await write('variables.tf', `variable "rules" {
  type = list(object({
    id = string
    ports = optional(list(number), [])
    target = object({ name = string, tags = map(string) })
  }))
}`);

		const [rules] = (await readModuleVariables(moduleDir)).variables;

		expect(formatModuleType(rules.type!)).to.equal([
			'list(object({',
			'  id     = string',
			'  ports  = optional(list(number), [])',
			'  target = object({',
			'    name = string',
			'    tags = map(string)',
			'  })',
			'}))'
		].join('\n'));
		expect(summarizeModuleType(rules.type!)).to.equal('list(object({…}))');
	});

	it('treats a trailing triple slash as no subdirectory', () => {
		expect(splitModuleSource('../../modules/vpc-ipam///')).to.deep.equal({ repository: '../../modules/vpc-ipam', subdirectory: '', ref: undefined, forced: undefined });
		expect(splitModuleSource('git::https://example.com/repo.git//modules/app?ref=v1')).to.deep.equal({ repository: 'https://example.com/repo.git', subdirectory: 'modules/app', ref: 'v1', forced: 'git' });
	});

	it('keeps the first declaration of a name repeated across files', async () => {
		await write('a.tf', 'variable "shared" { default = "from a" }');
		await write('b.tf', 'variable "shared" { default = "from b" }');

		const result = await readModuleVariables(moduleDir);

		expect(result.variables).to.have.length(1);
		expect(result.variables[0].defaultText).to.equal('"from a"');
		expect(path.basename(result.variables[0].file)).to.equal('a.tf');
	});

	it('serves the cached result until a file changes or is added', async () => {
		await write('variables.tf', 'variable "first" {}');
		const cache = new ModuleVariableCache();

		const initial = await cache.get(moduleDir);
		expect(await cache.get(moduleDir)).to.equal(initial);

		await write('variables.tf', 'variable "first" {}\nvariable "second" {}');
		const later = new Date(Date.now() + 5_000);
		await fs.utimes(path.join(moduleDir, 'variables.tf'), later, later);
		const edited = await cache.get(moduleDir);
		expect(edited).not.to.equal(initial);
		expect(edited.variables.map(variable => variable.name)).to.deep.equal(['first', 'second']);

		await write('outputs.tf', 'variable "third" {}');
		const added = await cache.get(moduleDir);
		expect(added).not.to.equal(edited);
		expect(added.variables.map(variable => variable.name)).to.deep.equal(['third', 'first', 'second']);
	});
});
