import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CtyNumber, NUMBER_OUT_OF_RANGE } from './cty-number';
import { arithmetic, comparison, negation, sequencePosition } from './cty-operations';
import { FunctionOperation, invokeFunctionOperation, readArgs, FUNCTION_CONTEXT_KEY } from './function-ops';
import type { InlineFunctionDefinition } from './inline-functions';
import { checkTypeConstraint, readInlineFunction, readTypeConstraint, synthesizeDefinition } from './inline-functions';
import { parseHclSyntax } from './syntax';
import { Schema } from './Schema';
import { encryptedSopsDocument } from './sops';
import { goRepoRoot, RepoRootError } from './functions/git_repo_root';
import type { FunctionArity, FunctionContext, FunctionDefinition, RuntimeValue, ValueType } from './model';
import {
	coerceToString,
	compareStrings,
	conditionValue,
	convertToBool,
	type LogicalOperand,
	logicalOperation,
	NULL_OPERAND,
	operandBool,
	convertToRuntimeValue,
	makeArrayValue,
	makeBooleanValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeSensitiveValue,
	makeStringValue,
	runtimeToJavaScript,
	templatePart,
	unwrapSensitive
} from './functions/utils';
import { decodeConfigFile, dependencyAddress, mergeDeep, mergeShallow, terragruntConfigAsCty, UNRESOLVED } from './terragrunt-config';
import type { ConfigBlock, ConfigBody, Plain, TerragruntConfig } from './terragrunt-config';
import {
	conflictingMetaArgumentsMessage,
	countElements,
	dependencyLabelCollisionMessage,
	DUPLICATE_DEPENDENCY_WARNING,
	duplicateDependencyConfigPathMessage,
	duplicateDependencyMessage,
	duplicateExpansionBlockMessage,
	EXPANSION_BLOCK,
	forEachElements,
	hclRange,
	type InstanceKey,
	instanceAddress,
	instanceKeyText,
	type MetaArgument,
	misspelledExpansionBlock,
	misspelledExpansionBlockMessage,
	missingMetaArgumentMessage,
	nameSuggestion
} from './expansion';
import { scanHclTokens } from './hcl-scanner';
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
	/**
	 * The strict controls enabled, by name, each turning what Terragrunt only warns about into an error: two
	 * `dependency` blocks claiming one address or one `config_path` under `duplicate-dependency-labels`.
	 */
	strictControls?: readonly string[];
	/** Where a warning Terragrunt logs goes, each once per evaluator; warnings are dropped when it is not set. */
	warn?: (message: string) => void;
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
	/**
	 * The dependency's address, which messages name it by: the block's label, which `dependency.<name>` reads, and for
	 * one element of an expanded block its key, as `name[key]`.
	 */
	name: string;
	/** Absolute path of the unit the dependency belongs to. */
	unitPath: string;
	/** Absolute path of the file whose block decided the dependency, as messages name it. */
	declaredIn: string;
	/**
	 * Where its outputs are read: the configuration `config_path` names, resolved against the unit's directory, and
	 * the directory it is in. Absent for a dependency whose outputs are not read, one disabled or skipping its outputs,
	 * whose `config_path` need not exist.
	 */
	target?: { configPath: string; dir: string };
	/** The block's `enabled`: a disabled dependency reads nothing and gives its mocks. */
	enabled: boolean;
	/** The block's `skip_outputs`: its outputs are never read, and it gives its mocks where the command may see them. */
	skipOutputs: boolean;
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
 * The outputs of an element of an expanded dependency that cannot be known yet: reading one is unresolved, as reading
 * an unexpanded dependency with no outputs is, while the element and its key are known.
 */
class UnresolvedDependencyOutputs extends Map<string, RuntimeValue<ValueType>> {
	constructor(private readonly address: string) {
		super();
	}

	override get(): RuntimeValue<ValueType> | undefined {
		throw new UnresolvedDependencyError(this.address);
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
 * A `dependency` block, or one element of an expanded block, after Terragrunt's include merge: `config_path`,
 * `enabled` and `skip_outputs` from the highest-priority block that sets each, and the mock settings of every block
 * deep-merged into it, lowest priority first. An element's attributes are evaluated in a scope that reads its
 * `each` or `count`.
 */
interface DependencyDeclaration {
	/** The block's label. */
	name: string;
	/** Which element of an expanded block it is; absent for a block that was not expanded. */
	key?: InstanceKey;
	declaredIn: string;
	configPath?: DependencyAttribute;
	enabled?: DependencyAttribute;
	skipOutputs?: DependencyAttribute;
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
	/** The unit's merged dependency blocks by address, built on the first dependency reference. */
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

	private async renderField(
		file: string,
		field: string,
		evaluate: () => Promise<RuntimeValue<ValueType>>
	): Promise<RuntimeValue<ValueType> | undefined> {
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
	/** The warnings given, so each is given once. */
	private readonly warned = new Set<string>();

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
			let items: Array<[string, RuntimeValue<ValueType>]> = [];
			let collectionValue: RuntimeValue<ValueType> | undefined;
			try {
				collectionValue = await this.evalNode(collection, scope);
				if (!collectionValue.encrypted) items = iterateValue(collectionValue);
			} catch {
				items = [];
			}
			const kept = gathered.get(collection) ?? [];
			kept.push(...items.map(([, item]) => item).filter(item => !item.encrypted));
			gathered.set(collection, kept);
			// A body is visited once for each element, so a for expression inside it sees that element.
			for (const [key, item] of items) {
				const frame = new Map<string, RuntimeValue<ValueType>>();
				if (variables.length === 2) {
					frame.set(String(variables[0].value ?? ''), collectionValue?.type === 'array' ? makeNumberValue(CtyNumber.fromInt64(Number(key))) : makeStringValue(key));
				}
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
		if (inputsAssignment && !skipInputs) {
			const inputNode = requiredValueNode(inputsAssignment, 'root_assignment_identifier');
			let value: RuntimeValue<ValueType>;
			if (inputNode.type === 'object' && !(inputNode.children ?? []).some(child => child.type !== 'attribute')) {
				// Attribute by attribute, so a fault in one does not hide a fault in the next.
				const entries = new Map<string, RuntimeValue<ValueType>>();
				let unresolved: UnresolvedRenderValueError | undefined;
				for (const child of inputNode.children ?? []) {
					const keyNode = child.children?.find(part => part.type === 'object_key');
					const key = keyNode
						? coerceToString(await this.evalNode(keyNode.children?.[0], scope))
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
			hasInputs: inputsAssignment !== undefined
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
				return convertToRuntimeValue(terragruntConfigAsCty(await this.readTerragruntConfig(result, true)));
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
					checkArgumentCount(name, definition.arity, args.length);
					if (!this.schema.getFunctionRegistry().hasFunction(name)) {
					throw new Error(`Function ${name} has no evaluator`);
				}
					return this.schema.getFunctionRegistry().evaluateFunction(name, args, await this.makeContext(scope));
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
	private configBody(result: FileResult, scope: Scope): ConfigBody {
		const file = result.filePath;
		const attribute = (field: string, node: TNode, written: boolean, within: Scope) => async (): Promise<Plain | typeof UNRESOLVED> => {
			const value = await this.renderField(file, field, async () => {
				const evaluated = await this.evalNode(node, within);
				return written ? computable(evaluated) : evaluated;
			});
			return value === undefined ? UNRESOLVED : unmarkedPlain(value);
		};
		const blockBody = (node: TNode, where: string, path: string, writes: boolean, within: Scope): ConfigBody => {
			const body: ConfigBody = { where, attributes: new Map(), blocks: [] };
			for (const child of node.children ?? []) {
				if (child.type === 'attribute') body.attributes.set(String(child.value), attribute(`${path}.${String(child.value)}`, requiredValueNode(child), writes, within));
				else if (child.type === 'block') body.blocks.push(block(child, path, writes));
			}
			return body;
		};
		const block = (node: TNode, prefix: string, written: boolean): ConfigBlock => {
			const type = String(node.value);
			const labels = (node.children ?? []).filter(child => child.type === 'parameter').map(child => String(child.value));
			const path = [prefix, type, ...labels].filter(Boolean).join('.');
			const writes = written || type === 'generate' || type === 'remote_state';
			const where = `${file}: ${type}${labels.map(label => ` "${label}"`).join('')}`;
			const configBlock: ConfigBlock = { type, labels, body: blockBody(node, where, path, writes, scope) };
			if (prefix === '' && type === 'dependency' && (node.children ?? []).some(child => child.type === 'block' && child.value === EXPANSION_BLOCK)) {
				configBlock.expansion = {
					elements: async () => (await this.expandBlock(node, scope))!.map(element => ({
						key: element.key,
						body: blockBody(node, where, instanceAddress(path, element.key), writes, element.scope)
					})),
					source: async () => ({
						id: `${file}:${node.location!.start.offset}`,
						text: scope.content.slice(node.location!.start.offset, node.location!.end.offset),
						asCty: await this.bodyAsCty(node, scope)
					})
				};
			}
			return configBlock;
		};
		const body: ConfigBody = { where: file, attributes: new Map(), blocks: [] };
		for (const child of result.scope.ast.children ?? []) {
			if (child.type === 'block') body.blocks.push(block(child, '', false));
			else if (child.type === 'assignment' && String(child.value) !== 'inputs') {
				const name = String(child.value);
				body.attributes.set(name, attribute(name, requiredValueNode(child, 'root_assignment_identifier'), name === 'generate' || name === 'remote_state', scope));
			}
		}
		return body;
	}

	/**
	 * A block's body as Terragrunt's BodyAsCty gives it for `render --json`, the way a JSON configuration writes it:
	 * each attribute's value where it can be evaluated with no variables and no functions, and otherwise the template a
	 * JSON configuration spells the expression with; a nested block as an object of its own.
	 *
	 * @param block the block.
	 * @param scope the scope of the file it is written in.
	 * @throws Error for a nested block with labels, which JSON cannot write as one object.
	 */
	private async bodyAsCty(block: TNode, scope: Scope): Promise<Record<string, Plain>> {
		const attributes: Record<string, Plain> = {};
		const blocks: Record<string, Plain> = {};
		for (const child of block.children ?? []) {
			if (child.type === 'attribute') {
				attributes[String(child.value)] = await this.exprAsCty(requiredValueNode(child), scope);
			} else if (child.type === 'block') {
				const labels = (child.children ?? []).filter(entry => entry.type === 'parameter');
				if (labels.length > 0) {
					const header = (child.children ?? []).find(entry => entry.type === 'block_identifier')!;
					throw new Error(`${hclRange(scope.filePath, scope.content, header.location!.start.offset, labels.at(-1)!.location!.end.offset)}: cannot render this block as JSON`);
				}
				blocks[String(child.value)] = await this.bodyAsCty(child, scope);
			}
		}
		return { ...attributes, ...blocks };
	}

	/**
	 * One expression as BodyAsCty writes it: a template rebuilt from its own source, unevaluated; an object or a tuple
	 * one element at a time, unless an object's key cannot be known without evaluating it; anything else its value
	 * when it reads no variable and calls no function, and otherwise `${…}` around its source, the template a JSON
	 * configuration writes an expression with.
	 */
	private async exprAsCty(node: TNode, scope: Scope): Promise<Plain> {
		const text = (expression: TNode): string => expressionSource(expression, scope.content);
		switch (node.type) {
			case 'string_lit':
				return escapeTemplateMarkers(String(node.value));
			case 'interpolated_string': {
				const parts = node.children ?? [];
				// A template that is one interpolation and nothing else is HCL's TemplateWrapExpr, which keeps the type of
				// what it reads.
				if (parts.length === 1 && parts[0].type === 'interpolation') return `\${${text(parts[0].children![0])}}`;
				return parts.map(part => {
					if (part.type === 'string_lit') return escapeTemplateMarkers(String(part.value));
					if (part.type === 'interpolation') return `\${${text(part.children![0])}}`;
					// A directive is written in template syntax already, its markers included.
					return scope.content.slice(part.location!.start.offset, part.location!.end.offset);
				}).join('');
			}
			case 'object': {
				const out: Record<string, Plain> = {};
				for (const item of node.children ?? []) {
					// A key JSON cannot spell, such as one computed: the object goes back whole, as one interpolation.
					if ((item.children ?? []).some(child => child.type === 'object_key')) return `\${${text(node)}}`;
					out[String(item.value)] = await this.exprAsCty(requiredValueNode(item), scope);
				}
				return out;
			}
			case 'array_lit': {
				const out: Plain[] = [];
				for (const element of node.children ?? []) out.push(await this.exprAsCty(element, scope));
				return out;
			}
			default:
				if (variableRoots(node).length === 0 && !callsFunction(node)) {
					try {
						return unmarkedPlain(await this.evalNode(node, scope));
					} catch {
						// Unevaluable on its own, as HCL finds it with no context: written as the template.
					}
				}
				return `\${${text(node)}}`;
		}
	}

	/**
	 * The configuration of the unit a file result is for, decoded and merged as Terragrunt's ParseConfig does: the
	 * unit's own, then its autoinclude merged over it shallowly, then each include merged under it, the last first,
	 * by the include's strategy. The locals are the unit's own and the exclude block the unit's when it has one; the
	 * inputs are those the evaluation merged. With `withOutputs`, each enabled dependency that does not skip its
	 * outputs carries them, except an element of an expanded block, which is never written with its outputs.
	 *
	 * @throws Error for each fault Terragrunt finds decoding a file or merging them, among them a dependency label
	 *   declared both with and without an expansion.
	 */
	private async readTerragruntConfig(result: FileResult, withOutputs: boolean): Promise<TerragruntConfig> {
		for (const [name, issue] of result.unresolvedInputs) {
			this.renderUnresolved.push({file: issue.file, field: `inputs.${name}`, reason: issue.reason});
		}
		const own = await this.decodeFile(result, result.scope);
		const autoinclude = result.scope.autoinclude;
		if (autoinclude) mergeShallow(own, await this.decodeFile(autoinclude, this.mergedScope(autoinclude, result)));
		let config = own;
		for (const name of [...result.scope.includes.keys()].reverse()) {
			const include = result.scope.includes.get(name)!;
			if (include.mergeStrategy === 'no_merge') continue;
			const included = await this.decodeFile(include.result, this.mergedScope(include.result, result));
			if (include.mergeStrategy === 'deep') mergeDeep(included, config);
			else mergeShallow(included, config);
			config = included;
		}
		if (own.exclude) config.exclude = own.exclude;
		const expanded = new Set(config.dependencyBlocks.filter(dependency => dependency.instance).map(dependency => dependency.name));
		const collision = config.dependencyBlocks.find(dependency => !dependency.instance && expanded.has(dependency.name));
		if (collision) throw new Error(dependencyLabelCollisionMessage(collision.name));

		const locals: Record<string, Plain> = {};
		for (const name of result.scope.locals.keys()) {
			const value = await this.renderField(result.filePath, `locals.${name}`, () => this.resolveLocal(result.scope, name));
			if (value !== undefined) locals[name] = unmarkedPlain(value);
		}
		config.locals = Object.keys(locals).length > 0 ? locals : undefined;
		config.inputs = result.inputs === null ? undefined : unmarkedPlain(makeObjectValue(result.inputs)) as Record<string, Plain>;

		for (const dependency of withOutputs ? config.dependencyBlocks : []) {
			if (dependency.instance || dependency.enabled === false || dependency.skipOutputs === true) continue;
			const value = await this.renderField(result.filePath, `dependency.${dependency.name}`, () => this.dependencyValue(dependency.name, result.scope));
			if (value === undefined) continue;
			const outputs = (unmarkedPlain(value) as Record<string, Plain>).outputs;
			dependency.outputs = outputs === undefined ? null : outputs;
		}
		return config;
	}

	/**
	 * One file's configuration, decoded as Terragrunt's ParseConfig decodes it before any merge: its `expansion`
	 * blocks checked for spelling first, and its dependency blocks checked for two that claim one dependency, by
	 * address or by `config_path`.
	 *
	 * @param result the file.
	 * @param scope the scope it is decoded in.
	 */
	private async decodeFile(result: FileResult, scope: Scope): Promise<TerragruntConfig> {
		assertExpansionSpelling(scope);
		const config = await decodeConfigFile(this.configBody(result, scope));
		// Terragrunt reports the first address claimed twice, and only when there is none, the first config_path.
		if (this.reportDuplicateDependencies(result.filePath, config.dependencyBlocks.map(dependencyAddress))) return config;
		const seen = new Map<string, string>();
		for (const dependency of config.dependencyBlocks) {
			if (dependency.enabled === false || typeof dependency.configPath !== 'string') continue;
			const resolved = path.resolve(path.dirname(result.filePath), dependency.configPath);
			const first = seen.get(resolved);
			if (first !== undefined) {
				this.duplicateDependencyFound(duplicateDependencyConfigPathMessage(result.filePath, first, dependencyAddress(dependency), dependency.configPath));
				break;
			}
			seen.set(resolved, dependencyAddress(dependency));
		}
		return config;
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
			return parts.length === 1 ? value : this.traverse(value, parts.slice(1), namespace);
		}

		if (namespace === 'local') {
			if (parts.length < 2) throw new Error('local reference requires a name');
			const value = await this.resolveLocal(scope, parts[1]);
			return this.traverse(value, parts.slice(2), parts[1]);
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
			return this.traverse(dependency, parts.slice(2), parts[1]);
		}

		throw new Error(`Undefined reference "${parts.join('.')}"`);
	}

	/**
	 * The value of `dependency.<name>` for the unit being evaluated. Every reference to a dependency, in the unit or
	 * in a file merged into it, shares one resolution.
	 *
	 * A block expanded with `count` or `for_each` gives an object of its elements by key, each what an unexpanded
	 * block gives, so `dependency.<name>[key].outputs` reads one element, as Terragrunt's DependencyBlocksToCtyValue
	 * encodes it.
	 *
	 * @param name the dependency's label.
	 * @param referencingScope the scope the reference is written in, which may be a merged file still being evaluated.
	 * @returns `{ outputs: … }` as the resolver gives it, or the elements' by key.
	 * @throws UnresolvedDependencyError when the dependency is declared but has no outputs yet; an Error when it is not
	 *   declared, is declared incorrectly, is declared both with and without an expansion, or reads itself.
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
				() => this.resolveNamedDependency(unit, name, referencingScope)
			);
			unit.resolved.set(name, resolution);
		}
		const value = await resolution;
		if (!value) throw new UnresolvedDependencyError(name);
		return value;
	}

	/**
	 * Finds every block or element of the unit's merged dependency blocks with a label, and resolves each.
	 *
	 * @returns the block's value, or its elements' by key; undefined when one of them has no outputs to give.
	 */
	private async resolveNamedDependency(unit: UnitContext, name: string, referencingScope: Scope): Promise<RuntimeValue<ValueType> | undefined> {
		unit.declarations ??= this.dependencyDeclarations(unit, referencingScope);
		const declarations = [...(await unit.declarations).values()].filter(declaration => declaration.name === name);
		if (declarations.length === 0) throw new Error(`No dependency "${name}" block in ${unit.unitPath} or the configurations it includes`);
		const elements = declarations.filter(declaration => declaration.key !== undefined);
		if (elements.length === 0) return this.resolveUnitDependency(unit, declarations[0]);
		if (elements.length !== declarations.length) throw new Error(dependencyLabelCollisionMessage(name));
		const values = new Map<string, RuntimeValue<ValueType>>();
		for (const element of elements) {
			const address = instanceAddress(name, element.key);
			// Its keys are known whatever its outputs are, so a key it lacks is still a fault.
			values.set(
				instanceKeyText(element.key!),
				await this.resolveUnitDependency(unit, element)
					?? makeObjectValue(new Map([['outputs', makeObjectValue(new UnresolvedDependencyOutputs(address))]]))
			);
		}
		return makeObjectValue(values);
	}

	/**
	 * Evaluates one dependency's attributes where each is written and asks the resolver for its outputs.
	 *
	 * @returns what the resolver gives, or undefined when there is no resolver or it has no outputs to give.
	 */
	private async resolveUnitDependency(unit: UnitContext, declaration: DependencyDeclaration): Promise<RuntimeValue<ValueType> | undefined> {
		const name = instanceAddress(declaration.name, declaration.key);
		const where = `dependency "${name}" in ${declaration.declaredIn}`;
		const flag = async (attribute: DependencyAttribute | undefined, field: string, absent: boolean): Promise<boolean> => {
			if (!attribute) return absent;
			const value = unwrapSensitive(await this.evalNode(attribute.node, attribute.scope));
			if (value.type === 'null') return absent;
			const converted = convertToBool(value);
			if (converted === null) throw new Error(`${where}: ${field} must be a bool`);
			return converted;
		};
		const enabled = await flag(declaration.enabled, 'enabled', true);
		const skipOutputs = await flag(declaration.skipOutputs, 'skip_outputs', false);

		let target: DependencyRequest['target'];
		// Terragrunt reads nothing from a dependency that is disabled or skips its outputs, so its config_path need not
		// name anything that exists.
		if (enabled && !skipOutputs) {
			if (!declaration.configPath) throw new Error(`${where} is missing config_path`);
			const configPath = await this.evalNode(declaration.configPath.node, declaration.configPath.scope);
			if (configPath.type !== 'string' || String(configPath.value) === '') throw new Error(`${where}: config_path must be a non-empty string`);
			// Terragrunt resolves config_path against the unit's directory, wherever the block is written.
			const targetConfigPath = await dependencyTargetConfig(path.resolve(unit.unitDir, String(configPath.value)), where);
			target = { configPath: targetConfigPath, dir: path.dirname(targetConfigPath) };
		}

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
			...(target !== undefined ? { target } : {}),
			enabled,
			skipOutputs,
			...(mockOutputs !== undefined ? { mockOutputs } : {}),
			...(mockOutputsAllowedTerraformCommands !== undefined ? { mockOutputsAllowedTerraformCommands } : {})
		};
		return this.options.resolveDependency?.(request);
	}

	/**
	 * The unit's `dependency` blocks by address after Terragrunt's include merge, each block expanded into its
	 * elements first, as each file decodes its own. The sibling autoinclude's block replaces the unit's of the same
	 * address; each direct include is then merged beneath, the last include first: a shallow include's block is
	 * replaced whole by a higher one of the same address, a deep include's has `config_path`, `enabled` and
	 * `skip_outputs` overridden, its `mock_outputs` deep-merged and its allowed commands concatenated. An include with
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
			for (const declaration of await this.fileDependencyDeclarations(scope)) {
				declarations.set(instanceAddress(declaration.name, declaration.key), declaration);
			}
		}

		const includes: Array<{ scope: Scope; strategy: MergeStrategy }> = [];
		for (const block of unitScope.blocks) {
			if (block.value !== 'include') continue;
			const { includePath, mergeStrategy } = await this.readIncludeBlock(block, unitScope);
			if (mergeStrategy === 'no_merge') continue;
			includes.push({ scope: await this.mergedFileScope(unit, includePath, referencingScope), strategy: mergeStrategy });
		}
		for (const { scope, strategy } of includes.reverse()) {
			for (const lower of await this.fileDependencyDeclarations(scope)) {
				const address = instanceAddress(lower.name, lower.key);
				const higher = declarations.get(address);
				if (!higher) {
					declarations.set(address, lower);
				} else if (strategy === 'deep') {
					declarations.set(address, {
						name: higher.name,
						key: higher.key,
						declaredIn: higher.declaredIn,
						configPath: higher.configPath ?? lower.configPath,
						enabled: higher.enabled ?? lower.enabled,
						skipOutputs: higher.skipOutputs ?? lower.skipOutputs,
						mockOutputs: [...lower.mockOutputs, ...higher.mockOutputs],
						mockOutputsAllowedTerraformCommands: [...lower.mockOutputsAllowedTerraformCommands, ...higher.mockOutputsAllowedTerraformCommands]
					});
				}
			}
		}
		return declarations;
	}

	/**
	 * One file's `dependency` blocks as declarations, in the order they are written, each expanded block giving one per
	 * element. Two that claim one address are reported as Terragrunt reports them, and the later one is kept.
	 *
	 * @throws Error for a misspelled or malformed `expansion` block, a meta-argument Terragrunt refuses, and, under the
	 *   `duplicate-dependency-labels` strict control, two blocks claiming one address.
	 */
	private async fileDependencyDeclarations(scope: Scope): Promise<DependencyDeclaration[]> {
		assertExpansionSpelling(scope);
		const declarations: DependencyDeclaration[] = [];
		for (const block of scope.blocks) {
			if (block.value !== 'dependency') continue;
			const label = (block.children ?? []).find(child => child.type === 'parameter');
			if (!label) throw new Error(`A dependency block in ${scope.filePath} has no name`);
			const name = String(label.value);
			const elements = await this.expandBlock(block, scope);
			if (elements === undefined) {
				declarations.push(dependencyDeclaration(block, name, undefined, scope));
				continue;
			}
			for (const element of elements) declarations.push(dependencyDeclaration(block, name, element.key, element.scope));
		}
		this.reportDuplicateDependencies(scope.filePath, declarations.map(declaration => instanceAddress(declaration.name, declaration.key)));
		return declarations;
	}

	/**
	 * Reports the first address two dependency blocks of one file both claim, as Terragrunt's validateUniqueDependencies
	 * does: an error under the `duplicate-dependency-labels` strict control, and otherwise a warning, the reference
	 * reading the later block.
	 *
	 * @param configPath the file.
	 * @param addresses each block's address, in the order they are written.
	 * @returns whether one was found.
	 */
	private reportDuplicateDependencies(configPath: string, addresses: readonly string[]): boolean {
		const seen = new Set<string>();
		for (const address of addresses) {
			if (seen.has(address)) {
				this.duplicateDependencyFound(duplicateDependencyMessage(configPath, address));
				return true;
			}
			seen.add(address);
		}
		return false;
	}

	/**
	 * Two dependency blocks claim one dependency: an error under the `duplicate-dependency-labels` strict control, and
	 * otherwise the control's warning and the message, each once.
	 *
	 * @throws Error with the message under the strict control.
	 */
	private duplicateDependencyFound(message: string): void {
		if (this.options.strictControls?.includes('duplicate-dependency-labels')) throw new Error(message);
		this.warnOnce(DUPLICATE_DEPENDENCY_WARNING);
		this.warnOnce(message);
	}

	private warnOnce(message: string): void {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		this.options.warn?.(message);
	}

	/**
	 * The elements of a block expanded by its `expansion` block, each with a scope that reads its `each` or `count`, as
	 * Terragrunt's ExpandBlock gives them; undefined for a block with no `expansion` block. The meta-argument is
	 * evaluated in the block's own scope, which reads neither.
	 *
	 * @param block the `dependency` block.
	 * @param scope the scope of the file it is written in.
	 * @throws Error in Terragrunt's words for a labelled `expansion` block, a second one, an argument or block it does
	 *   not take, both meta-arguments or neither, and a value of the meta-argument Terragrunt refuses.
	 */
	private async expandBlock(block: TNode, scope: Scope): Promise<Array<{ key: InstanceKey; scope: Scope }> | undefined> {
		const nested = (block.children ?? []).filter(child => child.type === 'block' && child.value === EXPANSION_BLOCK);
		if (nested.length === 0) return undefined;
		const range = (start: TNode, end: TNode = start): string => hclRange(scope.filePath, scope.content, start.location!.start.offset, end.location!.end.offset);
		// HCL refuses a label on any expansion block before Terragrunt looks at how many there are.
		for (const expansion of nested) {
			const label = (expansion.children ?? []).find(child => child.type === 'parameter');
			if (label) throw new Error(`${range(label)}: Extraneous label for ${EXPANSION_BLOCK}; No labels are expected for ${EXPANSION_BLOCK} blocks.`);
		}
		const header = (node: TNode): TNode => (node.children ?? []).find(child => child.type === 'block_identifier')!;
		if (nested.length > 1) throw new Error(duplicateExpansionBlockMessage(range(header(nested[1])), String(block.value)));
		const expansion = nested[0];

		// The expansion block is read with its schema, so anything else in it is refused, in HCL's words.
		const metaArguments: MetaArgument[] = ['for_each', 'count'];
		const problems: string[] = [];
		const attributes = new Map<MetaArgument, TNode>();
		for (const child of expansion.children ?? []) {
			if (child.type === 'attribute') {
				const name = String(child.value);
				const identifier = (child.children ?? []).find(entry => entry.type === 'attribute_identifier')!;
				if (metaArguments.includes(name as MetaArgument)) {
					attributes.set(name as MetaArgument, child);
					continue;
				}
				const suggestion = nameSuggestion(name, metaArguments);
				problems.push(`${range(identifier)}: Unsupported argument; An argument named "${name}" is not expected here.${suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`}`);
			} else if (child.type === 'block') {
				const type = String(child.value);
				const detail = metaArguments.includes(type as MetaArgument)
					? ` Did you mean to define argument "${type}"? If so, use the equals sign to assign it a value.`
					: '';
				problems.push(`${range(header(child))}: Unsupported block type; Blocks of type "${type}" are not expected here.${detail}`);
			}
		}
		if (problems.length > 0) throw new Error(problems.length === 1 ? problems[0] : `${problems[0]}, and ${problems.length - 1} other diagnostic(s)`);
		const forEach = attributes.get('for_each');
		const count = attributes.get('count');
		if (forEach && count) throw new Error(conflictingMetaArgumentsMessage(range(header(expansion))));
		const attribute = count ?? forEach;
		if (!attribute) throw new Error(missingMetaArgumentMessage(range(header(expansion))));

		const valueNode = requiredValueNode(attribute);
		const value = await this.evalNode(valueNode, scope);
		const attributeRange = range((attribute.children ?? []).find(entry => entry.type === 'attribute_identifier')!, valueNode);
		const elements = count ? countElements(value, attributeRange) : forEachElements(value, attributeRange);
		return elements.map(element => ({
			key: element.key,
			scope: { ...scope, comprehension: [...scope.comprehension, element.variables] }
		}));
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
		if (head === 'locals') {
			// `include.<name>.locals` with no trailing name is the whole map.
			if (parts.length < 2) {
				const all = new Map<string, RuntimeValue<ValueType>>();
				for (const name of result.scope.locals.keys()) {
					all.set(name, await this.resolveLocal(result.scope, name));
				}
				return makeObjectValue(all);
			}
			const value = await this.resolveLocal(result.scope, parts[1]);
			return this.traverse(value, parts.slice(2), parts[1]);
		}
		if (head === 'inputs') {
			if (!result.inputs) throw new Error(`include "${parts[1]}" has no inputs`);
			return this.traverse(makeObjectValue(result.inputs), parts.slice(1), 'inputs');
		}
		if (head === 'terraform') {
			const value = await this.terraformObject(result.scope);
			return this.traverse(value, parts.slice(1), 'terraform');
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

	private traverse(value: RuntimeValue<ValueType>, parts: string[], base: string): RuntimeValue<ValueType> {
		let current = unwrapSensitive(value);
		for (const part of parts) {
			if (current.type === 'object' || current.type === 'block') {
				const map = current.value as Map<string, RuntimeValue<ValueType>>;
				const next = map.get(part);
				if (next === undefined) throw new Error(`Missing attribute "${part}" on "${base}"`);
				current = unwrapSensitive(next);
			} else if (current.type === 'array') {
				const items = current.value as RuntimeValue<ValueType>[];
				const index = Number(part);
				if (!Number.isInteger(index) || index < 0 || index >= items.length) {
					throw new Error(`List index ${part} out of range on "${base}"`);
				}
				current = unwrapSensitive(items[index]);
			} else {
				throw new Error(`Cannot access "${part}" on value of type ${current.type}`);
			}
		}
		return current;
	}

	private getAttribute(value: RuntimeValue<ValueType>, name: string): RuntimeValue<ValueType> {
		const current = unwrapSensitive(value);
		if (current.type !== 'object' && current.type !== 'block') {
			throw new Error(`Cannot access attribute "${name}" on value of type ${current.type}`);
		}
		const map = current.value as Map<string, RuntimeValue<ValueType>>;
		const next = map.get(name);
		if (next === undefined) throw new Error(`Missing attribute "${name}"`);
		return unwrapSensitive(next);
	}

	private indexValue(base: RuntimeValue<ValueType>, index: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
		const current = unwrapSensitive(base);
		if (current.type === 'array') {
			const items = current.value as RuntimeValue<ValueType>[];
			return unwrapSensitive(items[sequencePosition(items.length, index)]);
		}
		if (current.type === 'object' || current.type === 'block') {
			const key = index.type === 'string' ? String(index.value) : coerceToString(index);
			const map = current.value as Map<string, RuntimeValue<ValueType>>;
			const next = map.get(key);
			if (next === undefined) throw new Error(`Missing key "${key}"`);
			return unwrapSensitive(next);
		}
		throw new Error(`Cannot index value of type ${current.type}`);
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
				return makeNullValue();
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
			case 'ternary_expression': {
				const [condition, whenTrue, whenFalse] = node.children ?? [];
				const value = computable(await this.evalNode(condition, scope));
				const truth = this.atNode(condition, scope, () => conditionValue(value));
				return truth ? this.evalNode(whenTrue, scope) : this.evalNode(whenFalse, scope);
			}
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
				return this.traverse(await this.evalNode(node.children?.[0], scope), member.split('.'), member);
			}
			case 'index_expression': {
				const [collection, index] = await this.evalOperands([node.children?.[0], node.children?.[1]], scope);
				return this.indexValue(collection, computable(index));
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
				for (const [, item] of iterateValue(items)) {
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
					return [{ key: coerceToString(computable(key)), value, inherited: false }];
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
		const items = this.atNode(collection, scope, () => iterateValue(collectionValue));
		let rendered = '';
		let sensitive = marked !== collectionValue;
		for (const [key, item] of items) {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			if (variables.length === 2) {
				frame.set(String(variables[0].value ?? ''), collectionValue.type === 'array' ? makeNumberValue(CtyNumber.fromInt64(Number(key))) : makeStringValue(key));
			}
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
			const key = comprehensionKey(computable(await this.evalNode(keyNode, scope)));
			const value = await this.evalNode(valueNode, scope);
			if (grouping) {
				const group = groups.get(key) ?? [];
				group.push(value);
				groups.set(key, group);
			} else {
				if (map.has(key)) throw new Error(`Duplicate key "${key}" in a for expression; use "..." to group values by key`);
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
		for (const [key, item] of iterateValue(collectionValue)) {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			if (variables.length === 2) {
				frame.set(
					String(variables[0].value ?? ''),
					collectionValue.type === 'array' ? makeNumberValue(CtyNumber.fromInt64(Number(key))) : makeStringValue(key)
				);
			}
			frame.set(String(variables[variables.length - 1].value ?? ''), item);
			scope.comprehension.push(frame);
			try {
				if (condition && !comprehensionCondition(computable(await this.evalNode(condition, scope)))) continue;
				await each(body);
			} finally {
				scope.comprehension.pop();
			}
		}
	}

	private async evalSplat(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const base = await this.evalNode(node.children?.[0], scope);
		const attribute = node.children?.[1] ? String(node.children[1].value ?? '') : null;
		if (base.type !== 'array') throw new Error('Splat requires a list');
		const items = base.value as RuntimeValue<ValueType>[];
		if (attribute === null) return makeArrayValue(items);
		return makeArrayValue(items.map(item => this.getAttribute(item, attribute)));
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
		checkArgumentCount(name, definition.arity, args.length);

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
		if (!this.schema.getFunctionRegistry().hasFunction(name)) {
			throw new Error(`Function "${name}" has no evaluator`);
		}

		const evaluatedArgs = functionArguments(name, await this.evalCallArguments(args, scope));
		const context = await this.makeContext(scope);
		return this.schema.getFunctionRegistry().evaluateFunction(name, evaluatedArgs, context);
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
 * The elements of a for expression's collection, in the order HCL visits them: a list by index, an object by key in
 * the order of their bytes, as `keys` and `values` give them.
 *
 * @throws Error when the collection is null or is not a collection, in HCL's words.
 */
function iterateValue(value: RuntimeValue<ValueType>): Array<[string, RuntimeValue<ValueType>]> {
	const items: Array<[string, RuntimeValue<ValueType>]> = [];
	if (value.type === 'array') {
		(value.value as RuntimeValue<ValueType>[]).forEach((item, index) => items.push([String(index), item]));
	} else if (value.type === 'object' || value.type === 'block') {
		const map = value.value as Map<string, RuntimeValue<ValueType>>;
		for (const key of [...map.keys()].sort(compareStrings)) items.push([key, map.get(key)!]);
	} else if (value.type === 'null') {
		throw new Error('A null value cannot be used as the collection in a \'for\' expression.');
	} else {
		const type = value.type === 'boolean' ? 'bool' : value.type;
		throw new Error(`A value of type ${type} cannot be used as the collection in a 'for' expression.`);
	}
	return items;
}

/**
 * Whether a for expression keeps an element, from its `if` clause: a bool, or a string HCL converts to one.
 *
 * @throws Error when the clause is null or does not convert to a bool, as HCL refuses it.
 */
function comprehensionCondition(value: RuntimeValue<ValueType>): boolean {
	if (value.type === 'null') throw new Error('The "if" clause of a for expression must not be null');
	try {
		return convertToBool(value) as boolean;
	} catch {
		const shown = value.type === 'string' ? ` ${JSON.stringify(value.value)}` : '';
		throw new Error(`The "if" clause of a for expression must be a bool, got ${value.type}${shown}`);
	}
}

/**
 * The key a map for expression produces for an element: a string, or a number or bool HCL converts to one.
 *
 * @throws Error when the key is null or a collection, as HCL refuses it.
 */
function comprehensionKey(value: RuntimeValue<ValueType>): string {
	if (value.type === 'string' || value.type === 'number' || value.type === 'boolean') return coerceToString(value);
	if (value.type === 'null') throw new Error('The key of a for expression must not be null');
	throw new Error(`The key of a for expression must be a string, got ${value.type}`);
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

/** Whether an expression calls a function anywhere in it, which HCL cannot evaluate without a context. */
function callsFunction(node: TNode): boolean {
	return node.type === 'function_call' || (node.children ?? []).some(callsFunction);
}

/**
 * The source of an expression as HCL's range of it covers it: with the parentheses around it, which the parser leaves
 * out of its nodes, and those its own range cuts through.
 *
 * @param node the expression, written where its context never puts a parenthesis of its own beside it: an attribute's
 *   value, an element, an interpolation.
 * @param content the text of the file it is written in.
 */
function expressionSource(node: TNode, content: string): string {
	let start = node.location!.start.offset;
	let end = node.location!.end.offset;
	const before = (offset: number): number => {
		let at = offset - 1;
		while (at >= 0 && /\s/.test(content[at])) at--;
		return at;
	};
	const after = (offset: number): number => {
		let at = offset;
		while (at < content.length && /\s/.test(content[at])) at++;
		return at;
	};
	for (;;) {
		let depth = 0;
		let lowest = 0;
		for (const token of scanHclTokens(content.slice(start, end))) {
			if (token.type === 'OParen') depth++;
			else if (token.type === 'CParen') lowest = Math.min(lowest, --depth);
		}
		if (lowest < 0) {
			start = before(start);
			continue;
		}
		if (depth > 0) {
			end = after(end) + 1;
			continue;
		}
		const open = before(start);
		const close = after(end);
		if (content[open] !== '(' || content[close] !== ')') return content.slice(start, end);
		start = open;
		end = close + 1;
	}
}

/** Text written as an HCL template's literal, every sequence that would open a template escaped. */
function escapeTemplateMarkers(text: string): string {
	// A replacer, since a replacement string reads `$$` as one `$`.
	return text.replaceAll('${', () => '$${').replaceAll('%{', () => '%%{');
}

/**
 * Refuses a labelled `dependency` block of a file that nests a misspelling of `expansion`, as Terragrunt's
 * ValidateExpansionSpelling does before it reads the file, since the block would otherwise run without its iteration.
 *
 * @throws Error naming the block, the file and the misspelled name.
 */
function assertExpansionSpelling(scope: Scope): void {
	for (const block of scope.blocks) {
		if (block.value !== 'dependency') continue;
		const labels = (block.children ?? []).filter(child => child.type === 'parameter');
		if (labels.length !== 1) continue;
		const nested = (block.children ?? []).filter(child => child.type === 'block').map(child => String(child.value));
		const name = misspelledExpansionBlock(nested);
		if (name !== undefined) throw new Error(misspelledExpansionBlockMessage('dependency', String(labels[0].value), scope.filePath, name));
	}
}

/**
 * One `dependency` block, or one element of an expanded block, as a declaration, its attributes paired with the scope
 * they are evaluated in.
 *
 * @param block the block.
 * @param name its label.
 * @param key the element's key; undefined for a block that was not expanded.
 * @param scope the scope of the file it is written in, reading the element's `each` or `count` for an element.
 */
function dependencyDeclaration(block: TNode, name: string, key: InstanceKey | undefined, scope: Scope): DependencyDeclaration {
	const attribute = (attributeName: string): DependencyAttribute | undefined => {
		const child = (block.children ?? []).find(entry => entry.type === 'attribute' && String(entry.value) === attributeName);
		const node = child?.children?.find(entry => entry.type !== 'attribute_identifier');
		return node ? { node, scope } : undefined;
	};
	const mockOutputs = attribute('mock_outputs');
	const allowed = attribute('mock_outputs_allowed_terraform_commands');
	return {
		name,
		...(key !== undefined ? { key } : {}),
		declaredIn: scope.filePath,
		configPath: attribute('config_path'),
		enabled: attribute('enabled'),
		skipOutputs: attribute('skip_outputs'),
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
 * @param arity its go-cty parameters.
 * @param count the call's arguments, an expanded final argument counted as its elements.
 * @throws when there are fewer arguments than parameters, or more and no variadic parameter takes them.
 */
function checkArgumentCount(name: string, arity: FunctionArity, count: number): void {
	if (count < arity.params.length) {
		throw new Error(
			`Not enough function arguments; Function "${name}" expects${arity.variadic ? ' at least' : ''} ${arity.params.length} argument(s). `
			+ `Missing value for "${arity.params[count]}".`
		);
	}
	if (!arity.variadic && count > arity.params.length) {
		throw new Error(`Too many function arguments; Function "${name}" expects only ${arity.params.length} argument(s).`);
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

/** What stands in for a value sops stored encrypted wherever a plain form of it is shown. */
export const ENCRYPTED_VALUE = '(encrypted)';

/**
 * A value in plain JavaScript: strings, booleans, null, arrays and records, and each number a {@link CtyNumber},
 * which JSON.stringify writes as its exact decimal text.
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

/**
 * A value in plain JavaScript as {@link runtimeValueToPlain} gives it, with every sensitive mark taken off first, as
 * Terragrunt unmarks what it decodes into its configuration.
 */
function unmarkedPlain(value: RuntimeValue<ValueType>): Plain {
	const unmarked = unwrapSensitive(value);
	switch (unmarked.type) {
		case 'array':
			return (unmarked.value as RuntimeValue<ValueType>[]).map(unmarkedPlain);
		case 'object':
		case 'block': {
			const out: Record<string, Plain> = {};
			for (const [key, entry] of (unmarked.value as Map<string, RuntimeValue<ValueType>>).entries()) out[key] = unmarkedPlain(entry);
			return out;
		}
		default:
			return runtimeValueToPlain(unmarked);
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
