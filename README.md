# Terragrunt HCL Parser

Parser and language-service toolkit for the Terragrunt 1.x HCL language. Version 1 follows the current Terragrunt regime and intentionally does not accept removed or deprecated compatibility syntax.

It powers the [Terragrunt HCL Language Server](https://marketplace.visualstudio.com/items?itemName=BahramJoharshamshiri.hcl-lsp) VS Code extension and is published as a standalone [npm package](https://www.npmjs.com/package/tghclparser).

## Supported files

- `terragrunt.hcl` and named shared unit configurations such as `root.hcl`
- `terragrunt.stack.hcl` explicit stacks
- `terragrunt.values.hcl` generated stack values
- `terragrunt.autoinclude.hcl` and `terragrunt.autoinclude.stack.hcl`

The schema covers unit configuration, `unit` and `stack` declarations, component `autoinclude` blocks, feature flags, excludes, error policies, catalogs, IaC engines, CAS source controls, and Terragrunt functions. See the official [HCL blocks](https://docs.terragrunt.com/reference/hcl/blocks/), [attributes](https://docs.terragrunt.com/reference/hcl/attributes/), and [functions](https://docs.terragrunt.com/reference/hcl/functions/) references for the language contract.

## Language-service features

- HCL parsing with source ranges and a navigable token tree
- File-kind-aware diagnostics and completion
- Reference completion for locals, includes, dependencies, features, values, units, and stacks
- Exact include resolution using the filename passed to `find_in_parent_folders`
- Workspace graphs for includes, dependencies, explicit stacks, and generated component targets
- Dependency output discovery from state
- Hover and document-link providers

## Development

Install dependencies in this directory. The grammar source is `grammar.peggy`; `src/parser.js` is the checked-in generated parser used by consumers. The test suite contains behavior assertions for includes, completions, file-kind validation, stack references, autoincludes, and workspace graph construction.

## License

MIT. See [LICENSE](LICENSE).

This is a community-supported project and is not affiliated with Gruntworks, Inc. or the Terragrunt project. Contributions are welcome — bug reports, feature ideas, and pull requests all help.

<a href='https://ko-fi.com/I2I51AM5W7' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi6.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>
