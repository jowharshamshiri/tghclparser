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

	it('retains broad current function and block metadata', () => {
		const schema = Schema.getInstance();
		expect(schema.getAllFunctions()).to.have.length.greaterThan(130);
		expect(schema.getAllBlockTemplates().map(block => block.type)).to.include.members([
			'unit', 'stack', 'autoinclude', 'catalog', 'engine', 'feature', 'exclude', 'errors', 'dependency', 'generate'
		]);
		for (const name of ['coalescelist', 'join', 'keys', 'length', 'mark_glob_as_read', 'md5', 'sha1', 'sha256', 'sha512', 'signum', 'sum', 'title']) {
			const definition = schema.getFunctionDefinition(name);
			expect(definition, `${name} metadata`).not.to.equal(undefined);
			expect(definition?.description, `${name} description`).not.to.equal('');
		}
	});

	it('has an evaluator for every Terragrunt-specific function', () => {
		const registry = Schema.getInstance().getFunctionRegistry();
		for (const name of [
			'find_in_parent_folders', 'path_relative_to_include', 'path_relative_from_include',
			'get_env', 'run_cmd', 'read_terragrunt_config', 'get_platform', 'get_repo_root',
			'get_path_from_repo_root', 'get_path_to_repo_root', 'get_terragrunt_dir',
			'get_original_terragrunt_dir', 'get_terraform_command', 'get_terraform_cli_args',
			'get_parent_terragrunt_dir', 'get_aws_account_alias', 'get_aws_account_id',
			'get_aws_caller_identity_arn', 'get_aws_caller_identity_user_id',
			'get_terraform_commands_that_need_vars', 'get_terraform_commands_that_need_locking',
			'get_terraform_commands_that_need_input', 'get_terraform_commands_that_need_parallelism',
			'sops_decrypt_file', 'get_terragrunt_source_cli_flag', 'get_default_retryable_errors',
			'read_tfvars_file', 'get_working_dir', 'mark_as_read', 'mark_glob_as_read',
			'constraint_check', 'deep_merge', 'startswith', 'endswith', 'strcontains', 'timecmp'
		]) {
			expect(registry.hasFunction(name), `${name} evaluator`).to.equal(true);
		}
	});

	it('does not expose functions rejected by the current runtime', () => {
		const schema = Schema.getInstance();
		for (const name of ['base64gunzip', 'cidrcontains', 'issensitive', 'plantimestamp', 'regex_replace', 'templatestring', 'type', 'urldecode']) {
			expect(schema.getFunctionDefinition(name), `${name} metadata`).to.equal(undefined);
		}
		for (const name of ['base64gzip', 'bcrypt', 'rsadecrypt', 'timestamp']) {
			expect(schema.getFunctionDefinition(name), `${name} metadata`).not.to.equal(undefined);
		}
	});
});
