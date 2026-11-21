/**
 * Configurations and what Terragrunt v1.2.2's discovery lists each unit or stack as reading, as
 * `terragrunt find --json --reading` prints it run in the configuration's directory: paths relative to it, sorted.
 * Each list was recorded from the v1.2.2 release binary.
 */
export interface ReadingCase {
	name: string;
	/** The files of the configuration, by path relative to its directory. */
	files: Record<string, string>;
	/** What each unit or stack reads, by its directory. */
	reading: Record<string, string[]>;
}

const text = (names: string[], directory = ''): Record<string, string> =>
	Object.fromEntries(names.map(name => [`${directory}${name}`, `${name}\n`]));

export const readingCases: ReadingCase[] = [
	{
		name: 'every reading function, where a file is and where none is',
		files: {
			...text(['file.txt', 'filebase64.txt', 'fileexists.txt', 'filemd5.txt', 'filesha1.txt', 'filesha256.txt', 'filesha512.txt',
				'filebase64sha256.txt', 'filebase64sha512.txt', 'inner.txt', 'fs/one.txt', 'fs/sub/two.txt', 'glob/a.yaml', 'glob/b.yaml'], 'app/'),
			'app/dir/.keep': '',
			'app/template.tftpl': 'inner = ${file("inner.txt")}\n',
			'app/vars.tfvars': 'x = 1\n',
			'app/config.hcl': 'locals {\n  a = 1\n}\n',
			'app/secret.yaml': 'secret: value\n',
			'app/terragrunt.hcl': `locals {
  file             = file("file.txt")
  filebase64       = filebase64("filebase64.txt")
  fileexists       = fileexists("fileexists.txt")
  not_there        = fileexists("not-there.txt")
  directory_exists = can(fileexists("dir"))
  filemd5          = filemd5("filemd5.txt")
  directory_md5    = can(filemd5("dir"))
  filesha1         = filesha1("filesha1.txt")
  filesha256       = filesha256("filesha256.txt")
  filesha512       = filesha512("filesha512.txt")
  filebase64sha256 = filebase64sha256("filebase64sha256.txt")
  filebase64sha512 = filebase64sha512("filebase64sha512.txt")
  templatefile     = templatefile("template.tftpl", {})
  fileset          = fileset("fs", "**")
  tfvars           = read_tfvars_file("vars.tfvars")
  config           = read_terragrunt_config("config.hcl")
  default          = read_terragrunt_config("no-config.hcl", {})
  marked           = mark_as_read("marked-but-absent.txt")
  globbed          = mark_glob_as_read("glob/*.yaml")
  secret           = sops_decrypt_file("secret.yaml")
}
`
		},
		reading: {
			app: [
				'app/config.hcl', 'app/dir', 'app/file.txt', 'app/filebase64.txt', 'app/filebase64sha256.txt', 'app/filebase64sha512.txt',
				'app/fileexists.txt', 'app/filemd5.txt', 'app/filesha1.txt', 'app/filesha256.txt', 'app/filesha512.txt', 'app/fs/one.txt',
				'app/fs/sub/two.txt', 'app/glob/a.yaml', 'app/glob/b.yaml', 'app/inner.txt', 'app/marked-but-absent.txt', 'app/secret.yaml',
				'app/template.tftpl', 'app/vars.tfvars'
			]
		}
	},
	{
		name: 'a read in each block and attribute of a unit, recorded only where discovery evaluates it',
		files: {
			...text(['feature.txt', 'dependencies.txt', 'config_path.txt', 'mock_outputs.txt', 'engine.txt', 'exclude.txt', 'errors.txt',
				'source.txt', 'extra_arguments.txt', 'before_hook.txt', 'prevent_destroy.txt', 'iam_role.txt', 'iam_web_identity_token.txt',
				'terragrunt_version_constraint.txt', 'terraform_version_constraint.txt', 'terraform_binary.txt', 'download_dir.txt',
				'remote_state.txt', 'generate.txt', 'inputs.txt', 'inputs_mark.txt', 'inputs_vars.tfvars'], 'app/'),
			'app/inputs_config.hcl': 'locals {\n  a = 1\n}\n',
			'net/terragrunt.hcl': 'inputs = {}\n',
			'app/terragrunt.hcl': `feature "f" {
  default = file("feature.txt")
}
dependencies {
  paths = [trimspace(file("dependencies.txt")) == "dependencies.txt" ? "../net" : "../net"]
}
dependency "net" {
  config_path  = trimspace(file("config_path.txt")) == "config_path.txt" ? "../net" : "../net"
  mock_outputs = { m = file("mock_outputs.txt") }
}
engine {
  source = "github.com/acme/engine"
  meta   = { m = file("engine.txt") }
}
exclude {
  if      = file("exclude.txt") == ""
  actions = ["plan"]
}
errors {
  retry "r" {
    retryable_errors   = [file("errors.txt")]
    max_attempts       = 2
    sleep_interval_sec = 1
  }
}
terraform {
  source = trimspace(file("source.txt")) == "source.txt" ? "git::https://example.com/acme/module.git" : "x"
  extra_arguments "e" {
    commands  = ["plan"]
    arguments = [file("extra_arguments.txt")]
  }
  before_hook "h" {
    commands = ["plan"]
    execute  = ["echo", file("before_hook.txt")]
  }
}
prevent_destroy               = file("prevent_destroy.txt") == ""
iam_role                      = trimspace(file("iam_role.txt")) == "" ? "x" : ""
iam_web_identity_token        = trimspace(file("iam_web_identity_token.txt")) == "" ? "x" : ""
terragrunt_version_constraint = trimspace(file("terragrunt_version_constraint.txt")) == "" ? "<= 0.1" : ">= 0.1"
terraform_version_constraint  = trimspace(file("terraform_version_constraint.txt")) == "" ? "<= 0.1" : ">= 0.1"
terraform_binary              = trimspace(file("terraform_binary.txt")) == "" ? "x" : "tofu"
download_dir                  = trimspace(file("download_dir.txt")) == "" ? "x" : ".download"
remote_state {
  backend = "local"
  config  = { path = file("remote_state.txt") }
}
generate "g" {
  path      = "g.txt"
  if_exists = "overwrite"
  contents  = file("generate.txt")
}
inputs = {
  file   = file("inputs.txt")
  marked = mark_as_read("inputs_mark.txt")
  vars   = read_tfvars_file("inputs_vars.tfvars")
  config = read_terragrunt_config("inputs_config.hcl")
}
`
		},
		reading: {
			app: [
				'app/config_path.txt', 'app/dependencies.txt', 'app/engine.txt', 'app/errors.txt', 'app/exclude.txt', 'app/feature.txt',
				'app/iam_role.txt', 'app/iam_web_identity_token.txt', 'app/mock_outputs.txt', 'app/prevent_destroy.txt', 'app/source.txt',
				'app/terraform_binary.txt', 'app/terraform_version_constraint.txt', 'app/terragrunt_version_constraint.txt'
			],
			net: []
		}
	},
	{
		name: 'the files a unit includes, and what they read from their own directory and from the unit\'s',
		files: {
			...text(['root_file.txt', 'root_inputs.txt', 'root_generate.txt', 'exposed_file.txt', 'exposed_inputs.txt', 'exposed_generate.txt']),
			...text(['root_mark.txt', 'root_secret.yaml', 'root_glob/a.txt', 'auto_file.txt', 'include_expose.txt'], 'app/'),
			...text(['root_glob/a.txt']),
			'root.hcl': `locals {
  file   = file("root_file.txt")
  mark   = mark_as_read("root_mark.txt")
  glob   = mark_glob_as_read("root_glob/*.txt")
  secret = sops_decrypt_file("root_secret.yaml")
}
inputs = {
  file = file("root_inputs.txt")
}
generate "root" {
  path      = "root.txt"
  if_exists = "overwrite"
  contents  = file("root_generate.txt")
}
`,
			'exposed.hcl': `locals {
  file = file("exposed_file.txt")
}
inputs = {
  file = file("exposed_inputs.txt")
}
generate "exposed" {
  path      = "exposed.txt"
  if_exists = "overwrite"
  contents  = file("exposed_generate.txt")
}
`,
			'unmerged.hcl': 'locals {\n  a = 1\n}\n',
			'app/terragrunt.autoinclude.hcl': 'locals {\n  auto = file("auto_file.txt")\n}\n',
			'app/terragrunt.hcl': `include "root" {
  path = find_in_parent_folders("root.hcl")
}
include "exposed" {
  path   = "\${get_terragrunt_dir()}/../exposed.hcl"
  expose = true
}
include "unmerged" {
  path           = "../unmerged.hcl"
  expose         = trimspace(file("include_expose.txt")) == ""
  merge_strategy = "no_merge"
}
inputs = {}
`
		},
		reading: {
			app: [
				'app/auto_file.txt', 'app/include_expose.txt', 'app/root_glob/a.txt', 'app/root_mark.txt', 'app/root_secret.yaml', 'exposed.hcl', 'exposed_file.txt',
				'exposed_generate.txt', 'exposed_inputs.txt', 'root.hcl', 'root_file.txt', 'unmerged.hcl'
			]
		}
	},
	{
		name: 'a read whose path, or whether it is made, only evaluation gives',
		files: {
			...text(['chosen.txt', 'not-chosen.txt', 'true.txt', 'false.txt', 'and.txt', 'first.txt', 'second.txt', 'third.txt', 'can.txt',
				'one.txt', 'two.txt', 'named.txt', 'local.txt'], 'app/'),
			'app/names.hcl': 'locals {\n  name = "named.txt"\n}\n',
			'app/terragrunt.hcl': `locals {
  chosen    = file(true ? "chosen.txt" : "not-chosen.txt")
  both      = true ? file("true.txt") : file("false.txt")
  and       = false && fileexists("and.txt")
  tried     = try(file("missing.txt"), file("first.txt"), file("second.txt"))
  can       = can(file("can.txt"))
  each      = [for name in ["one.txt", "two.txt"] : file(name)]
  name      = read_terragrunt_config("names.hcl").locals.name
  by_name   = file(local.name)
  condition = length(local.each) > 1 ? "local.txt" : "third.txt"
  by_local  = file(local.condition)
}
`
		},
		reading: {
			app: [
				'app/and.txt', 'app/can.txt', 'app/chosen.txt', 'app/false.txt', 'app/first.txt', 'app/local.txt', 'app/named.txt',
				'app/names.hcl', 'app/one.txt', 'app/true.txt', 'app/two.txt'
			]
		}
	},
	{
		name: 'a configuration read_terragrunt_config reads, parsed in full from its own directory',
		files: {
			...text(['locals.txt', 'inputs.txt', 'generate.txt', 'remote_state.txt', 'mark.txt'], 'shared/'),
			'shared/vars.tfvars': 'x = 1\n',
			'shared/other.hcl': `locals {
  file = file("locals.txt")
  mark = mark_as_read("mark.txt")
  vars = read_tfvars_file("vars.tfvars")
}
inputs = {
  file = file("inputs.txt")
}
generate "g" {
  path      = "g.txt"
  if_exists = "overwrite"
  contents  = file("generate.txt")
}
remote_state {
  backend = "local"
  config  = { path = file("remote_state.txt") }
}
`,
			'app/terragrunt.hcl': 'locals {\n  other = read_terragrunt_config("../shared/other.hcl")\n}\n'
		},
		reading: {
			app: [
				'shared/generate.txt', 'shared/inputs.txt', 'shared/locals.txt', 'shared/mark.txt', 'shared/other.hcl', 'shared/remote_state.txt',
				'shared/vars.tfvars'
			]
		}
	},
	{
		name: 'a stack, its values file, and only the paths of its autoinclude dependencies',
		files: {
			...text(['locals.txt', 'values.txt', 'source.txt', 'config_path.txt', 'mock_outputs.txt', 'inputs.txt', 'values_file.txt'], 'live/'),
			'units/app/terragrunt.hcl': 'inputs = {}\n',
			'units/vpc/terragrunt.hcl': 'inputs = {}\n',
			'live/terragrunt.values.hcl': 'v = file("values_file.txt")\n',
			'live/terragrunt.stack.hcl': `locals {
  file = file("locals.txt")
}
unit "vpc" {
  source = "../units/vpc"
  path   = "vpc"
  values = { v = file("values.txt") }
}
unit "app" {
  source = trimspace(file("source.txt")) == "source.txt" ? "../units/app" : "x"
  path   = "app"
  autoinclude {
    dependency "vpc" {
      config_path  = trimspace(file("config_path.txt")) == "config_path.txt" ? "../vpc" : "x"
      mock_outputs = { m = file("mock_outputs.txt") }
    }
    inputs = {
      i = file("inputs.txt")
    }
  }
}
`
		},
		reading: {
			live: ['live/config_path.txt', 'live/locals.txt', 'live/source.txt', 'live/values.txt', 'live/values_file.txt'],
			'units/app': [],
			'units/vpc': []
		}
	},
	{
		name: 'a dependency\'s reads, and a fault that drops one read and keeps the rest',
		files: {
			...text(['before.txt', 'after.txt', 'exclude.txt'], 'app/'),
			...text(['net.txt'], 'net/'),
			'net/terragrunt.hcl': 'locals {\n  net = file("net.txt")\n}\n',
			'app/terragrunt.hcl': `dependency "net" {
  config_path = "../net"
}
locals {
  before  = file("before.txt")
  missing = file("missing.txt")
  broken  = file(local.missing)
  cycle   = file(local.cycle)
  after   = file("after.txt")
}
exclude {
  if      = file("exclude.txt") == ""
  actions = ["plan"]
}
`
		},
		reading: {
			app: ['app/after.txt', 'app/before.txt', 'app/exclude.txt'],
			net: ['net/net.txt']
		}
	}
];
