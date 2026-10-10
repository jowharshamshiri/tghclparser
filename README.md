# tghclparser

A **drop-in replacement for the `terragrunt` CLI**, and the parser and language-service toolkit for the Terragrunt 1.x HCL language that underpins it. Version 1 follows the current Terragrunt regime and intentionally does not accept removed or deprecated compatibility syntax.

The `tghclp` command runs OpenTofu or Terraform through Terragrunt configurations — includes, dependencies, `generate` blocks, explicit stacks — in place of `terragrunt` itself:

```sh
tghclp init            # terragrunt init
tghclp plan            # terragrunt plan
tghclp apply --all     # terragrunt run-all apply
```

Compatibility is established by running the same configuration through both and comparing what each produces, rather than by reading the documentation and assuming agreement. Where the two disagree, that is a bug here.

Being TypeScript rather than a compiled binary, the same package is one npm dependency wherever Node runs — CI, an editor extension, an application — with no toolchain to install and no platform build to match. And the parser, evaluator and workspace graph it uses are exported, so a configuration is something your own code can read rather than something you shell out to and parse text back from.

It also powers the [Terragrunt HCL Language Server](https://marketplace.visualstudio.com/items?itemName=BahramJoharshamshiri.hcl-lsp) VS Code extension and is published as a standalone [npm package](https://www.npmjs.com/package/tghclparser).

Read the [tghclparser documentation](https://jowharshamshiri.github.io/tghclparser/) for a guided tutorial, task-focused how-to guides, command and API reference, and architectural explanation.

## Supported files

- `terragrunt.hcl` and named shared unit configurations such as `root.hcl`
- `terragrunt.stack.hcl` explicit stacks
- `terragrunt.values.hcl` generated stack values
- `terragrunt.autoinclude.hcl` and `terragrunt.autoinclude.stack.hcl`

The schema covers unit configuration, `unit` and `stack` declarations, component `autoinclude` blocks, feature flags, excludes, error policies, catalogs, IaC engines, CAS source controls, and Terragrunt functions. See the official [HCL blocks](https://docs.terragrunt.com/reference/hcl/blocks/), [attributes](https://docs.terragrunt.com/reference/hcl/attributes/), and [functions](https://docs.terragrunt.com/reference/hcl/functions/) references for the language contract.

## Inline functions

A configuration may declare its own functions, written in JavaScript, and call them exactly as it calls built-ins. Every configuration Terragrunt accepts is accepted unchanged; this is the one place the language goes beyond it.

```hcl
locals {
  org = "acme"
}

function state_key(environment: string, component: string = "app") {
  const tier = environment === "prod" ? "prod" : "nonprod";
  return `${tg.local.org}/${tier}/${component}/terraform.tfstate`;
}

inputs = {
  key = state_key("prod", "api")
}
```

Parameters are declared in the signature using JavaScript conventions — `name`, `name = default`, `...rest` — and bind as ordinary identifiers in the body. Defaults are HCL expressions evaluated in the declaring file's scope. An optional `: type` annotation carrying an HCL type constraint (`string`, `number`, `bool`, `list(string)`, `object(a = string,)`, `any`) is checked on every call and drives hover, completion, and diagnostics; an unannotated parameter accepts any value.

Bodies are implicitly `async`, so `await` is available and the result is awaited before it re-enters HCL evaluation — call sites write a plain call. Values cross the boundary as plain JavaScript; returning something with no HCL representation, such as a function or a circular structure, is a reported error rather than a silent `null`.

A `tg` binding reaches the surrounding configuration:

| Binding | Meaning |
| --- | --- |
| `tg.call(name, ...)` | Invoke any function, built-in or inline |
| `tg.local.<name>` | A local of the declaring file |
| `tg.include.<name>` | An exposed include, following the usual `expose` rule |
| `tg.context` | `terragruntDir`, `repoRoot`, `workingDirectory`, `environmentVariables` |

Declarations are inherited through `include`, so shared helpers live in `root.hcl` alongside shared locals. A file's own declaration overrides an inherited one of the same name, and shadowing a built-in is an error. Bodies resolve `tg.local` and `tg.include` against the file that declares them, never the caller, so a function means the same thing wherever it is called. Recursion is supported and bounded.

## Language-service features

- HCL parsing with source ranges and a navigable token tree
- File-kind-aware diagnostics and completion
- Reference completion for locals, includes, dependencies, features, values, units, and stacks
- Exact include resolution using the filename passed to `find_in_parent_folders`
- Workspace graphs for includes, dependencies, explicit stacks, and generated component targets
- Dependency output discovery from state
- Hover and document-link providers
- Inline function signatures in completion, hover, and call diagnostics
- Formatting into Terragrunt's canonical layout, with no external formatter
- Completion, hover and checking of `inputs` against the variables of the module `terraform { source }` names

### Remote module sources

A local `terraform { source }` is read in place. A registry source (`tfr:///namespace/name/provider?version=…`) is fetched, so its variables drive the same completion, hover and checks.

- **Enabling:** `Workspace.configureRemoteModules({ enabled, trusted }, options)`. Fetching starts once both are true. A fetch runs in the background: the unit reports `loading`, then `onModuleVariablesChanged` listeners are told to republish its diagnostics. A workspace that never calls it leaves remote sources alone: a unit naming one has no module state and no diagnostics about it.
- **What is fetched:** the top-level `.tf` files of the module, read straight from the git repository or tar.gz archive the registry points to.
- **Cache:** `TGHCLPARSER_CACHE_DIR`, else the platform cache directory under `tghclparser`, owner-only and keyed by the resolved version, so each version is fetched once. Clear it with `Workspace.clearRemoteModuleCache()`, which also refetches open units, or `tghclp cache clear`.
- **Credentials:** `TF_TOKEN_<host>`, then `credentials` blocks in the Terraform CLI configuration (`TF_CLI_CONFIG_FILE` or `~/.terraformrc`, then `~/.terraform.d/*.tfrc*`), then `TG_TF_REGISTRY_TOKEN` for private registries. Add your own with `chainCredentials`. A token is sent to its registry host alone; git uses its own credential helpers and ssh agent. Messages show credentials redacted.
- **Hosts:** the `approveHost` callback is asked before the first contact with a registry or git host, once per host however many units need it; `allowedHosts` are contacted straight away. Approving a registry covers the hosts it points to: where its discovery document places the module API, where a redirect leads, and where a download is served. Every host is contacted by name and must resolve outside the loopback and link-local ranges; `localhost`, `*.local` and `*.internal` are refused.
- **Default registry:** `tfr:///` means what it means to Terragrunt: `TG_TF_DEFAULT_REGISTRY_HOST`, else the policy's `defaultRegistryHost`, else the registry of the binary Terragrunt would run — `TG_TF_PATH`, else a literal `terraform_binary`, else `tofu` when it is on `PATH` and `terraform` when it is not. That is `registry.terraform.io` for a binary named `terraform` and `registry.opentofu.org` for anything else. Terragrunt runs the binary to learn which it is; the name is used here so that opening a file runs nothing.
- **Requirements:** git 2.31 or newer on `PATH` for modules served from git.

## Command line

The package provides the `tghclp` executable. Its validation command follows the Terragrunt command shape:

```sh
tghclp hcl validate --json --working-dir ./infrastructure
```

It recursively validates Terragrunt HCL files, returns a non-zero status when diagnostics are found, and supports JSON diagnostics for automation. Add `--show-config-path` to emit the invalid configuration paths instead of diagnostic objects.

Configuration discovery is also available without evaluating a configuration:

```sh
tghclp find --json --working-dir ./infrastructure
tghclp list --working-dir ./infrastructure
tghclp dag graph --working-dir ./infrastructure
tghclp info print --working-dir ./infrastructure
tghclp run --working-dir ./infrastructure -- plan
```

Discovery skips generated and dependency-cache directories and reports paths relative to the selected working directory.
`run` validates the discovered configuration before invoking the selected OpenTofu/Terraform binary without a shell; use `--tf-path` to select the executable explicitly.

To put configuration into the canonical layout, format it:

```sh
tghclp hcl format --working-dir ./infrastructure
tghclp hcl format --check --diff --working-dir ./infrastructure
tghclp hcl format --stdin < terragrunt.hcl
```

This does what `terragrunt hcl format` does, without Terragrunt, OpenTofu or Terraform installed: every file under the working directory whose name ends in `.hcl` is rewritten with two-space indentation, single spaces between tokens, and the equals signs and trailing comments of consecutive lines aligned. Only whitespace changes.

It is a replacement for that command, not a likeness of it. It takes the same flags and environment variables, formats and skips the same files, prints the same diffs, exits with the same status, and refuses exactly the files Terragrunt refuses. That is checked against Terragrunt itself: the layout on every file of the parity corpus, and the scanner, the syntax check, the path filters and the command as a whole on recorded adversarial input, a part of which this package's own tests replay.

- `--check` changes nothing and exits 1 when a file needs formatting. `--diff` prints the change as a unified diff and, as in Terragrunt, still makes it unless `--check` is given too.
- `--file <path>` formats one file and `--stdin` formats standard input to standard output. `--exclude-dir <name>` skips a directory of that name wherever it is; `.terragrunt-cache`, `.boilerplate` and `.terragrunt-stack` are never entered.
- `--filter <query>` selects among the files found with Terragrunt's path filters, such as `--filter './apps/**' --filter '!./apps/legacy/**'`. The filters in `.terragrunt-filters` (or `--filters-file`) and the exclusions in `.terragrunt-excludes` apply as they do in Terragrunt. A filter by name, type, dependency or Git history needs Terragrunt's unit discovery and is refused, as Terragrunt refuses it for this command.
- The flags may be given with one dash or two, a switch may be given a value (`--check=false`), and `TG_CHECK`, `TG_DIFF`, `TG_STDIN`, `TG_FILE`, `TG_EXCLUDE_DIR`, `TG_FILTER` and `TG_WORKING_DIR` set them from the environment. Terragrunt's deprecated names for those variables still work, with a warning, unless `--strict-mode` is given.
- A file that is not valid HCL is reported and left as it is; the rest are still formatted, and the command exits 1. The report is the HCL parser's own first error: its summary, its detail, and its line and column.
- Inline functions are kept exactly as written, since their bodies are JavaScript, not HCL.

Two things differ, and only in what is printed: `--help` describes this command in its own words, and where Terragrunt lists every error its parser found in a file, this reports the first.

The same formatter is exported as `formatHcl(source)`, which throws `HclSyntaxError` for source that is not valid HCL, and `formatHclTokens(source)`, which works on tokens alone and never refuses. `findHclSyntaxProblem(source)` is the syntax check on its own: it returns what the HCL parser would report first, or `undefined` for valid source. The language service runs the same check first, so a file Terragrunt would refuse is flagged in the editor with the error Terragrunt's parser gives.

To see what a configuration actually evaluates to — after `include` merging, `locals`, function calls, and `dependency` resolution — render it:

```sh
tghclp render --json --working-dir ./infrastructure/app
tghclp render --json --working-dir ./infrastructure/app --config root.hcl
```

JSON is currently the only output format, so `--json` (or `--format=json`) is required. `--config` selects the configuration filename, which defaults to `terragrunt.hcl` and must sit inside the working directory. A `.hcl.json` configuration is validated and printed as authored rather than re-evaluated.

Experiment-gated language features must be enabled explicitly, for example `--experiment deep-merge`; the command fails when such a feature is used without its explicit switch.

To see what the language service holds for a configuration, rather than what it evaluates to, inspect it:

```sh
tghclp inspect --json --working-dir ./infrastructure/app
```

This adds the configuration to a workspace exactly as the editor does and prints the result as JSON:

- `diagnostics`, as the editor would show them
- `moduleVariables`: the variables of the module named by `terraform { source }`, and the input keys included configurations already supply. A registry source is fetched first, with the ambient credentials and every host approved
- `inlineFunctions`, declared and inherited, and `links`
- `merge`: the configurations Terragrunt merges into the unit, highest priority first — the sibling `terragrunt.autoinclude.hcl`, the unit, then its direct includes from the last to the first, leaving out any with `merge_strategy = "no_merge"` — or the `reason` that cannot be determined or would be refused
- `autoinclude`: the sibling `terragrunt.autoinclude.hcl`, described like an include, or `null`
- `relationships`: the include, dependency and read edges. Each include is described by how it is included — its label, the file that includes it and the `merge_strategy` written there — and by what it contributes: root attributes, blocks, `inputs` keys, module source, inline functions, diagnostics and edges. Each file read during evaluation is described by its `locals` and `inputs` keys, or, for a file that is not HCL, by whether it exists. An include path that cannot be resolved, or a file that cannot be loaded, is listed with its `error`.

`--workspace-root` sets the folder the editor would have open, defaulting to the enclosing Git repository. When adding the configuration fails, for example on a missing include, whatever state the document has is printed with an `error` field and the command exits 2.

Fetched modules stay in the per-user cache until it is cleared:

```sh
tghclp cache clear
```

This removes the fetched modules under the cache directory, so the next `inspect` or editor session fetches them again.

## Dependencies and mock outputs

`dependency.<name>.outputs.<x>` is resolved the way Terragrunt resolves it. The `dependency "<name>"` block is found in the unit and the configurations merged into it — the sibling `terragrunt.autoinclude.hcl` over the unit, then its includes from the last to the first, leaving out any with `merge_strategy = "no_merge"`; a shallow include's block is replaced whole by a higher one of the same name, a deep include's is merged attribute by attribute. Its `config_path` and mocks are evaluated in the file that declares them, and `config_path` is resolved against the unit's directory wherever the block is written. So a dependency shared through a root or `_envcommon` file works as it does in Terragrunt, and a `root.hcl` can read a dependency its units declare. Each dependency's outputs are read once per evaluation, from the directory `config_path` names. Commands that execute OpenTofu require that output to exist or an explicitly permitted mock.

`render --json` can print the known part of a configuration when a dependency's outputs cannot be had: the dependency returns an empty output map, or its `tofu output -json` command fails or returns something that is not an output map. It omits fields whose values cannot be evaluated, names each field and the reason on stderr, and exits with status 2 so the JSON cannot be mistaken for a complete render. An invalid dependency block, or an output missing from a nonempty output map, is an error: render exits 1 without JSON. Only `render` carries on past outputs it could not read; `run` and the commands it wraps stop, even with a mock allowed for them. To render a complete configuration before apply, declare `mock_outputs` and include `"render"` in `mock_outputs_allowed_terraform_commands`.

A unit that has not been applied has no outputs to give, and that is ordinary during a teardown: `destroy` runs in reverse dependency order, so a unit is destroyed before the ones depending on it. `mock_outputs` supplies stand-in values for exactly that case.

```hcl
dependency "planning" {
  config_path = "../planning"

  mock_outputs = {
    area_file_path = "../teardown/empty-area.json"
  }
  mock_outputs_allowed_terraform_commands = ["destroy", "plan", "validate"]
}
```

Rules, most of which differ from Terragrunt's defaults on purpose:

- **`mock_outputs_allowed_terraform_commands` is required.** Terragrunt treats an omitted list as *every* command, which lets an invented value reach an `apply` and be written to real infrastructure. Here a unit that declares mocks names the commands that may see them; one that does not is refused.
- **A mock never shadows a real output.** Mocks fill in what the dependency does not have; a value it does have always wins, so a stale mock cannot quietly replace one.
- **A failed output command is an error.** Mocks apply when the output command succeeds with an empty map; an absent executable, invalid working directory, or credential failure is not evidence that state is absent.
- **A dependency block cannot read a dependency.** `config_path` and the mocks may use locals and functions, as in Terragrunt, but not `dependency.*`: Terragrunt evaluates dependency blocks before any outputs exist, and a mock stands in for a unit that has not been applied. Such a read is refused by name.

Note that a mocked path may still be read during evaluation — a module doing `jsondecode(file(var.path))` in a top-level local does so whatever the command — so a mock standing in for a file should name a real, minimal one rather than a path to nothing.

Reading an output that only a disallowed mock would have supplied reports which dependency, which output, where it looked, which commands its mocks are allowed for, and which command is running.

## Development

Install dependencies in this directory, with Node 22.18 or later in the 22 line, 24.11 or later in the 24 line, or 26 and up: the build tool needs it, and `npm install` says so and stops on any other. Using the published package has no such requirement. The grammar source is `grammar.peggy`; `src/parser.js` is the checked-in generated parser used by consumers. The test suite contains behavior assertions for includes, completions, file-kind validation, stack references, autoincludes, and workspace graph construction.

Run the TypeScript CLI directly during development with `npm run tghclp -- render --help` (or pass any other CLI arguments). This uses the locally installed `tsx` and does not require rebuilding `dist` after source changes.

Function evaluation is implemented as named operations using `@jowharshamshiri/ops-ts`. Each operation receives serialized arguments through a dry context and the live evaluator services through a wet context, so built-in and inline functions share the same invocation boundary.

## License

MIT. See [LICENSE](LICENSE).

Some source files are ports of other projects' code, and stay under those projects' licences:

- `src/hcl-format.ts`, `src/hcl-scanner.ts` and `src/hcl-syntax.ts` are ports of the formatter, scanner and parser of [hashicorp/hcl](https://github.com/hashicorp/hcl) (Copyright IBM Corp.), and are subject to the [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/). Their source is in this repository.
- `src/unified-diff.ts` is a port of the Go project's `internal/diff` (Copyright The Go Authors), under its [BSD-style licence](https://go.dev/LICENSE).
- `src/grapheme-clusters.ts` and `src/grapheme-table.ts` are a port of [go-textseg](https://github.com/apparentlymart/go-textseg) (Copyright Martin Atkins, MIT), whose table is built from the Unicode Character Database (Copyright Unicode, Inc., [Unicode License v3](https://www.unicode.org/license.txt)).
- `src/glob.ts` is a port of [gobwas/glob](https://github.com/gobwas/glob) (Copyright Sergey Kamardin, MIT).
- `src/terragrunt-filter.ts` is a port of the filter query language of [Terragrunt](https://github.com/gruntwork-io/terragrunt) (Copyright Gruntwork, Inc., MIT).

This is a community-supported project and is not affiliated with Gruntworks, Inc. or the Terragrunt project. Contributions are welcome — bug reports, feature ideas, and pull requests all help.

<a href='https://ko-fi.com/I2I51AM5W7' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
