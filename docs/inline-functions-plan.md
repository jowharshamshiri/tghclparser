# Inline Functions — Design & Implementation Plan

Status: implemented. §11 records where the built result differs from the plan
and why.

## 1. What we are building

A `function` block that defines a JavaScript function inside an HCL
configuration. It declares its arguments, its body is multi-line JavaScript, and
it is called exactly like a built-in.

```hcl
function state_key(environment, component = "app") {
  const tier = environment === "prod" ? "prod" : "nonprod";
  return `${tier}/${component}/terraform.tfstate`;
}

inputs = {
  key = state_key("prod", "api")
}
```

That is the whole feature. One block form, one body language, one calling
convention.

## 2. Why

**The gap.** Terragrunt configurations repeat expressions — a naming convention,
a tag map, a shard computation — copied across units or smuggled into `locals`
blocks duplicated in every file. `locals` cannot take arguments, so it cannot be
parameterized. There is no unit of reuse between "a literal value" and "a
built-in function." And HCL has no imperative control flow: ternaries and
comprehensions stop scaling past two levels of nesting, and the workarounds
(chained `merge`, nested `for` with `if` guards) are worse than the problem.

**Why JavaScript, and only JavaScript.** An HCL-expression body would solve the
parameterization half and leave the control-flow half untouched — a second,
weaker function form that users would have to choose between, and a decision
they should never have to make. One body language, and it should be the one that
can actually express the logic people are writing.

**Why it is nearly free here.** `tghclparser` is already TypeScript on Node.
The evaluator is already `async` throughout. The marshalling layer is already
written: `runtimeToPlain` and `convertToRuntimeValue`
(`src/functions/utils.ts:44–80`) convert `RuntimeValue` ↔ plain JS in both
directions. There is no runtime to embed, no new dependency, no bridge to build.

**Why now.** This is a conscious divergence from Terragrunt. `tghclparser` is
not a language service for someone else's runtime any more; it is the runtime.
That settles the trade-offs that would otherwise dominate:

- Portability to Terragrunt is not a goal for new capability. It is a hard
  requirement in one direction only: every existing Terragrunt configuration
  must continue to evaluate identically (§8).
- Sandboxing is not a goal. The config file *is* the program, exactly as it is
  for `terraform apply`. `run_cmd` (`src/Evaluator.ts:395`) already executes
  arbitrary programs; a JS body grants no authority that is not already granted,
  and grants it more legibly.
- The consumer's trust model stays the consumer's. The LSP keeps its
  `assertTrusted` gate (`src/Evaluator.ts:97`) for evaluate-on-open. That is an
  editor policy, not a language constraint.

**Why the architecture already wants this.** `FunctionOperation.inline(name,
handler)` exists today (`src/function-ops.ts:81`) and is tested
(`tests/function-ops.test.ts:41`) but unused in `src/`. It is an op whose
`perform` reads the standardized dry/wet contexts directly — exactly the seam
this feature needs. Inline functions become the first production consumer of a
boundary that was built for them.

## 3. Syntax

### 3.1 The block

```
function <name>(<parameters>) { <javascript> }
```

The signature line reads as a function signature, because it is one. The body is
JavaScript. Nothing about it needs explaining to someone who has written either
language.

```hcl
function bucket_name(environment, region) {
  const org = tg.local.organization;
  return `${org}-${environment}-${region}-state`;
}
```

**Why this shape rather than a labeled HCL block.** The alternative —
`function "name" { param "environment" { type = string } result = <<-JS ... JS }`
— buries a signature under three levels of nesting, splits the parameter list
away from the body, and wraps the code in a heredoc. It parses without grammar
changes, which is its only advantage. The form above is what a user would guess
if asked to write a function, which is the whole requirement: no learning curve.

### 3.2 Parameters

Declared in the signature, positionally, with the JS conventions users already
know:

```hcl
function shard_plan(units, shards = 3, ...labels) {
  const plan = {};
  for (const [index, unit] of units.entries()) {
    plan[unit] = { shard: index % shards, labels };
  }
  return plan;
}
```

| Form           | Meaning                                        |
| -------------- | ---------------------------------------------- |
| `name`         | Required parameter                             |
| `name = expr`  | Optional, with a default (an HCL expression)   |
| `...name`      | Variadic; collects the remaining arguments     |

Defaults are HCL expressions evaluated in the defining file's scope, so
`function f(region = local.default_region)` works. Parameters are bound as
ordinary JS identifiers in the body — no `param.` prefix, no `args` array, no
second access path.

**Optional type annotations.** For diagnostics and hover, a parameter may carry
an HCL type constraint:

```hcl
function state_key(environment: string, component: string = "app") {
  return `${environment}/${component}/terraform.tfstate`;
}
```

Untyped parameters are `any` and unchecked. Types are declaration and check in
one place — unlike the built-ins, where `src/functions.json` declares the
parameter and the implementation re-states it by hand
(`stringArgument(args, 0, 'substr')`, `src/functions/builtin_functions.ts:643`)
with nothing keeping the two in sync.

### 3.3 Calling

Identical to a built-in. Call sites parse today under `FunctionCall`
(`grammar.peggy:847`).

```hcl
inputs = {
  key  = state_key("prod")
  tags = resource_tags("prod", { Team = "platform" })
}
```

### 3.4 Async

Bodies are implicitly async. `await` is available; the result is awaited before
it re-enters HCL evaluation. Callers write a normal call — there is no `await`
at the HCL call site.

```hcl
function repo_state_prefix() {
  const root = await tg.call("get_repo_root");
  return root.split("/").pop();
}
```

### 3.5 Reaching the configuration — `tg`

A `tg` binding gives the body access to the surrounding configuration.

| Binding              | Meaning                                                |
| -------------------- | ------------------------------------------------------ |
| `tg.call(name, ...)` | Invoke any function — built-in or inline               |
| `tg.local.<name>`    | A local from the defining file's scope                  |
| `tg.include.<name>`  | An exposed include, same rules as HCL                   |
| `tg.context`         | `{ terragruntDir, repoRoot, workingDirectory, environmentVariables }` |

`tg.call` routes through `FunctionContext.evaluateFunction`, which already
exists (`src/model.ts:395`): arguments convert in with `convertToRuntimeValue`,
the result converts out with `runtimeToPlain`. Everything is in-process, so
there is no boundary to cross. A helper that could not reach its file's locals
or call `find_in_parent_folders` would be half a feature.

### 3.6 Values across the boundary

HCL values arrive as plain JS — strings, numbers, booleans, arrays, objects —
via `runtimeToPlain`. The return value converts back via
`convertToRuntimeValue`. Returning a value with no HCL representation (a
function, a `Symbol`, a circular structure) is an evaluation error naming the
function.

## 4. How it works

Every function — built-in or inline — is a `FunctionOperation` invoked through
`invokeFunctionOperation` (`src/function-ops.ts:100`), which places serialized
arguments in a `DryContext` under `tghclp.function.args` and the live
`FunctionContext` in a `WetContext` under `tghclp.function.context`. Inline
functions change nothing about that boundary; they are its first inline
consumer.

```ts
function makeInlineFunctionOperation(
  definition: InlineFunctionDefinition,
  evaluator: ConfigEvaluator
): FunctionOperation {
  return FunctionOperation.inline(definition.name, async (dry, wet) => {
    const args    = readArgs(dry);                            // FUNCTION_ARGS_KEY
    const context = wet.getRequired<FunctionContext>(FUNCTION_CONTEXT_KEY);
    const bound   = await evaluator.bindParameters(definition, args);
    return evaluator.invokeJsBody(definition, bound, context);
  });
}
```

`bindParameters` zips the positional arguments against the declared parameters:
evaluating defaults for absent optionals, collecting the tail into a variadic
parameter, and type-checking any annotated ones. It produces the argument list
the compiled body is called with.

`invokeJsBody` compiles the body once per definition and caches it:

```ts
const body = new AsyncFunction(...definition.parameterNames, 'tg', definition.source);
return convertToRuntimeValue(await body(...boundArgs, tgBinding));
```

Parameters are real function arguments, so `return` works, compilation is
cached, and stack traces map cleanly back to the body's source range for
diagnostics.

## 5. Scoping

**Lexical.** A body's `tg.local.*` and `tg.include.*` resolve against the file
that **defines** the function, never the caller's. A function is a named
expression in its own file and behaves identically regardless of call site.
Parameter defaults evaluate in that same scope.

**Inherited through `include`,** following the conventions that already govern
inherited configuration. A `function` in `root.hcl` is callable from every unit
that includes it. Child definitions win on name collision. There is no `expose`
gate — `expose` controls data-namespace pollution; functions are behavior.

**Shadowing a built-in is an error:**
`Inline function "join" shadows a built-in function`.

**Recursion** is permitted, guarded by a call-depth cap reusing the `'pending'`
sentinel pattern from `resolveLocal` (`src/Evaluator.ts:545`):
`Inline function "f" exceeded maximum call depth`. Mutual recursion falls out
for free.

## 6. Implementation

### 6.1 Grammar

This is the one place the feature costs real work, and it is the price of the
syntax being intuitive rather than merely parseable.

A new top-level statement rule, added to `Statement` (`grammar.peggy:76`)
alongside `RootAssignment` and `Block`:

```peggy
InlineFunction =
  _ "function" [ \t]+ name:Identifier _
  "(" _ params:FunctionParams? _ ")" _
  "{" body:RawJsBody "}" {
    return makeNode('inline_function', name, location(), [
      ...(params || []),
      makeNode('js_body', body.text, body.location)
    ]);
  }

FunctionParams = first:FunctionParam rest:(_ "," _ FunctionParam)* _ ","? {
  return [first, ...rest.map(r => r[3])];
}

FunctionParam =
  variadic:"..."? _ name:Identifier _
  type:(":" _ TypeConstraint)? _
  def:("=" _ Expression)? {
    return makeNode('inline_param', name, location(), [
      ...(type ? [type[2]] : []),
      ...(def ? [makeNode('param_default', null, location(), [def[2]])] : [])
    ]);
  }
```

`RawJsBody` captures the body by scanning to its matching `}`, tracking brace
depth while skipping over JS string literals, template literals, regex literals,
and comments — so a `}` inside `` `${x}` `` or `"}"` does not terminate the
body. It returns the raw text plus its location, which is what makes error
mapping (§6.4) possible.

Two token types are added to `TokenType` in `src/model.ts`: `inline_function`
and `inline_param`.

Everything else parses unchanged: call sites under `FunctionCall`
(`grammar.peggy:847`), type annotations under `TypeConstraint`
(`grammar.peggy:942`), defaults under `Expression`.

### 6.2 New `src/inline-functions.ts`

```ts
export interface InlineFunctionParameter {
  name: string;
  variadic: boolean;
  typeNode?: TNode;      // optional HCL type constraint
  defaultNode?: TNode;   // optional HCL expression
}

export interface InlineFunctionDefinition {
  name: string;
  parameters: InlineFunctionParameter[];
  source: string;        // raw JS body
  sourceRange: Range;    // for error mapping
  scope: Scope;          // defining file — lexical capture
  compiled?: AsyncFunction;
}
```

Plus `synthesizeDefinition(def): FunctionDefinition`, producing the metadata
object that diagnostics, hover, and completions already consume — so those
providers need no new concepts, only a new source of definitions.

Inline functions are **per-file** and therefore never enter the process-wide
`FunctionRegistry` singleton. They live on `Scope`.

### 6.3 `src/blocks.json`

No changes. `function` is a statement, not a block, so it is not part of the
block schema.

### 6.4 `src/Evaluator.ts`

- `Scope` gains `functions: Map<string, InlineFunctionDefinition>`.
- `evaluateFile` (line 240): collect `inline_function` statements in the same
  pass that collects `locals`; check duplicates and built-in shadowing.
- `evalFunctionCall` (line 922): before the built-in lookup at line 946, resolve
  against `scope.functions`, walking the include chain. On a hit, evaluate
  arguments as usual and dispatch through `invokeFunctionOperation`.
- New `bindParameters` — defaults, variadic collection, type checks (§4).
- New `invokeJsBody` — compile-and-cache, build the `tg` binding, await, convert
  back. Thrown errors are re-raised with the body's source range so diagnostics
  land on the right line of the right file.

### 6.5 `src/function-ops.ts`

One change: export `deserializeArgs` (or add a `readArgs(dry)` helper).
`FunctionOperation` itself needs nothing.

### 6.6 Language service

These consume the synthesized `FunctionDefinition`, so the changes are small:

- `DiagnosticsProvider.validateFunctions` (line 152) — consult document-local
  inline functions before emitting `Unknown function`; arity and type checks run
  through the existing `validateFunctionArguments`.
- `CompletionsProvider.functionItems` (line 252) — append document-local
  functions with `sortText: '1-'` so they rank above built-ins.
- `HoverProvider` (line 379) — signature from the synthesized definition, plus
  the body source.
- `LinkProvider` — jump from a call site to its definition.

JS syntax errors in a body surface as diagnostics at parse time, positioned via
`sourceRange`.

### 6.7 CLI

`tghclp run` and `tghclp hcl validate` (`src/cli.ts`) both funnel through
`ConfigEvaluator` → `FunctionRegistry`, so evaluation falls out. The validate
path needs the diagnostics side to recognize inline functions, or CI will reject
configurations the runtime accepts.

## 7. Worked example

```hcl
# root.hcl — defined once, inherited by every unit
locals {
  organization = "acme"
}

function state_key(environment: string, component: string = "app") {
  const tier = environment === "prod" ? "prod" : "nonprod";
  return `${tier}/${component}/terraform.tfstate`;
}

function resource_tags(environment: string, extra = {}) {
  const base = {
    Organization: tg.local.organization,
    Environment:  environment,
    ManagedBy:    "terragrunt",
    Root:         await tg.call("get_repo_root"),
  };
  return { ...base, ...extra };
}

function shard_plan(units, shards = 3) {
  const plan = {};
  for (const [index, unit] of units.entries()) {
    plan[unit] = { shard: index % shards, primary: index === 0 };
  }
  return plan;
}
```

```hcl
# app/terragrunt.hcl
include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  state_key = state_key("prod", "api")
  tags      = resource_tags("prod", { Team = "platform" })
  shards    = shard_plan(["api", "worker", "cron", "web"])
}
```

## 8. Compatibility & testing

The drop-in requirement runs in one direction: **every existing Terragrunt
configuration must evaluate identically.**

The concrete risk is the new `function` statement keyword. Verified: no file in
`tests/fixtures/github-corpus/` (30 configurations) uses `function` as a block
identifier or root attribute name. The plan adds a standing corpus assertion
that no fixture's AST or diagnostics change once the rule is added.

New `tests/inline-functions.test.ts` covers:

- Parsing: signatures, defaults, variadics, type annotations, nested braces in
  the body, and `}` inside strings, template literals, regexes, and comments.
- Binding: defaults applied, variadic tails collected, type-check failures,
  arity errors.
- Async: `await` in a body; a body returning a promise.
- `tg.call`, `tg.local`, `tg.include`, `tg.context`.
- Lexical capture — a function using `tg.local.x` called from a file with a
  different `local.x`.
- Inheritance through `include`; child-wins on collision.
- Built-in shadowing; duplicate definitions.
- Recursion depth cap; mutual recursion.
- Marshalling: every `RuntimeValue` type in and out; unrepresentable return
  values error clearly.
- Error mapping: a body throwing at line N reports line N of the right file.
- `metadata().name` is `tghclp.function.<name>`, matching every built-in.

## 9. Decisions

| Question              | Decision |
| --------------------- | -------- |
| Body language         | JavaScript, multi-line, only body form |
| Syntax                | `function name(params) { ... }` as a top-level statement |
| Parameter declaration | In the signature, positional, JS conventions (`= default`, `...rest`) |
| Type annotations      | Optional, `name: type`, HCL type constraints |
| Argument access       | Bound as ordinary JS identifiers — no `param.` or `args` path |
| Async                 | Implicitly async; results awaited; no `await` at the HCL call site |
| Config access         | `tg` binding, in v1 |
| Recognition scope     | Follows existing inherited-configuration conventions |
| Experiment gate       | None — a conscious divergence, not an experiment |
| Sandboxing            | None — the config is the program, as with `run_cmd` |

## 11. What the implementation added to this plan

The design held. These are the details the plan did not anticipate, each found by
a test or a probe against the real pipeline.

**Peggy code blocks cannot contain a brace inside a quoted string or a comment.**
Peggy delimits a grammar action by counting braces, without regard for string
literals or comments. The body scanner therefore compares character *codes*
(`OPEN_BRACE = 123`) rather than characters, and its comments carry no brace
characters. Template literals and hex escapes are handled correctly by Peggy;
quoted `'{'` and a `}` in a `//` comment are not.

**PEG rules consume input only by matching.** A semantic predicate cannot advance
the parser, so the body is consumed one character at a time by
`InlineFunctionBodyChar`, whose predicate stops at the end offset that
`scanJsBody` computed once when the opening brace matched. A stack of end offsets
supports a nested `function` declaration inside a body.

**`makeContext` resolved the repository root eagerly**, so evaluating any
configuration outside a Git repository failed with `No Git repository contains
…`. Inline functions call `makeContext` on every invocation, which made this
surface constantly. The functions that genuinely need the repository root already
resolve it themselves and raise their own error, so `repoRoot` is now resolved
only when a repository exists (`findRepoRoot`).

**Collecting inherited declarations must not evaluate the configuration.** The
first implementation called `evaluateFile`, so any error anywhere — including the
very argument-type error under diagnosis — produced no inherited definitions and
a call to an inherited function was then misreported as `Unknown function`.
`collectInheritedInlineFunctions` now walks the include chain structurally,
parsing each file and resolving only include paths.

**Eagerly resolving `tg.local` broke calls from inside a `locals` block.** A
function called while a local is being evaluated re-entered that local, and the
cycle detector reported a cycle that did not exist. Locals still resolving are
now withheld (`resolvableLocals`); reading one from a body is a real cycle and
says so precisely. Sibling locals remain fully available.

**Errors re-wrapped once per stack frame.** Runaway recursion produced a message
repeating its prefix 128 times. `InlineFunctionError` marks a failure that
already names its function and position, and enclosing frames re-throw it
unchanged.

**`runtimeToPlain` mapped unrepresentable values to `null`.** That would have
silently emptied a `sensitive` value passed into a body. It now unwraps
`sensitive` and throws on genuinely unrepresentable types; `convertToRuntimeValue`
gained an optional label that turns functions, symbols, `undefined`, non-finite
numbers, and circular structures into named errors instead of `null`.

**Two shared-code defects surfaced and were fixed at the root**: the diagnostic
"accepts at most 1 arguments" was not pluralized, and the CLI classified inline
function problems as generic `HCL validation error` (now `Invalid inline
function`).

### Verification

`tests/inline-functions.test.ts` covers declaration capture (braces inside
strings, templates, nested substitutions, both comment forms, regexes, nested
functions, empty bodies, division-versus-regex), signature validation, binding
and arity, every type constraint including structural ones, scoping and
inheritance, the `tg` bindings, failure reporting, and the language service.

The full suite is 130 passing, which includes the 30 GitHub-derived corpus
fixtures continuing to preserve their authored structure — the drop-in
compatibility guarantee of §8.
