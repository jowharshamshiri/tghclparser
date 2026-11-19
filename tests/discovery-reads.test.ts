import { expect } from 'chai';

import { discoveryEvaluates } from '../src/discovery-reads';
import type { TerragruntFileKind, Token } from '../src/model';
import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';

// Where Terragrunt v1.2.2's discovery evaluates an expression, so that a file a
// function reads there counts as read: each call below names its place in its
// pattern argument.
describe('discovery evaluation', () => {
	const places = (filename: string, kind: TerragruntFileKind, content: string) => {
		const document = new ParsedDocument(new Workspace(), `file:///repo/live/app/${filename}`, content);
		const calls: Token[] = [];
		const visit = (token: Token): void => {
			if (token.type === 'function_call' && token.value === 'fileset') calls.push(token);
			for (const child of token.children) visit(child);
		};
		for (const token of document.getTokens()) visit(token);
		const place = (call: Token) => String(call.children.filter(child => child.type !== 'function_identifier')[1].value);
		return {
			evaluated: calls.filter(call => discoveryEvaluates(call, kind)).map(place),
			skipped: calls.filter(call => !discoveryEvaluates(call, kind)).map(place)
		};
	};

	const unit = `locals {
  a = fileset(".", "locals")
}
include "root" {
  path = fileset(".", "include")
}
feature "f" {
  default = fileset(".", "feature")
}
dependencies {
  paths = fileset(".", "dependencies")
}
dependency "vpc" {
  config_path  = "../vpc"
  mock_outputs = { files = fileset(".", "dependency") }
}
engine {
  source = "x"
  meta   = { files = fileset(".", "engine") }
}
exclude {
  if      = length(fileset(".", "exclude")) > 0
  actions = ["plan"]
}
errors {
  retry "r" {
    retryable_errors = fileset(".", "errors")
    max_attempts     = 1
    sleep_interval_sec = 1
  }
}
terraform {
  source = join("", fileset(".", "terraform.source"))
  extra_arguments "a" {
    commands  = ["plan"]
    arguments = fileset(".", "terraform.extra_arguments")
  }
}
prevent_destroy               = length(fileset(".", "prevent_destroy")) > 0
iam_role                      = join("", fileset(".", "iam_role"))
iam_web_identity_token        = join("", fileset(".", "iam_web_identity_token"))
terragrunt_version_constraint = join("", fileset(".", "terragrunt_version_constraint"))
terraform_version_constraint  = join("", fileset(".", "terraform_version_constraint"))
terraform_binary              = join("", fileset(".", "terraform_binary"))
download_dir                  = join("", fileset(".", "download_dir"))
remote_state {
  backend = "local"
  config  = { files = fileset(".", "remote_state") }
}
generate "g" {
  path      = "g.txt"
  if_exists = "overwrite"
  contents  = join("", fileset(".", "generate"))
}
inputs = {
  files = fileset(".", "inputs")
}
`;
	const unitEvaluated = [
		'locals', 'include', 'feature', 'dependencies', 'dependency', 'engine', 'exclude', 'errors', 'terraform.source',
		'prevent_destroy', 'iam_role', 'iam_web_identity_token', 'terragrunt_version_constraint',
		'terraform_version_constraint', 'terraform_binary'
	];
	const unitSkipped = ['terraform.extra_arguments', 'download_dir', 'remote_state', 'generate', 'inputs'];

	it('evaluates what a unit configuration\'s partial parse decodes', () => {
		expect(places('terragrunt.hcl', 'unit', unit)).to.deep.equal({ evaluated: unitEvaluated, skipped: unitSkipped });
	});

	it('evaluates the same in the autoinclude beside a unit', () => {
		expect(places('terragrunt.autoinclude.hcl', 'unit-autoinclude', unit)).to.deep.equal({ evaluated: unitEvaluated, skipped: unitSkipped });
	});

	const stack = `locals {
  a = fileset(".", "locals")
}
unit "app" {
  source = "../units/app"
  path   = "app"
  values = { files = fileset(".", "unit") }
  autoinclude {
    dependency "vpc" {
      config_path  = join("", fileset(".", "autoinclude.dependency.config_path"))
      mock_outputs = { files = fileset(".", "autoinclude.dependency.mock_outputs") }
    }
    inputs = {
      files = fileset(".", "autoinclude.inputs")
    }
  }
}
stack "nested" {
  source = "../stacks/nested"
  path   = "nested"
  values = { files = fileset(".", "stack") }
}
`;

	it('evaluates a stack file\'s locals and components, and only each autoinclude dependency\'s path', () => {
		expect(places('terragrunt.stack.hcl', 'stack', stack)).to.deep.equal({
			evaluated: ['locals', 'unit', 'autoinclude.dependency.config_path', 'stack'],
			skipped: ['autoinclude.dependency.mock_outputs', 'autoinclude.inputs']
		});
	});

	it('evaluates a values file whole', () => {
		expect(places('terragrunt.values.hcl', 'values', 'files = fileset(".", "values")\n')).to.deep.equal({ evaluated: ['values'], skipped: [] });
	});
});
