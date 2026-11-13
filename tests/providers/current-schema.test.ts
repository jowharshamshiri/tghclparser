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

	it('has a runtime entry for every current function definition', () => {
		const schema = Schema.getInstance();
		const registry = schema.getFunctionRegistry();
		for (const definition of schema.getAllFunctions()) {
			expect(registry.hasFunction(definition.name), `${definition.name} runtime entry`).to.equal(true);
			expect(registry.getFunctionOperation(definition.name)?.metadata().name, `${definition.name} operation`).to.equal(`tghclp.function.${definition.name}`);
		}
		expect(registry.getFunctionNames().sort()).to.deep.equal(schema.getAllFunctions().map(definition => definition.name).sort());
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

describe('object value key hovers', () => {
	const hoverAt = async (content: string, line: number, character: number) => {
		const document = new ParsedDocument(new Workspace(), 'file:///repo/app/terragrunt.hcl', content);
		return (await document.getHoverInfo({ line, character }))?.value;
	};
	const blockForm = `remote_state {
  backend = "s3"
  config = {
    bucket = "state"
    skip_bucket_versioning = true
    assume_role = {
      role_arn = "arn:aws:iam::123456789012:role/state"
    }
  }
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
}
`;

	it('documents a backend key by the backend written beside config', async () => {
		const bucket = await hoverAt(blockForm, 3, 5);
		expect(bucket).to.include('## bucket Attribute');
		expect(bucket).to.include('The name of the S3 bucket.');
		expect(await hoverAt(blockForm, 4, 5)).to.include('Used by Terragrunt, not passed to the backend.');
		expect(await hoverAt(blockForm, 6, 7)).to.include('## role_arn Attribute');
	});

	it('documents the keys of remote_state generate, and lists them on generate itself', async () => {
		const ifExists = await hoverAt(blockForm, 11, 5);
		expect(ifExists).to.include('## if_exists Attribute');
		expect(ifExists).to.include('`overwrite_terragrunt`');
		const generate = await hoverAt(blockForm, 9, 3);
		expect(generate).to.include('### Properties');
		expect(generate).to.include('**path** (required)');
	});

	it('documents keys inside the attribute form of remote_state', async () => {
		const content = 'remote_state = {\n  backend = "gcs"\n  config = {\n    prefix = "app"\n  }\n}\n';
		expect(await hoverAt(content, 1, 3)).to.include('## backend Attribute');
		expect(await hoverAt(content, 3, 5)).to.include('The directory where state files will be saved inside the bucket.');
	});

	it('documents an entry of the generate map and the keys inside it', async () => {
		const content = 'generate = {\n  provider = {\n    if_exists = "overwrite_terragrunt"\n  }\n}\n';
		expect(await hoverAt(content, 1, 3)).to.include('## provider Attribute');
		const ifExists = await hoverAt(content, 2, 5);
		expect(ifExists).to.include('## if_exists Attribute');
		expect(ifExists).to.include('`overwrite_terragrunt`');
	});

	it('documents nothing for a key the schema does not describe', async () => {
		expect(await hoverAt('remote_state {\n  backend = "nope"\n  config = {\n    bucket = "state"\n  }\n}\n', 3, 5)).to.equal(undefined);
		expect(await hoverAt('dependency "vpc" {\n  config_path = "../vpc"\n  mock_outputs = {\n    vpc_id = "vpc-1"\n  }\n}\n', 3, 5)).to.equal(undefined);
	});
});

describe('object value key diagnostics', () => {
	const unit = 'file:///repo/app/terragrunt.hcl';

	it('accepts the keys the schema lists for the backend', () => {
		expect(diagnosticsFor(unit, `remote_state {
  backend = "s3"
  config = {
    bucket                 = "state"
    "region"               = "eu-west-2"
    skip_bucket_versioning = true
    assume_role = {
      role_arn = "arn:aws:iam::123456789012:role/state"
    }
    (local.extra) = "x"
  }
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
}`)).to.deep.equal([]);
	});

	it('reports a key the backend does not take, nested keys and generate keys', () => {
		const messages = diagnosticsFor(unit, `remote_state {
  backend = "s3"
  config = {
    bukcet = "state"
    assume_role = {
      role_ar = "arn"
    }
  }
  generate = {
    pth = "backend.tf"
  }
}`);
		expect(messages).to.include('Unknown key "bukcet" in remote_state.config for backend "s3"');
		expect(messages).to.include('Unknown key "role_ar" in remote_state.config.assume_role');
		expect(messages).to.include('Unknown key "pth" in remote_state.generate');
	});

	it('reports a key of another backend', () => {
		expect(diagnosticsFor(unit, 'remote_state {\n  backend = "gcs"\n  config = {\n    dynamodb_table = "locks"\n  }\n}'))
			.to.deep.equal(['Unknown key "dynamodb_table" in remote_state.config for backend "gcs"']);
	});

	it('checks the attribute form of remote_state and the generate map', () => {
		const messages = diagnosticsFor(unit, `remote_state = {
  backend = "gcs"
  bakend  = "gcs"
  config = {
    prefx = "app"
  }
}
generate = {
  provider = {
    path     = "provider.tf"
    contnets = ""
  }
}`);
		expect(messages).to.include('Unknown key "bakend" in remote_state');
		expect(messages).to.include('Unknown key "prefx" in remote_state.config for backend "gcs"');
		expect(messages).to.include('Unknown key "contnets" in generate.provider');
	});

	it('checks encryption keys by the key provider written inside it', () => {
		expect(diagnosticsFor(unit, `remote_state {
  backend = "s3"
  config = { bucket = "state" }
  encryption = {
    key_provider = "aws_kms"
    kms_key_id   = "key"
    kms_key      = "key"
  }
}`)).to.deep.equal(['Unknown key "kms_key" in remote_state.encryption for key_provider "aws_kms"']);
	});

	it('reports nothing when the backend cannot be known', () => {
		for (const backend of ['local.backend', '"nope"', '"${local.kind}"']) {
			expect(diagnosticsFor(unit, `remote_state {\n  backend = ${backend}\n  config = {\n    anything = "x"\n  }\n}`), backend).to.deep.equal([]);
		}
		expect(diagnosticsFor(unit, 'remote_state {\n  config = {\n    anything = "x"\n  }\n}')).to.deep.equal(['Missing required attribute: backend']);
	});

	it('reports nothing inside values whose keys the schema does not describe', () => {
		expect(diagnosticsFor(unit, `locals {
  settings = { anything = "x" }
}
dependency "vpc" {
  config_path = "../vpc"
  mock_outputs = {
    vpc_id = "vpc-1"
  }
  mock_outputs_allowed_terraform_commands = ["validate"]
}
inputs = {
  anything = "x"
}`)).to.deep.equal([]);
	});
});
