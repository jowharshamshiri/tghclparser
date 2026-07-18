import { expect } from 'chai';

import { ParsedDocument } from '../../src/ParsedDocument';
import { Schema } from '../../src/Schema';
import { Workspace } from '../../src/Workspace';

const diagnosticsFor = (uri: string, content: string) => {
	const document = new ParsedDocument(new Workspace(), uri, content);
	return document.getDiagnostics().map(diagnostic => diagnostic.message);
};

describe('current Terragrunt schema', () => {
	it('accepts a labeled include with an explicit parent filename', () => {
		const messages = diagnosticsFor('file:///repo/app/terragrunt.hcl', `include "root" {
  path = find_in_parent_folders("root.hcl")
}`);
		expect(messages).to.deep.equal([]);
	});

	it('accepts literal braces, dollars, and percentages alongside quoted-string interpolation', () => {
		const messages = diagnosticsFor('file:///repo/root.hcl', `locals {
  region = "eu-west-1"
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = "provider \\"aws\\" { region = \\"\${local.region}\\"; budget = \\"$5 at 100%\\" }"
}`);
		expect(messages).to.deep.equal([]);
	});

	it('rejects bare includes and implicit parent filename lookup', () => {
		const messages = diagnosticsFor('file:///repo/app/terragrunt.hcl', `include {
  path = find_in_parent_folders()
}`);
		expect(messages).to.include('Block "include" requires 1 label');
		expect(messages).to.include('Function "find_in_parent_folders" requires at least 1 argument');
	});

	it('accepts explicit stacks, component path references, and autoinclude dependencies', () => {
		const messages = diagnosticsFor('file:///repo/terragrunt.stack.hcl', `locals {
  environment = "production"
}

unit "network" {
  source = "../catalog/network"
  path   = "network"
}

unit "app" {
  source = "../catalog/app"
  path   = "app"
  values = { network_path = unit.network.path }

  autoinclude {
    dependency "network" {
      config_path = unit.network.path
    }
    inputs = { network_id = dependency.network.outputs.id }
  }
}`);
		expect(messages).to.deep.equal([]);
	});

	it('rejects unit-only blocks at stack root', () => {
		const messages = diagnosticsFor('file:///repo/terragrunt.stack.hcl', 'terraform { source = "../module" }');
		expect(messages).to.include('Unknown block type: terraform');
	});

	it('enforces stack include semantics without unit include compatibility', () => {
		const messages = diagnosticsFor('file:///repo/terragrunt.stack.hcl', `include "shared" {
  path   = "shared.stack.hcl"
  expose = true
}`);
		expect(messages).to.include('Unknown attribute "expose" in include block');
	});

	it('treats terragrunt.values.hcl as arbitrary root attributes', () => {
		const messages = diagnosticsFor('file:///repo/terragrunt.values.hcl', 'region = "eu-west-1"\nreplicas = 3');
		expect(messages).to.deep.equal([]);
	});

	it('does not expose removed legacy schema entries', () => {
		const schema = Schema.getInstance();
		expect(schema.getBlockDefinition('retry')).to.equal(undefined);
		expect(schema.getBlockDefinition('download_dir')).to.equal(undefined);
		expect(schema.getRootAttributeDefinitions('file:///repo/terragrunt.hcl').map(attribute => attribute.name)).not.to.include.members([
			'skip',
			'retryable_errors'
		]);
		expect(schema.getFunctionDefinition('get_terraform_commands_that_need_retry')).to.equal(undefined);
		expect(schema.getFunctionDefinition('path.join')).to.equal(undefined);
	});
});
