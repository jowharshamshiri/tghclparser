import { expect } from 'chai';

import type { ConfigurationNode } from '../src/discovery-reads';
import { discoveryExpressions } from '../src/discovery-reads';
import type { TerragruntFileKind } from '../src/model';
import { parseHclSyntax } from '../src/syntax';

// Which expressions Terragrunt v1.2.2's discovery evaluates, so that a file a
// function reads there counts as read: each call below names its place in its
// pattern argument. Locals and include blocks are evaluated as a file's scope is
// built, so they are not among them and these files have none.
describe('discovery evaluation', () => {
	const places = (kind: TerragruntFileKind, content: string, parsedInFull = false) => {
		const root = parseHclSyntax(content, 'terragrunt.hcl', 'terragrunt.hcl') as ConfigurationNode;
		const calls = (node: ConfigurationNode): ConfigurationNode[] => [
			...(node.type === 'function_call' && node.value === 'fileset' ? [node] : []),
			...(node.children ?? []).flatMap(calls)
		];
		const place = (call: ConfigurationNode) => String(call.children!.filter(child => child.type !== 'function_identifier')[1].value);
		const selected = new Set(discoveryExpressions(root, kind, parsedInFull).flatMap(calls));
		const all = calls(root);
		return {
			evaluated: all.filter(call => selected.has(call)).map(place),
			skipped: all.filter(call => !selected.has(call)).map(place)
		};
	};

	const unit = `feature "f" {
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
		'feature', 'dependencies', 'dependency', 'engine', 'exclude', 'errors', 'terraform.source',
		'prevent_destroy', 'iam_role', 'iam_web_identity_token', 'terragrunt_version_constraint',
		'terraform_version_constraint', 'terraform_binary'
	];
	const unitSkipped = ['terraform.extra_arguments', 'download_dir', 'remote_state', 'generate', 'inputs'];

	it('evaluates what a unit configuration\'s partial parse decodes', () => {
		expect(places('unit', unit)).to.deep.equal({ evaluated: unitEvaluated, skipped: unitSkipped });
	});

	it('evaluates the same in the autoinclude beside a unit', () => {
		expect(places('unit-autoinclude', unit)).to.deep.equal({ evaluated: unitEvaluated, skipped: unitSkipped });
	});

	it('evaluates everything in a configuration Terragrunt parses in full', () => {
		expect(places('unit', unit, true)).to.deep.equal({ evaluated: [...unitEvaluated.slice(0, 7), 'terraform.extra_arguments', ...unitEvaluated.slice(7), ...unitSkipped.slice(1)], skipped: [] });
	});

	const stack = `unit "app" {
  source = "../units/app"
  path   = "app"
  values = { files = fileset(".", "unit") }
  autoinclude {
    dependency "vpc" {
      config_path  = join("", fileset(".", "autoinclude.dependency.config_path"))
      mock_outputs = { files = fileset(".", "autoinclude.dependency.mock_outputs") }
      expansion {
        prefix = join("", fileset(".", "autoinclude.dependency.expansion"))
      }
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

	it('evaluates a stack file\'s components, and only each autoinclude dependency\'s path and expansion', () => {
		expect(places('stack', stack)).to.deep.equal({
			evaluated: ['unit', 'autoinclude.dependency.config_path', 'autoinclude.dependency.expansion', 'stack'],
			skipped: ['autoinclude.dependency.mock_outputs', 'autoinclude.inputs']
		});
	});

	it('evaluates a values file whole', () => {
		expect(places('values', 'files = fileset(".", "values")\n')).to.deep.equal({ evaluated: ['values'], skipped: [] });
	});
});
