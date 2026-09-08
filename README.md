# Terragrunt HCL Parser

A **drop-in replacement for the `terragrunt` CLI**, and the parser and language-service toolkit for the Terragrunt 1.x HCL language that underpins it. Version 1 follows the current Terragrunt regime and intentionally does not accept removed or deprecated compatibility syntax.

The `tghclp` command runs OpenTofu or Terraform through Terragrunt configurations — includes, dependencies, `generate` blocks, explicit stacks — in place of `terragrunt` itself:

```sh
tghclp init            # terragrunt init
tghclp plan            # terragrunt plan
tghclp apply --all     # terragrunt run-all apply
```

Compatibility is established by running the same configuration through both and comparing what each produces, rather than by reading the documentation and assuming agreement. Where the two disagree, that is a bug here.

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

Experiment-gated language features must be enabled explicitly, for example `--experiment deep-merge`; the command fails when such a feature is used without its explicit switch.

## Development

Install dependencies in this directory. The grammar source is `grammar.peggy`; `src/parser.js` is the checked-in generated parser used by consumers. The test suite contains behavior assertions for includes, completions, file-kind validation, stack references, autoincludes, and workspace graph construction.

Function evaluation is implemented as named operations using `@jowharshamshiri/ops-ts`. Each operation receives serialized arguments through a dry context and the live evaluator services through a wet context, so built-in and inline functions share the same invocation boundary.

## License

MIT. See [LICENSE](LICENSE).

This is a community-supported project and is not affiliated with Gruntworks, Inc. or the Terragrunt project. Contributions are welcome — bug reports, feature ideas, and pull requests all help.

<a href='https://ko-fi.com/I2I51AM5W7' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
