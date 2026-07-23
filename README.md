# Terragrunt HCL Parser

Parser and language-service toolkit for the current Terragrunt HCL language. Version 1 targets the Terragrunt 1.x configuration model and intentionally does not accept removed or deprecated compatibility syntax.

## Supported files

- `terragrunt.hcl` and named shared unit configurations such as `root.hcl`
- `terragrunt.stack.hcl` explicit stacks
- `terragrunt.values.hcl` generated stack values
- `terragrunt.autoinclude.hcl` and `terragrunt.autoinclude.stack.hcl`

The schema includes current unit configuration, `unit` and `stack` declarations, component `autoinclude` blocks, feature flags, excludes, error policies, catalogs, IaC engines, CAS source controls, and current Terragrunt functions. See the official [HCL blocks](https://docs.terragrunt.com/reference/hcl/blocks/), [attributes](https://docs.terragrunt.com/reference/hcl/attributes/), and [functions](https://docs.terragrunt.com/reference/hcl/functions/) references for the language contract.

## Language-service features

- HCL parsing with source ranges and a navigable token tree
- File-kind-aware diagnostics and completion
- Locals, includes, dependencies, features, values, units, and stacks reference completion
- Exact include resolution using the filename passed to `find_in_parent_folders`
- Workspace graphs for includes, dependencies, explicit stacks, and generated component targets
- Dependency output discovery from state
- Hover and document-link providers


## Development

Install dependencies in this directory. The grammar source is `grammar.peggy`; `src/parser.js` is the checked-in generated parser used by consumers. The test suite contains behavior assertions for current includes, completions, file-kind validation, stack references, autoincludes, and workspace graph construction.

## License

MIT. See [LICENSE](LICENSE).
