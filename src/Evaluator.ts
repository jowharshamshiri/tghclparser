import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CtyNumber, NUMBER_OUT_OF_RANGE } from './cty-number';
import { ConversionError, convert, getConversionUnsafe, unify } from './cty-convert';
import {
	arithmetic,
	attributeType,
	attributeValue,
	comparison,
	type ConditionalBranch,
	conditionalResult,
	conditionValue,
	convertToBool,
	describeConditionalTypeMismatch,
	forCondition,
	forElements,
	forKey,
	HclError,
	indexValue,
	negation,
	objectKey,
	operandBool,
	settleUnknowns,
	splatResult,
	templatePart,
	UNSUPPORTED_ATTRIBUTE
} from './cty-operations';
import { type CtyType, ctyBool, ctyDynamic, ctyNumber, ctyString, friendlyName, listOf, tupleOf, typeEquals } from './cty-types';
import { FunctionOperation, invokeFunctionOperation, readArgs, FUNCTION_CONTEXT_KEY } from './function-ops';
import { EXPRESSION_CLOSURE, type FunctionSignature, markResult, parameterAt, prepareArguments } from './function-signature';
import { goQuoted } from './go-quote';
import { type HclDiagnostic, type HclRange, hclRange, hclValueText, rangeOver, rangeString } from './hcl-diagnostics';
import type { InlineFunctionDefinition } from './inline-functions';
import { checkTypeConstraint, readInlineFunction, readTypeConstraint, synthesizeDefinition } from './inline-functions';
import { parseHclSyntax } from './syntax';
import { Schema } from './Schema';
import { encryptedSopsDocument } from './sops';
import { goRepoRoot, RepoRootError } from './functions/git_repo_root';
import type { BuiltinFunctionDefinition, FunctionContext, FunctionDefinition, RuntimeValue, ValueType } from './model';
import {
	compareStrings,
	type LogicalOperand,
	logicalOperation,
	NULL_OPERAND,
	convertToRuntimeValue,
	isUnknown,
	isWhollyKnown,
	makeArrayValue,
	makeBooleanValue,
	makeDynamicValue,
	makeListValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeSensitiveValue,
	makeStringValue,
	makeUnknownValue,
	runtimeToJavaScript,
	unwrapSensitive,
	valueType
} from './functions/utils';
import { decodeConfigFile, mergeDeep, mergeShallow, samePlain, terragruntConfigValue, throughJson, UnknownAttribute, UNRESOLVED } from './terragrunt-config';
import type { ConfigBlock, ConfigBody, Plain, TerragruntConfig } from './terragrunt-config';
import { isDefect } from './unresolved';
import { isWrittenOut } from './writtenOut';
import type { Range } from 'vscode-languageserver';

interface TNode {
	type: string;
	value?: string | number | boolean | null;
	children?: TNode[];
	/** Set on inline_param nodes to mark a `...rest` parameter. */
	variadic?: boolean;
	location?: {
		start: { offset: number; line: number; column: number };
		end: { offset: number; line: number; column: number };
	};
}

export interface ConfigEvaluatorOptions {
	environmentVariables: Record<string, string>;
	terraformCommand?: string;
	terraformCliArgs?: string[];
	experiments?: string[];
	workspaceTrusted?: boolean;
	/**
	 * Directories outside the workspace root a configuration may still read.
	 *
	 * The workspace boundary comes from this tool's origin as a language
	 * server, where a configuration is opened before anyone has vouched for
	 * it and must not be able to read whatever it names. Terragrunt has no
	 * such boundary, so a layout it accepts can be one this refuses -- a
	 * deployment plan kept in a sibling checkout, say, which is a normal way
	 * to keep credentials out of the repository.
	 *
	 * Named rather than inferred: widening the root until it covers both
	 * would have to reach a common ancestor, and an ancestor broad enough to
	 * contain two sibling checkouts has stopped being a boundary at all. Each
	 * entry says one place, so what was opened up stays legible.
	 */
	allowedPaths?: string[];
	/**
	 * Reads the outputs of a dependency the evaluator has found and evaluated (see {@link DependencyRequest}),
	 * resolving to `{ outputs: … }`. Resolves to undefined when the dependency has no outputs to give yet, which is
	 * reported as unresolved rather than as a fault. Whether a dependency is declared at all is decided by the
	 * evaluator, before the resolver is asked.
	 */
	resolveDependency?: (request: DependencyRequest) => Promise<RuntimeValue<ValueType> | undefined>;
	/** Omit fields that read unresolvable values, and expose them through unresolvedRenderFields(). */
	partialRender?: boolean;
	/**
	 * Decode each file as Terragrunt's `render` decodes it: its inputs and the attributes of its blocks evaluated as HCL
	 * evaluates them, going on past errors, and the file's errors let pass when one of them is an attribute a value
	 * does not have. The errors let pass are given by toleratedDecodes().
	 */
	renderDecode?: boolean;
	/**
	 * When sops cannot decrypt a file, read its keys from the encrypted file itself, with the values left as sops
	 * wrote them. For an editor, whose completion and hover can then name a secret's keys on a machine that has no
	 * key to it, and for validating where there is no key, as in CI: a key the file does not have is still a fault.
	 *
	 * Such a value can be passed along as it is, but anything computed from it (a template, an operator, a function
	 * other than one that only decodes the file or selects from a collection, an inline function) is unresolved, as
	 * {@link EncryptedSopsValueError}. So `run_cmd` is never run with one, and a `generate` block or `remote_state`
	 * holding one is unresolved rather than rendered to be written to a file. Leave unset for anything that runs or
	 * generates, which needs the real value.
	 */
	readEncryptedSops?: boolean;
}

/**
 * A dependency as Terragrunt would resolve it for a unit: its `dependency` block found in the configurations merged
 * into the unit, and its attributes evaluated in the scope of the file that declares each of them.
 */
export interface DependencyRequest {
	/** The block's label, which `dependency.<name>` reads. */
	name: string;
	/** Absolute path of the unit the dependency belongs to. */
	unitPath: string;
	/** Absolute path of the file whose block decided the dependency, as messages name it. */
	declaredIn: string;
	/** Absolute path of the configuration `config_path` names, resolved against the unit's directory. */
	targetConfigPath: string;
	/** Absolute path of the directory the target configuration is in, where its outputs are read. */
	targetDir: string;
	/** The evaluated `mock_outputs`, merged across included blocks; absent when none is declared. */
	mockOutputs?: RuntimeValue<ValueType>;
	/** The evaluated `mock_outputs_allowed_terraform_commands`, merged across included blocks; absent when none is declared. */
	mockOutputsAllowedTerraformCommands?: string[];
}

/** A value a render cannot resolve: the field that reads it is omitted and reported rather than failing the render. */
export class UnresolvedRenderValueError extends Error {}

/**
 * A fault in one expression of a configuration, so it can be reported where that expression is written: a local
 * that does not exist, an attribute a value does not have.
 *
 * The file is the one the expression is written in. For a unit that inherits the expression through an include, that
 * is the included file and not the unit.
 */
export class LocatedEvaluationError extends Error {
	/** Faults found after this one in the same evaluation, where evaluation could carry on past it. */
	readonly further: LocatedEvaluationError[] = [];

	/**
	 * Creates the error.
	 *
	 * @param message what went wrong.
	 * @param filePath the configuration holding the expression.
	 * @param range where the expression is in that configuration.
	 * @param options the underlying error, if any.
	 */
	constructor(message: string, public readonly filePath: string, public readonly range: Range, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'LocatedEvaluationError';
	}
}

/**
 * Where a node is in its file, or undefined for a node the parser gave no location.
 *
 * @param node the syntax node.
 * @returns the node's range, zero-based as an editor expects.
 */
function nodeRange(node: TNode): Range | undefined {
	if (!node.location) return undefined;
	return {
		start: { line: node.location.start.line - 1, character: node.location.start.column - 1 },
		end: { line: node.location.end.line - 1, character: node.location.end.column - 1 }
	};
}

/** The variables a `locals` block can read, as Terragrunt names them. */
const LOCALS_ROOTS = ['local', 'include', 'feature', 'values'];

/** The variable each kind of reference node reads, for the kinds whose variable the grammar fixes. */
const REFERENCE_ROOTS: Record<string, string> = {
	local_reference: 'local',
	dependency_reference: 'dependency',
	module_reference: 'module',
	terraform_reference: 'terraform',
	var_reference: 'var',
	data_reference: 'data',
	path_reference: 'path'
};

/** Nodes that name something rather than read a variable: a for expression's variables, members, functions and keys. */
const NAMING_NODES = new Set(['identifier', 'function_identifier', 'attribute_identifier', 'type_parameters']);

/**
 * The variables an expression reads, by the name each is rooted at, in the order they are written: what HCL's
 * `Expression.Variables()` gives. A for expression's own variables are not among them, inside it, whatever they are
 * called; its collection is read outside them.
 *
 * @param node the expression.
 * @param bound the names the for expressions around it bind.
 * @returns the root names, one per reference.
 */
function variableRoots(node: TNode, bound: ReadonlySet<string> = new Set()): string[] {
	const root = REFERENCE_ROOTS[node.type]
		?? (node.type === 'reference' || node.type === 'traversal_reference' ? String(node.value ?? '') : undefined);
	if (root !== undefined) return bound.has(root) ? [] : [root];
	const children = node.children ?? [];
	if (node.type === 'list_comprehension' || node.type === 'map_comprehension' || node.type === 'for_expression' || node.type === 'for_directive') {
		const names = children.filter(child => child.type === 'identifier').map(child => String(child.value ?? ''));
		const [collection, ...body] = children.filter(child => child.type !== 'identifier');
		const inner = new Set([...bound, ...names]);
		return [
			...(collection ? variableRoots(collection, bound) : []),
			...body.flatMap(child => variableRoots(child, inner))
		];
	}
	return children.filter(child => !NAMING_NODES.has(child.type)).flatMap(child => variableRoots(child, bound));
}

/**
 * Refuses a local that reads a variable a `locals` block cannot see, as Terragrunt does before evaluating any: a
 * dependency's outputs, `var`, `terraform` and the rest. The reference alone decides, whether or not evaluation would
 * reach it.
 *
 * @param node the local's expression.
 * @param filePath the configuration it is written in.
 * @throws LocatedEvaluationError naming the first such variable, with one further fault for each other.
 */
function assertLocalReadsOnlyLocalsRoots(node: TNode, filePath: string): void {
	const refused = [...new Set(variableRoots(node).filter(root => !LOCALS_ROOTS.includes(root)))];
	if (refused.length === 0) return;
	const messages = refused.map(root =>
		`Locals can only reference these variables: ${LOCALS_ROOTS.join(', ')}. This expression references "${root}".`
	);
	const range = nodeRange(node);
	if (!range) throw new Error(messages[0]);
	const [first, ...rest] = messages.map(message => new LocatedEvaluationError(message, filePath, range));
	first.further.push(...rest);
	throw first;
}

export class UnreadableSopsFileError extends UnresolvedRenderValueError {
	constructor(file: string, reason: string) {
		super(`sops could not decrypt ${file}: ${reason}`);
		this.name = 'UnreadableSopsFileError';
	}
}

/**
 * A value read as written from a sops file that could not be decrypted (see {@link ConfigEvaluatorOptions.readEncryptedSops}),
 * used where its plain value is needed. The secret is not known here, so nothing computed from it is either: it is
 * unresolved, as an unapplied dependency's output is, rather than computed from the encrypted text, and no command or
 * generated file ever receives that text.
 */
export class EncryptedSopsValueError extends UnresolvedRenderValueError {
	constructor() {
		super('reads a secret from a sops file that could not be decrypted, so its value is not known');
		this.name = 'EncryptedSopsValueError';
	}
}

export class UnresolvedDependencyOutputError extends UnresolvedRenderValueError {
	constructor(dependency: string, output: string, reason?: string) {
		super(
			reason === undefined
				? `dependency "${dependency}" has no output "${output}"; apply the unit or allow a mock for render`
				: `dependency "${dependency}" output "${output}" could not be read: ${reason}`
		);
		this.name = 'UnresolvedDependencyOutputError';
	}
}

export class UnresolvedDependencyError extends UnresolvedRenderValueError {
	constructor(dependency: string) {
		super(`Dependency "${dependency}" has no evaluated outputs`);
		this.name = 'UnresolvedDependencyError';
	}
}

/**
 * A span of source, by character offset, and the value it evaluates to.
 *
 * `kind` says what the span is: an `expression`, or the `name` of an attribute, whose value is the one bound to it.
 * A name's value is always also the value of the expression beside it, so a caller marking spans can leave names
 * out and lose nothing, while one answering a hover still has them. The `elements` of a `for` expression's
 * collection are the values its variable takes, as a list in the order HCL visits them, gathered over every element
 * of the `for` expressions around it: they are not the collection's value, which is its `expression` span when it
 * has one, and are for completing the variable, not for showing.
 */
export interface EvaluatedSpan {
	start: number;
	end: number;
	kind: 'name' | 'expression' | 'elements';
	value: RuntimeValue<ValueType>;
}

// The node types that are expressions in their own right. Array and object literals are left out: their elements
// are spans, and the name they are bound to shows the whole.
const EXPRESSION_SPAN_TYPES = new Set([
	'string_lit',
	'number_lit',
	'boolean_lit',
	'null_lit',
	'reference',
	'local_reference',
	'dependency_reference',
	'module_reference',
	'terraform_reference',
	'var_reference',
	'data_reference',
	'path_reference',
	'traversal_reference',
	'interpolated_string',
	'ternary_expression',
	'comparison_expression',
	'logical_expression',
	'arithmetic_expression',
	'null_coalescing',
	'unary_expression',
	'postfix_expression',
	'pipe_expression',
	'index_expression',
	'splat_expression',
	'member_access',
	'list_comprehension',
	'map_comprehension',
	'function_call'
]);

/** A fault in one expression, and where that expression is written. */
export interface EvaluationProblem {
	message: string;
	/** The configuration the expression is written in: an included file when the unit inherits the expression. */
	filePath: string;
	range: Range;
}

export interface ConfigEvaluationResult {
	valid: boolean;
	inputs: RuntimeValue<ValueType> | null;
	error?: string;
	/** The error is a value that cannot be known yet, such as a dependency never applied, not a fault in the configuration. */
	unresolved?: boolean;
	/**
	 * Every fault evaluation could place, where each is written. `error` is the first one's message. Absent when the
	 * error has no place in the configuration, such as a file that cannot be read.
	 */
	problems?: EvaluationProblem[];
}

interface IncludeRef {
	expose: boolean;
	mergeStrategy: MergeStrategy;
	dir: string;
	result: FileResult;
}

interface FileResult {
	filePath: string;
	dir: string;
	content: string;
	scope: Scope;
	inputs: Map<string, RuntimeValue<ValueType>> | null;
	unresolvedInputs: Map<string, {file: string; reason: string}>;
	hasInputs: boolean;
	/** The diagnostics a render's decode gave for the file's own inputs, which its decode weighs with the rest. */
	inputDiagnostics: HclDiagnostic[];
}

/** An expression's value as HCL gives it, unknown where HCL's is, with the diagnostics it gives beside it. */
interface Tolerated {
	value: RuntimeValue<ValueType>;
	diagnostics: HclDiagnostic[];
}

/**
 * A file a render decoded past errors, as Terragrunt's CompleteTerragruntConfigFile lets them pass: the file, its
 * text, and every diagnostic its decode gave, at least one of them an attribute a value does not have.
 */
export interface ToleratedDecode {
	filePath: string;
	content: string;
	diagnostics: HclDiagnostic[];
	/**
	 * Read by read_terragrunt_config(), whose parser Terragrunt has write diagnostics only at the debug level, rather
	 * than decoded for the configuration being rendered.
	 */
	quiet: boolean;
}

interface Scope {
	filePath: string;
	content: string;
	ast: TNode;
	dir: string;
	workspaceRoot: string;
	locals: Map<string, TNode>;
	localCache: Map<string, RuntimeValue<ValueType>>;
	/** In-flight `resolveLocal` work, so concurrent readers of one local await it instead of reporting a cycle. */
	localPending: Map<string, Promise<RuntimeValue<ValueType>>>;
	includes: Map<string, IncludeRef>;
	autoinclude: FileResult | null;
	rootAttrs: Map<string, TNode>;
	terraform: Map<string, TNode>;
	/**
	 * `generate` blocks by label, each as its own attribute map.
	 *
	 * Labelled, unlike `terraform`, because a configuration writes several and
	 * the label is what a later one overrides: a unit that generates
	 * `provider.tf` replaces the root's block of that name rather than adding
	 * a second one.
	 */
	generate: Map<string, Map<string, TNode>>;
	/**
	 * The directory of the unit being rendered, when that is not this file's.
	 *
	 * Set only while a `generate` block inherited through an include is
	 * evaluated. The two directories answer different questions and terragrunt
	 * keeps them apart: `file("../x.yml")` resolves against the file the
	 * expression is WRITTEN IN, while `get_terragrunt_dir()` reports the unit
	 * being rendered. Overriding `dir` for both made an inherited block read a
	 * file next to the unit instead of the one next to the root config -- the
	 * same relative path silently naming a different file.
	 */
	unitDir?: string;
	blocks: TNode[];
	comprehension: Array<Map<string, RuntimeValue<ValueType>>>;
	/** Inline functions declared by this file, by name. */
	functions: Map<string, InlineFunctionDefinition<Scope>>;
	/**
	 * The unit this file was evaluated for, which a `dependency` reference in it resolves against. Held by the scope
	 * rather than read from the asynchronous context, because a scope is evaluated in after its file's evaluation has
	 * returned -- an inherited `generate` block when rendering, an expression under the cursor.
	 */
	unit?: UnitContext;
}

interface LocalResolution {
	scope: Scope;
	name: string;
}

/** An attribute of a `dependency` block with the scope of the file it is written in, where it is evaluated. */
interface DependencyAttribute {
	node: TNode;
	scope: Scope;
}

/**
 * A `dependency` block after Terragrunt's include merge: `config_path` from the highest-priority block that sets
 * it, and the mock settings of every block deep-merged into it, lowest priority first.
 */
interface DependencyDeclaration {
	declaredIn: string;
	configPath?: DependencyAttribute;
	mockOutputs: DependencyAttribute[];
	mockOutputsAllowedTerraformCommands: DependencyAttribute[];
}

/**
 * The unit an evaluation serves, shared by every file evaluated for it -- the unit itself, its includes and its
 * autoinclude -- since Terragrunt resolves a `dependency` reference in any of them against the unit's merged
 * blocks, and each dependency once.
 */
interface UnitContext {
	unitPath: string;
	unitDir: string;
	/** The unit's own scope, set as soon as the unit's file is parsed. */
	scope?: Scope;
	/** The unit's merged dependency blocks by name, built on the first dependency reference. */
	declarations?: Promise<Map<string, DependencyDeclaration>>;
	/** Each dependency's resolution, so every reference to it shares one. */
	resolved: Map<string, Promise<RuntimeValue<ValueType> | undefined>>;
	/** Scopes for merged files that have not been evaluated when a dependency needs one, by path. */
	structuralScopes: Map<string, Scope>;
	/** The run's Git repository roots by the directories walked to them, shared with the configurations it reads. */
	repoRoots: Map<string, string>;
}

type MergeStrategy = 'no_merge' | 'shallow' | 'deep';

/**
 * The merge strategy of an include, as Terragrunt accepts it: `no_merge`, `shallow` or `deep`. `deep_map_only` and
 * any other value are refused as Terragrunt refuses them, not taken for the default.
 */
function readMergeStrategy(value: RuntimeValue<ValueType>, includeName: string, filePath: string): MergeStrategy {
	if (value.type !== 'string') throw new Error(`include "${includeName}" in ${filePath}: merge_strategy must be a string`);
	const strategy = String(value.value);
	if (strategy === 'no_merge' || strategy === 'shallow' || strategy === 'deep') return strategy;
	if (strategy === 'deep_map_only') {
		throw new Error(`include "${includeName}" in ${filePath}: merge_strategy "deep_map_only" is not supported on include blocks`);
	}
	throw new Error(`include "${includeName}" in ${filePath}: merge_strategy "${strategy}" is not one of no_merge, shallow or deep`);
}

const AUTOINCLUDE_FILES = new Set(['terragrunt.autoinclude.hcl', 'terragrunt.autoinclude.stack.hcl']);

/** The attributes Terragrunt decodes on their own before the rest of a file, to find the IAM role to parse it with. */
const PRE_DECODED_FLAGS = ['iam_role', 'iam_web_identity_token', 'prevent_destroy'];

/**
 * Identifier under which the configuration binding is exposed to inline function
 * bodies. The grammar rejects a parameter of this name, since it would shadow
 * the binding and silently discard the caller's argument; the literal is
 * repeated there because a grammar cannot import from this module. Changing this
 * name requires changing the check in grammar.peggy's InlineFunction rule.
 */
const TG_BINDING_NAME = 'tg';

/**
 * Bound on nested inline function calls. Recursion is supported, but an
 * unbounded chain would exhaust the JavaScript stack and abort evaluation
 * without a located message, so it is stopped with a named error instead.
 */
const MAX_INLINE_CALL_DEPTH = 128;

/**
 * How deep a chain of includes may nest before evaluation gives up.
 *
 * The same argument as MAX_INLINE_CALL_DEPTH, for the other way a
 * configuration can refer to itself. A unit that includes a file which
 * includes it back never finishes, and until this existed it did not fail
 * either: the process spun at full CPU allocating scopes until it was killed
 * by hand, with nothing printed. `find_in_parent_folders("terragrunt.hcl")`
 * resolving to the very file that called it is how that happened here, and
 * that specific bug is fixed at its source -- but a cycle assembled some
 * other way should still stop with a message rather than hang.
 *
 * Real configurations nest a handful of levels; 64 is far past anything
 * legitimate and still reached in well under a second.
 */
const MAX_INCLUDE_DEPTH = 64;

/**
 * An inline function failure that already names the function and the position it
 * arose from. Enclosing frames re-throw it unchanged so that a nested call
 * reports its original cause rather than one wrapper per level of nesting.
 */
class InlineFunctionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InlineFunctionError';
	}
}

/** The `tg` binding available inside an inline function body. */
interface TgBinding {
	call: (name: unknown, ...args: unknown[]) => Promise<unknown>;
	local: Record<string, unknown>;
	include: Record<string, unknown>;
	context: {
		terragruntDir: string;
		repoRoot: string | null;
		workingDirectory: string;
		environmentVariables: Record<string, string>;
	};
}

/**
 * Wraps a resolved namespace so that reading an absent name throws instead of
 * yielding undefined, with a message built from the name that was read. Property
 * probes used by the JavaScript runtime itself — `then` during promise
 * resolution, symbol lookups, `toJSON` during serialization — must answer
 * undefined rather than throw, or the value could not be awaited or inspected at
 * all.
 */
function guardedNamespace(
	values: Record<string, unknown>,
	message: (name: string) => string
): Record<string, unknown> {
	return new Proxy(values, {
		get(target, property) {
			if (typeof property !== 'string') return Reflect.get(target, property);
			if (property in target) return target[property];
			if (property === 'then' || property === 'toJSON' || property === 'constructor') {
				return Reflect.get(target, property);
			}
			throw new InlineFunctionError(message(property));
		},
		has(target, property) {
			return typeof property === 'string' && property in target;
		}
	});
}

/** The `inline_function` statements declared at the top level of a parsed file. */
function declaredInlineFunctions(ast: TNode): TNode[] {
	return (ast.children ?? []).filter(child => child.type === 'inline_function');
}

function requiredValueNode(node: TNode, excludedType = 'attribute_identifier'): TNode {
	const value = node.children?.find(child => child.type !== excludedType);
	if (!value) throw new Error(`Missing value for ${node.type}`);
	return value;
}

export class ConfigEvaluator {
	private readonly schema = Schema.getInstance();
	private readonly options: ConfigEvaluatorOptions;
	private readonly renderUnresolved: Array<{file: string; field: string; reason: string}> = [];

	unresolvedRenderFields(): ReadonlyArray<{file: string; field: string; reason: string}> {
		return [...new Map(this.renderUnresolved.map(issue => [JSON.stringify(issue), issue])).values()];
	}

	private readonly tolerated: ToleratedDecode[] = [];

	/** Each file the last render decoded past errors, in the order its decode ended. */
	toleratedDecodes(): readonly ToleratedDecode[] {
		return this.tolerated;
	}

	private async renderField<T = RuntimeValue<ValueType>>(
		file: string,
		field: string,
		evaluate: () => Promise<T>
	): Promise<T | undefined> {
		try {
			return await evaluate();
		} catch (error) {
			if (!this.options.partialRender || !(error instanceof UnresolvedRenderValueError)) throw error;
			this.renderUnresolved.push({file, field, reason: error.message});
			return undefined;
		}
	}
	/**
	 * Depth of nested inline function calls, bounded by MAX_INLINE_CALL_DEPTH.
	 *
	 * Kept in async context, like the chains below: one evaluator serves
	 * evaluations that run concurrently, and each is bounded by its own nesting,
	 * not by the sum of everyone's.
	 */
	private readonly inlineCallDepth = new AsyncLocalStorage<number>();
	/**
	 * The files being evaluated on this asynchronous evaluation chain, outermost first.
	 *
	 * A stack rather than a counter so that a cycle can be REPORTED: the chain
	 * names the files that lead back to the repeat, which is the difference
	 * between "something recursed" and "this unit includes itself". Per chain
	 * rather than per evaluator, so that two evaluations of the same file that
	 * overlap are not taken for a file that includes itself.
	 */
	private readonly includeChain = new AsyncLocalStorage<readonly string[]>();
	/**
	 * Local-resolution ancestry for each asynchronous evaluation chain.
	 *
	 * Scope-wide pending state cannot distinguish recursion from sibling
	 * expressions awaiting the same local. Keeping ancestry in async context
	 * preserves that distinction across every await.
	 */
	private readonly localResolutionPath = new AsyncLocalStorage<readonly LocalResolution[]>();
	/** The unit the current evaluation serves; see {@link UnitContext}. */
	private readonly unitContext = new AsyncLocalStorage<UnitContext>();
	/**
	 * The dependency whose block is being evaluated on this asynchronous chain, so a block whose attributes read a
	 * dependency is refused, as Terragrunt refuses it, instead of waiting on itself.
	 */
	private readonly dependencyResolutionPath = new AsyncLocalStorage<readonly string[]>();
	/** `options.allowedPaths` after realpath, resolved on first use. */
	private allowedPathsResolved: string[] | undefined;

	constructor(options: ConfigEvaluatorOptions) {
		this.options = options;
	}

	setWorkspaceTrusted(trusted: boolean): void {
		this.options.workspaceTrusted = trusted;
	}

	private assertTrusted(operation: string): void {
		if (this.options.workspaceTrusted !== true) {
			throw new Error(`${operation} is disabled until the workspace is trusted`);
		}
	}

	private async assertPathAllowed(target: string, workspaceRoot: string): Promise<void> {
		this.assertTrusted('Workspace file access');
		const root = await fs.realpath(workspaceRoot);
		let resolved: string;
		try {
			resolved = await fs.realpath(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			resolved = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
		}
		const permitted = [root, ...await this.resolvedAllowedPaths()];
		// Compared after realpath on BOTH sides, so a symlink cannot be used
		// to make an outside path look like an inside one.
		if (!permitted.some(allowed => resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`))) {
			throw new Error(
				`Workspace file access outside ${root} is blocked: ${target}`
				+ ' (pass --allow-path to permit a directory outside the workspace)'
			);
		}
	}

	/**
	 * The configured allowed paths, resolved once and kept.
	 *
	 * One that does not exist is an error rather than something skipped: it is
	 * a path somebody typed to open something up, and silently ignoring it
	 * would report the block it was meant to lift as though nothing had been
	 * asked for.
	 */
	private async resolvedAllowedPaths(): Promise<string[]> {
		if (this.allowedPathsResolved) return this.allowedPathsResolved;
		const configured = this.options.allowedPaths ?? [];
		const resolved: string[] = [];
		for (const entry of configured) {
			try {
				resolved.push(await fs.realpath(path.resolve(entry)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				throw new Error(`Allowed path does not exist: ${entry}`);
			}
		}
		this.allowedPathsResolved = resolved;
		return resolved;
	}

	private async resolveWorkspaceRoot(configuredRoot: string): Promise<string> {
		let current = path.resolve(configuredRoot);
		try {
			if ((await fs.stat(current)).isFile()) current = path.dirname(current);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
		}

		// `root.hcl` is the modern marker and wins wherever it appears. A
		// repository boundary is the fallback, because a configuration written
		// before that convention roots itself at a plain `terragrunt.hcl` and
		// has no marker to find -- and the old answer here was the UNIT's own
		// directory, which bounded the parent search to a directory whose only
		// parent-directory lookups are, by definition, outside it. Every
		// `find_in_parent_folders` in such a repository failed with "could not
		// find", naming a file sitting two levels up.
		let repoRoot: string | undefined;
		while (true) {
			if (await pathExists(path.join(current, 'root.hcl'))) return current;
			if (repoRoot === undefined && await pathExists(path.join(current, '.git'))) repoRoot = current;
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}

		return repoRoot ?? path.resolve(configuredRoot);
	}

	async evaluateUnit(configPath: string, content: string, workDir: string): Promise<ConfigEvaluationResult> {
		try {
			this.assertTrusted('Semantic evaluation');
			const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
			const result = await this.evaluateFile(configPath, content, workspaceRoot);
			if (result.inputs === null) return { valid: true, inputs: null };
			return { valid: true, inputs: makeObjectValue(result.inputs) };
		} catch (error) {
			return {
				valid: false,
				inputs: null,
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof UnresolvedRenderValueError ? { unresolved: true } : {}),
				...(error instanceof LocatedEvaluationError
					? { problems: [error, ...error.further].map(fault => ({ message: fault.message, filePath: fault.filePath, range: fault.range })) }
					: {})
			};
		}
	}

	/**
	 * Collects the inline functions a configuration inherits through its
	 * includes and autoincludes, as language-service metadata. Definitions in
	 * the configuration itself are excluded: callers already have those, and a
	 * local definition overrides an inherited one of the same name.
	 *
	 * This walks the include chain structurally — parsing each file and
	 * resolving include paths — without evaluating any configuration. A file
	 * whose evaluation would fail still contributes its declarations, so a call
	 * to an inherited function is never misreported as unknown merely because
	 * something else in the configuration is broken.
	 */
	async collectInheritedInlineFunctions(
		configPath: string,
		content: string,
		workDir: string
	): Promise<Map<string, FunctionDefinition>> {
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		const inherited = new Map<string, FunctionDefinition>();
		const visited = new Set<string>([path.resolve(configPath)]);
		const unitDir = path.dirname(configPath);

		const own = new Set<string>();
		for (const node of declaredInlineFunctions(parseHclSyntax(content, configPath, configPath))) {
			own.add(String(node.value ?? ''));
		}

		// Breadth-first over the include graph so that nearer declarations are
		// recorded first and never replaced by a same-named one further along,
		// matching the resolution order findInlineFunction uses.
		const queue: string[] = await this.includeTargets(configPath, content, workspaceRoot, unitDir);

		while (queue.length > 0) {
			const target = queue.shift()!;
			const resolved = path.resolve(target);
			if (visited.has(resolved)) continue;
			visited.add(resolved);

			let includedContent: string;
			try {
				await this.assertPathAllowed(resolved, workspaceRoot);
				includedContent = await fs.readFile(resolved, 'utf8');
			} catch {
				// An unreadable or out-of-workspace include is reported by the
				// evaluation pass that owns it; it contributes no declarations.
				continue;
			}

			let ast: TNode;
			try {
				ast = parseHclSyntax(includedContent, resolved, resolved);
			} catch {
				continue;
			}

			for (const node of declaredInlineFunctions(ast)) {
				const name = String(node.value ?? '');
				if (name === '' || own.has(name) || inherited.has(name)) continue;
				try {
					inherited.set(name, synthesizeDefinition(readInlineFunction(node, resolved, null)));
				} catch {
					// A declaration the evaluator will reject contributes no
					// metadata; its own diagnostic is raised where it is declared.
				}
			}

			queue.push(...await this.includeTargets(resolved, includedContent, workspaceRoot, unitDir));
		}

		return inherited;
	}

	/**
	 * Absolute paths of the configurations a file includes, plus its
	 * autoinclude when one exists. Include paths are evaluated because they may
	 * be computed — `find_in_parent_folders("root.hcl")` is the common form — but
	 * a path that cannot be resolved is skipped rather than failing the walk.
	 */
	private async includeTargets(
		filePath: string,
		content: string,
		workspaceRoot: string,
		unitDir = path.dirname(filePath)
	): Promise<string[]> {
		const targets: string[] = [];
		let ast: TNode;
		try {
			ast = parseHclSyntax(content, filePath, filePath);
		} catch {
			return targets;
		}

		const dir = path.dirname(filePath);
		const scope = structuralScope(filePath, content, ast, workspaceRoot, unitDir);

		for (const block of scope.blocks) {
			if (block.value !== 'include') continue;
			const pathAttribute = (block.children ?? []).find(child => child.type === 'attribute' && String(child.value) === 'path');
			if (!pathAttribute) continue;
			try {
				const value = await this.evalNode(requiredValueNode(pathAttribute), scope);
				if (value.type !== 'string') continue;
				const configured = String(value.value);
				targets.push(path.isAbsolute(configured) ? configured : path.resolve(dir, configured));
			} catch {
				// An include whose path cannot be computed yields no target; the
				// evaluation pass reports why.
			}
		}

		if (!AUTOINCLUDE_FILES.has(path.basename(filePath))) {
			const autoPath = path.join(dir, 'terragrunt.autoinclude.hcl');
			if (await pathExists(autoPath)) targets.push(autoPath);
		}

		return targets;
	}

	/**
	 * A unit's configuration as Terragrunt holds it once decoded and merged with what it includes: what `render`
	 * prints, and what `read_terragrunt_config()` reads.
	 *
	 * @param withOutputs whether to read the outputs of each dependency, which only what shows the configuration whole
	 *   needs: they are read whether anything refers to them or not.
	 */
	async evaluateRenderedConfig(configPath: string, content: string, workDir: string, withOutputs = false): Promise<TerragruntConfig> {
		this.assertTrusted('Rendered configuration evaluation');
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		this.renderUnresolved.length = 0;
		this.tolerated.length = 0;
		const result = await this.evaluateFile(configPath, content, workspaceRoot);
		return this.readTerragruntConfig(result, withOutputs);
	}

	/**
	 * The unit's own `catalog` block, which only `catalog` reads, each attribute as it evaluates; undefined when the
	 * unit has none.
	 */
	async evaluateCatalogConfig(configPath: string, content: string, workDir: string): Promise<Record<string, Plain> | undefined> {
		this.assertTrusted('Rendered configuration evaluation');
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		this.renderUnresolved.length = 0;
		const result = await this.evaluateFile(configPath, content, workspaceRoot);
		const catalog = this.configBody(result, result.scope).blocks.find(block => block.type === 'catalog');
		if (!catalog) return undefined;
		const values: Record<string, Plain> = {};
		for (const [name, read] of catalog.body.attributes) {
			const value = await read();
			if (value !== UNRESOLVED) values[name] = value;
		}
		return values;
	}

	async evaluateAtPosition(
		configPath: string,
		content: string,
		workDir: string,
		position: { line: number; character: number }
	): Promise<RuntimeValue<ValueType> | undefined> {
		this.assertTrusted('Semantic evaluation');
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		// A failure elsewhere in the file must not answer for the one expression being hovered; `inputs` is evaluated eagerly
		// and can throw on its own.
		let result: FileResult;
		try {
			result = await this.evaluateFile(configPath, content, workspaceRoot);
		} catch {
			const partial = await this.scopeWithoutInputs(configPath, content, workspaceRoot);
			if (!partial) return undefined;
			result = partial;
		}
		const lines = content.split('\n');
		if (position.line < 0 || position.line >= lines.length || position.character < 0) return undefined;
		const offset = lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
		const candidates: TNode[] = [];
		const visit = (node: TNode): void => {
			const location = node.location;
			if (node.type === 'function_call') {
				const identifier = node.children?.find(child => child.type === 'function_identifier');
				if (identifier?.location && identifier.location.start.offset <= offset && offset <= identifier.location.end.offset) {
					candidates.push(node);
				}
			}
			if (node.type === 'attribute') {
				const identifier = node.children?.find(child => child.type === 'attribute_identifier');
				const value = node.children?.find(child => child.type !== 'attribute_identifier');
				if (identifier?.location && value && identifier.location.start.offset <= offset && offset <= identifier.location.end.offset) {
					candidates.push(value);
				}
			}
			if (location && location.start.offset <= offset && offset <= location.end.offset) {
				if (!['root', 'assignment', 'block', 'attribute', 'attribute_identifier', 'root_assignment_identifier', 'block_identifier', 'parameter', 'function_identifier', 'access_chain', 'namespace'].includes(node.type)) {
					candidates.push(node);
				}
			}
			for (const child of node.children ?? []) visit(child);
		};
		visit(result.scope.ast);
		candidates.sort((left, right) => this.nodeWidth(left) - this.nodeWidth(right));
		for (const candidate of candidates) {
			try {
				return await this.evalNode(candidate, result.scope);
			} catch {
				continue;
			}
		}
		return undefined;
	}

	/**
	 * Every span of the file whose value a reader cannot already see written there, each with that value, from a
	 * single evaluation of the file.
	 *
	 * An expression is a span unless its value is exactly what its source spells out (see `isWrittenOut`). An
	 * attribute's name is a span for the value bound to it, so `name = upper(local.service)` yields the name as well
	 * as the call, while `cidr = "10.0.0.0/16"` yields neither. Array and object literals are not spans of their
	 * own: their elements are, and so is the name they are bound to. An expression that cannot be evaluated in the
	 * file's scope, such as one reading a `for` variable, has no value to show and yields no span.
	 */
	async evaluatedSpans(configPath: string, content: string, workDir: string): Promise<EvaluatedSpan[]> {
		this.assertTrusted('Semantic evaluation');
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		// As for evaluateAtPosition: an `inputs` that fails must not take every other expression's value with it.
		let result: FileResult;
		try {
			result = await this.evaluateFile(configPath, content, workspaceRoot);
		} catch {
			const partial = await this.scopeWithoutInputs(configPath, content, workspaceRoot);
			if (!partial) return [];
			result = partial;
		}
		const spans = new Map<string, EvaluatedSpan>();
		const add = async (span: NonNullable<TNode['location']>, kind: EvaluatedSpan['kind'], node: TNode): Promise<void> => {
			const key = `${span.start.offset}:${span.end.offset}`;
			if (spans.has(key)) return;
			let value: RuntimeValue<ValueType>;
			try {
				value = await this.evalNode(node, result.scope);
			} catch {
				return;
			}
			if (value.encrypted || isWrittenOut(node, value, content)) return;
			spans.set(key, { start: span.start.offset, end: span.end.offset, kind, value });
		};
		const visit = async (node: TNode, parent: TNode | undefined): Promise<void> => {
			if (node.type === 'attribute') {
				const identifier = node.children?.find(child => child.type === 'attribute_identifier');
				const value = node.children?.find(child => child.type !== 'attribute_identifier');
				if (identifier?.location && value) await add(identifier.location, 'name', value);
			}
			// The literal fragments of an interpolated string, and the templates of a directive's branches and loop, are
			// parts of the string; the string is the span.
			const fragment = (node.type === 'string_lit' && parent?.type === 'interpolated_string')
				|| (parent?.type === 'if_directive' && parent.children?.[0] !== node)
				|| (parent?.type === 'for_directive' && parent.children?.at(-1) === node);
			if (node.location && EXPRESSION_SPAN_TYPES.has(node.type) && !fragment) await add(node.location, 'expression', node);
			for (const child of node.children ?? []) await visit(child, node);
		};
		await visit(result.scope.ast, undefined);
		const elements = await this.forElements(result.scope);
		return [...spans.values(), ...elements].sort((left, right) => left.start - right.start || right.end - left.end);
	}

	/**
	 * The `elements` spans of a file: for each `for` expression, the values its variable takes. Its collection is
	 * evaluated once for each element of every `for` expression around it, with their variables bound, so a literal
	 * collection and one that reads an outer variable have elements as any other does. An evaluation that fails, such
	 * as for an element an outer condition would leave out, adds nothing.
	 *
	 * @param scope the file's scope.
	 * @returns one span per collection that gave any elements, in the order the file is written.
	 */
	private async forElements(scope: Scope): Promise<EvaluatedSpan[]> {
		const gathered = new Map<TNode, RuntimeValue<ValueType>[]>();
		const visit = async (node: TNode): Promise<void> => {
			if (node.type !== 'list_comprehension' && node.type !== 'map_comprehension' && node.type !== 'for_directive') {
				for (const child of node.children ?? []) await visit(child);
				return;
			}
			const children = node.children ?? [];
			const variables = children[1]?.type === 'identifier' ? children.slice(0, 2) : children.slice(0, 1);
			const [collection, ...body] = children.slice(variables.length);
			if (!collection) return;
			await visit(collection);
			let items: Array<[RuntimeValue<ValueType>, RuntimeValue<ValueType>]> = [];
			try {
				const collectionValue = await this.evalNode(collection, scope);
				if (!collectionValue.encrypted) items = forElements(unwrapSensitive(collectionValue));
			} catch {
				items = [];
			}
			const kept = gathered.get(collection) ?? [];
			kept.push(...items.map(([, item]) => item).filter(item => !item.encrypted));
			gathered.set(collection, kept);
			// A body is visited once for each element, so a for expression inside it sees that element.
			for (const [key, item] of items) {
				const frame = new Map<string, RuntimeValue<ValueType>>();
				if (variables.length === 2) frame.set(String(variables[0].value ?? ''), key);
				frame.set(String(variables.at(-1)?.value ?? ''), item);
				scope.comprehension.push(frame);
				try {
					for (const child of body) await visit(child);
				} finally {
					scope.comprehension.pop();
				}
			}
			// With no elements to bind, a for expression inside the body still has its own collection, if it reads none.
			if (items.length === 0) for (const child of body) await visit(child);
		};
		await visit(scope.ast);
		return [...gathered]
			.filter(([collection, values]) => collection.location && values.length > 0)
			.map(([collection, values]) => ({
				start: collection.location!.start.offset,
				end: collection.location!.end.offset,
				kind: 'elements',
				value: makeArrayValue(values)
			}));
	}

	private nodeWidth(node: TNode): number {
		if (!node.location) return Number.MAX_SAFE_INTEGER;
		return node.location.end.offset - node.location.start.offset;
	}

	/** The scope alone, for callers that evaluate one node and can do without the file's own `inputs`. */
	private async scopeWithoutInputs(filePath: string, content: string, workDir: string): Promise<FileResult | undefined> {
		try {
			return await this.evaluateFile(filePath, content, workDir, undefined, true);
		} catch {
			return undefined;
		}
	}

	/**
	 * An `include` block's label, the absolute path it names, whether it is exposed and how it is merged, evaluated in
	 * the scope of the file it is written in.
	 */
	private async readIncludeBlock(block: TNode, scope: Scope): Promise<{ name: string; includePath: string; expose: boolean; mergeStrategy: MergeStrategy }> {
		const nameNode = (block.children ?? []).find(child => child.type === 'parameter');
		const name = nameNode ? String(nameNode.value) : 'root';
		let expose = false;
		let mergeStrategy: MergeStrategy = 'shallow';
		let pathNode: TNode | undefined;
		for (const child of block.children ?? []) {
			if (child.type !== 'attribute') continue;
			const attrName = String(child.value);
			if (attrName === 'path') {
				pathNode = child;
			} else if (attrName === 'expose') {
				// Terragrunt decodes expose as an optional bool: null is false.
				const exposeNode = requiredValueNode(child);
				const value = await this.evalNode(exposeNode, scope);
				expose = this.atNode(exposeNode, scope, () => {
					try {
						return convertToBool(value) ?? false;
					} catch (error) {
						throw new Error(`Unsuitable value: ${(error as Error).message}`);
					}
				});
			} else if (attrName === 'merge_strategy') {
				mergeStrategy = readMergeStrategy(await this.evalNode(requiredValueNode(child), scope), name, scope.filePath);
			}
		}
		if (!pathNode) throw new Error(`include "${name}" in ${scope.filePath} is missing a path attribute`);
		const pathValue = await this.evalNode(requiredValueNode(pathNode), scope);
		if (pathValue.type !== 'string') throw new Error(`include "${name}" in ${scope.filePath} must have a string path`);
		const includePath = path.isAbsolute(String(pathValue.value))
			? String(pathValue.value)
			: path.resolve(scope.dir, String(pathValue.value));
		return { name, includePath, expose, mergeStrategy };
	}

	/** A fresh {@link UnitContext} for evaluating `filePath` as a unit. */
	private newUnitContext(filePath: string, unitDir?: string): UnitContext {
		const unitPath = path.resolve(filePath);
		return {
			unitPath,
			unitDir: unitDir ?? path.dirname(unitPath),
			resolved: new Map(),
			structuralScopes: new Map(),
			repoRoots: this.unitContext.getStore()?.repoRoots ?? new Map()
		};
	}

	private async evaluateFile(filePath: string, content: string, workDir: string, unitDir?: string, skipInputs = false): Promise<FileResult> {
		// The first file evaluated is the unit; the includes and autoinclude evaluated within it share its context.
		if (!this.unitContext.getStore()) {
			return this.unitContext.run(
				this.newUnitContext(filePath, unitDir),
				() => this.evaluateFile(filePath, content, workDir, unitDir, skipInputs)
			);
		}
		const resolvedPath = path.resolve(filePath);
		const chain = this.includeChain.getStore() ?? [];
		const repeatedAt = chain.indexOf(resolvedPath);
		if (repeatedAt !== -1) {
			const cycle = [...chain.slice(repeatedAt), resolvedPath];
			throw new Error(`Include cycle: ${cycle.join(' -> ')}`);
		}
		if (chain.length >= MAX_INCLUDE_DEPTH) {
			throw new Error(
				`Includes nested deeper than ${MAX_INCLUDE_DEPTH} levels, starting at ${chain[0]}`
			);
		}
		return this.includeChain.run(
			[...chain, resolvedPath],
			() => this.evaluateFileUnguarded(filePath, content, workDir, unitDir, skipInputs)
		);
	}

	private async evaluateFileUnguarded(filePath: string, content: string, workDir: string, unitDir?: string, skipInputs = false): Promise<FileResult> {
		const ast = parseHclSyntax(content, filePath, filePath);
		const dir = path.dirname(filePath);
		const baseName = path.basename(filePath);

		const blocks: TNode[] = [];
		const assignments: TNode[] = [];
		const functionNodes: TNode[] = [];
		for (const child of ast.children ?? []) {
			if (child.type === 'block') blocks.push(child);
			else if (child.type === 'assignment') assignments.push(child);
			else if (child.type === 'inline_function') functionNodes.push(child);
		}

		const scope: Scope = {
			filePath,
			content,
			ast,
			dir,
			// An included file resolves parent-folder searches for the unit that included it, not for its own directory.
			unitDir: unitDir ?? dir,
			workspaceRoot: path.resolve(workDir),
			locals: new Map(),
			localCache: new Map(),
			localPending: new Map(),
			includes: new Map(),
			autoinclude: null,
			rootAttrs: new Map(),
			terraform: new Map(),
			generate: new Map(),
			blocks,
			comprehension: [],
			functions: new Map()
		};

		const unit = this.unitContext.getStore();
		if (!unit) throw new Error(`${filePath} was evaluated outside the evaluation of a unit`);
		scope.unit = unit;
		if (!unit.scope && path.resolve(filePath) === unit.unitPath) unit.scope = scope;

		for (const node of functionNodes) {
			const definition = readInlineFunction(node, filePath, scope);
			if (scope.functions.has(definition.name)) {
				throw new Error(`Inline function "${definition.name}" is defined more than once in ${filePath}`);
			}
			if (this.schema.getFunctionDefinition(definition.name)) {
				throw new Error(`Inline function "${definition.name}" shadows a built-in function`);
			}
			// Reading each annotation now surfaces an unsupported type constraint
			// at definition time rather than at the first call.
			for (const parameter of definition.parameters) {
				if (parameter.typeNode) readTypeConstraint(parameter.typeNode);
			}
			scope.functions.set(definition.name, definition);
		}

		for (const block of blocks) {
			if (block.value === 'locals') {
				for (const child of block.children ?? []) {
					if (child.type === 'attribute') {
						const name = String(child.value);
						const valueNode = child.children?.find(c => c.type !== 'attribute_identifier');
						if (valueNode) scope.locals.set(name, valueNode);
					}
				}
			}
		}

		const terraformBlock = blocks.find(block => block.value === 'terraform');
		if (terraformBlock) {
			for (const child of terraformBlock.children ?? []) {
				if (child.type === 'attribute') {
					const valueNode = child.children?.find(c => c.type !== 'attribute_identifier');
					if (valueNode) scope.terraform.set(String(child.value), valueNode);
				}
			}
		}

		for (const block of blocks) {
			if (block.value !== 'generate') continue;
			const nameNode = (block.children ?? []).find(child => child.type === 'parameter');
			if (!nameNode) continue;
			const attributes = new Map<string, TNode>();
			for (const child of block.children ?? []) {
				if (child.type !== 'attribute') continue;
				const valueNode = child.children?.find(c => c.type !== 'attribute_identifier');
				if (valueNode) attributes.set(String(child.value), valueNode);
			}
			scope.generate.set(String(nameNode.value), attributes);
		}

		for (const assignment of assignments) {
			if (String(assignment.value) === 'inputs') continue;
			const valueNode = assignment.children?.find(c => c.type !== 'root_assignment_identifier');
			if (valueNode) scope.rootAttrs.set(String(assignment.value), valueNode);
		}

		for (const block of blocks) {
			if (block.value !== 'include') continue;
			const { name, includePath, expose, mergeStrategy } = await this.readIncludeBlock(block, scope);
			this.assertTrusted('Included configuration evaluation');
			await this.assertPathAllowed(includePath, scope.workspaceRoot);
			const includeContent = await fs.readFile(includePath, 'utf8');
			const includeResult = await this.evaluateFile(includePath, includeContent, workDir, scope.unitDir ?? dir);
			if (blocks.some(block => block.value === 'remote_state') && includeResult.scope.blocks.some(block => block.value === 'remote_state')) {
				throw new Error(`remote_state is defined in both ${filePath} and included configuration ${includePath}`);
			}
			scope.includes.set(name, { expose, mergeStrategy, dir: path.dirname(includePath), result: includeResult });
		}

		if (!AUTOINCLUDE_FILES.has(baseName)) {
			const autoPath = path.join(dir, 'terragrunt.autoinclude.hcl');
			if (await pathExists(autoPath)) {
				this.assertTrusted('Autoinclude evaluation');
				await this.assertPathAllowed(autoPath, scope.workspaceRoot);
				const autoContent = await fs.readFile(autoPath, 'utf8');
				scope.autoinclude = await this.evaluateFile(autoPath, autoContent, workDir, scope.unitDir ?? dir);
			}
		}

		const inputsAssignment = assignments.find(assignment => String(assignment.value) === 'inputs');
		let ownInputs: Map<string, RuntimeValue<ValueType>> | null = null;
		const unresolvedInputs = new Map<string, {file: string; reason: string}>();
		// Every fault found, so all of them are reported where they are written before the first is fixed. One read by
		// several expressions is one fault.
		const faults = new Map<string, LocatedEvaluationError>();
		const recordFault = (error: LocatedEvaluationError) => {
			const where = `${error.filePath}:${error.range.start.line}:${error.range.start.character}:${error.message}`;
			if (!faults.has(where)) faults.set(where, error);
		};
		/** Throws the first fault, with the rest in `further`, when there is one. */
		const throwFaults = () => {
			if (faults.size === 0) return;
			const [first, ...rest] = faults.values();
			first.further.push(...rest);
			throw first;
		};
		if (!skipInputs && unit.scope === scope) {
			// Terragrunt evaluates every local of a unit and of the configurations it includes, whether anything reads it
			// or not, and fails on a broken one. They are evaluated only once every include is read, as a local may read
			// any of them.
			for (const owner of configurationScopes(scope)) {
				for (const name of owner.locals.keys()) {
					try {
						await this.resolveLocal(owner, name);
					} catch (error) {
						// A value that cannot be known yet is not a fault; whatever reads it reports it.
						if (error instanceof LocatedEvaluationError) recordFault(error);
						else if (!(error instanceof UnresolvedRenderValueError)) throw error;
					}
				}
			}
		}
		const inputDiagnostics: HclDiagnostic[] = [];
		if (inputsAssignment && !skipInputs) {
			const inputNode = requiredValueNode(inputsAssignment, 'root_assignment_identifier');
			let value: RuntimeValue<ValueType>;
			if (this.options.renderDecode) {
				// As Terragrunt's render decodes inputs: past their errors, which the file's decode weighs, with each value
				// not known settled. A value that cannot be known yet leaves its input out, as a partial render does.
				const valueOf = async (valueNode: TNode | undefined, key: string | undefined): Promise<Tolerated | undefined> => {
					try {
						const item = await this.tolerate(valueNode, scope);
						if (key !== undefined) unresolvedInputs.delete(key);
						return item;
					} catch (error) {
						if (!(error instanceof UnresolvedRenderValueError) || !this.options.partialRender) throw error;
						if (key !== undefined) unresolvedInputs.set(key, {file: filePath, reason: error.message});
						return undefined;
					}
				};
				const evaluated = inputNode.type === 'object' ? await this.tolerateObject(inputNode, scope, valueOf) : await this.tolerate(inputNode, scope);
				inputDiagnostics.push(...evaluated.diagnostics);
				value = settleUnknowns(evaluated.value);
			} else if (inputNode.type === 'object' && !(inputNode.children ?? []).some(child => child.type !== 'attribute')) {
				// Attribute by attribute, so a fault in one does not hide a fault in the next.
				const entries = new Map<string, RuntimeValue<ValueType>>();
				let unresolved: UnresolvedRenderValueError | undefined;
				for (const child of inputNode.children ?? []) {
					const keyNode = child.children?.find(part => part.type === 'object_key');
					const keyValue = keyNode ? computable(await this.evalNode(keyNode.children?.[0], scope)) : undefined;
					const key = keyValue
						? this.atNode(keyNode?.children?.[0], scope, () => objectKey(keyValue))
						: String(child.value);
					const valueNode = child.children?.find(part => part.type !== 'attribute_identifier' && part.type !== 'object_key');
					try {
						entries.set(key, await this.evalNode(valueNode, scope));
						unresolvedInputs.delete(key);
					} catch (error) {
						if (error instanceof LocatedEvaluationError) {
							recordFault(error);
							continue;
						}
						if (!(error instanceof UnresolvedRenderValueError)) throw error;
						if (!this.options.partialRender) {
							unresolved ??= error;
							continue;
						}
						entries.delete(key);
						unresolvedInputs.set(key, {file: filePath, reason: error.message});
					}
				}
				throwFaults();
				if (unresolved) throw unresolved;
				value = makeObjectValue(entries);
			} else {
				try {
					value = await this.evalNode(inputNode, scope);
				} catch (error) {
					if (error instanceof LocatedEvaluationError) {
						recordFault(error);
						throwFaults();
					}
					throw error;
				}
			}
			if (value.type !== 'object' && value.type !== 'block') {
				throw new Error(`inputs in ${filePath} must evaluate to an object`);
			}
			ownInputs = new Map(value.value as Map<string, RuntimeValue<ValueType>>);
		}
		throwFaults();

		let mergedInputs: Map<string, RuntimeValue<ValueType>> | null = ownInputs ? new Map(ownInputs) : new Map();
		const mergedUnresolved = new Map(unresolvedInputs);
		if (scope.autoinclude?.inputs) {
			for (const [key, value] of scope.autoinclude.inputs) {
				mergedInputs.set(key, value);
				mergedUnresolved.delete(key);
			}
		}
		for (const [key, issue] of scope.autoinclude?.unresolvedInputs ?? []) {
			mergedInputs.delete(key);
			mergedUnresolved.set(key, issue);
		}
		for (const name of [...scope.includes.keys()].reverse()) {
			const include = scope.includes.get(name)!;
			const includeInputs = include.result.inputs;
			if (!includeInputs || include.mergeStrategy === 'no_merge') continue;
			if (include.mergeStrategy === 'deep') {
				const prior = mergedInputs;
				mergedInputs = deepMergeInputs(mergedInputs, includeInputs);
				for (const [key, issue] of include.result.unresolvedInputs) {
					if (mergedUnresolved.has(key)) continue;
					const child = prior.get(key);
					if (!child || isObjectValue(child)) mergedUnresolved.set(key, issue);
				}
			} else {
				const next = new Map(includeInputs);
				for (const [key, value] of mergedInputs) next.set(key, value);
				mergedInputs = next;
				for (const [key, issue] of include.result.unresolvedInputs) {
					if (!mergedInputs.has(key) && !mergedUnresolved.has(key)) mergedUnresolved.set(key, issue);
				}
			}
		}
		for (const name of mergedUnresolved.keys()) mergedInputs.delete(name);

		if (ownInputs === null && mergedInputs.size === 0 && mergedUnresolved.size === 0) mergedInputs = null;
		if (mergedInputs !== null) checkInputNumbers(mergedInputs);

		return {
			filePath,
			dir,
			content,
			scope,
			inputs: mergedInputs,
			unresolvedInputs: mergedUnresolved,
			hasInputs: inputsAssignment !== undefined,
			inputDiagnostics
		};
	}

	private async makeContext(scope: Scope): Promise<FunctionContext> {
		return {
			workingDirectory: scope.dir,
			environmentVariables: this.options.environmentVariables,
			document: {
				uri: scope.filePath,
				content: scope.content
			},
			terraformCommand: this.options.terraformCommand,
			terraformCliArgs: this.options.terraformCliArgs,
			experiments: this.options.experiments,
			workspaceTrusted: this.options.workspaceTrusted === true,
			workspaceRoot: scope.workspaceRoot,
			assertPathAllowed: target => this.assertPathAllowed(target, scope.workspaceRoot),
			assertTrusted: operation => this.assertTrusted(operation),
			fs: {
				access: async (target: string) => {
					await this.assertPathAllowed(target, scope.workspaceRoot);
					await fs.access(target);
				}
			},
			// `workingDirectory` above stays this FILE's directory, because
			// that is what a relative `file()` resolves against. Directory-aware
			// Terragrunt functions report the unit currently being rendered.
			terragruntDir: scope.unitDir ?? scope.dir,
			originalTerragruntDir: scope.unitDir ?? scope.dir,
			// A file other than the unit's own is one the unit includes, and Terragrunt's include functions in it answer
			// about it.
			includes: {
				original: scope.unit !== undefined && path.resolve(scope.filePath) !== scope.unit.unitPath ? scope.dir : undefined,
				named: new Map([...scope.includes].map(([name, include]) => [name, include.dir]))
			},
			repoRoots: this.unitContext.getStore()?.repoRoots,
			readTerragruntConfig: async (relativePath: string) => {
				this.assertTrusted('read_terragrunt_config');
				const target = path.isAbsolute(relativePath)
					? relativePath
					: path.resolve(scope.unitDir ?? scope.dir, relativePath);
				await this.assertPathAllowed(target, scope.workspaceRoot);
				if (!(await pathExists(target))) return undefined;
				const fileContent = await fs.readFile(target, 'utf8');
				// The configuration read is a unit of its own: its dependency blocks are its, not the reader's.
				const result = await this.unitContext.run(
					this.newUnitContext(target),
					() => this.evaluateFile(target, fileContent, scope.workspaceRoot)
				);
				const written = new Map<string, RuntimeValue<ValueType>[]>();
				const config = await this.readTerragruntConfig(result, true, written, true);
				return terragruntConfigValue(config, (field, plain) => written.get(field)?.find(value => samePlain(runtimeValueToPlain(value), plain)));
			},
			readTFVarsFile: async (relativePath: string) => {
				this.assertTrusted('read_tfvars_file');
				const target = path.isAbsolute(relativePath)
					? relativePath
					: path.resolve(scope.unitDir ?? scope.dir, relativePath);
				await this.assertPathAllowed(target, scope.workspaceRoot);
				if (!(await pathExists(target))) return undefined;
				const fileContent = await fs.readFile(target, 'utf8');
					return this.readTFVars(target, fileContent);
			},
			runCommand: async (program: string, args: string[]) => {
				this.assertTrusted('run_cmd');
				return this.runCommand(scope, program, args);
			},
			decryptSopsFile: async (filePath: string) => {
				try {
					return { content: this.runCommand(scope, 'sops', ['--decrypt', filePath]), encrypted: false };
				} catch (error) {
					if (this.options.readEncryptedSops) {
						const encrypted = await encryptedSopsDocument(filePath);
						if (encrypted !== undefined) return { content: encrypted, encrypted: true };
					}
					// Terragrunt decrypts with sops built in; this needs the sops program, and says so when it is missing.
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						// Offline, a file reaches here only when it holds no sops metadata to read as written.
						const offline = this.options.readEncryptedSops
							? '.'
							: ', or validate offline with "hcl validate --offline" to read the file as written.';
						throw new Error(
							`sops_decrypt_file cannot decrypt ${filePath}: the sops program is not on PATH. ` +
							`Install sops (https://github.com/getsops/sops/releases) and put it on PATH${offline}`
						);
					}
					if (!this.options.partialRender) throw error;
					const stderr = (error as {stderr?: unknown}).stderr;
					const reason = typeof stderr === 'string' && stderr.trim() !== ''
						? stderr.trim()
						: error instanceof Error ? error.message : String(error);
					throw new UnreadableSopsFileError(filePath, reason);
				}
			},
			evaluateFunction: async (name: string, args: RuntimeValue<ValueType>[]) => {
				const definition = this.schema.getFunctionDefinition(name);
				if (!definition) throw new Error(`Unknown function ${name}`);
				checkArgumentCount(name, definition.signature, args.length);
				return this.callBuiltin(name, definition, args, scope);
			}
		};
	}

	private runCommand(scope: Scope, program: string, args: string[]): string {
		const output = execFileSync(program, args, {
			cwd: scope.dir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true
		});
		return output.endsWith('\n') ? output.slice(0, -1) : output;
	}

	/**
	 * The scope a file merged into a unit is decoded in: its own, for its locals and the files it reads, with the
	 * unit's directory and includes, since Terragrunt parses an included file for the unit that includes it and
	 * `get_terragrunt_dir()` and `get_parent_terragrunt_dir()` there answer about that unit.
	 */
	private mergedScope(from: FileResult, unit: FileResult): Scope {
		return from === unit ? from.scope : { ...from.scope, unitDir: unit.scope.dir, includes: unit.scope.includes };
	}

	/**
	 * One file's configuration as the decoder reads it: its blocks and its attributes other than `inputs`, each
	 * attribute evaluated in the given scope when it is read. A value that cannot be known yet is recorded as
	 * unresolved and read as unset. What is written to a file, a `generate` block's or the backend's, may not hold a
	 * value sops left encrypted.
	 */
	private configBody(result: FileResult, scope: Scope, values?: Map<string, RuntimeValue<ValueType>[]>, diagnostics?: HclDiagnostic[]): ConfigBody {
		const file = result.filePath;
		const strict = (field: string, node: TNode, written: boolean) => async (): Promise<Plain | typeof UNRESOLVED> => {
			const value = await this.renderField(file, field, async () => {
				const evaluated = await this.evalNode(node, scope);
				return written ? computable(evaluated) : evaluated;
			});
			if (value === undefined) return UNRESOLVED;
			values?.set(field, [...(values.get(field) ?? []), value]);
			return runtimeValueToPlain(value);
		};
		// A render's decode evaluates as HCL does, going on past errors; a value not wholly known is settled for a field
		// kept as a cty value, and not known to a field of a Go type, which gohcl reports.
		const tolerant = (field: string, node: TNode, written: boolean, sink: HclDiagnostic[]) => async (): Promise<Plain | typeof UNRESOLVED | UnknownAttribute> => {
			const evaluated = await this.renderField(file, field, () => this.tolerate(node, scope));
			if (evaluated === undefined) return UNRESOLVED;
			sink.push(...evaluated.diagnostics);
			const value = written ? computable(evaluated.value) : evaluated.value;
			const settled = settleUnknowns(value);
			values?.set(field, [...(values.get(field) ?? []), settled]);
			if (isWhollyKnown(value)) return runtimeValueToPlain(value);
			return new UnknownAttribute(runtimeValueToPlain(settled), () => {
				const subject = this.startRangeOf(scope, node);
				sink.push({
					summary: 'Unsuitable value type',
					detail: 'Unsuitable value: value must be known',
					subject,
					context: this.rangeOf(scope, node),
					block: topLevelBlockName(scope.ast, subject.start.offset)
				});
			});
		};
		// Terragrunt decodes dependency and feature blocks apart from the rest, and the flags it reads before the rest of
		// the file (iam_role, iam_web_identity_token, prevent_destroy) by a decode of their own, none of which goes on
		// past an error.
		const attribute = (field: string, node: TNode, written: boolean) => {
			const [head] = field.split('.');
			if (!diagnostics || ['dependency', 'feature', 'include', 'locals', ...PRE_DECODED_FLAGS].includes(head)) return strict(field, node, written);
			return tolerant(field, node, written, diagnostics);
		};
		const block = (node: TNode, prefix: string, written: boolean): ConfigBlock => {
			const type = String(node.value);
			const labels = (node.children ?? []).filter(child => child.type === 'parameter').map(child => String(child.value));
			const path = [prefix, type, ...labels].filter(Boolean).join('.');
			const writes = written || type === 'generate' || type === 'remote_state';
			const body: ConfigBody = { where: `${file}: ${type}${labels.map(label => ` "${label}"`).join('')}`, attributes: new Map(), blocks: [] };
			for (const child of node.children ?? []) {
				if (child.type === 'attribute') body.attributes.set(String(child.value), attribute(`${path}.${String(child.value)}`, requiredValueNode(child), writes));
				else if (child.type === 'block') body.blocks.push(block(child, path, writes));
			}
			return { type, labels, body };
		};
		const body: ConfigBody = { where: file, attributes: new Map(), blocks: [] };
		for (const child of result.scope.ast.children ?? []) {
			if (child.type === 'block') body.blocks.push(block(child, '', false));
			else if (child.type === 'assignment' && String(child.value) !== 'inputs') {
				const name = String(child.value);
				body.attributes.set(name, attribute(name, requiredValueNode(child, 'root_assignment_identifier'), name === 'generate' || name === 'remote_state'));
			}
		}
		return body;
	}

	/**
	 * The configuration of the unit a file result is for, decoded and merged as Terragrunt's ParseConfig does: the
	 * unit's own, then its autoinclude merged over it shallowly, then each include merged under it, the last first,
	 * by the include's strategy. The locals are the unit's own and the exclude block the unit's when it has one; the
	 * inputs are those the evaluation merged. With `withOutputs`, each enabled dependency that does not skip its
	 * outputs has them read, as Terragrunt reads every dependency's outputs as it parses; read by
	 * read_terragrunt_config(), the dependency carries them, as only that function's configuration does in Terragrunt.
	 */
	private async readTerragruntConfig(result: FileResult, withOutputs: boolean, values?: Map<string, RuntimeValue<ValueType>[]>, readByFunction = false): Promise<TerragruntConfig> {
		for (const [name, issue] of result.unresolvedInputs) {
			this.renderUnresolved.push({file: issue.file, field: `inputs.${name}`, reason: issue.reason});
		}
		const decode = async (from: FileResult, scope: Scope): Promise<TerragruntConfig> => {
			if (!this.options.renderDecode) return decodeConfigFile(this.configBody(from, scope, values));
			const diagnostics = [...from.inputDiagnostics];
			const config = await decodeConfigFile(this.configBody(from, scope, values, diagnostics));
			this.settleDecode(from, diagnostics, readByFunction);
			return config;
		};
		const own = await decode(result, result.scope);
		const autoinclude = result.scope.autoinclude;
		if (autoinclude) mergeShallow(own, await decode(autoinclude, this.mergedScope(autoinclude, result)));
		let config = own;
		for (const name of [...result.scope.includes.keys()].reverse()) {
			const include = result.scope.includes.get(name)!;
			if (include.mergeStrategy === 'no_merge') continue;
			const included = await decode(include.result, this.mergedScope(include.result, result));
			if (include.mergeStrategy === 'deep') mergeDeep(included, config);
			else mergeShallow(included, config);
			config = included;
		}
		if (own.exclude) config.exclude = own.exclude;

		const locals: Record<string, Plain> = {};
		for (const name of result.scope.locals.keys()) {
			const value = await this.renderField(result.filePath, `locals.${name}`, () => this.resolveLocal(result.scope, name));
			if (value !== undefined) locals[name] = runtimeValueToPlain(value);
		}
		config.locals = Object.keys(locals).length > 0 ? locals : undefined;
		config.inputs = result.inputs === null ? undefined : runtimeValueToPlain(makeObjectValue(result.inputs)) as Record<string, Plain>;

		for (const dependency of withOutputs ? config.dependencyBlocks : []) {
			if (dependency.enabled === false || dependency.skipOutputs === true) continue;
			const value = await this.renderField(result.filePath, `dependency.${dependency.name}`, () => this.dependencyValue(dependency.name, result.scope));
			if (value === undefined || !readByFunction) continue;
			const outputs = (runtimeValueToPlain(value) as Record<string, Plain>).outputs;
			dependency.outputs = outputs === undefined ? null : outputs;
			const typed = (unwrapSensitive(value).value as Map<string, RuntimeValue<ValueType>>).get('outputs');
			if (typed) values?.set(`dependency.${dependency.name}.outputs`, [typed]);
		}
		return config;
	}

	/**
	 * Weighs one file's decode as Terragrunt's CompleteTerragruntConfigFile weighs it for a render: when any of its
	 * diagnostics is an attribute a value does not have (isAttributeAccessError), every one of them is let pass and
	 * the file recorded among the tolerated decodes; otherwise the first fails the render.
	 *
	 * @param from the file decoded.
	 * @param diagnostics every diagnostic its decode gave, its inputs' first.
	 * @param quiet whether read_terragrunt_config() read it.
	 * @throws LocatedEvaluationError for the first diagnostic, where none is an attribute a value does not have.
	 */
	private settleDecode(from: FileResult, diagnostics: HclDiagnostic[], quiet: boolean): void {
		if (diagnostics.length === 0) return;
		if (diagnostics.some(diagnostic => diagnostic.summary.includes(UNSUPPORTED_ATTRIBUTE))) {
			this.tolerated.push({ filePath: from.filePath, content: from.content, diagnostics, quiet });
			return;
		}
		const [first] = diagnostics;
		const subject = first.subject;
		const at = (offset: number, line: number) => ({ line: line - 1, character: offset - (from.content.lastIndexOf('\n', offset - 1) + 1) });
		const range: Range = subject && subject.filename === from.filePath
			? { start: at(subject.start.offset, subject.start.line), end: at(subject.end.offset, subject.end.line) }
			: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
		throw new LocatedEvaluationError(first.detail, subject?.filename ?? from.filePath, range);
	}

	private async readTFVars(target: string, content: string): Promise<RuntimeValue<ValueType>> {
		if (target.endsWith('.tfvars.json')) {
			return makeStringValue(content);
		}
		const ast = parseHclSyntax(content, target, target);
		const values = new Map<string, RuntimeValue<ValueType>>();
		for (const child of ast.children ?? []) {
			if (child.type === 'assignment') {
				const name = String(child.value);
				const valueNode = child.children?.find(c => c.type !== 'root_assignment_identifier');
				if (valueNode) values.set(name, await this.evalNode(valueNode, makeRootScope(target, content, path.dirname(target))));
			}
		}
		const plain: Record<string, unknown> = {};
		for (const key of [...values.keys()].sort()) plain[key] = runtimeValueToPlain(values.get(key)!);
		return makeStringValue(JSON.stringify(plain));
	}

	private async resolveLocal(scope: Scope, name: string): Promise<RuntimeValue<ValueType>> {
		const cached = scope.localCache.get(name);
		if (cached !== undefined) return cached;

		const activePath = this.localResolutionPath.getStore() ?? [];
		if (activePath.some(entry => entry.scope === scope && entry.name === name)) {
			throw new Error(`Cycle detected in locals involving "${name}"`);
		}

		// A reader outside the active ancestry is concurrent, not recursive. It
		// shares the published evaluation instead of starting duplicate work.
		const inFlight = scope.localPending.get(name);
		if (inFlight) return inFlight;

		const node = scope.locals.get(name);
		if (!node) throw new Error(`Undefined local value "${name}"`);
		assertLocalReadsOnlyLocalsRoots(node, scope.filePath);
		const evaluation = this.localResolutionPath.run(
			[...activePath, { scope, name }],
			() => this.evalNode(node, scope)
		);
		scope.localPending.set(name, evaluation);
		try {
			const value = await evaluation;
			scope.localCache.set(name, value);
			return value;
		} finally {
			// Do not remove a newer evaluation if a rejected promise was retried
			// before this finally block ran.
			if (scope.localPending.get(name) === evaluation) scope.localPending.delete(name);
		}
	}

	private async resolveReference(parts: string[], scope: Scope): Promise<RuntimeValue<ValueType>> {
		if (parts.length === 0) throw new Error('Empty reference');
		const namespace = parts[0];

		// A for expression's variables shadow every name of the scope it is written in, `local` and the rest included.
		for (let index = scope.comprehension.length - 1; index >= 0; index--) {
			const frame = scope.comprehension[index];
			if (!frame.has(namespace)) continue;
			const value = frame.get(namespace)!;
			return parts.length === 1 ? value : this.traverse(value, parts.slice(1));
		}

		if (namespace === 'local') {
			if (parts.length < 2) throw new Error('local reference requires a name');
			const value = await this.resolveLocal(scope, parts[1]);
			return this.traverse(value, parts.slice(2));
		}

		if (namespace === 'include') {
			if (parts.length < 2) throw new Error('include reference requires a name');
			const include = scope.includes.get(parts[1]);
			if (!include) throw new Error(`Undefined include "${parts[1]}"`);
			if (!include.expose) throw new Error(`include "${parts[1]}" is not exposed`);
			return this.resolveIncludePath(include, parts.slice(2));
		}

		if (namespace === 'dependency') {
			if (parts.length < 2) throw new Error('dependency reference requires a name');
			const dependency = await this.dependencyValue(parts[1], scope);
			return this.traverse(dependency, parts.slice(2));
		}

		throw new Error(`Undefined reference "${parts.join('.')}"`);
	}

	/**
	 * The value of `dependency.<name>` for the unit being evaluated. Every reference to a dependency, in the unit or
	 * in a file merged into it, shares one resolution.
	 *
	 * @param name the dependency's label.
	 * @param referencingScope the scope the reference is written in, which may be a merged file still being evaluated.
	 * @returns `{ outputs: … }` as the resolver gives it.
	 * @throws UnresolvedDependencyError when the dependency is declared but has no outputs yet; an Error when it is not
	 *   declared, is declared incorrectly, or reads itself.
	 */
	private async dependencyValue(name: string, referencingScope: Scope): Promise<RuntimeValue<ValueType>> {
		const unit = referencingScope.unit;
		if (!unit?.scope) throw new Error(`dependency "${name}" was read in ${referencingScope.filePath}, which was not evaluated for a unit`);
		// Terragrunt evaluates dependency blocks before any outputs exist, so a block's attributes -- config_path, the
		// mocks -- cannot read a dependency, its own or another's.
		const resolving = this.dependencyResolutionPath.getStore() ?? [];
		if (resolving.length > 0) {
			throw new Error(
				`dependency "${resolving.at(-1)}" reads dependency.${name}: a dependency block cannot read dependency outputs, ` +
				'since they are evaluated before any outputs exist'
			);
		}
		let resolution = unit.resolved.get(name);
		if (!resolution) {
			resolution = this.dependencyResolutionPath.run(
				[...resolving, name],
				() => this.resolveUnitDependency(unit, name, referencingScope)
			);
			unit.resolved.set(name, resolution);
		}
		const value = await resolution;
		if (!value) throw new UnresolvedDependencyError(name);
		return value;
	}

	/**
	 * Finds a dependency in the unit's merged blocks, evaluates its attributes where each is written, and asks the
	 * resolver for its outputs.
	 *
	 * @returns what the resolver gives, or undefined when there is no resolver or it has no outputs to give.
	 */
	private async resolveUnitDependency(unit: UnitContext, name: string, referencingScope: Scope): Promise<RuntimeValue<ValueType> | undefined> {
		unit.declarations ??= this.dependencyDeclarations(unit, referencingScope);
		const declaration = (await unit.declarations).get(name);
		if (!declaration) throw new Error(`No dependency "${name}" block in ${unit.unitPath} or the configurations it includes`);
		const where = `dependency "${name}" in ${declaration.declaredIn}`;
		if (!declaration.configPath) throw new Error(`${where} is missing config_path`);

		const configPath = await this.evalNode(declaration.configPath.node, declaration.configPath.scope);
		if (configPath.type !== 'string' || String(configPath.value) === '') throw new Error(`${where}: config_path must be a non-empty string`);
		// Terragrunt resolves config_path against the unit's directory, wherever the block is written.
		const target = path.resolve(unit.unitDir, String(configPath.value));
		const targetConfigPath = await dependencyTargetConfig(target, where);

		let mockOutputs: RuntimeValue<ValueType> | undefined;
		for (const attribute of declaration.mockOutputs) {
			const value = await this.evalNode(attribute.node, attribute.scope);
			if (!isObjectValue(value)) {
				throw new Error(`dependency "${name}" in ${attribute.scope.filePath}: mock_outputs must be an object of output names to values`);
			}
			// Lowest priority first, so a later block's value wins where both set one.
			mockOutputs = mockOutputs === undefined
				? value
				: makeObjectValue(deepMergeInputs(
					value.value as Map<string, RuntimeValue<ValueType>>,
					mockOutputs.value as Map<string, RuntimeValue<ValueType>>
				));
		}

		let mockOutputsAllowedTerraformCommands: string[] | undefined;
		for (const attribute of declaration.mockOutputsAllowedTerraformCommands) {
			const value = await this.evalNode(attribute.node, attribute.scope);
			const commands = value.type === 'array'
				? (value.value as RuntimeValue<ValueType>[]).map(entry => entry.type === 'string' ? String(entry.value) : undefined)
				: undefined;
			if (!commands || commands.includes(undefined)) {
				throw new Error(`dependency "${name}" in ${attribute.scope.filePath}: mock_outputs_allowed_terraform_commands must be a list of command names`);
			}
			mockOutputsAllowedTerraformCommands = [...(mockOutputsAllowedTerraformCommands ?? []), ...commands as string[]];
		}

		const request: DependencyRequest = {
			name,
			unitPath: unit.unitPath,
			declaredIn: declaration.declaredIn,
			targetConfigPath,
			targetDir: path.dirname(targetConfigPath),
			...(mockOutputs !== undefined ? { mockOutputs } : {}),
			...(mockOutputsAllowedTerraformCommands !== undefined ? { mockOutputsAllowedTerraformCommands } : {})
		};
		return this.options.resolveDependency?.(request);
	}

	/**
	 * The unit's `dependency` blocks by name after Terragrunt's include merge. The sibling autoinclude's block
	 * replaces the unit's of the same name; each direct include is then merged beneath, the last include first: a
	 * shallow include's block is replaced whole by a higher one of the same name, a deep include's has `config_path`
	 * overridden, its `mock_outputs` deep-merged and its allowed commands concatenated. An include with
	 * `merge_strategy = "no_merge"` contributes nothing.
	 */
	private async dependencyDeclarations(unit: UnitContext, referencingScope: Scope): Promise<Map<string, DependencyDeclaration>> {
		const unitScope = unit.scope!;
		const declarations = new Map<string, DependencyDeclaration>();

		const top: Scope[] = [unitScope];
		if (!AUTOINCLUDE_FILES.has(path.basename(unit.unitPath))) {
			const autoPath = path.join(path.dirname(unit.unitPath), 'terragrunt.autoinclude.hcl');
			if (await pathExists(autoPath)) top.push(await this.mergedFileScope(unit, autoPath, referencingScope));
		}
		for (const scope of top) {
			for (const [name, block] of dependencyBlocks(scope)) declarations.set(name, dependencyDeclaration(block, scope));
		}

		const includes: Array<{ scope: Scope; strategy: MergeStrategy }> = [];
		for (const block of unitScope.blocks) {
			if (block.value !== 'include') continue;
			const { includePath, mergeStrategy } = await this.readIncludeBlock(block, unitScope);
			if (mergeStrategy === 'no_merge') continue;
			includes.push({ scope: await this.mergedFileScope(unit, includePath, referencingScope), strategy: mergeStrategy });
		}
		for (const { scope, strategy } of includes.reverse()) {
			for (const [name, block] of dependencyBlocks(scope)) {
				const lower = dependencyDeclaration(block, scope);
				const higher = declarations.get(name);
				if (!higher) {
					declarations.set(name, lower);
				} else if (strategy === 'deep') {
					declarations.set(name, {
						declaredIn: higher.declaredIn,
						configPath: higher.configPath ?? lower.configPath,
						mockOutputs: [...lower.mockOutputs, ...higher.mockOutputs],
						mockOutputsAllowedTerraformCommands: [...lower.mockOutputsAllowedTerraformCommands, ...higher.mockOutputsAllowedTerraformCommands]
					});
				}
			}
		}
		return declarations;
	}

	/**
	 * The scope of a file merged into the unit: its evaluated scope when it has been evaluated or is the file a
	 * reference is being read in, else one built from its syntax (see {@link structuralScope}).
	 */
	private async mergedFileScope(unit: UnitContext, filePath: string, referencingScope: Scope): Promise<Scope> {
		const resolved = path.resolve(filePath);
		if (path.resolve(referencingScope.filePath) === resolved) return referencingScope;
		const unitScope = unit.scope!;
		if (unitScope.autoinclude && path.resolve(unitScope.autoinclude.filePath) === resolved) return unitScope.autoinclude.scope;
		for (const include of unitScope.includes.values()) {
			if (path.resolve(include.result.filePath) === resolved) return include.result.scope;
		}
		const cached = unit.structuralScopes.get(resolved);
		if (cached) return cached;
		await this.assertPathAllowed(resolved, unitScope.workspaceRoot);
		const content = await fs.readFile(resolved, 'utf8');
		const scope = structuralScope(resolved, content, parseHclSyntax(content, resolved, resolved), unitScope.workspaceRoot, unit.unitDir);
		scope.unit = unit;
		unit.structuralScopes.set(resolved, scope);
		return scope;
	}

	private async resolveIncludePath(include: IncludeRef, parts: string[]): Promise<RuntimeValue<ValueType>> {
		if (parts.length === 0) throw new Error('include reference requires a path');
		const head = parts[0];
		const result = include.result;
		// Terragrunt carries an included file's locals and inputs through JSON, so they hold objects and tuples.
		if (head === 'locals') {
			// `include.<name>.locals` with no trailing name is the whole map.
			if (parts.length < 2) {
				const all = new Map<string, RuntimeValue<ValueType>>();
				for (const name of result.scope.locals.keys()) {
					all.set(name, await this.resolveLocal(result.scope, name));
				}
				return throughJsonValue(makeObjectValue(all));
			}
			const value = await this.resolveLocal(result.scope, parts[1]);
			return this.traverse(throughJsonValue(value), parts.slice(2));
		}
		if (head === 'inputs') {
			if (!result.inputs) throw new Error(`include "${parts[1]}" has no inputs`);
			return this.traverse(throughJsonValue(makeObjectValue(result.inputs)), parts.slice(1));
		}
		if (head === 'terraform') {
			const value = await this.terraformObject(result.scope);
			return this.traverse(value, parts.slice(1));
		}
		const attrNode = result.scope.rootAttrs.get(head);
		if (attrNode) return this.evalNode(attrNode, result.scope);
		throw new Error(`Cannot resolve include path "${parts.join('.')}"`);
	}

	private async terraformObject(scope: Scope): Promise<RuntimeValue<ValueType>> {
		const map = new Map<string, RuntimeValue<ValueType>>();
		for (const [name, node] of scope.terraform) {
			map.set(name, await this.evalNode(node, scope));
		}
		return makeObjectValue(map);
	}

	/**
	 * Follows a reference's steps after its root, as HCL traverses one: a step written as a whole number, such as the
	 * `0` of `local.zones.0`, indexes the value, and any other step takes its attribute.
	 *
	 * @param value the value the reference's root names.
	 * @param parts the steps after the root.
	 * @returns the value the steps reach, carrying the sensitivity of every value along the way.
	 */
	private traverse(value: RuntimeValue<ValueType>, parts: string[]): RuntimeValue<ValueType> {
		let current = value;
		for (const part of parts) {
			current = /^\d+$/u.test(part)
				? indexValue(current, makeNumberValue(CtyNumber.parse(part)))
				: attributeValue(current, part);
		}
		return current;
	}

	/**
	 * Evaluates an expression so that a fault in it is reported where it is written. The innermost expression at fault
	 * is the one reported, so a local that calls an unknown function is placed at the call, not at a reference reading
	 * the local. A value that cannot be known yet is not a fault, and a defect in the evaluator is not the
	 * configuration's: both pass through as they are.
	 *
	 * @param node the expression.
	 * @param scope the scope of the file it is written in.
	 * @returns its value.
	 */
	private async evalNode(node: TNode | undefined, scope: Scope): Promise<RuntimeValue<ValueType>> {
		if (!node) throw new Error('Cannot evaluate an empty expression');
		try {
			return await this.evalExpression(node, scope);
		} catch (error) {
			if (!(error instanceof Error) || isDefect(error) || error instanceof LocatedEvaluationError || error instanceof UnresolvedRenderValueError) throw error;
			const range = nodeRange(node);
			if (!range) throw error;
			throw new LocatedEvaluationError(error.message, scope.filePath, range, { cause: error });
		}
	}

	/**
	 * Runs a check of a value already evaluated, placing a fault it finds where the value's expression is written
	 * rather than where the expression around it is.
	 *
	 * @param node the expression the value is of.
	 * @param scope the scope of the file it is written in.
	 * @param check the check.
	 * @returns what the check returns.
	 */
	private atNode<T>(node: TNode | undefined, scope: Scope, check: () => T): T {
		try {
			return check();
		} catch (error) {
			const range = node ? nodeRange(node) : undefined;
			if (!(error instanceof Error) || !range) throw error;
			throw new LocatedEvaluationError(error.message, scope.filePath, range, { cause: error });
		}
	}

	/*
	 * Tolerant evaluation: an expression evaluated as hclsyntax v2.25.0 evaluates it, giving a value and the
	 * diagnostics beside it rather than stopping at the first fault. Where a part of an expression has errors, the
	 * expression gives what HCL gives in its place: an unknown of its result's type, or of no known type, and the
	 * other parts as they are. Terragrunt decodes a configuration for `render` this way and goes on past its errors
	 * when one of them is an attribute a value does not have (see renderDecode).
	 */

	/** The range of a node in its file, as HCL counts it; for a postfix expression, up to where it ends. */
	private rangeOf(scope: Scope, node: TNode): HclRange {
		if (!node.location) throw new TypeError(`a ${node.type} node has no location`);
		return hclRange(scope.filePath, scope.content, node.location.start.offset, this.endOf(scope, node));
	}

	/** The range between two offsets of a scope's file. */
	private rangeAt(scope: Scope, start: number, end: number): HclRange {
		return hclRange(scope.filePath, scope.content, start, end);
	}

	/**
	 * Where an expression ends. A postfix expression's node spans the whole chain it is part of, so its end is worked
	 * out from its base and the source after it: `]` for an index, the member's name, and a splat's `[*]` or `.*` and
	 * the attribute after it.
	 */
	private endOf(scope: Scope, node: TNode): number {
		if (!node.location) throw new TypeError(`a ${node.type} node has no location`);
		const [base, tail] = node.children ?? [];
		const after = (offset: number): number => {
			let index = offset;
			while (index < scope.content.length && /\s/u.test(scope.content[index])) index++;
			return index;
		};
		switch (node.type) {
			case 'index_expression': {
				if (!tail?.location) return node.location.end.offset;
				return after(this.endOf(scope, tail)) + 1;
			}
			case 'member_access': {
				if (!base) return node.location.end.offset;
				const dot = after(this.endOf(scope, base));
				return after(dot + 1) + String(tail?.value ?? '').length;
			}
			case 'splat_expression': {
				if (!base) return node.location.end.offset;
				let index = after(this.endOf(scope, base));
				index = scope.content[index] === '[' ? scope.content.indexOf(']', index) + 1 : index + 2;
				if (!tail) return index;
				const dot = after(index);
				return after(dot + 1) + String(tail.value ?? '').length;
			}
			default:
				return node.location.end.offset;
		}
	}

	/**
	 * Where an expression starts, as HCL's StartRange gives it for a diagnostic about a value it gave: a function call's
	 * name and `(`, a tuple's `[`, an object's `{`, an operation's or conditional's first operand, a template's first
	 * part, and any other expression whole.
	 */
	private startRangeOf(scope: Scope, node: TNode): HclRange {
		const [first] = node.children ?? [];
		switch (node.type) {
			case 'function_call': {
				const start = node.location!.start.offset;
				return this.rangeAt(scope, start, scope.content.indexOf('(', start + String(node.value ?? '').length) + 1);
			}
			case 'array_lit':
			case 'object':
			case 'list_comprehension':
			case 'map_comprehension': {
				const start = node.location!.start.offset;
				return this.rangeAt(scope, start, start + 1);
			}
			case 'arithmetic_expression':
			case 'comparison_expression':
			case 'logical_expression':
			case 'ternary_expression': {
				// A binary operation and a conditional start with their first operand; a unary operation with its symbol.
				if (first && (node.children?.length ?? 0) > 1) return this.startRangeOf(scope, first);
				const start = node.location!.start.offset;
				return this.rangeAt(scope, start, start + 1);
			}
			case 'interpolated_string': {
				const children = node.children ?? [];
				if (children.length === 1 && children[0].type === 'interpolation') return this.rangeOf(scope, node);
				const part = children[0]?.type === 'interpolation' ? children[0].children?.[0] : children[0];
				return part?.location ? this.startRangeOf(scope, part) : this.rangeOf(scope, node);
			}
			default:
				return this.rangeOf(scope, node);
		}
	}

	/**
	 * A diagnostic about part of a scope's file. Where HCL's diagnostic carries the expression it is about, the values
	 * of the variables that expression reads are worked out here, as HCL's text writer works them out.
	 */
	private async diagnosticAt(scope: Scope, summary: string, detail: string, subject: HclRange, context?: HclRange, expression?: TNode): Promise<HclDiagnostic> {
		const diagnostic: HclDiagnostic = { summary, detail, subject, block: topLevelBlockName(scope.ast, subject.start.offset) };
		if (context) diagnostic.context = context;
		if (expression) {
			const values = await this.diagnosticValues(expression, scope);
			if (values.length > 0) diagnostic.values = values;
		}
		return diagnostic;
	}

	/**
	 * The values of the variables an expression reads, as HCL's text writer states them after a diagnostic's source:
	 * `name as value`, or `name set to null`, sorted; one that cannot be read without errors, is unknown or is
	 * sensitive is not stated.
	 */
	private async diagnosticValues(expression: TNode, scope: Scope): Promise<string[]> {
		const statements = new Map<string, string>();
		for (const reference of referencesIn(expression)) {
			const steps = this.referenceSteps(reference, scope);
			const text = steps.map((step, index) => index === 0 ? step.name : step.key === undefined ? `.${step.name}` : `[${hclValueText(step.key)}]`).join('');
			if (statements.has(text)) continue;
			const resolved = await this.tolerateReference(reference, scope).catch(() => undefined);
			if (!resolved || resolved.diagnostics.length > 0) continue;
			const value = resolved.value;
			if (value.type === 'unknown' || (value.type as string) === 'sensitive') continue;
			statements.set(text, value.type === 'null' ? `${text} set to null` : `${text} as ${hclValueText(value)}`);
		}
		return [...statements.values()].sort(compareStrings);
	}

	/**
	 * A fault thrown while part of an expression was evaluated, as a diagnostic: what HCL calls it where its summary is
	 * known, and where it was written. A value that cannot be known yet and a defect in the evaluator are not
	 * diagnostics: they are thrown on.
	 */
	private async faultDiagnostic(error: unknown, scope: Scope, node: TNode): Promise<HclDiagnostic> {
		if (!(error instanceof Error) || isDefect(error) || error instanceof UnresolvedRenderValueError) throw error;
		let cause: unknown = error;
		while (cause instanceof LocatedEvaluationError && cause.cause instanceof Error) cause = cause.cause;
		if (cause instanceof HclError) return this.diagnosticAt(scope, cause.summary, cause.message, this.rangeOf(scope, node));
		const message = cause instanceof Error ? cause.message : String(cause);
		// tghclp's own faults, and those it words as HCL does, write the summary before the detail.
		const stated = /^([A-Z][^;\n]*); ([\s\S]*)$/u.exec(message);
		return this.diagnosticAt(scope, stated ? stated[1] : 'Invalid expression', stated ? stated[2] : message, this.rangeOf(scope, node));
	}

	/**
	 * Evaluates an expression tolerantly: as hclsyntax evaluates it, with the diagnostics it gives.
	 *
	 * @param node the expression.
	 * @param scope the scope of the file it is written in.
	 * @returns its value, unknown where HCL's is, and its diagnostics.
	 * @throws UnresolvedRenderValueError when part of it cannot be known yet, as the strict evaluation throws it.
	 */
	private async tolerate(node: TNode | undefined, scope: Scope): Promise<Tolerated> {
		if (!node) throw new TypeError('Cannot evaluate an empty expression');
		switch (node.type) {
			case 'array_lit': {
				const values: RuntimeValue<ValueType>[] = [];
				const diagnostics: HclDiagnostic[] = [];
				for (const element of node.children ?? []) {
					const item = await this.tolerate(element, scope);
					values.push(item.value);
					diagnostics.push(...item.diagnostics);
				}
				return { value: makeArrayValue(values), diagnostics };
			}
			case 'object':
				return this.tolerateObject(node, scope);
			case 'interpolated_string': {
				const children = node.children ?? [];
				if (children.length === 1 && children[0].type === 'interpolation') return this.tolerate(children[0], scope);
				return this.tolerateTemplate(node, scope);
			}
			case 'interpolation':
				if (!node.children?.length) break;
				return this.tolerate(node.children[0], scope);
			case 'if_directive': {
				const [condition, whenTrue, whenFalse] = node.children ?? [];
				return this.tolerateConditional(node, condition, () => this.tolerateTemplate(whenTrue, scope), () => this.tolerateTemplate(whenFalse, scope), scope);
			}
			case 'for_directive':
				return this.tolerateTemplateFor(node, scope);
			case 'ternary_expression': {
				const [condition, whenTrue, whenFalse] = node.children ?? [];
				return this.tolerateConditional(node, condition, () => this.tolerate(whenTrue, scope), () => this.tolerate(whenFalse, scope), scope);
			}
			case 'logical_expression':
				return String(node.value) === '!' ? this.tolerateUnary(node, ctyBool, scope) : this.tolerateLogical(node, scope);
			case 'comparison_expression': {
				const operator = String(node.value);
				return this.tolerateBinary(node, operator === '==' || operator === '!=' ? ctyDynamic : ctyNumber, ctyBool, scope);
			}
			case 'arithmetic_expression':
				return (node.children?.length ?? 0) === 1 ? this.tolerateUnary(node, ctyNumber, scope) : this.tolerateBinary(node, ctyNumber, ctyNumber, scope);
			case 'member_access':
				return this.tolerateMemberAccess(node, scope);
			case 'index_expression':
				return this.tolerateIndex(node, scope);
			case 'list_comprehension':
			case 'map_comprehension':
			case 'for_expression':
				return this.tolerateFor(node, scope);
			case 'splat_expression':
				return this.tolerateSplat(node, scope);
			case 'function_call':
				return this.tolerateCall(node, scope);
			case 'reference':
			case 'local_reference':
			case 'terraform_reference':
			case 'var_reference':
			case 'data_reference':
			case 'module_reference':
			case 'dependency_reference':
			case 'path_reference':
			case 'traversal_reference':
				return this.tolerateReference(node, scope);
			default:
				break;
		}
		// A literal, and the expressions only tghclp's grammar has, evaluated strictly; a fault in one is its diagnostic.
		try {
			return { value: await this.evalNode(node, scope), diagnostics: [] };
		} catch (error) {
			return { value: makeDynamicValue(), diagnostics: [await this.faultDiagnostic(error, scope, node)] };
		}
	}

	/**
	 * HCL's ObjectConsExpr: each key and value evaluated; a key that has errors, is null or unknown, or is not a string
	 * makes the object of no known type.
	 *
	 * @param node the object.
	 * @param scope the scope of the file it is written in.
	 * @param valueOf evaluates an attribute's value, given its key's text where the key evaluated to one; undefined
	 *   leaves the attribute out.
	 */
	private async tolerateObject(
		node: TNode,
		scope: Scope,
		valueOf: (valueNode: TNode | undefined, key: string | undefined) => Promise<Tolerated | undefined> = valueNode => this.tolerate(valueNode, scope)
	): Promise<Tolerated> {
		const entries = new Map<string, RuntimeValue<ValueType>>();
		const diagnostics: HclDiagnostic[] = [];
		let known = true;
		for (const child of node.children ?? []) {
			if (child.type === 'inheritance') {
				// tghclp's own `...source`: every attribute of the source not set by name.
				const source = await this.tolerate(child.children?.[0], scope);
				diagnostics.push(...source.diagnostics);
				if (source.diagnostics.length > 0 || source.value.type === 'unknown') {
					known = false;
					continue;
				}
				if (!isObjectValue(source.value)) {
					diagnostics.push(await this.diagnosticAt(scope, 'Invalid expression', 'inherit requires an object source', this.rangeOf(scope, child)));
					known = false;
					continue;
				}
				for (const [key, value] of source.value.value as Map<string, RuntimeValue<ValueType>>) if (!entries.has(key)) entries.set(key, value);
				continue;
			}
			if (child.type !== 'attribute') continue;
			const keyNode = child.children?.find(part => part.type === 'object_key');
			const valueNode = child.children?.find(part => part.type !== 'attribute_identifier' && part.type !== 'object_key');
			const key = keyNode ? await this.tolerate(keyNode.children?.[0], scope) : { value: makeStringValue(String(child.value)), diagnostics: [] };
			diagnostics.push(...key.diagnostics);
			const keyPlain = unwrapSensitive(key.value);
			const value = await valueOf(valueNode, key.diagnostics.length === 0 && keyPlain.type === 'string' ? String(keyPlain.value) : undefined);
			if (!value) continue;
			diagnostics.push(...value.diagnostics);
			if (key.diagnostics.length > 0) {
				known = false;
				continue;
			}
			const keyValue = unwrapSensitive(computable(key.value));
			if (keyValue.type === 'null') {
				diagnostics.push(await this.diagnosticAt(scope, 'Null value as key', "Can't use a null value as a key.", this.rangeOf(scope, valueNode!), undefined, keyNode?.children?.[0]));
				known = false;
				continue;
			}
			let converted: RuntimeValue<ValueType>;
			try {
				converted = convert(keyValue, ctyString);
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				diagnostics.push(await this.diagnosticAt(scope, 'Incorrect key type', `Can't use this value as a key: ${error.message}.`, this.rangeOf(scope, keyNode!.children![0]), undefined, keyNode?.children?.[0]));
				known = false;
				continue;
			}
			if (converted.type === 'unknown') {
				known = false;
				continue;
			}
			entries.set(String(converted.value), value.value);
		}
		return { value: known ? makeObjectValue(entries) : makeDynamicValue(), diagnostics };
	}

	/**
	 * HCL's TemplateExpr: each part rendered and converted to a string; an unknown part makes the result an unknown
	 * string, and once a part has errors the parts after it are no longer added to the text.
	 */
	private async tolerateTemplate(node: TNode | undefined, scope: Scope): Promise<Tolerated> {
		// A template `if` without an `else` has the empty template for it.
		if (!node) return { value: makeStringValue(''), diagnostics: [] };
		if (node.type === 'string_lit') return { value: makeStringValue(String(node.value ?? '')), diagnostics: [] };
		if (node.type !== 'interpolated_string') throw new TypeError(`A template cannot be a ${node.type}`);
		const templateRange = this.rangeOf(scope, node);
		const diagnostics: HclDiagnostic[] = [];
		let text = '';
		let known = true;
		let sensitive = false;
		for (const child of node.children ?? []) {
			if (child.type === 'string_lit') {
				if (known && diagnostics.length === 0) text += String(child.value ?? '');
				continue;
			}
			const expression = child.type === 'interpolation' ? child.children?.[0] : child;
			const part = await this.tolerate(child, scope);
			diagnostics.push(...part.diagnostics);
			const partRange = this.rangeOf(scope, expression ?? child);
			const value = computable(part.value);
			const plain = unwrapSensitive(value);
			if (plain.type === 'null') {
				diagnostics.push(await this.diagnosticAt(scope, 'Invalid template interpolation value', 'The expression result is null. Cannot include a null value in a string template.', partRange, templateRange, expression));
				continue;
			}
			sensitive ||= plain !== value;
			if (plain.type === 'unknown') {
				known = false;
				continue;
			}
			let converted: RuntimeValue<ValueType>;
			try {
				converted = convert(plain, ctyString);
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				diagnostics.push(await this.diagnosticAt(scope, 'Invalid template interpolation value', `Cannot include the given value in a string template: ${error.message}.`, partRange, templateRange, expression));
				continue;
			}
			if (known && diagnostics.length === 0) text += String(converted.value);
		}
		const value = known ? makeStringValue(text) : makeUnknownValue(ctyString);
		return { value: sensitive ? makeSensitiveValue(value) : value, diagnostics };
	}

	/** A template's `%{ for }`, as HCL's TemplateJoinExpr joins the for expression it lowers it to. */
	private async tolerateTemplateFor(node: TNode, scope: Scope): Promise<Tolerated> {
		const tuple = await this.tolerateFor(node, scope);
		const diagnostics = [...tuple.diagnostics];
		const value = unwrapSensitive(tuple.value);
		if (value.type === 'unknown') return { value: makeUnknownValue(ctyString), diagnostics };
		let text = '';
		for (const element of value.value as RuntimeValue<ValueType>[]) {
			const plain = unwrapSensitive(element);
			if (plain.type === 'null') {
				diagnostics.push(await this.diagnosticAt(scope, 'Invalid template interpolation value', 'An iteration result is null. Cannot include a null value in a string template.', this.rangeOf(scope, node), undefined, node));
				continue;
			}
			if (plain.type === 'unknown') return { value: makeUnknownValue(ctyString), diagnostics };
			let converted: RuntimeValue<ValueType>;
			try {
				converted = convert(plain, ctyString);
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				diagnostics.push(await this.diagnosticAt(scope, 'Invalid template interpolation value', `Cannot include one of the interpolation results into the string template: ${error.message}.`, this.rangeOf(scope, node), undefined, node));
				continue;
			}
			text += String(converted.value);
		}
		return { value: makeStringValue(text), diagnostics };
	}

	/**
	 * HCL's ConditionalExpr: both branches evaluated first and their types unified to the result's; then the
	 * condition, an unknown one making the result an unknown of that type; then the chosen branch, whose diagnostics
	 * alone are kept, converted to that type.
	 */
	private async tolerateConditional(node: TNode, conditionNode: TNode | undefined, whenTrue: () => Promise<Tolerated>, whenFalse: () => Promise<Tolerated>, scope: Scope): Promise<Tolerated> {
		const trueResult = await whenTrue();
		const falseResult = await whenFalse();
		const trueType = valueType(trueResult.value);
		const falseType = valueType(falseResult.value);
		const isUntypedNull = (value: RuntimeValue<ValueType>): boolean => value.type === 'null' && value.ctyType?.kind === 'dynamic';
		let resultType: CtyType = ctyDynamic;
		let conversions: (((value: RuntimeValue<ValueType>) => RuntimeValue<ValueType>) | undefined)[] = [undefined, undefined];
		if (isUntypedNull(trueResult.value)) {
			resultType = falseType;
			conversions = [getConversionUnsafe(ctyDynamic, resultType), undefined];
		} else if (isUntypedNull(falseResult.value)) {
			resultType = trueType;
			conversions = [undefined, getConversionUnsafe(ctyDynamic, resultType)];
		} else if (trueType.kind !== 'dynamic' && falseType.kind !== 'dynamic') {
			const unified = unify([trueType, falseType], true);
			if (!unified) {
				const [whenTrueNode, whenFalseNode] = [node.children?.[1], node.children?.[2]];
				const subject = whenTrueNode && whenFalseNode ? rangeOver(this.rangeOf(scope, whenTrueNode), this.rangeOf(scope, whenFalseNode)) : this.rangeOf(scope, node);
				return {
					value: makeDynamicValue(),
					diagnostics: [await this.diagnosticAt(scope, 'Inconsistent conditional result types', `The true and false result expressions must have consistent types. ${describeConditionalTypeMismatch(trueType, falseType)}.`, subject, this.rangeOf(scope, node), node)]
				};
			}
			resultType = unified.type;
			conversions = unified.conversions;
		}
		const condition = await this.tolerate(conditionNode, scope);
		const diagnostics = [...condition.diagnostics];
		const conditionValue = unwrapSensitive(computable(condition.value));
		const sensitive = [condition.value, trueResult.value, falseResult.value].some(value => (value.type as string) === 'sensitive');
		const mark = (value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => sensitive && (value.type as string) !== 'sensitive' ? makeSensitiveValue(value) : value;
		if (conditionValue.type === 'null') {
			diagnostics.push(await this.diagnosticAt(scope, 'Null condition', 'The condition value is null. Conditions must either be true or false.', this.rangeOf(scope, conditionNode!), this.rangeOf(scope, node), conditionNode));
			return { value: makeUnknownValue(resultType), diagnostics };
		}
		if (conditionValue.type === 'unknown') {
			if (unwrapSensitive(trueResult.value).type === 'null' && unwrapSensitive(falseResult.value).type === 'null') return { value: mark(makeNullValue(resultType)), diagnostics };
			return { value: mark(makeUnknownValue(resultType)), diagnostics };
		}
		let truth: boolean;
		try {
			truth = Boolean(convert(conditionValue, ctyBool).value);
		} catch (error) {
			if (!(error instanceof ConversionError)) throw error;
			diagnostics.push(await this.diagnosticAt(scope, 'Incorrect condition type', 'The condition expression must be of type bool.', this.rangeOf(scope, conditionNode!), this.rangeOf(scope, node), conditionNode));
			return { value: makeUnknownValue(resultType), diagnostics };
		}
		const chosen = truth ? trueResult : falseResult;
		diagnostics.push(...chosen.diagnostics);
		const conversion = conversions[truth ? 0 : 1];
		if (!conversion) return { value: mark(unwrapSensitive(chosen.value)), diagnostics };
		try {
			return { value: mark(conversion(unwrapSensitive(chosen.value))), diagnostics };
		} catch (error) {
			if (!(error instanceof ConversionError)) throw error;
			const branch = node.children?.[truth ? 1 : 2];
			diagnostics.push(await this.diagnosticAt(scope, 'Inconsistent conditional result types', `The ${truth ? 'true' : 'false'} result value has the wrong type: ${error.message}.`, branch ? this.rangeOf(scope, branch) : this.rangeOf(scope, node), this.rangeOf(scope, node), branch));
			return { value: makeUnknownValue(resultType), diagnostics };
		}
	}

	/**
	 * An operand of an operation converted to the type the operation takes, as HCL's BinaryOpExpr and UnaryOpExpr
	 * convert one, or the diagnostic saying why it does not convert.
	 */
	private async tolerateOperand(operand: Tolerated, type: CtyType, side: 'left' | 'right' | 'unary', operandNode: TNode, node: TNode, scope: Scope): Promise<{ value: RuntimeValue<ValueType> } | { diagnostic: HclDiagnostic }> {
		try {
			return { value: convert(computable(operand.value), type) };
		} catch (error) {
			if (!(error instanceof ConversionError)) throw error;
			return { diagnostic: await this.diagnosticAt(scope, 'Invalid operand', `Unsuitable value for ${side} operand: ${error.message}.`, this.rangeOf(scope, operandNode), this.rangeOf(scope, node), operandNode) };
		}
	}

	/** HCL's BinaryOpExpr for an arithmetic or comparison operator: an unknown of the result's type where an operand has errors or is unknown. */
	private async tolerateBinary(node: TNode, operandType: CtyType, resultType: CtyType, scope: Scope): Promise<Tolerated> {
		const [leftNode, rightNode] = node.children ?? [];
		const operator = String(node.value);
		const left = await this.tolerate(leftNode, scope);
		const leftOperand = await this.tolerateOperand(left, operandType, 'left', leftNode!, node, scope);
		const right = await this.tolerate(rightNode, scope);
		const rightOperand = await this.tolerateOperand(right, operandType, 'right', rightNode!, node, scope);
		const conversionDiagnostics = [leftOperand, rightOperand].flatMap(operand => ('diagnostic' in operand ? [operand.diagnostic] : []));
		if (conversionDiagnostics.length > 0) return { value: makeUnknownValue(resultType), diagnostics: [...conversionDiagnostics, ...left.diagnostics, ...right.diagnostics] };
		const diagnostics = [...left.diagnostics, ...right.diagnostics];
		const operands = [left.value, right.value].map(computable);
		if (diagnostics.length > 0 || operands.some(isUnknown)) return { value: makeUnknownValue(resultType), diagnostics };
		try {
			const value = resultType.kind === 'number' ? arithmetic(operator, operands[0], operands[1]) : comparison(operator, operands[0], operands[1]);
			return { value, diagnostics };
		} catch (error) {
			if (!(error instanceof HclError)) throw error;
			return { value: makeUnknownValue(resultType), diagnostics: [await this.diagnosticAt(scope, error.summary, error.message, this.rangeOf(scope, node), undefined, node)] };
		}
	}

	/** HCL's UnaryOpExpr: `!` or unary `-`, an unknown of the result's type where the operand has errors. */
	private async tolerateUnary(node: TNode, type: CtyType, scope: Scope): Promise<Tolerated> {
		const operandNode = node.children?.[0];
		const operand = await this.tolerate(operandNode, scope);
		const converted = await this.tolerateOperand(operand, type, 'unary', operandNode!, node, scope);
		const diagnostics = [...operand.diagnostics, ...('diagnostic' in converted ? [converted.diagnostic] : [])];
		if (diagnostics.length > 0 || !('value' in converted) || isUnknown(converted.value)) return { value: makeUnknownValue(type), diagnostics };
		try {
			if (type.kind === 'number') return { value: negation(operand.value), diagnostics };
			const truth = operandBool(operand.value, 'unary');
			if (truth === null) throw new HclError('Operation failed', NULL_OPERAND);
			return { value: makeBooleanValue(!truth), diagnostics };
		} catch (error) {
			if (!(error instanceof HclError)) throw error;
			return { value: makeUnknownValue(type), diagnostics: [await this.diagnosticAt(scope, error.summary, error.message, this.rangeOf(scope, node), undefined, node)] };
		}
	}

	/**
	 * HCL's BinaryOpExpr for `&&` and `||`: the operands converted to bools, then the operation's short circuit, which
	 * takes the result from one operand, known or not, and keeps only that operand's diagnostics.
	 */
	private async tolerateLogical(node: TNode, scope: Scope): Promise<Tolerated> {
		const [leftNode, rightNode] = node.children ?? [];
		const operator = String(node.value) as '&&' | '||';
		const left = await this.tolerate(leftNode, scope);
		const leftOperand = await this.tolerateOperand(left, ctyBool, 'left', leftNode!, node, scope);
		const right = await this.tolerate(rightNode, scope);
		const rightOperand = await this.tolerateOperand(right, ctyBool, 'right', rightNode!, node, scope);
		if (!('value' in leftOperand) || !('value' in rightOperand)) {
			const conversionDiagnostics = [leftOperand, rightOperand].flatMap(operand => ('diagnostic' in operand ? [operand.diagnostic] : []));
			return { value: makeUnknownValue(ctyBool), diagnostics: [...conversionDiagnostics, ...left.diagnostics, ...right.diagnostics] };
		}
		const sensitive = [leftOperand.value, rightOperand.value].some(value => (value.type as string) === 'sensitive');
		const mark = (value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => sensitive ? makeSensitiveValue(value) : value;
		const lhs = unwrapSensitive(leftOperand.value);
		const rhs = unwrapSensitive(rightOperand.value);
		// go-cty's True and False read a null bool as false.
		const isTrue = (value: RuntimeValue<ValueType>): boolean => value.type === 'boolean' && value.value === true;
		const deciding = operator === '||' ? isTrue : (value: RuntimeValue<ValueType>) => value.type !== 'unknown' && !isTrue(value);
		const opposite = operator === '||' ? (value: RuntimeValue<ValueType>) => value.type !== 'unknown' && !isTrue(value) : isTrue;
		if (lhs.type === 'unknown' && rhs.type === 'unknown') {
			if (left.diagnostics.length === 0) return { value: mark(makeUnknownValue(ctyBool)), diagnostics: left.diagnostics };
		} else if (lhs.type !== 'unknown' && deciding(lhs)) {
			return { value: mark(makeBooleanValue(operator === '||')), diagnostics: left.diagnostics };
		} else if (rhs.type !== 'unknown' && deciding(rhs)) {
			return { value: mark(makeBooleanValue(operator === '||')), diagnostics: right.diagnostics };
		} else if (lhs.type === 'unknown' && opposite(rhs)) {
			return { value: mark(makeUnknownValue(ctyBool)), diagnostics: left.diagnostics };
		} else if (rhs.type === 'unknown' && opposite(lhs)) {
			return { value: mark(makeUnknownValue(ctyBool)), diagnostics: right.diagnostics };
		}
		const diagnostics = [...left.diagnostics, ...right.diagnostics];
		if (diagnostics.length > 0 || lhs.type === 'unknown' || rhs.type === 'unknown') return { value: mark(makeUnknownValue(ctyBool)), diagnostics };
		const asOperand = (value: RuntimeValue<ValueType>): LogicalOperand => value.type === 'null' ? null : Boolean(value.value);
		try {
			return { value: mark(makeBooleanValue(logicalOperation(operator, asOperand(lhs), asOperand(rhs)))), diagnostics };
		} catch (error) {
			if (!(error instanceof Error) || isDefect(error)) throw error;
			return { value: makeUnknownValue(ctyBool), diagnostics: [await this.diagnosticAt(scope, 'Operation failed', error.message, this.rangeOf(scope, node), undefined, node)] };
		}
	}

	/** HCL's IndexExpr: the collection and key evaluated, and hcl.Index applied whatever their diagnostics. */
	private async tolerateIndex(node: TNode, scope: Scope): Promise<Tolerated> {
		const [collectionNode, keyNode] = node.children ?? [];
		const collection = await this.tolerate(collectionNode, scope);
		const key = await this.tolerate(keyNode, scope);
		const diagnostics = [...collection.diagnostics, ...key.diagnostics];
		try {
			return { value: indexValue(collection.value, computable(key.value)), diagnostics };
		} catch (error) {
			if (!(error instanceof HclError)) throw error;
			const open = scope.content.lastIndexOf('[', keyNode!.location!.start.offset);
			diagnostics.push(await this.diagnosticAt(scope, error.summary, error.message, this.rangeAt(scope, open, this.endOf(scope, node)), undefined, node));
			return { value: makeDynamicValue(), diagnostics };
		}
	}

	/** HCL's RelativeTraversalExpr: `.name` steps after an expression, the first step that fails giving a value of no known type. */
	private async tolerateMemberAccess(node: TNode, scope: Scope): Promise<Tolerated> {
		const [baseNode, member] = node.children ?? [];
		const base = await this.tolerate(baseNode, scope);
		let value = base.value;
		let offset = this.endOf(scope, baseNode!);
		for (const name of String(member?.value ?? '').split('.')) {
			const start = scope.content.indexOf('.', offset);
			const nameStart = scope.content.indexOf(name, start);
			offset = nameStart + name.length;
			try {
				value = /^\d+$/u.test(name) ? indexValue(value, makeNumberValue(CtyNumber.parse(name))) : attributeValue(value, name);
			} catch (error) {
				if (!(error instanceof HclError)) throw error;
				return { value: makeDynamicValue(), diagnostics: [...base.diagnostics, await this.diagnosticAt(scope, error.summary, error.message, this.rangeAt(scope, start, offset), undefined, node)] };
			}
		}
		return { value, diagnostics: base.diagnostics };
	}

	/**
	 * HCL's ForExpr: the collection, then the `if` clause checked once with the variables unknown, then each element.
	 * A collection or clause with errors, an unknown collection, and an element whose clause or key cannot be known
	 * make the result of no known type.
	 */
	private async tolerateFor(node: TNode, scope: Scope): Promise<Tolerated> {
		const children = node.children ?? [];
		let variables: TNode[];
		let collectionNode: TNode | undefined;
		let keyNode: TNode | undefined;
		let valueNode: TNode | undefined;
		let conditionNode: TNode | undefined;
		let grouping = false;
		if (node.type === 'for_expression') {
			[collectionNode, valueNode] = children.slice(1);
			variables = children.slice(0, 1);
		} else if (node.type === 'for_directive') {
			variables = children.slice(0, children.length - 2);
			[collectionNode, valueNode] = children.slice(variables.length);
		} else {
			variables = children[1]?.type === 'identifier' ? children.slice(0, 2) : children.slice(0, 1);
			const rest = children.slice(variables.length + 1);
			collectionNode = children[variables.length];
			if (node.type === 'map_comprehension') {
				[keyNode, valueNode, conditionNode] = rest;
				grouping = node.value === '...';
			} else {
				[valueNode, conditionNode] = rest;
			}
		}
		const forRange = this.rangeOf(scope, node);
		const names = variables.map(variable => String(variable.value ?? ''));
		const withElement = async <T>(key: RuntimeValue<ValueType>, element: RuntimeValue<ValueType>, run: () => Promise<T>): Promise<T> => {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			if (names.length === 2) frame.set(names[0], key);
			frame.set(names[names.length - 1], element);
			scope.comprehension.push(frame);
			try {
				return await run();
			} finally {
				scope.comprehension.pop();
			}
		};
		const evaluateBody = node.type === 'for_directive'
			? () => this.tolerateTemplate(valueNode, scope)
			: () => this.tolerate(valueNode, scope);
		const collection = await this.tolerate(collectionNode, scope);
		const diagnostics = [...collection.diagnostics];
		const collectionValue = unwrapSensitive(computable(collection.value));
		if (collectionValue.type === 'null') {
			diagnostics.push(await this.diagnosticAt(scope, 'Iteration over null value', "A null value cannot be used as the collection in a 'for' expression.", this.rangeOf(scope, collectionNode!), forRange, collectionNode));
			return { value: makeDynamicValue(), diagnostics };
		}
		const collectionType = valueType(collectionValue);
		if (collectionType.kind === 'dynamic') return { value: makeDynamicValue(), diagnostics };
		if (!['list', 'tuple', 'set', 'map', 'object'].includes(collectionType.kind)) {
			diagnostics.push(await this.diagnosticAt(scope, 'Iteration over non-iterable value', `A value of type ${friendlyName(collectionType)} cannot be used as the collection in a 'for' expression.`, this.rangeOf(scope, collectionNode!), forRange, collectionNode));
			return { value: makeDynamicValue(), diagnostics };
		}
		if (conditionNode) {
			const check = await withElement(makeDynamicValue(), makeDynamicValue(), () => this.tolerate(conditionNode, scope));
			diagnostics.push(...check.diagnostics);
			const result = unwrapSensitive(check.value);
			if (result.type === 'null') {
				diagnostics.push(await this.diagnosticAt(scope, 'Condition is null', "The value of the 'if' clause must not be null.", this.rangeOf(scope, conditionNode), forRange, conditionNode));
				return { value: makeDynamicValue(), diagnostics };
			}
			try {
				convert(result, ctyBool);
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				diagnostics.push(await this.diagnosticAt(scope, "Invalid 'for' condition", `The 'if' clause value is invalid: ${error.message}.`, this.rangeOf(scope, conditionNode), forRange, conditionNode));
				return { value: makeDynamicValue(), diagnostics };
			}
			if (check.diagnostics.length > 0) return { value: makeDynamicValue(), diagnostics };
		}
		if (collectionValue.type === 'unknown') return { value: makeDynamicValue(), diagnostics };
		let known = true;
		const values: RuntimeValue<ValueType>[] = [];
		const entries = new Map<string, RuntimeValue<ValueType>>();
		const groups = new Map<string, RuntimeValue<ValueType>[]>();
		for (const [key, element] of forElements(collectionValue)) {
			const skip = await withElement(key, element, async (): Promise<boolean> => {
				if (conditionNode) {
					const include = await this.tolerate(conditionNode, scope);
					diagnostics.push(...include.diagnostics);
					const raw = unwrapSensitive(include.value);
					if (raw.type === 'null') {
						if (known) diagnostics.push(await this.diagnosticAt(scope, "Invalid 'for' condition", "The value of the 'if' clause must not be null.", this.rangeOf(scope, conditionNode), forRange, conditionNode));
						known = false;
						return true;
					}
					// A tuple's clause is checked for being known before it is converted, an object's after.
					if (!keyNode && raw.type === 'unknown') {
						known = false;
						return true;
					}
					let included: RuntimeValue<ValueType>;
					try {
						included = convert(raw, ctyBool);
					} catch (error) {
						if (!(error instanceof ConversionError)) throw error;
						if (known) diagnostics.push(await this.diagnosticAt(scope, "Invalid 'for' condition", `The 'if' clause value is invalid: ${error.message}.`, this.rangeOf(scope, conditionNode), forRange, conditionNode));
						known = false;
						return true;
					}
					if (included.type === 'unknown') {
						known = false;
						return true;
					}
					if (included.value === false) return true;
				}
				if (!keyNode) {
					const item = await evaluateBody();
					diagnostics.push(...item.diagnostics);
					values.push(item.value);
					return false;
				}
				const keyResult = await this.tolerate(keyNode, scope);
				diagnostics.push(...keyResult.diagnostics);
				const rawKey = unwrapSensitive(keyResult.value);
				if (rawKey.type === 'null') {
					if (known) diagnostics.push(await this.diagnosticAt(scope, 'Invalid object key', "Key expression in 'for' expression must not produce a null value.", this.rangeOf(scope, keyNode), forRange, keyNode));
					known = false;
					return true;
				}
				if (rawKey.type === 'unknown') {
					known = false;
					return true;
				}
				let keyText: string;
				try {
					keyText = String(convert(rawKey, ctyString).value);
				} catch (error) {
					if (!(error instanceof ConversionError)) throw error;
					if (known) diagnostics.push(await this.diagnosticAt(scope, 'Invalid object key', `The key expression produced an invalid result: ${error.message}.`, this.rangeOf(scope, keyNode), forRange, keyNode));
					known = false;
					return true;
				}
				const item = await evaluateBody();
				diagnostics.push(...item.diagnostics);
				if (grouping) {
					groups.set(keyText, [...(groups.get(keyText) ?? []), item.value]);
				} else if (entries.has(keyText)) {
					diagnostics.push(await this.diagnosticAt(scope, 'Duplicate object key', `Two different items produced the key "${keyText}" in this 'for' expression. If duplicates are expected, use the ellipsis (...) after the value expression to enable grouping by key.`, this.rangeOf(scope, keyNode), forRange, keyNode));
				} else {
					entries.set(keyText, item.value);
				}
				return false;
			});
			if (skip) continue;
		}
		if (!known) return { value: makeDynamicValue(), diagnostics };
		if (!keyNode) return { value: makeArrayValue(values), diagnostics };
		if (grouping) for (const [key, group] of groups) entries.set(key, makeArrayValue(group));
		return { value: makeObjectValue(entries), diagnostics };
	}

	/**
	 * HCL's SplatExpr: the attribute after the splat taken of each element of a list, set or tuple, or of a value taken
	 * as a tuple of itself. A source with errors gives a value of no known type, and an element whose attribute fails
	 * makes the result an unknown of the type the splat would have.
	 */
	private async tolerateSplat(node: TNode, scope: Scope): Promise<Tolerated> {
		const [baseNode, attributeNode] = node.children ?? [];
		const source = await this.tolerate(baseNode, scope);
		const diagnostics = [...source.diagnostics];
		if (diagnostics.length > 0) return { value: makeDynamicValue(), diagnostics };
		const attribute = attributeNode ? String(attributeNode.value ?? '') : undefined;
		const each = (element: RuntimeValue<ValueType>): RuntimeValue<ValueType> => (attribute === undefined ? element : attributeValue(element, attribute));
		const eachType = (type: CtyType): CtyType => {
			try {
				return valueType(each(makeUnknownValue(type)));
			} catch (error) {
				if (!(error instanceof HclError)) throw error;
				return ctyDynamic;
			}
		};
		const plain = unwrapSensitive(computable(source.value));
		const sensitive = plain !== source.value;
		const mark = (value: RuntimeValue<ValueType>): RuntimeValue<ValueType> => sensitive ? makeSensitiveValue(value) : value;
		let type = valueType(plain);
		const autoUpgrade = !['tuple', 'list', 'set'].includes(type.kind);
		if (plain.type === 'null') {
			if (autoUpgrade) return { value: mark(makeArrayValue([])), diagnostics };
			diagnostics.push(await this.diagnosticAt(scope, 'Splat of null value', 'Splat expressions (with the * symbol) cannot be applied to null sequences.', this.rangeOf(scope, baseNode!), this.rangeOf(scope, node), baseNode));
			return { value: makeDynamicValue(), diagnostics };
		}
		if (type.kind === 'dynamic') return { value: mark(makeDynamicValue()), diagnostics };
		let sourceValue = plain;
		let upgradedUnknown = false;
		if (autoUpgrade) {
			upgradedUnknown = plain.type === 'unknown';
			sourceValue = makeArrayValue([plain]);
			type = valueType(sourceValue);
		}
		const resultType = (): CtyType => {
			if (type.kind === 'list' || type.kind === 'set') return listOf(eachType(type.element));
			if (type.kind === 'tuple') return tupleOf(type.elements.map(eachType));
			return ctyDynamic;
		};
		if (sourceValue.type === 'unknown') return { value: mark(makeUnknownValue(resultType())), diagnostics };
		const attributeRange = (): HclRange => {
			const end = this.endOf(scope, node);
			return this.rangeAt(scope, scope.content.lastIndexOf('.', end - String(attribute ?? '').length), end);
		};
		const results: RuntimeValue<ValueType>[] = [];
		let known = true;
		for (const element of sourceValue.value as RuntimeValue<ValueType>[]) {
			try {
				results.push(each(element));
			} catch (error) {
				if (!(error instanceof HclError)) throw error;
				diagnostics.push(await this.diagnosticAt(scope, error.summary, error.message, attributeRange()));
				known = false;
				results.push(makeDynamicValue());
			}
		}
		if (upgradedUnknown) return { value: mark(makeDynamicValue()), diagnostics };
		if (!known) return { value: mark(makeUnknownValue(resultType())), diagnostics };
		if (type.kind !== 'list' && type.kind !== 'set') return { value: mark(makeArrayValue(results)), diagnostics };
		if (results.length === 0) return { value: mark(makeListValue(eachType(type.element), [])), diagnostics };
		const first = valueType(results[0]);
		if (!results.every(result => typeEquals(valueType(result), first))) {
			diagnostics.push(await this.diagnosticAt(scope, 'Invalid nested splat expressions', "The second level of splat expression produced elements of different types, so it isn't possible to construct a valid list to represent the top-level result.\n\nConsider using a for expression instead, to produce a tuple-typed result which can therefore have non-homogenous element types.", attributeRange(), this.rangeOf(scope, node)));
			return { value: makeDynamicValue(), diagnostics };
		}
		return { value: mark(makeListValue(first, results)), diagnostics };
	}

	/**
	 * HCL's FunctionCallExpr: an unknown function, or a count of arguments the function's parameters do not allow,
	 * refused before any argument is evaluated; then each argument evaluated and converted to its parameter's type, and
	 * the function called only where none has errors. `try` and `can` evaluate their arguments themselves.
	 */
	private async tolerateCall(node: TNode, scope: Scope): Promise<Tolerated> {
		const name = String(node.value ?? '');
		const callRange = this.rangeOf(scope, node);
		const written = (node.children ?? []).filter(child => child.type !== 'function_identifier');
		if (this.findInlineFunction(scope, name) || written.some(child => child.type === 'named_argument')) {
			// tghclp's own inline functions and named arguments, which Terragrunt does not have, are evaluated strictly.
			try {
				return { value: await this.evalNode(node, scope), diagnostics: [] };
			} catch (error) {
				return { value: makeDynamicValue(), diagnostics: [await this.faultDiagnostic(error, scope, node)] };
			}
		}
		const definition = this.schema.getFunctionDefinition(name);
		if (!definition) {
			const identifier = (node.children ?? []).find(child => child.type === 'function_identifier');
			const suggestion = functionNameSuggestion(name, this.schema.getFunctionRegistry().getFunctionNames());
			return {
				value: makeDynamicValue(),
				diagnostics: [await this.diagnosticAt(scope, 'Call to unknown function', `There is no function named "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, identifier ? this.rangeOf(scope, identifier) : callRange, callRange, node)]
			};
		}
		const diagnostics: HclDiagnostic[] = [];
		// Each argument with where it is written, an expanded final argument as its elements.
		let args: Array<{ expression?: TNode; value?: RuntimeValue<ValueType>; written: TNode }> = written.map(expression => ({ expression, written: expression }));
		const final = written.at(-1);
		if (final?.type === 'variadic_arguments') {
			const expanding = final.children?.[0];
			const expanded = await this.tolerate(expanding, scope);
			diagnostics.push(...expanded.diagnostics);
			if (expanded.diagnostics.length > 0) return { value: makeDynamicValue(), diagnostics };
			const collection = unwrapSensitive(expanded.value);
			const collectionType = valueType(collection);
			const refuse = async (detail: string): Promise<Tolerated> => {
				diagnostics.push(await this.diagnosticAt(scope, 'Invalid expanding argument value', detail, this.rangeOf(scope, expanding!), callRange, expanding));
				return { value: makeDynamicValue(), diagnostics };
			};
			if (collectionType.kind === 'dynamic') {
				if (collection.type === 'null') return refuse('The expanding argument (indicated by ...) must not be null.');
				return { value: makeDynamicValue(), diagnostics };
			}
			if (!['tuple', 'list', 'set'].includes(collectionType.kind)) return refuse('The expanding argument (indicated by ...) must be of a tuple, list, or set type.');
			if (collection.type === 'null') return refuse('The expanding argument (indicated by ...) must not be null.');
			if (collection.type === 'unknown') return { value: makeDynamicValue(), diagnostics };
			const sensitive = collection !== expanded.value;
			args = [
				...args.slice(0, -1),
				...(collection.value as RuntimeValue<ValueType>[]).map(value => ({ value: sensitive ? makeSensitiveValue(value) : value, written: expanding! }))
			];
		}
		const { params, varParam } = definition.signature;
		if (args.length < params.length) {
			const closing = this.rangeAt(scope, callRange.end.offset - 1, callRange.end.offset);
			return {
				value: makeDynamicValue(),
				diagnostics: [await this.diagnosticAt(scope, 'Not enough function arguments', `Function "${name}" expects${varParam ? ' at least' : ''} ${params.length} argument(s). Missing value for "${params[args.length].name}".`, closing, callRange, node)]
			};
		}
		if (!varParam && args.length > params.length) {
			return {
				value: makeDynamicValue(),
				diagnostics: [await this.diagnosticAt(scope, 'Too many function arguments', `Function "${name}" expects only ${params.length} argument(s).`, this.startRangeOf(scope, args[params.length].written), callRange, node)]
			};
		}
		if (name === 'try' || name === 'can') return this.tolerateTryOrCan(name, args.map(arg => arg.written), node, scope);
		const values: RuntimeValue<ValueType>[] = [];
		for (const [index, arg] of args.entries()) {
			const parameter = parameterAt(definition.signature, index);
			const evaluated = arg.expression ? await this.tolerate(arg.expression, scope) : { value: arg.value!, diagnostics: [] };
			diagnostics.push(...evaluated.diagnostics);
			try {
				if (parameter.type === EXPRESSION_CLOSURE) throw new TypeError(`parameter "${parameter.name}" of ${name} takes an expression`);
				convert(evaluated.value, parameter.type);
			} catch (error) {
				if (!(error instanceof ConversionError)) throw error;
				diagnostics.push(await this.diagnosticAt(scope, 'Invalid function argument', `Invalid value for "${parameter.name}" parameter: ${error.message}.`, this.startRangeOf(scope, arg.written), callRange, arg.written));
			}
			values.push(evaluated.value);
		}
		if (diagnostics.length > 0) return { value: makeDynamicValue(), diagnostics };
		// go-cty calls a function with an unknown argument only where its parameter takes one, and gives an unknown of
		// the function's result type otherwise. An unknown argument without errors arises only where a for expression's
		// `if` clause is checked with its variables unknown, where nothing but the result's nullness and its conversion
		// to a bool is read, so the result is taken to be of no known type.
		if (!values.every(isWhollyKnown)) return { value: makeDynamicValue(), diagnostics };
		try {
			if (name === 'deep_merge' && !this.options.experiments?.includes('deep-merge')) {
				throw new Error('deep_merge requires the deep-merge experiment to be enabled');
			}
			return { value: await this.callBuiltin(name, definition, functionArguments(name, values), scope), diagnostics };
		} catch (error) {
			if (!(error instanceof Error) || isDefect(error) || error instanceof UnresolvedRenderValueError) throw error;
			const startRange = this.startRangeOf(scope, node);
			const argument = /^Invalid function argument; ([\s\S]*)$/u.exec(error.message);
			const diagnostic = argument
				? await this.diagnosticAt(scope, 'Invalid function argument', argument[1], startRange, callRange, node)
				: await this.diagnosticAt(scope, 'Error in function call', `Call to function "${name}" failed: ${error.message}.`, startRange, callRange, node);
			return { value: makeDynamicValue(), diagnostics: [diagnostic] };
		}
	}

	/**
	 * `try` and `can`, as HCL's tryfunc evaluates the expressions they are given: `try` gives the first without errors,
	 * of no known type when it is not wholly known, and fails naming every diagnostic when none has none; `can` gives
	 * whether its expression has no errors, unknown when its value is not wholly known.
	 */
	private async tolerateTryOrCan(name: 'try' | 'can', expressions: TNode[], node: TNode, scope: Scope): Promise<Tolerated> {
		if (name === 'can') {
			const result = await this.tolerate(expressions[0], scope);
			if (result.diagnostics.length > 0) return { value: makeBooleanValue(false), diagnostics: [] };
			return { value: isWhollyKnown(result.value) ? makeBooleanValue(true) : makeUnknownValue(ctyBool), diagnostics: [] };
		}
		const seen: HclDiagnostic[] = [];
		for (const expression of expressions) {
			const result = await this.tolerate(expression, scope);
			seen.push(...result.diagnostics);
			if (result.diagnostics.length > 0) continue;
			return { value: isWhollyKnown(result.value) ? result.value : makeDynamicValue(), diagnostics: [] };
		}
		const failures = seen.map(diagnostic => diagnostic.subject
			? `- ${diagnostic.summary} (at ${rangeString(diagnostic.subject)})\n  ${diagnostic.detail}\n`
			: `- ${diagnostic.summary}\n  ${diagnostic.detail}\n`).join('');
		const detail = expressions.length === 0
			? 'at least one argument is required'
			: `no expression succeeded:\n${failures}At least one expression must produce a successful result`;
		return {
			value: makeDynamicValue(),
			diagnostics: [await this.diagnosticAt(scope, 'Error in function call', `Call to function "${name}" failed: ${detail}.`, this.startRangeOf(scope, node), this.rangeOf(scope, node), node)]
		};
	}

	/**
	 * The root and steps of a reference as HCL traverses them: the root's name, then each attribute or index step,
	 * each with its range, an attribute step's from its `.`, an index step's its brackets.
	 */
	private referenceSteps(node: TNode, scope: Scope): Array<{ name: string; key?: RuntimeValue<ValueType>; range: HclRange }> {
		const start = node.location!.start.offset;
		const parts = this.referenceParts(node);
		const root = parts[0] ?? '';
		const steps: Array<{ name: string; key?: RuntimeValue<ValueType>; range: HclRange }> = [{ name: root, range: this.rangeAt(scope, start, start + root.length) }];
		const segments: TNode[] = [];
		for (const child of node.children ?? []) {
			if (child.type === 'access_chain') segments.push(...(child.children ?? []));
			else if (['dependency_name', 'module_name', 'terraform_attribute', 'provider'].includes(child.type) && child.children?.[0]) segments.push(child.children[0]);
		}
		if (node.type === 'dependency_reference') {
			const name = node.children?.find(child => child.type === 'dependency_name');
			const chain = node.children?.find(child => child.type === 'access_chain');
			segments.length = 0;
			if (name?.children?.[0]) segments.push(name.children[0]);
			segments.push(...(chain?.children ?? []));
		}
		let offset = start + root.length;
		for (const [index, part] of parts.slice(1).entries()) {
			const segment = segments[index];
			const segmentStart = segment?.location?.start.offset ?? scope.content.indexOf(part, offset);
			const segmentEnd = segment?.location?.end.offset ?? segmentStart + part.length;
			offset = segmentEnd;
			if (segment?.type === 'index_identifier') {
				const raw = segment.value;
				const key = typeof raw === 'number' || /^\d+$/u.test(String(raw)) ? makeNumberValue(CtyNumber.parse(String(raw))) : makeStringValue(String(raw));
				steps.push({ name: part, key, range: this.rangeAt(scope, segmentStart, segmentEnd) });
			} else if (/^\d+$/u.test(part)) {
				steps.push({ name: part, key: makeNumberValue(CtyNumber.parse(part)), range: this.rangeAt(scope, segmentStart - 1, segmentEnd) });
			} else {
				steps.push({ name: part, range: this.rangeAt(scope, segmentStart - 1, segmentEnd) });
			}
		}
		return steps;
	}

	/**
	 * A reference as HCL's ScopeTraversalExpr traverses it: the root variable, `local`, `include`, `dependency` or a
	 * for expression's variable, then each step, the first that fails giving a value of no known type and its
	 * diagnostic. Terragrunt has each of `local`, `include` and `dependency` as an object of what is declared, so a
	 * name not declared there is an attribute the object does not have.
	 */
	private async tolerateReference(node: TNode, scope: Scope): Promise<Tolerated> {
		const steps = this.referenceSteps(node, scope);
		const fail = async (index: number, error: HclError): Promise<Tolerated> => ({
			value: makeDynamicValue(),
			diagnostics: [await this.diagnosticAt(scope, error.summary, error.message, steps[index].range)]
		});
		const missing = (index: number): HclError => new HclError(UNSUPPORTED_ATTRIBUTE, `This object does not have an attribute named "${steps[index].name}".`);
		const root = steps[0].name;
		let value: RuntimeValue<ValueType> | undefined;
		let next = 1;
		for (let index = scope.comprehension.length - 1; index >= 0 && value === undefined; index--) {
			value = scope.comprehension[index].get(root);
		}
		if (value === undefined) {
			try {
				if (root === 'local' && steps.length > 1) {
					if (!scope.locals.has(steps[1].name)) return fail(1, missing(1));
					value = await this.resolveLocal(scope, steps[1].name);
					next = 2;
				} else if (root === 'include' && steps.length > 2) {
					const include = scope.includes.get(steps[1].name);
					if (!include?.expose) return fail(1, missing(1));
					const result = include.result;
					const head = steps[2].name;
					next = 3;
					if (head === 'locals' && steps.length > 3) {
						if (!result.scope.locals.has(steps[3].name)) return fail(3, missing(3));
						value = await this.resolveLocal(result.scope, steps[3].name);
						next = 4;
					} else if (head === 'inputs') {
						value = result.inputs ? makeObjectValue(result.inputs) : makeNullValue(ctyDynamic);
					} else if (head === 'terraform') {
						value = await this.terraformObject(result.scope);
					} else if (result.scope.rootAttrs.has(head)) {
						value = await this.evalNode(result.scope.rootAttrs.get(head)!, result.scope);
					} else if (head !== 'locals') {
						return fail(2, missing(2));
					}
				} else if (root === 'dependency' && steps.length > 1) {
					try {
						value = await this.dependencyValue(steps[1].name, scope);
					} catch (error) {
						if (error instanceof Error && error.message.startsWith(`No dependency "${steps[1].name}" block`)) return fail(1, missing(1));
						throw error;
					}
					next = 2;
				} else if (!['local', 'include', 'dependency'].includes(root)) {
					return fail(0, new HclError('Unknown variable', `There is no variable named "${root}".`));
				}
				// `local`, `include.<name>` and `include.<name>.locals` read whole, as tghclp reads them strictly.
				value ??= await this.resolveReference(steps.map(step => step.name).slice(0, next), scope);
			} catch (error) {
				return { value: makeDynamicValue(), diagnostics: [await this.faultDiagnostic(error, scope, node)] };
			}
		}
		if (value === undefined) throw new TypeError(`the reference ${steps.map(step => step.name).join('.')} resolved to nothing`);
		for (let index = next; index < steps.length; index++) {
			const step = steps[index];
			try {
				value = step.key === undefined ? attributeValue(value, step.name) : indexValue(value, step.key);
			} catch (error) {
				if (!(error instanceof HclError)) throw error;
				return fail(index, error);
			}
		}
		return { value, diagnostics: [] };
	}

	/**
	 * `!`, `&&` or `||`, as HCL evaluates them. Each operand must convert to a bool, an operand of `&&` or `||` even
	 * where the other decides. Both operands of `&&` and `||` are evaluated, and one that decides the result drops
	 * what the other threw, a value not known yet or a fault.
	 *
	 * @param node the logical expression.
	 * @param scope the scope of the file it is written in.
	 * @returns its value.
	 */
	private async evalLogical(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const operator = node.value === undefined ? '' : String(node.value);
		const [first, second] = node.children ?? [];
		if (operator === '!') {
			const value = computable(await this.evalNode(first, scope));
			const truth = this.atNode(first, scope, () => operandBool(value, 'unary'));
			if (truth === null) throw new Error(NULL_OPERAND);
			return makeBooleanValue(!truth);
		}
		if (operator !== '&&' && operator !== '||') throw new Error(`Unknown logical operator "${operator}"`);
		const operands: LogicalOperand[] = [];
		const invalid: LocatedEvaluationError[] = [];
		for (const [operandNode, side] of [[first, 'left'], [second, 'right']] as const) {
			let value: RuntimeValue<ValueType>;
			try {
				value = computable(await this.evalNode(operandNode, scope));
			} catch (error) {
				if (error instanceof Error && isDefect(error)) throw error;
				operands.push({ error });
				continue;
			}
			try {
				operands.push(this.atNode(operandNode, scope, () => operandBool(value, side)));
			} catch (error) {
				if (!(error instanceof LocatedEvaluationError)) throw error;
				invalid.push(error);
				operands.push(null);
			}
		}
		if (invalid.length > 0) {
			const [firstInvalid, ...rest] = invalid;
			firstInvalid.further.push(...rest);
			throw firstInvalid;
		}
		return makeBooleanValue(logicalOperation(operator, operands[0], operands[1]));
	}

	/**
	 * Evaluates every operand of an expression. One that cannot be known yet does not stop the rest, so a fault
	 * beside it, such as `local.nope` in `"${dependency.x.outputs.y}-${local.nope}"`, is still found.
	 *
	 * @param nodes the operands, in the order they are written.
	 * @param scope the scope of the file they are written in.
	 * @param concurrent evaluate them at once, as a list's elements are, rather than in order.
	 * @returns their values.
	 * @throws the first fault among them, else the first value that cannot be known yet.
	 */
	private async evalOperands(nodes: (TNode | undefined)[], scope: Scope, concurrent = false): Promise<RuntimeValue<ValueType>[]> {
		return this.settleOperands(nodes.map(node => () => this.evalNode(node, scope)), concurrent);
	}

	/**
	 * Runs every step, carrying on past one that cannot be known yet and stopping at the first fault.
	 *
	 * @param steps the steps, in the order they are written.
	 * @param concurrent run them at once rather than in order.
	 * @returns their results.
	 * @throws the first fault among them, else the first value that cannot be known yet.
	 */
	private async settleOperands<T>(steps: (() => Promise<T>)[], concurrent = false): Promise<T[]> {
		const values: T[] = [];
		let unresolved: UnresolvedRenderValueError | undefined;
		const settle = (error: unknown) => {
			if (!(error instanceof UnresolvedRenderValueError)) throw error;
			unresolved ??= error;
		};
		if (concurrent) {
			for (const result of await Promise.allSettled(steps.map(step => step()))) {
				if (result.status === 'fulfilled') values.push(result.value);
				else settle(result.reason);
			}
		} else {
			for (const step of steps) {
				try {
					values.push(await step());
				} catch (error) {
					settle(error);
				}
			}
		}
		if (unresolved) throw unresolved;
		return values;
	}

	private async evalExpression(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		switch (node.type) {
			case 'string_lit':
				return makeStringValue(String(node.value ?? ''));
			case 'number_lit':
				return makeNumberValue(numberLiteral(node));
			case 'boolean_lit':
				return makeBooleanValue(Boolean(node.value));
			case 'null_lit':
				return makeNullValue(ctyDynamic);
			case 'array_lit':
				return makeArrayValue(await this.evalOperands(node.children ?? [], scope, true));
			case 'object':
				return this.evalObject(node, scope);
			case 'interpolated_string':
				return this.evalInterpolatedString(node, scope);
			case 'interpolation':
				return this.evalNode(node.children?.[0], scope);
			case 'if_directive':
				return this.evalTemplateIf(node, scope);
			case 'for_directive':
				return this.evalTemplateFor(node, scope);
			case 'ternary_expression':
				return this.evalConditional(node, scope);
			case 'logical_expression':
				return this.evalLogical(node, scope);
			case 'comparison_expression':
				return this.evalComparison(node, scope);
			case 'arithmetic_expression':
				return this.evalArithmetic(node, scope);
			case 'null_coalescing': {
				const left = await this.evalNode(node.children?.[0], scope);
				return left.type === 'null' ? this.evalNode(node.children?.[1], scope) : left;
			}
			case 'member_access': {
				const member = String(node.children?.[1]?.value ?? '');
				return this.traverse(await this.evalNode(node.children?.[0], scope), member.split('.'));
			}
			case 'index_expression': {
				const [collection, index] = await this.evalOperands([node.children?.[0], node.children?.[1]], scope);
				return indexValue(collection, computable(index));
			}
			case 'range_expression': {
				const [start, end] = (await this.evalOperands([node.children?.[0], node.children?.[1]], scope)).map(computable);
				if (start.type !== 'number' || end.type !== 'number') throw new Error('range requires number arguments');
				const items: RuntimeValue<ValueType>[] = [];
				const one = CtyNumber.fromInt64(1);
				const limit = end.value as CtyNumber;
				for (let value = start.value as CtyNumber; value.compare(limit) < 0; value = value.add(one)) items.push(makeNumberValue(value));
				return makeArrayValue(items);
			}
			case 'list_comprehension':
				return this.evalListComprehension(node, scope);
			case 'map_comprehension':
				return this.evalMapComprehension(node, scope);
			case 'splat_expression':
				return this.evalSplat(node, scope);
			case 'function_call':
				return this.evalFunctionCall(node, scope);
			case 'reference':
			case 'local_reference':
			case 'terraform_reference':
			case 'var_reference':
			case 'data_reference':
			case 'module_reference':
			case 'dependency_reference':
			case 'path_reference':
				return this.resolveReference(this.referenceParts(node), scope);
			case 'traversal_reference':
				return this.resolveReference([String(node.value ?? '')], scope);
			case 'for_expression': {
				const [identifier, collection, body] = node.children ?? [];
				const items = await this.evalNode(collection, scope);
				const results: RuntimeValue<ValueType>[] = [];
				for (const [, item] of this.atNode(collection, scope, () => forElements(unwrapSensitive(items)))) {
					const frame = new Map<string, RuntimeValue<ValueType>>();
					frame.set(String(identifier?.value ?? ''), item);
					scope.comprehension.push(frame);
					try {
						results.push(await this.evalNode(body, scope));
					} finally {
						scope.comprehension.pop();
					}
				}
				return makeArrayValue(results);
			}
			default:
				throw new Error(`Cannot evaluate expression of type ${node.type}`);
		}
	}

	private referenceParts(node: TNode): string[] {
		if (node.type === 'dependency_reference') {
			const dependencyName = node.children?.find(child => child.type === 'dependency_name')?.value;
			const chain = node.children?.find(child => child.type === 'access_chain');
			return [
				'dependency',
				String(dependencyName ?? ''),
				...(chain?.children ?? []).map(segment => String(segment.value ?? ''))
			];
		}
		const parts: string[] = [];
		let hasNamespace = false;
		for (const child of node.children ?? []) {
			if (child.type === 'namespace') {
				parts.push(String(child.value ?? ''));
				hasNamespace = true;
			}
		}
		if (!hasNamespace && node.value !== undefined && node.value !== null) parts.push(String(node.value));
		for (const child of node.children ?? []) {
			if (child.type === 'dependency_name' || child.type === 'module_name' || child.type === 'terraform_attribute' || child.type === 'path_attribute') {
				parts.push(String(child.value ?? ''));
			} else if (child.type === 'provider') {
				parts.push(String(child.value ?? ''));
			} else if (child.type === 'access_chain') {
				for (const segment of child.children ?? []) parts.push(String(segment.value ?? ''));
			}
		}
		return parts;
	}

	private async evalObject(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		type Entry = { key: string; value: RuntimeValue<ValueType>; inherited: boolean };
		const members = await this.settleOperands((node.children ?? []).flatMap((child): (() => Promise<Entry[]>)[] => {
			if (child.type === 'attribute') {
				return [async () => {
					const keyNode = child.children?.find(c => c.type === 'object_key');
					const valueNode = child.children?.find(c => c.type !== 'attribute_identifier' && c.type !== 'object_key');
					if (!keyNode) return [{ key: String(child.value), value: await this.evalNode(valueNode, scope), inherited: false }];
					const [key, value] = await this.evalOperands([keyNode.children?.[0], valueNode], scope);
					const keyValue = computable(key);
					return [{ key: this.atNode(keyNode.children?.[0], scope, () => objectKey(keyValue)), value, inherited: false }];
				}];
			}
			if (child.type === 'inheritance') {
				return [async () => {
					const source = await this.evalNode(child.children?.[0], scope);
					if (source.type !== 'object' && source.type !== 'block') throw new Error('inherit requires an object source');
					return [...(source.value as Map<string, RuntimeValue<ValueType>>)].map(([key, value]) => ({ key, value, inherited: true }));
				}];
			}
			return [];
		}));
		const map = new Map<string, RuntimeValue<ValueType>>();
		for (const { key, value, inherited } of members.flat()) {
			if (!inherited || !map.has(key)) map.set(key, value);
		}
		return makeObjectValue(map);
	}

	/**
	 * Evaluates a quoted string or heredoc holding a template sequence as HCL does. One that is a single interpolation
	 * and nothing else gives that interpolation's value as it is, of whatever type, as HCL's TemplateWrapExpr does;
	 * any other is rendered to a string. A literal a strip marker emptied is still a part, as it is to HCL.
	 *
	 * @param node the interpolated string.
	 * @param scope the scope of the file it is written in.
	 * @returns its value.
	 */
	private async evalInterpolatedString(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const children = node.children ?? [];
		if (children.length === 1 && children[0].type === 'interpolation') return this.evalNode(children[0], scope);
		return this.renderTemplate(node, scope);
	}

	/**
	 * Renders a template to a string as HCL's TemplateExpr does, each interpolation's value converted as
	 * {@link templatePart} converts it, even where the template is one interpolation: a directive's branch or loop is
	 * a template of its own that HCL never passes through.
	 *
	 * @param node the template: an interpolated string, or a string literal for one with no sequence in it.
	 * @param scope the scope of the file it is written in.
	 * @returns the rendered string, sensitive when any part is.
	 * @throws Error where a value is written that does not convert, in HCL's words.
	 */
	private async renderTemplate(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		if (node.type === 'string_lit') return makeStringValue(String(node.value ?? ''));
		if (node.type !== 'interpolated_string') throw new Error(`A template cannot be a ${node.type}`);
		const parts = await this.settleOperands((node.children ?? []).map(child => {
			if (child.type === 'string_lit') return async () => ({ text: String(child.value ?? ''), sensitive: false });
			if (child.type === 'interpolation' || child.type === 'if_directive' || child.type === 'for_directive') {
				return async () => {
					const value = computable(await this.evalNode(child, scope));
					return this.atNode(child.type === 'interpolation' ? child.children?.[0] : child, scope, () => templatePart(value));
				};
			}
			throw new Error(`A template cannot hold a ${child.type}`);
		}));
		const rendered = makeStringValue(parts.map(part => part.text).join(''));
		return parts.some(part => part.sensitive) ? makeSensitiveValue(rendered) : rendered;
	}

	/**
	 * Evaluates a template's `%{ if }` as HCL evaluates the conditional it lowers one to: the condition converts to a
	 * bool as any condition does, and the template of the branch it takes is rendered.
	 *
	 * @param node the if_directive: its condition, and the template of each branch.
	 * @param scope the scope of the file it is written in.
	 * @returns the rendered branch.
	 */
	private async evalTemplateIf(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const [condition, whenTrue, whenFalse] = node.children ?? [];
		const value = computable(await this.evalNode(condition, scope));
		const truth = this.atNode(condition, scope, () => conditionValue(value));
		return this.renderTemplate(truth ? whenTrue : whenFalse, scope);
	}

	/**
	 * Evaluates a template's `%{ for }` as HCL evaluates the for expression it lowers one to, joined: the template it
	 * repeats is rendered for each element of the collection in the collection's order, with the value variable
	 * bound to the element and the key variable to its index or key, and the renderings are concatenated.
	 *
	 * @param node the for_directive: its key variable if it has one, its value variable, the collection and the
	 *   template it repeats.
	 * @param scope the scope of the file it is written in.
	 * @returns the concatenated renderings, sensitive when the collection or any rendering is.
	 * @throws Error at the collection when it is null or cannot be iterated, in HCL's words.
	 */
	private async evalTemplateFor(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const children = node.children ?? [];
		const variables = children.slice(0, children.length - 2);
		const [collection, template] = children.slice(variables.length);
		const marked = computable(await this.evalNode(collection, scope));
		const collectionValue = unwrapSensitive(marked);
		const items = this.atNode(collection, scope, () => forElements(collectionValue));
		let rendered = '';
		let sensitive = marked !== collectionValue;
		for (const [key, item] of items) {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			if (variables.length === 2) frame.set(String(variables[0].value ?? ''), key);
			frame.set(String(variables[variables.length - 1].value ?? ''), item);
			scope.comprehension.push(frame);
			try {
				const repeated = await this.renderTemplate(template, scope);
				const text = unwrapSensitive(repeated);
				rendered += String(text.value);
				sensitive ||= text !== repeated;
			} finally {
				scope.comprehension.pop();
			}
		}
		return sensitive ? makeSensitiveValue(makeStringValue(rendered)) : makeStringValue(rendered);
	}

	/**
	 * `condition ? whenTrue : whenFalse` as HCL evaluates it: both branches first, then the result's type from theirs,
	 * then the condition, and the chosen branch converted to that type. A fault in the branch not chosen is dropped.
	 *
	 * @param node the ternary expression: its condition and two branches.
	 * @param scope the scope of the file it is written in.
	 * @returns the chosen branch's value.
	 */
	private async evalConditional(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const [conditionNode, whenTrue, whenFalse] = node.children ?? [];
		const settle = async (evaluate: () => Promise<RuntimeValue<ValueType>>): Promise<ConditionalBranch> => {
			try {
				return { value: await evaluate() };
			} catch (error) {
				if (error instanceof Error && isDefect(error)) throw error;
				return { error };
			}
		};
		const trueBranch = await settle(() => this.evalNode(whenTrue, scope));
		const falseBranch = await settle(() => this.evalNode(whenFalse, scope));
		const condition = await settle(async () => computable(await this.evalNode(conditionNode, scope)));
		return conditionalResult(trueBranch, falseBranch, () => {
			if ('error' in condition) throw condition.error;
			return { truth: this.atNode(conditionNode, scope, () => conditionValue(condition.value)), value: condition.value };
		});
	}

	private async evalComparison(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const [left, right] = (await this.evalOperands([node.children?.[0], node.children?.[1]], scope)).map(computable);
		return comparison(node.value === undefined ? '' : String(node.value), left, right);
	}

	private async evalArithmetic(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const operator = node.value === undefined ? '' : String(node.value);
		if (operator === '-' && (node.children?.length ?? 0) === 1) {
			return negation(computable(await this.evalNode(node.children?.[0], scope)));
		}
		const [left, right] = (await this.evalOperands([node.children?.[0], node.children?.[1]], scope)).map(computable);
		return arithmetic(operator, left, right);
	}

	/**
	 * Evaluates `[for … in … : … if …]`.
	 *
	 * @param node the list_comprehension node.
	 * @param scope the scope the comprehension is written in.
	 * @returns the body's value for each element that passes the condition, in order.
	 */
	private async evalListComprehension(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const results: RuntimeValue<ValueType>[] = [];
		await this.forEachComprehensionElement(node, 1, scope, async ([expr]) => {
			results.push(await this.evalNode(expr, scope));
		});
		return makeArrayValue(results);
	}

	/**
	 * Evaluates `{for … in … : key => value if …}`, and its `...` grouping form.
	 *
	 * @param node the map_comprehension node, whose value is `...` when it groups.
	 * @param scope the scope the comprehension is written in.
	 * @returns an object of the produced keys; with grouping, each key holds a list of its values in order.
	 * @throws Error when two elements produce the same key and the comprehension does not group.
	 */
	private async evalMapComprehension(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const grouping = node.value === '...';
		const map = new Map<string, RuntimeValue<ValueType>>();
		const groups = new Map<string, RuntimeValue<ValueType>[]>();
		await this.forEachComprehensionElement(node, 2, scope, async ([keyNode, valueNode]) => {
			const keyValue = computable(await this.evalNode(keyNode, scope));
			const key = this.atNode(keyNode, scope, () => forKey(keyValue));
			const value = await this.evalNode(valueNode, scope);
			if (grouping) {
				const group = groups.get(key) ?? [];
				group.push(value);
				groups.set(key, group);
			} else {
				if (map.has(key)) {
					throw new Error(`Two different items produced the key "${key}" in this 'for' expression. If duplicates are expected, use the ellipsis (...) after the value expression to enable grouping by key.`);
				}
				map.set(key, value);
			}
		});
		if (grouping) for (const [key, group] of groups) map.set(key, makeArrayValue(group));
		return makeObjectValue(map);
	}

	/**
	 * Binds a comprehension's variables to each element of its collection in turn, and runs `each` for the elements
	 * that pass its `if` condition. With two variables, the first is the element's index in a list or its key in an
	 * object, and the second its value; with one, it is the value.
	 *
	 * @param node a list_comprehension or map_comprehension node: its variables, the collection, the body expressions,
	 *   then the condition if there is one.
	 * @param bodyLength how many body expressions follow the collection: 1 for a list, 2 for a map's key and value.
	 * @param scope the scope the comprehension is written in.
	 * @param each called with the body expressions while the element's variables are in scope.
	 */
	private async forEachComprehensionElement(
		node: TNode,
		bodyLength: number,
		scope: Scope,
		each: (body: TNode[]) => Promise<void>
	): Promise<void> {
		const children = node.children ?? [];
		const variables = children[1]?.type === 'identifier' ? children.slice(0, 2) : children.slice(0, 1);
		const [collection, ...rest] = children.slice(variables.length);
		const body = rest.slice(0, bodyLength);
		const condition = rest[bodyLength];
		const collectionValue = await this.evalNode(collection, scope);
		for (const [key, item] of this.atNode(collection, scope, () => forElements(unwrapSensitive(collectionValue)))) {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			if (variables.length === 2) frame.set(String(variables[0].value ?? ''), key);
			frame.set(String(variables[variables.length - 1].value ?? ''), item);
			scope.comprehension.push(frame);
			try {
				if (condition) {
					const conditionValue = computable(await this.evalNode(condition, scope));
					if (!this.atNode(condition, scope, () => forCondition(conditionValue))) continue;
				}
				await each(body);
			} finally {
				scope.comprehension.pop();
			}
		}
	}

	private async evalSplat(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const base = await this.evalNode(node.children?.[0], scope);
		const attribute = node.children?.[1] ? String(node.children[1].value ?? '') : null;
		if (attribute === null) return splatResult(base, element => element, type => type);
		return splatResult(base, element => attributeValue(element, attribute), type => attributeType(type, attribute));
	}

	private async evalFunctionCall(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const name = String(node.value ?? '');

		// Inline functions resolve before built-ins. A name may not be both:
		// definition-time shadow checking rejects that, so the order below can
		// never mask a built-in.
		// An inline function computes from its arguments in a body this evaluator does not see into, so it is given no
		// value sops left encrypted.
		const inline = this.findInlineFunction(scope, name);
		if (inline) {
			const args = await this.evalCallArguments(await this.callArguments(node, scope), scope);
			return this.callInlineFunction(inline, args.map(computable));
		}

		const definition = this.schema.getFunctionDefinition(name);
		if (!definition) throw new Error(`Unknown function "${name}"`);
		const args = await this.callArguments(node, scope);
		checkArgumentCount(name, definition.signature, args.length);

		if (name === 'can') {
			try {
				await this.evalCallArgument(args[0], scope);
				return makeBooleanValue(true);
			} catch (error) {
				if (error instanceof UnresolvedRenderValueError) throw error;
				return makeBooleanValue(false);
			}
		}

		if (name === 'try') {
			if (args.length === 0) throw new Error('at least one argument is required');
			const failures: string[] = [];
			for (const arg of args) {
				try {
					return await this.evalCallArgument(arg, scope);
				} catch (error) {
					if (error instanceof UnresolvedRenderValueError) throw error;
					failures.push(error instanceof Error ? error.message : String(error));
				}
			}
			throw new Error(`no expression succeeded:\n${failures.map(failure => `- ${failure}\n`).join('')}At least one expression must produce a successful result.`);
		}

		if (name === 'deep_merge' && !this.options.experiments?.includes('deep-merge')) {
			throw new Error('deep_merge requires the deep-merge experiment to be enabled');
		}
		return this.callBuiltin(name, definition, functionArguments(name, await this.evalCallArguments(args, scope)), scope);
	}

	/**
	 * Calls a function Terragrunt defines, its arguments counted already: each converted to its parameter's type, a
	 * null or sensitive argument handled as go-cty handles one for that parameter, as HCL and go-cty call a function.
	 *
	 * @param name the function.
	 * @param definition its definition, with its go-cty parameters.
	 * @param args its evaluated arguments.
	 * @param scope the scope of the file the call is written in.
	 * @returns the function's result, sensitive when an argument it does not take marked was.
	 */
	private async callBuiltin(name: string, definition: BuiltinFunctionDefinition, args: RuntimeValue<ValueType>[], scope: Scope): Promise<RuntimeValue<ValueType>> {
		if (!this.schema.getFunctionRegistry().hasFunction(name)) {
			throw new Error(`Function "${name}" has no evaluator`);
		}
		const prepared = prepareArguments(definition.signature, args);
		const context = await this.makeContext(scope);
		return markResult(await this.schema.getFunctionRegistry().evaluateFunction(name, prepared.args, context), prepared.marked);
	}

	/**
	 * A call's arguments as HCL counts them: the expressions written in it, and, for a final argument expanded with
	 * `...`, each element of the list, set or tuple it evaluates to, carrying the collection's sensitivity.
	 */
	private async callArguments(node: TNode, scope: Scope): Promise<CallArgument[]> {
		const written: CallArgument[] = (node.children ?? [])
			.filter(child => child.type !== 'function_identifier')
			.map(expression => ({ expression }));
		const final = written.at(-1);
		if (!final || !('expression' in final) || final.expression.type !== 'variadic_arguments') return written;

		const collection = await this.evalNode(final.expression.children?.[0], scope);
		const sensitive = (collection.type as string) === 'sensitive';
		const expanded = unwrapSensitive(collection);
		if (expanded.type === 'null') {
			throw new Error('Invalid expanding argument value; The expanding argument (indicated by ...) must not be null.');
		}
		if (expanded.type !== 'array') {
			throw new Error('Invalid expanding argument value; The expanding argument (indicated by ...) must be of a tuple, list, or set type.');
		}
		const elements = (expanded.value as RuntimeValue<ValueType>[])
			.map(value => ({ value: sensitive ? makeSensitiveValue(value) : value }));
		return [...written.slice(0, -1), ...elements];
	}

	private async evalCallArgument(argument: CallArgument, scope: Scope): Promise<RuntimeValue<ValueType>> {
		return 'value' in argument ? argument.value : this.evalNode(argument.expression, scope);
	}

	private async evalCallArguments(args: CallArgument[], scope: Scope): Promise<RuntimeValue<ValueType>[]> {
		return this.settleOperands(args.map(argument => () => this.evalCallArgument(argument, scope)));
	}

	/**
	 * Resolves an inline function visible from `scope`. A file's own definitions
	 * win over inherited ones, matching how child configuration overrides
	 * included configuration elsewhere. Autoincludes are searched before
	 * includes so that the nearer declaration takes precedence.
	 */
	private findInlineFunction(scope: Scope, name: string): InlineFunctionDefinition<Scope> | undefined {
		const own = scope.functions.get(name);
		if (own) return own;

		if (scope.autoinclude) {
			const fromAutoinclude = this.findInlineFunction(scope.autoinclude.scope, name);
			if (fromAutoinclude) return fromAutoinclude;
		}

		for (const include of scope.includes.values()) {
			const inherited = this.findInlineFunction(include.result.scope, name);
			if (inherited) return inherited;
		}

		return undefined;
	}

	/**
	 * Invokes an inline function through the standard operation boundary, so it
	 * is evaluated exactly as a built-in is: arguments serialized into a dry
	 * context, the live evaluation services supplied through a wet context.
	 */
	private async callInlineFunction(
		definition: InlineFunctionDefinition<Scope>,
		args: RuntimeValue<ValueType>[]
	): Promise<RuntimeValue<ValueType>> {
		const depth = this.inlineCallDepth.getStore() ?? 0;
		if (depth >= MAX_INLINE_CALL_DEPTH) {
			throw new InlineFunctionError(
				`Inline function "${definition.name}" exceeded maximum call depth of ${MAX_INLINE_CALL_DEPTH}`
			);
		}

		const operation = FunctionOperation.inline(definition.name, async (dry, wet) => {
			const callArgs = readArgs(dry);
			const context = wet.getRequired<FunctionContext>(FUNCTION_CONTEXT_KEY);
			const bound = await this.bindParameters(definition, callArgs);
			return this.invokeJsBody(definition, bound, context);
		});

		// The context is built from the defining file's scope: an inline function
		// resolves its surroundings lexically, so `tg.local` and relative paths
		// mean the same thing regardless of which file called it.
		const context = await this.makeContext(definition.scope);

		return this.inlineCallDepth.run(depth + 1, async () => {
			const value = await invokeFunctionOperation(operation, args, context);
			if (!value) throw new Error(`Inline function "${definition.name}" returned no value`);
			return value;
		});
	}

	/**
	 * Binds positional call arguments to a function's declared parameters:
	 * applies defaults for absent optionals, collects the tail into a variadic
	 * parameter, and checks every annotated parameter against its declared type.
	 * Arity and type failures are reported here, before the body runs.
	 */
	private async bindParameters(
		definition: InlineFunctionDefinition<Scope>,
		args: RuntimeValue<ValueType>[]
	): Promise<RuntimeValue<ValueType>[]> {
		const parameters = definition.parameters;
		const variadic = parameters.at(-1)?.variadic === true;
		const positional = variadic ? parameters.slice(0, -1) : parameters;
		const required = positional.filter(parameter => parameter.defaultNode === undefined).length;

		if (args.length < required) {
			throw new InlineFunctionError(
				`Inline function "${definition.name}" requires at least ${required} argument${required === 1 ? '' : 's'}, got ${args.length}`
			);
		}
		if (!variadic && args.length > positional.length) {
			throw new InlineFunctionError(
				`Inline function "${definition.name}" accepts at most ${positional.length} argument${positional.length === 1 ? '' : 's'}, got ${args.length}`
			);
		}

		const bound: RuntimeValue<ValueType>[] = [];
		for (const [index, parameter] of positional.entries()) {
			let value = args[index];
			if (value === undefined) {
				if (!parameter.defaultNode) {
					throw new InlineFunctionError(`Inline function "${definition.name}" is missing argument "${parameter.name}"`);
				}
				// Defaults are HCL expressions evaluated in the defining file's
				// scope, so they may reference that file's locals.
				value = await this.evalNode(parameter.defaultNode, definition.scope);
			}
			if (parameter.typeNode) {
				const failure = checkTypeConstraint(
					value,
					readTypeConstraint(parameter.typeNode),
					`Inline function "${definition.name}" argument "${parameter.name}"`
				);
				if (failure) throw new InlineFunctionError(failure);
			}
			bound.push(value);
		}

		if (variadic) {
			const rest = args.slice(positional.length);
			const parameter = parameters.at(-1)!;
			if (parameter.typeNode) {
				const constraint = readTypeConstraint(parameter.typeNode);
				for (const [index, value] of rest.entries()) {
					// The index sits outside the quoted parameter name, matching how
					// checkTypeConstraint renders a path into a structured argument.
					const failure = checkTypeConstraint(
						value,
						constraint,
						`Inline function "${definition.name}" argument "${parameter.name}"[${index}]`
					);
					if (failure) throw new InlineFunctionError(failure);
				}
			}
			bound.push(makeArrayValue(rest));
		}

		return bound;
	}

	/**
	 * Compiles and runs an inline function's JavaScript body. The body is
	 * compiled once per definition and reused; arguments arrive as ordinary
	 * function parameters, so `return` behaves as it does in any function.
	 */
	private async invokeJsBody(
		definition: InlineFunctionDefinition<Scope>,
		args: RuntimeValue<ValueType>[],
		context: FunctionContext
	): Promise<RuntimeValue<ValueType>> {
		if (!definition.compiled) definition.compiled = this.compileJsBody(definition);

		const plainArgs = args.map(value => runtimeToJavaScript(value));
		const binding = await this.makeTgBinding(definition, context);

		let result: unknown;
		try {
			result = await definition.compiled(...plainArgs, binding);
		} catch (error) {
			// A failure raised by a nested inline call already carries its own
			// location; re-wrapping it at every frame would bury the cause under
			// one prefix per level of nesting.
			if (error instanceof InlineFunctionError) throw error;
			throw new InlineFunctionError(
				`Inline function "${definition.name}" (${definition.filePath}:${definition.bodyStart.line}) failed: ` +
				`${error instanceof Error ? error.message : String(error)}`
			);
		}

		try {
			return convertToRuntimeValue(result, `Inline function "${definition.name}" return value`);
		} catch (error) {
			throw new InlineFunctionError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Compiles a body into an async function whose parameters are the declared
	 * parameter names plus the `tg` binding. Compilation failures name the
	 * function and the body's position so a syntax error is actionable.
	 */
	private compileJsBody(definition: InlineFunctionDefinition<Scope>): (...args: unknown[]) => Promise<unknown> {
		const parameterNames = definition.parameters.map(parameter => parameter.name);
		const AsyncFunction = Object.getPrototypeOf(async function () { /* empty */ }).constructor as
			new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;
		try {
			return new AsyncFunction(...parameterNames, TG_BINDING_NAME, definition.source);
		} catch (error) {
			throw new InlineFunctionError(
				`Inline function "${definition.name}" (${definition.filePath}:${definition.bodyStart.line}) ` +
				`has an invalid body: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Resolves the locals of a scope that can be resolved right now, keyed by
	 * name and converted to plain values. Locals already being evaluated are
	 * skipped: see makeTgBinding.
	 */
	private async resolvableLocals(scope: Scope): Promise<Record<string, unknown>> {
		const resolved: Record<string, unknown> = {};
		const activePath = this.localResolutionPath.getStore() ?? [];
		for (const name of scope.locals.keys()) {
			// A function can be called while one of its declaring scope's locals
			// is being resolved. Do not eagerly recurse into that one merely to
			// build the binding; guardedNamespace still fails if the body reads it.
			if (activePath.some(entry => entry.scope === scope && entry.name === name)) continue;
			resolved[name] = runtimeToJavaScript(await this.resolveLocal(scope, name));
		}
		return resolved;
	}

	/**
	 * Builds the `tg` binding a body uses to reach the configuration it was
	 * defined in.
	 *
	 * A local that is still being evaluated is omitted rather than resolved: a
	 * function called from inside a `locals` block runs while that local is
	 * mid-resolution, and resolving it again would trip the cycle detector over a
	 * cycle that does not exist. Reading such a name from a body is a genuine
	 * cycle and is reported as one. Reading a name that does not exist throws, so
	 * a body never proceeds on a silently missing value.
	 */
	private async makeTgBinding(
		definition: InlineFunctionDefinition<Scope>,
		context: FunctionContext
	): Promise<TgBinding> {
		const scope = definition.scope;
		const locals = await this.resolvableLocals(scope);

		const includes: Record<string, unknown> = {};
		for (const [name, include] of scope.includes) {
			if (!include.expose) continue;
			const exposed: Record<string, unknown> = {};
			exposed.locals = guardedNamespace(
				await this.resolvableLocals(include.result.scope),
				localName => `Inline function "${definition.name}" referenced undefined local "${localName}" on include "${name}"`
			);
			if (include.result.inputs) {
				exposed.inputs = runtimeToJavaScript(makeObjectValue(include.result.inputs));
			}
			includes[name] = exposed;
		}

		const terragruntDir = context.terragruntDir ?? scope.dir;
		let repoRoot: string | null;
		try {
			repoRoot = await goRepoRoot(terragruntDir, context.environmentVariables, context.repoRoots);
		} catch (error) {
			if (!(error instanceof RepoRootError)) throw error;
			repoRoot = null;
		}

		return {
			call: async (name: unknown, ...callArgs: unknown[]): Promise<unknown> => {
				if (typeof name !== 'string' || name === '') {
					throw new Error(`tg.call in inline function "${definition.name}" requires a function name`);
				}
				const runtimeArgs = callArgs.map((value, index) =>
					convertToRuntimeValue(value, `tg.call("${name}") argument ${index + 1}`));
				const inline = this.findInlineFunction(scope, name);
				if (inline) {
					return runtimeToJavaScript(await this.callInlineFunction(inline, runtimeArgs));
				}
				if (!this.schema.getFunctionDefinition(name)) {
					throw new Error(`tg.call in inline function "${definition.name}" named unknown function "${name}"`);
				}
				if (!context.evaluateFunction) {
					throw new Error(
						`tg.call is unavailable to inline function "${definition.name}": the evaluation context has no function evaluator`
					);
				}
				return runtimeToJavaScript(await context.evaluateFunction(name, runtimeArgs));
			},
			local: guardedNamespace(locals, name => (
				scope.locals.has(name)
					// Declared but unresolvable here: it is the local whose own
					// evaluation is what called this function.
					? `Inline function "${definition.name}" was called while resolving local "${name}", which it also reads`
					: `Inline function "${definition.name}" referenced undefined local "${name}"`
			)),
			include: guardedNamespace(
				includes,
				name => `Inline function "${definition.name}" referenced unexposed or undefined include "${name}"`
			),
			context: {
				terragruntDir,
				repoRoot,
				workingDirectory: context.workingDirectory,
				environmentVariables: { ...context.environmentVariables }
			}
		};
	}
}

function makeRootScope(filePath: string, content: string, workspaceRoot = path.dirname(filePath)): Scope {
	const ast = parseHclSyntax(content, filePath, filePath);
	return {
		filePath,
		content,
		ast,
		dir: path.dirname(filePath),
		workspaceRoot,
		locals: new Map(),
		localCache: new Map(),
		localPending: new Map(),
		includes: new Map(),
		autoinclude: null,
		rootAttrs: new Map(),
		terraform: new Map(),
		generate: new Map(),
		blocks: [],
		comprehension: [],
		functions: new Map()
	};
}

/**
 * The value of a number literal, read from its text as HCL reads it with go-cty's ParseNumberVal.
 *
 * @throws Error in HCL's words when the text is not a number go-cty can read, and in Terragrunt's when its magnitude is
 *   beyond 1e±4096, which Terragrunt refuses as it parses a configuration.
 */
function numberLiteral(node: TNode): CtyNumber {
	const number = CtyNumber.tryParse(String(node.value));
	if (!number) throw new Error('Invalid number literal: Failed to recognize the value of this number literal.');
	if (!number.withinSupportedRange()) throw new Error(NUMBER_OUT_OF_RANGE);
	return number;
}

/**
 * Refuses inputs Terragrunt cannot convert, as its ParseCtyValueToMap refuses them for every command: first a number
 * whose magnitude is beyond 1e±4096, named by its path in the inputs, and then an infinity, which JSON cannot hold.
 * Attributes are visited in the order of their names, as go-cty walks an object.
 *
 * @param inputs the inputs.
 */
function checkInputNumbers(inputs: Map<string, RuntimeValue<ValueType>>): void {
	let infinite = false;
	const visit = (value: RuntimeValue<ValueType>, path: string): void => {
		const current = unwrapSensitive(value);
		switch (current.type) {
			case 'number': {
				const number = current.value as CtyNumber;
				if (!number.withinSupportedRange()) throw new Error(`${path}: ${NUMBER_OUT_OF_RANGE}`);
				if (number.isInfinite()) infinite = true;
				return;
			}
			case 'array':
				(current.value as RuntimeValue<ValueType>[]).forEach((item, index) => visit(item, `${path}[${index}]`));
				return;
			case 'object':
			case 'block': {
				const map = current.value as Map<string, RuntimeValue<ValueType>>;
				for (const key of [...map.keys()].sort(compareStrings)) visit(map.get(key)!, `${path}.${key}`);
				return;
			}
			default:
				return;
		}
	};
	for (const key of [...inputs.keys()].sort(compareStrings)) visit(inputs.get(key)!, key);
	if (infinite) throw new Error('failed to serialize value: cannot serialize infinity as JSON');
}

/**
 * A file's `dependency` blocks by label. Two blocks with one label in a file are refused, as Terragrunt refuses them,
 * rather than one silently shadowing the other.
 */
function dependencyBlocks(scope: Scope): Map<string, TNode> {
	const blocks = new Map<string, TNode>();
	for (const block of scope.blocks) {
		if (block.value !== 'dependency') continue;
		const label = (block.children ?? []).find(child => child.type === 'parameter');
		if (!label) throw new Error(`A dependency block in ${scope.filePath} has no name`);
		const name = String(label.value);
		if (blocks.has(name)) throw new Error(`dependency "${name}" is declared more than once in ${scope.filePath}`);
		blocks.set(name, block);
	}
	return blocks;
}

/** One `dependency` block as a declaration, its attributes paired with the scope they are written in. */
function dependencyDeclaration(block: TNode, scope: Scope): DependencyDeclaration {
	const attribute = (name: string): DependencyAttribute | undefined => {
		const child = (block.children ?? []).find(entry => entry.type === 'attribute' && String(entry.value) === name);
		const node = child?.children?.find(entry => entry.type !== 'attribute_identifier');
		return node ? { node, scope } : undefined;
	};
	const mockOutputs = attribute('mock_outputs');
	const allowed = attribute('mock_outputs_allowed_terraform_commands');
	return {
		declaredIn: scope.filePath,
		configPath: attribute('config_path'),
		mockOutputs: mockOutputs ? [mockOutputs] : [],
		mockOutputsAllowedTerraformCommands: allowed ? [allowed] : []
	};
}

/** The configuration files Terragrunt looks for in a unit directory, in order. */
const DEFAULT_CONFIG_FILES = ['terragrunt.hcl', 'terragrunt.hcl.json'];

/**
 * The configuration a dependency's `config_path` names: the path itself when it is a file, else the unit
 * configuration in that directory.
 *
 * @throws when the path does not exist, or is a directory without a unit configuration.
 */
async function dependencyTargetConfig(target: string, where: string): Promise<string> {
	let stats: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stats = await fs.stat(target);
	} catch {
		throw new Error(`${where}: config_path ${target} does not exist`);
	}
	if (!stats.isDirectory()) return target;
	for (const name of DEFAULT_CONFIG_FILES) {
		const candidate = path.join(target, name);
		if (await pathExists(candidate)) return candidate;
	}
	throw new Error(`${where}: config_path ${target} has no ${DEFAULT_CONFIG_FILES.join(' or ')}`);
}

/**
 * A scope for a file known only by its syntax: its blocks and its locals, resolved on demand, without its includes,
 * inputs or inline functions. Enough to evaluate an expression that reads the file's locals and the unit's
 * directory -- an include path, or a dependency block's attributes in a merged file not yet evaluated.
 */
function structuralScope(filePath: string, content: string, ast: TNode, workspaceRoot: string, unitDir: string): Scope {
	const scope: Scope = {
		filePath,
		content,
		ast,
		dir: path.dirname(filePath),
		unitDir,
		workspaceRoot,
		locals: new Map(),
		localCache: new Map(),
		localPending: new Map(),
		includes: new Map(),
		autoinclude: null,
		rootAttrs: new Map(),
		terraform: new Map(),
		generate: new Map(),
		blocks: (ast.children ?? []).filter(child => child.type === 'block'),
		comprehension: [],
		functions: new Map()
	};
	for (const block of scope.blocks) {
		if (block.value !== 'locals') continue;
		for (const child of block.children ?? []) {
			if (child.type !== 'attribute') continue;
			const valueNode = child.children?.find(entry => entry.type !== 'attribute_identifier');
			if (valueNode) scope.locals.set(String(child.value), valueNode);
		}
	}
	return scope;
}

function deepMergeInputs(child: Map<string, RuntimeValue<ValueType>>, parent: Map<string, RuntimeValue<ValueType>>): Map<string, RuntimeValue<ValueType>> {
	const out = new Map(parent);
	for (const [key, childValue] of child) {
		const parentValue = out.get(key);
		if (parentValue && isObjectValue(parentValue) && isObjectValue(childValue)) {
			out.set(key, makeObjectValue(deepMergeInputs(
				childValue.value as Map<string, RuntimeValue<ValueType>>,
				parentValue.value as Map<string, RuntimeValue<ValueType>>
			)));
		} else {
			out.set(key, childValue);
		}
	}
	return out;
}

/**
 * A configuration's scope and the scopes of every configuration it includes or autoincludes, at any depth.
 *
 * @param scope the configuration's scope.
 * @returns the scopes, the configuration's own first.
 */
function configurationScopes(scope: Scope): Scope[] {
	return [
		scope,
		...[...scope.includes.values()].flatMap(include => configurationScopes(include.result.scope)),
		...(scope.autoinclude ? configurationScopes(scope.autoinclude.scope) : [])
	];
}

function isObjectValue(value: RuntimeValue<ValueType>): boolean {
	return value.type === 'object' || value.type === 'block';
}

/**
 * Built-in functions that give back, as they are, the values sops left encrypted that they are given. The decoders
 * read an encrypted document and mark each value in it as still encrypted; the rest only select from or combine
 * collections, so an encrypted value in their result is one they were given. They may not take an encrypted value as
 * a key, index or other plain argument. Every other function computes from its arguments.
 */
const ENCRYPTED_DOCUMENT_DECODERS = new Set(['yamldecode', 'jsondecode']);
const COLLECTION_SELECTORS = new Set(['merge', 'lookup', 'element', 'concat', 'flatten', 'values', 'tolist', 'tomap']);

/**
 * Whether a value is, or holds, one read as written from a sops file that could not be decrypted.
 *
 * @param value the value.
 * @returns true when it or anything in it is still encrypted.
 */
function holdsEncrypted(value: RuntimeValue<ValueType>): boolean {
	if (value.encrypted) return true;
	switch (value.type) {
		case 'array':
			return (value.value as RuntimeValue<ValueType>[]).some(holdsEncrypted);
		case 'object':
		case 'block':
			return [...(value.value as Map<string, RuntimeValue<ValueType>>).values()].some(holdsEncrypted);
		default:
			return (value.type as string) === 'sensitive' && holdsEncrypted(value.value as RuntimeValue<ValueType>);
	}
}

/**
 * A value an expression is about to compute from.
 *
 * @param value the operand.
 * @returns the operand, when nothing in it is still encrypted.
 * @throws EncryptedSopsValueError when it is, or holds, a value sops left encrypted: what is computed from it is not
 *   known.
 */
function computable(value: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	if (holdsEncrypted(value)) throw new EncryptedSopsValueError();
	return value;
}

/**
 * The arguments of a built-in function, checked against what it does with a value sops left encrypted.
 *
 * @param name the function.
 * @param args its evaluated arguments.
 * @returns the arguments.
 * @throws EncryptedSopsValueError when the function would compute from an encrypted value: any function given one
 *   other than the decoders, and a selector given one as a plain argument rather than inside a collection.
 */
/** An argument of a function call: an expression written in it, or an element of its expanded final argument. */
type CallArgument = { expression: TNode } | { value: RuntimeValue<ValueType> };

/**
 * Refuses a call whose argument count go-cty's parameters do not allow, as HCL does before it evaluates any argument.
 *
 * @param name the function.
 * @param signature its go-cty parameters.
 * @param count the call's arguments, an expanded final argument counted as its elements.
 * @throws when there are fewer arguments than parameters, or more and no variadic parameter takes them.
 */
function checkArgumentCount(name: string, signature: FunctionSignature, count: number): void {
	const { params, varParam } = signature;
	if (count < params.length) {
		throw new Error(
			`Not enough function arguments; Function "${name}" expects${varParam ? ' at least' : ''} ${params.length} argument(s). `
			+ `Missing value for "${params[count].name}".`
		);
	}
	if (!varParam && count > params.length) {
		throw new Error(`Too many function arguments; Function "${name}" expects only ${params.length} argument(s).`);
	}
}

function functionArguments(name: string, args: RuntimeValue<ValueType>[]): RuntimeValue<ValueType>[] {
	if (ENCRYPTED_DOCUMENT_DECODERS.has(name)) return args;
	if (COLLECTION_SELECTORS.has(name)) {
		for (const arg of args) {
			if (arg.type !== 'array' && !isObjectValue(arg)) computable(arg);
		}
		return args;
	}
	return args.map(computable);
}

/**
 * A value as Terragrunt carries it through JSON, as it does an included file's locals and inputs: its lists, sets and
 * maps become tuples and objects, and its sensitivity is dropped. A value sops left encrypted stays as it was read.
 */
function throughJsonValue(value: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	if (holdsEncrypted(value)) return value;
	return convertToRuntimeValue(throughJson(runtimeValueToPlain(value)));
}

/** What stands in for a value sops stored encrypted wherever a plain form of it is shown. */
export const ENCRYPTED_VALUE = '(encrypted)';

/**
 * A value in plain JavaScript: strings, booleans, null, arrays and records, and each number a {@link CtyNumber},
 * which JSON.stringify writes as its exact decimal text. A sensitive value is the value it holds.
 */
export function runtimeValueToPlain(value: RuntimeValue<ValueType>): unknown {
	switch (value.type) {
		case 'string':
			return value.encrypted ? ENCRYPTED_VALUE : value.value;
		case 'number':
		case 'boolean':
			return value.value;
		case 'null':
			return null;
		case 'unknown':
			// Unknowns are settled where a tolerant evaluation hands its value on, as Terragrunt settles them.
			throw new TypeError('an unknown value was not settled before it was read');
		case 'sensitive' as ValueType:
			// Sensitivity marks how a value is shown, not what it is: Terragrunt unmarks what it decodes and renders.
			return runtimeValueToPlain(value.value as RuntimeValue<ValueType>);
		case 'array':
			return (value.value as RuntimeValue<ValueType>[]).map(runtimeValueToPlain);
		case 'object':
		case 'block': {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of (value.value as Map<string, RuntimeValue<ValueType>>).entries()) {
				out[key] = runtimeValueToPlain(entry);
			}
			return out;
		}
		default:
			return null;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/** The node types a reference is, which HCL reads as a traversal from a root variable. */
const REFERENCE_TYPES = new Set([
	'reference', 'local_reference', 'terraform_reference', 'var_reference', 'data_reference', 'module_reference',
	'dependency_reference', 'path_reference', 'traversal_reference'
]);

/**
 * The references an expression reads, as HCL's Variables gives its traversals: a for expression's variables are its
 * own, and a reference to one inside it is not among them.
 *
 * @param expression the expression.
 * @returns the references, in the order they are written.
 */
function referencesIn(expression: TNode): TNode[] {
	const found: TNode[] = [];
	const walk = (node: TNode, bound: ReadonlySet<string>): void => {
		if (REFERENCE_TYPES.has(node.type)) {
			const root = node.type === 'dependency_reference' ? 'dependency'
				: node.type === 'traversal_reference' ? String(node.value ?? '')
				: String(node.children?.find(child => child.type === 'namespace')?.value ?? node.value ?? '');
			if (!bound.has(root)) found.push(node);
			return;
		}
		let inner = bound;
		if (['list_comprehension', 'map_comprehension', 'for_expression', 'for_directive'].includes(node.type)) {
			const children = node.children ?? [];
			const variables = node.type === 'for_directive' ? children.slice(0, children.length - 2)
				: node.type === 'for_expression' ? children.slice(0, 1)
				: children[1]?.type === 'identifier' ? children.slice(0, 2) : children.slice(0, 1);
			inner = new Set([...bound, ...variables.map(variable => String(variable.value ?? ''))]);
			// The collection is read in the scope around the for expression.
			const collection = children[variables.length];
			if (collection) walk(collection, bound);
			for (const child of children.slice(variables.length + 1)) walk(child, inner);
			return;
		}
		for (const child of node.children ?? []) walk(child, inner);
	};
	walk(expression, new Set());
	return found;
}

/**
 * The top-level block a position of a file is in, as HCL's ContextString names it: its type, then each label quoted
 * as Go quotes it; undefined outside every block.
 *
 * @param ast the file's syntax tree.
 * @param offset the position.
 */
function topLevelBlockName(ast: TNode, offset: number): string | undefined {
	const block = (ast.children ?? []).find(child => child.type === 'block' && child.location
		&& offset >= child.location.start.offset && offset < child.location.end.offset);
	if (!block) return undefined;
	const labels = (block.children ?? []).filter(child => child.type === 'parameter').map(child => goQuoted(String(child.value)));
	return [String(block.value), ...labels].join(' ');
}

/**
 * A function's name close to one that is not a function, as HCL's nameSuggestion offers it: one whose Levenshtein
 * distance from the name is less than three. HCL goes through its function table in Go's map order, so where several
 * are that close the one it offers varies; this offers the first in byte order.
 *
 * @param name the name called.
 * @param names the functions there are.
 */
function functionNameSuggestion(name: string, names: readonly string[]): string | undefined {
	const distance = (left: string, right: string): number => {
		const a = [...left];
		const b = [...right];
		let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
		for (let i = 1; i <= a.length; i++) {
			const current = [i];
			for (let j = 1; j <= b.length; j++) {
				current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			}
			previous = current;
		}
		return previous[b.length];
	};
	return [...names].sort(compareStrings).find(candidate => distance(name, candidate) < 3);
}
