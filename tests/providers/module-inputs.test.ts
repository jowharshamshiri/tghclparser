import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { ParsedDocument } from '../../src/ParsedDocument';
import { Workspace } from '../../src/Workspace';

describe('module inputs from terraform source', () => {
	let directory: string;
	let workspace: Workspace;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-inputs-'));
		workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		await fs.mkdir(path.join(directory, 'modules', 'app'), { recursive: true });
		await fs.writeFile(path.join(directory, 'modules', 'app', 'variables.tf'), `variable "name" {
  description = "Service name"
  type        = string
}

variable "region" {
  type    = string
  default = "eu-west-1"
}`);
		await fs.writeFile(path.join(directory, 'modules', 'app', 'main.tf'), 'resource "null_resource" "app" {}');
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const openUnit = async (content: string, relativePath = path.join('live', 'app', 'terragrunt.hcl')): Promise<ParsedDocument> => {
		const unitPath = path.join(directory, relativePath);
		await fs.mkdir(path.dirname(unitPath), { recursive: true });
		await fs.writeFile(unitPath, content);
		const document = new ParsedDocument(workspace, URI.file(unitPath).toString(), content);
		await workspace.addDocument(document);
		return document;
	};

	const unit = (source: string, inputs: string) => `terraform {
  source = ${source}
}

inputs = {
${inputs}
}`;

	const messages = (document: ParsedDocument) => document.getDiagnostics().map(diagnostic => diagnostic.message);
	const moduleMessages = (document: ParsedDocument) => messages(document).filter(message => /module/i.test(message));

	it('warns about keys the module does not declare and required variables left unset', async () => {
		const document = await openUnit(unit('"../../modules/app"', '  nam    = "typo"\n  region = "eu-west-2"'));

		const diagnostics = document.getDiagnostics();
		expect(diagnostics.map(diagnostic => [diagnostic.message, diagnostic.severity])).to.deep.equal([
			['Input "nam" is not declared by module ../../modules/app', DiagnosticSeverity.Warning],
			['Missing required module inputs: name', DiagnosticSeverity.Warning]
		]);
		expect(diagnostics[0].range.start).to.deep.equal({ line: 5, character: 2 });
		expect(diagnostics[1].range.start).to.deep.equal({ line: 4, character: 0 });
	});

	it('reports nothing when every required variable is set and every key is declared', async () => {
		const document = await openUnit(unit('"../../modules/app"', '  name = "api"'));
		expect(messages(document)).to.deep.equal([]);
	});

	it('anchors a missing-inputs warning on the source when the unit has no inputs at all', async () => {
		const document = await openUnit('terraform {\n  source = "../../modules/app"\n}');
		const [diagnostic] = document.getDiagnostics();
		expect(diagnostic.message).to.equal('Missing required module inputs: name');
		expect(diagnostic.range.start).to.deep.equal({ line: 1, character: 11 });
	});

	it('documents a key from the module variable and summarizes the module on inputs', async () => {
		const document = await openUnit(unit('"../../modules/app"', '  name = "api"'));

		const key = await document.getHoverInfo({ line: 5, character: 3 });
		expect(key?.value).to.include('## Input: name');
		expect(key?.value).to.include('Service name');
		expect(key?.value).to.include('- *Type:* `string`');
		expect(key?.value).to.include('- *Required:* Yes');
		const variablesFile = path.join(directory, 'modules', 'app', 'variables.tf');
		expect(key?.value).to.include(`- *Declared in:* [${path.join('modules', 'app', 'variables.tf')}:1](${URI.file(variablesFile).toString()}#L1)`);

		const inputs = await document.getHoverInfo({ line: 4, character: 2 });
		expect(inputs?.value).to.include(`### Module\n\n[${path.join('modules', 'app')}](${URI.file(variablesFile).toString()})`);
		expect(inputs?.value).to.include('| Input | Type | Required | Default |');
		expect(inputs?.value).to.include('| `name` | `string` | Yes |  |');
		expect(inputs?.value).to.include('| `region` | `string` | No | `"eu-west-1"` |');
	});

	it('checks object values against the variable type down through lists and maps', async () => {
		await fs.writeFile(path.join(directory, 'modules', 'app', 'variables.tf'), `variable "ipam" {
  type = object({
    enable = optional(bool, false)
    rules  = optional(list(object({ id = string, port = optional(number) })))
    owners = optional(map(object({ email = string })))
  })
  default = {}
}`);
		const document = await openUnit(unit('"../../modules/app"', `  ipam = {
    dfgsdfgh = "sdfgd"
    enable   = true
    rules = [
      { id = "a", prot = 80 },
      { port = 443 },
    ]
    owners = {
      platform = { email = "p@example.com", phone = "1" }
      data     = {}
    }
  }`));

		const diagnostics = document.getDiagnostics();
		expect(diagnostics.map(diagnostic => [diagnostic.message, diagnostic.range.start.line, diagnostic.range.start.character])).to.deep.equal([
			['Attribute "dfgsdfgh" is not declared by input ipam', 6, 4],
			['Attribute "prot" is not declared by input ipam.rules[0]', 9, 18],
			['Missing required attributes in ipam.rules[1]: id', 10, 6],
			['Attribute "phone" is not declared by input ipam.owners["platform"]', 13, 44],
			['Missing required attributes in ipam.owners["data"]: email', 14, 6]
		]);
		expect(diagnostics.every(diagnostic => diagnostic.severity === DiagnosticSeverity.Warning)).to.equal(true);
	});

	it('leaves a nested value that is not a literal alone', async () => {
		await fs.writeFile(path.join(directory, 'modules', 'app', 'variables.tf'), `variable "ipam" {
  type = object({ enable = bool })
  default = { enable = false }
}`);
		const document = await openUnit(unit('"../../modules/app"', '  ipam = merge(local.defaults, { enable = true })'));
		expect(messages(document)).to.deep.equal([]);
	});

	it('documents a nested key from the variable type and shows an object type as a block', async () => {
		await fs.writeFile(path.join(directory, 'modules', 'app', 'variables.tf'), `variable "ipam" {
  type = object({
    enable            = optional(bool, false)
    operating_regions = optional(list(string))
  })
  default = {}
}`);
		const document = await openUnit(unit('"../../modules/app"', '  ipam = {\n    operating_regions = []\n  }'));

		const nested = await document.getHoverInfo({ line: 6, character: 6 });
		expect(nested?.value).to.include('## Input: ipam.operating_regions');
		expect(nested?.value).to.include('- *Type:* `list(string)`');
		expect(nested?.value).to.include('- *Required:* No');

		const top = await document.getHoverInfo({ line: 5, character: 3 });
		expect(top?.value).to.include('```hcl\nobject({\n  enable            = optional(bool, false)\n  operating_regions = optional(list(string))\n})\n```');
		expect(top?.value).not.to.include('- *Type:*');
	});

	it('completes nested object attributes from the module type and skips keys already written', async () => {
		await fs.writeFile(path.join(directory, 'modules', 'app', 'variables.tf'), `variable "name" {
  type = string
}

variable "ipam" {
  type = object({
    enable            = optional(bool, false)
    description       = optional(string)
    operating_regions = optional(list(string))
  })
  default = {}
}`);
		const document = await openUnit(unit('"../../modules/app"', '  name = "api"\n  ipam = {\n    enable = true\n    \n  }'));
		const items = await document.getCompletionsAtPosition({ line: 8, character: 4 });
		expect(items.map(item => item.label)).to.deep.equal(['description', 'operating_regions']);
		expect(items[0].detail).to.equal('string · optional');
	});

	it('links the source to the module variables file', async () => {
		const document = await openUnit(unit('"../../modules/app"', '  name = "api"'));
		const links = await document.getLinks();
		expect(links.map(link => URI.parse(link.target!).fsPath)).to.deep.equal([path.join(directory, 'modules', 'app', 'variables.tf')]);
	});

	it('resolves the source through terragrunt and repository path functions and locals', async () => {
		await fs.mkdir(path.join(directory, '.git'));
		const sources = [
			'"${get_terragrunt_dir()}/../../modules/app"',
			'"${get_repo_root()}/modules/app"',
			'"${local.base}/app"',
			'"../../modules//app"',
			'"${get_path_to_repo_root()}/modules/app///"'
		];
		for (const source of sources) {
			const document = await openUnit(`locals {\n  base = "../../modules"\n}\n\n${unit(source, '  region = "x"')}`);
			expect(moduleMessages(document), source).to.deep.equal(['Missing required module inputs: name']);
		}
	});

	it('is silent for a remote source', async () => {
		const document = await openUnit(unit('"tfr:///terraform-aws-modules/vpc/aws?version=5.0.0"', '  anything = true'));
		expect(document.getModuleVariables()).to.equal(undefined);
		expect(moduleMessages(document)).to.deep.equal([]);
	});

	it('warns on a local source directory that does not exist', async () => {
		const document = await openUnit(unit('"../../modules/missing"', '  anything = true'));
		const diagnostics = document.getDiagnostics();
		expect(diagnostics.map(diagnostic => [diagnostic.message, diagnostic.severity])).to.deep.equal([
			[`Local module source not found: ${path.join(directory, 'modules', 'missing')}`, DiagnosticSeverity.Warning]
		]);
		expect(diagnostics[0].range.start).to.deep.equal({ line: 1, character: 11 });
	});

	it('warns on a missing module directory named by an included configuration, on the unit', async () => {
		await fs.writeFile(path.join(directory, 'root.hcl'), 'terraform {\n  source = "${get_terragrunt_dir()}/../../modules/missing"\n}');
		const document = await openUnit(`include "root" {
  path = find_in_parent_folders("root.hcl")
}`);
		const diagnostics = document.getDiagnostics();
		expect(diagnostics.map(diagnostic => [diagnostic.message, diagnostic.severity])).to.deep.equal([
			[`Local module source not found: ${path.join(directory, 'modules', 'missing')}`, DiagnosticSeverity.Warning]
		]);
		expect(diagnostics[0].range.start).to.deep.equal({ line: 0, character: 0 });
	});

	it('takes the source and required inputs from an included root configuration', async () => {
		await fs.mkdir(path.join(directory, '.git'));
		await fs.writeFile(path.join(directory, 'root.hcl'), `terraform {
  source = "\${get_repo_root()}/modules/app"
}

inputs = {
  name = "shared"
}`);
		const document = await openUnit(`include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  region = "eu-west-2"
  extra  = 1
}`);
		expect(moduleMessages(document)).to.deep.equal(['Input "extra" is not declared by module ../../modules/app']);
	});

	it('does not report coverage when an included configuration merges its inputs', async () => {
		await fs.writeFile(path.join(directory, 'root.hcl'), `locals {
  common = { name = "shared" }
}

inputs = merge(local.common, { region = "eu-west-1" })`);
		const document = await openUnit(`include "root" {
  path = find_in_parent_folders("root.hcl")
}

${unit('"../../modules/app"', '  extra = 1')}`);
		expect(moduleMessages(document)).to.deep.equal(['Input "extra" is not declared by module ../../modules/app']);
	});

	it('says why required inputs are not checked when an included configuration cannot be parsed', async () => {
		await fs.writeFile(path.join(directory, 'root.hcl'), 'inputs = { name = "shared"\n');
		const document = await openUnit(`include "root" {
  path = find_in_parent_folders("root.hcl")
}

${unit('"../../modules/app"', '  region = "eu-west-2"')}`);
		expect(moduleMessages(document)).to.deep.equal([
			'Required module inputs are not checked: ../../root.hcl does not parse, so the inputs it sets are unknown'
		]);
	});

	it('leaves a merged inputs value alone', async () => {
		const document = await openUnit(unit('"../../modules/app"', '').replace(/inputs = \{\n\n\}/, 'inputs = merge({}, { extra = 1 })'));
		expect(moduleMessages(document)).to.deep.equal([]);
	});

	it('does not treat an included configuration opened on its own as a unit', async () => {
		const document = await openUnit(unit('"../../modules/app"', '  extra = 1'), path.join('live', 'app', 'root.hcl'));
		expect(document.getModuleVariables()).to.equal(undefined);
		expect(moduleMessages(document)).to.deep.equal([]);
	});

	describe('a module file that does not parse', () => {
		beforeEach(async () => {
			await fs.writeFile(path.join(directory, 'modules', 'app', 'extra.tf'), 'variable "tier" {\n  type = string\n  broken = $\n}');
		});

		it('names the file and stops calling inputs undeclared, since it may declare them', async () => {
			const document = await openUnit(unit('"../../modules/app"', '  name = "api"\n  tier = "gold"'));
			expect(moduleMessages(document)).to.deep.equal([
				'Module file ../../modules/app/extra.tf does not parse (line 3, column 12: unexpected "$"); the variables it declares are unknown, so undeclared inputs are not reported'
			]);
		});

		it('still reports required variables that were read and left unset', async () => {
			const document = await openUnit(unit('"../../modules/app"', '  tier = "gold"'));
			expect(moduleMessages(document)).to.include('Missing required module inputs: name');
		});

		it('names a file the grammar rejects by its own checks, not only by syntax', async () => {
			await fs.writeFile(path.join(directory, 'modules', 'app', 'extra.tf'), 'variable "tier" {\n  type = string\n  type = number\n}');
			const document = await openUnit(unit('"../../modules/app"', '  name = "api"\n  tier = "gold"'));
			expect(moduleMessages(document)).to.deep.equal([
				'Module file ../../modules/app/extra.tf does not parse (Attribute redefined: type); the variables it declares are unknown, so undeclared inputs are not reported'
			]);
		});

		it('says on the inputs hover that the module list may be incomplete', async () => {
			const document = await openUnit(unit('"../../modules/app"', '  name = "api"'));
			const inputs = await document.getHoverInfo({ line: 4, character: 2 });
			expect(inputs?.value).to.include('*`modules/app/extra.tf` does not parse, so this list may be incomplete: line 3, column 12: unexpected "$"*');
		});
	});

	describe('merging includes the way Terragrunt does', () => {
		beforeEach(async () => {
			await fs.mkdir(path.join(directory, 'modules', 'other'), { recursive: true });
			await fs.writeFile(path.join(directory, 'modules', 'other', 'variables.tf'), 'variable "size" {\n  type = number\n}');
		});

		const include = (name: string, file: string, strategy?: string) => `include "${name}" {
  path = "\${get_terragrunt_dir()}/../../${file}"${strategy === undefined ? '' : `\n  merge_strategy = ${strategy}`}
}`;
		const moduleOf = (document: ParsedDocument) => {
			const state = document.getModuleVariables();
			return state?.status === 'loaded' ? path.relative(directory, state.moduleDir) : state?.status;
		};

		it('does not count the inputs of an include with no_merge', async () => {
			await fs.writeFile(path.join(directory, 'root.hcl'), 'inputs = {\n  name = "shared"\n}');
			const document = await openUnit(`${include('root', 'root.hcl', '"no_merge"')}\n\n${unit('"../../modules/app"', '  region = "eu-west-2"')}`);
			expect(moduleMessages(document)).to.deep.equal(['Missing required module inputs: name']);
		});

		it('does not take the source of an include with no_merge', async () => {
			await fs.writeFile(path.join(directory, 'root.hcl'), 'terraform {\n  source = "${get_terragrunt_dir()}/../../modules/app"\n}');
			const document = await openUnit(`${include('root', 'root.hcl', '"no_merge"')}\n\ninputs = {\n  anything = 1\n}`);
			expect(document.getModuleVariables()).to.equal(undefined);
			expect(moduleMessages(document)).to.deep.equal([]);
		});

		it('takes the source of the last include that sets one, and the unit\'s over every include', async () => {
			await fs.writeFile(path.join(directory, 'first.hcl'), 'terraform {\n  source = "${get_terragrunt_dir()}/../../modules/app"\n}');
			await fs.writeFile(path.join(directory, 'second.hcl'), 'terraform {\n  source = "${get_terragrunt_dir()}/../../modules/other"\n}');
			const fromIncludes = await openUnit(`${include('first', 'first.hcl')}\n${include('second', 'second.hcl')}`);
			expect(moduleOf(fromIncludes)).to.equal(path.join('modules', 'other'));
			const fromUnit = await openUnit(`${include('first', 'first.hcl')}\n${include('second', 'second.hcl')}\n\nterraform {\n  source = "../../modules/app"\n}`, path.join('live', 'unit', 'terragrunt.hcl'));
			expect(moduleOf(fromUnit)).to.equal(path.join('modules', 'app'));
		});

		it('counts the inputs of shallow and deep includes alike', async () => {
			await fs.writeFile(path.join(directory, 'root.hcl'), 'inputs = {\n  name = "shared"\n}');
			const document = await openUnit(`${include('root', 'root.hcl', '"deep"')}\n\n${unit('"../../modules/app"', '  region = "eu-west-2"')}`);
			expect(moduleMessages(document)).to.deep.equal([]);
		});

		it('takes the source and inputs of the sibling autoinclude over the unit\'s', async () => {
			await fs.mkdir(path.join(directory, 'live', 'app'), { recursive: true });
			await fs.writeFile(path.join(directory, 'live', 'app', 'terragrunt.autoinclude.hcl'), 'terraform {\n  source = "../../modules/other"\n}\n\ninputs = {\n  size = 3\n}');
			const document = await openUnit(unit('"../../modules/app"', '  name = "api"'));
			expect(moduleOf(document)).to.equal(path.join('modules', 'other'));
			expect(moduleMessages(document)).to.deep.equal(['Input "name" is not declared by module ../../modules/other']);
		});

		it('refuses an included configuration with includes of its own, as Terragrunt does', async () => {
			await fs.writeFile(path.join(directory, 'base.hcl'), 'inputs = {}');
			await fs.writeFile(path.join(directory, 'root.hcl'), 'include "base" {\n  path = "base.hcl"\n}');
			const document = await openUnit(`${include('root', 'root.hcl')}\n\n${unit('"../../modules/app"', '  name = "api"')}`);
			expect(moduleMessages(document)).to.deep.equal([
				'Module inputs are not checked: ../../root.hcl, included by include "root", has include blocks of its own; Terragrunt does not support nested includes'
			]);
		});

		it('refuses merge_strategy "deep_map_only" and unknown strategies, as Terragrunt does', async () => {
			await fs.writeFile(path.join(directory, 'root.hcl'), 'inputs = {}');
			const deepMapOnly = await openUnit(`${include('root', 'root.hcl', '"deep_map_only"')}\n\n${unit('"../../modules/app"', '  name = "api"')}`);
			expect(moduleMessages(deepMapOnly)).to.deep.equal([
				'Module inputs are not checked: include "root" uses merge_strategy "deep_map_only", which Terragrunt does not support on include blocks'
			]);
			const unknown = await openUnit(`${include('root', 'root.hcl', '"sideways"')}\n\n${unit('"../../modules/app"', '  name = "api"')}`, path.join('live', 'unit', 'terragrunt.hcl'));
			expect(moduleMessages(unknown)).to.deep.equal([
				'Module inputs are not checked: include "root" has merge_strategy "sideways", which is not one of no_merge, shallow or deep'
			]);
		});

		it('says why when a merge strategy is an expression it cannot read', async () => {
			await fs.writeFile(path.join(directory, 'root.hcl'), 'inputs = {}');
			const document = await openUnit(`locals {\n  strategy = "deep"\n}\n\n${include('root', 'root.hcl', 'local.strategy')}\n\n${unit('"../../modules/app"', '  name = "api"')}`);
			expect(moduleMessages(document)).to.deep.equal([
				'Module inputs are not checked: include "root" sets merge_strategy with an expression, so whether its source and inputs are merged cannot be determined'
			]);
		});
	});

	it('says why when the module source cannot be resolved', async () => {
		const document = await openUnit(`locals {\n  src = "../../modules/app"\n}\n\n${unit('local.src', '  name = "api"')}`);
		expect(moduleMessages(document)).to.deep.equal([
			'Module inputs are not checked: the module source could not be resolved: Unsupported path expression for workspace graph resolution: local_reference'
		]);
		const inputs = await document.getHoverInfo({ line: 8, character: 2 });
		expect(inputs?.value).to.include('### Module\n\nInputs are not checked: the module source could not be resolved');
	});

	it('says why when the module cannot be read', async function () {
		if (process.getuid?.() === 0) this.skip();
		const variables = path.join(directory, 'modules', 'app', 'variables.tf');
		await fs.chmod(variables, 0o000);
		try {
			const document = await openUnit(unit('"../../modules/app"', '  name = "api"'));
			expect(moduleMessages(document)).to.have.length(1);
			expect(moduleMessages(document)[0]).to.match(/^Module inputs are not checked: module .*modules\/app could not be read: EACCES: permission denied, open '.*variables\.tf'$/);
		} finally {
			await fs.chmod(variables, 0o644);
		}
	});
});
