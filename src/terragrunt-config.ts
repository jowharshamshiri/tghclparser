/**
 * A unit's configuration as Terragrunt v1.2.2 holds it once it is decoded and its includes are merged in: its
 * `TerragruntConfig` (pkg/config/config.go). `terragrunt render` writes this structure, as HCL by
 * `TerragruntConfig.WriteTo` and as JSON through `TerragruntConfigAsCty`, and `read_terragrunt_config()` hands it to
 * an expression in the second form. What a field holds, whether it is set at all, and the order of what is listed
 * follow Terragrunt's decoding (`ConvertToTerragruntConfig`) and merging (`Merge`, `DeepMerge` in include.go), since
 * every one of them shows in what render prints.
 *
 * Values are plain, as runtimeValueToPlain gives them: strings, booleans, null, arrays, records and numbers as
 * {@link CtyNumber}. A field Terragrunt decodes into a Go type holds the value converted to that type, as gohcl
 * converts it: a number given for a string is its decimal text, a string "true" given for a boolean is true.
 */

import { CtyNumber } from './cty-number';
import { type CtyType, ctyBool, ctyDynamic, ctyNumber, ctyString, listOf, mapOf, objectOf } from './cty-types';
import {
	convertToRuntimeValue,
	makeArrayValue,
	makeBooleanValue,
	makeListValue,
	makeMapValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeStringValue
} from './functions/utils';
import type { RuntimeValue, ValueType } from './model';

/** A value as runtimeValueToPlain gives it. */
export type Plain = unknown;

/** A `before_hook` or `after_hook` block. */
export interface Hook {
	name: string;
	if?: boolean;
	runOnError?: boolean;
	suppressStdout?: boolean;
	workingDir?: string;
	commands: string[] | undefined;
	execute: string[] | undefined;
}

/** An `error_hook` block. */
export interface ErrorHook {
	name: string;
	suppressStdout?: boolean;
	workingDir?: string;
	commands: string[] | undefined;
	execute: string[] | undefined;
	onErrors: string[] | undefined;
}

/** An `extra_arguments` block. */
export interface ExtraArguments {
	name: string;
	arguments?: string[];
	requiredVarFiles?: string[];
	optionalVarFiles?: string[];
	envVars?: Record<string, string>;
	commands: string[] | undefined;
}

/** The `terraform` block. */
export interface TerraformConfig {
	source?: string;
	version?: string;
	updateSourceWithCas?: boolean;
	mutable?: boolean;
	includeInCopy?: string[];
	excludeFromCopy?: string[];
	copyTerraformLockFile?: boolean;
	noDotTerragruntCache?: boolean;
	extraArguments: ExtraArguments[];
	beforeHooks: Hook[];
	afterHooks: Hook[];
	errorHooks: ErrorHook[];
}

/** `remote_state`, written as a block or as an attribute. */
export interface RemoteState {
	backend: string;
	disableInit: boolean;
	disableDependencyOptimization: boolean;
	generate?: { path: string; ifExists: string };
	/** The backend's settings; undefined only for the attribute form that leaves `config` out. */
	config: Record<string, Plain> | undefined;
	encryption: Record<string, Plain> | undefined;
}

/** A `dependency` block. */
export interface Dependency {
	name: string;
	configPath: Plain;
	enabled?: boolean;
	skipOutputs?: boolean;
	mockOutputs?: Plain;
	mockOutputsAllowedTerraformCommands?: string[];
	mockOutputsMergeWithState?: boolean;
	mockOutputsMergeStrategyWithState?: string;
	/** The outputs the dependency gave, real or mocked; undefined until they are read, and when they are not. */
	outputs?: Plain;
}

/** A `generate` block, with the defaults Terragrunt fills in. */
export interface GenerateConfig {
	path: string;
	ifExists: string;
	ifDisabled: string;
	commentPrefix: string;
	contents: string;
	disableSignature: boolean;
	disable: boolean;
	hclFmt?: boolean;
	mutable?: boolean;
}

/** A `feature` block. */
export interface FeatureFlag {
	name: string;
	default?: Plain;
}

/** The `engine` block. */
export interface EngineConfig {
	source: string;
	version?: string;
	type?: string;
	meta?: Plain;
}

/** The `exclude` block. */
export interface ExcludeConfig {
	if: boolean;
	actions: string[] | undefined;
	excludeDependencies?: boolean;
	noRun?: boolean;
}

/** A `retry` block of `errors`. */
export interface RetryBlock {
	label: string;
	retryableErrors: string[] | undefined;
	maxAttempts: number;
	sleepIntervalSec: number;
}

/** An `ignore` block of `errors`. */
export interface IgnoreBlock {
	label: string;
	ignorableErrors: string[] | undefined;
	message: string;
	signals?: Record<string, Plain>;
}

/** The `errors` block. */
export interface ErrorsConfig {
	retry: RetryBlock[] | undefined;
	ignore: IgnoreBlock[] | undefined;
}

/** A unit's configuration, decoded and merged as Terragrunt holds it. */
export interface TerragruntConfig {
	/** The unit's own locals, never an included file's; undefined when it has none. */
	locals?: Record<string, Plain>;
	terraform?: TerraformConfig;
	remoteState?: RemoteState;
	dependencies?: { paths: string[] };
	dependencyBlocks: Dependency[];
	/** By label. Terragrunt keeps them in a Go map, so nothing about their order is Terragrunt's. */
	generate: Map<string, GenerateConfig>;
	/**
	 * The labels of the generate blocks left out because a value they require cannot be known yet. Not Terragrunt's,
	 * which fails instead: they still count where Terragrunt refuses a label given twice.
	 */
	unresolvedGenerate: Set<string>;
	featureFlags: FeatureFlag[] | undefined;
	engine?: EngineConfig;
	exclude?: ExcludeConfig;
	errors?: ErrorsConfig;
	inputs?: Record<string, Plain>;
	terraformBinary: string;
	terraformVersionConstraint: string;
	terragruntVersionConstraint: string;
	downloadDir: string;
	preventDestroy?: boolean;
	iamRole: string;
	iamAssumeRoleDuration?: CtyNumber;
	iamAssumeRoleSessionName: string;
	iamWebIdentityToken: string;
}

/** The value of an attribute that cannot be known yet, such as a dependency output a partial render leaves out. */
export const UNRESOLVED = Symbol('unresolved');

/** One body of configuration, a file or a block, as the decoder reads it. */
export interface ConfigBody {
	/** Where it is written, which the messages name. */
	where: string;
	/** Its attributes in the order they are written, each evaluated when read. */
	attributes: Map<string, () => Promise<Plain | typeof UNRESOLVED>>;
	/** Its blocks in the order they are written. */
	blocks: ConfigBlock[];
}

/** A block of a {@link ConfigBody}. */
export interface ConfigBlock {
	type: string;
	labels: string[];
	body: ConfigBody;
}

/** The value of each attribute of a body that can be known, by name; an unknown one is left out, as unset. */
type Attributes = Map<string, Plain>;

/** An empty configuration, as Terragrunt starts one. */
export function emptyTerragruntConfig(): TerragruntConfig {
	return {
		dependencyBlocks: [],
		generate: new Map(),
		unresolvedGenerate: new Set(),
		featureFlags: undefined,
		terraformBinary: '',
		terraformVersionConstraint: '',
		terragruntVersionConstraint: '',
		downloadDir: '',
		iamRole: '',
		iamAssumeRoleSessionName: '',
		iamWebIdentityToken: ''
	};
}

function isRecord(value: Plain): value is Record<string, Plain> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof CtyNumber);
}

/** A value of the wrong type for what Terragrunt decodes it into, in HCL's words. */
function unsuitable(where: string, name: string, detail: string): Error {
	return new Error(`${where}: Unsuitable value type for "${name}": Unsuitable value: ${detail}`);
}

/**
 * A value converted to a string as go-cty converts it: a number to its decimal text, a boolean to `true` or `false`.
 *
 * @throws Error for null and for any other type.
 */
function toGoString(value: Plain, where: string, name: string): string {
	if (typeof value === 'string') return value;
	if (value instanceof CtyNumber) return value.toString();
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (value === null) throw unsuitable(where, name, 'null value is not allowed');
	throw unsuitable(where, name, 'string required');
}

/**
 * A value converted to a boolean as go-cty converts it: a string `true` or `1`, `false` or `0`.
 *
 * @throws Error for null and for any other value.
 */
function toGoBool(value: Plain, where: string, name: string): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	if (value === null) throw unsuitable(where, name, 'null value is not allowed');
	throw unsuitable(where, name, 'bool required');
}

/** A value converted to a list of strings, each element as {@link toGoString} converts it. */
function toStringList(value: Plain, where: string, name: string): string[] {
	if (!Array.isArray(value)) throw unsuitable(where, name, value === null ? 'null value is not allowed' : 'list of string required');
	return value.map(item => toGoString(item, where, name));
}

/** A value converted to a map of strings. */
function toStringMap(value: Plain, where: string, name: string): Record<string, string> {
	if (!isRecord(value)) throw unsuitable(where, name, value === null ? 'null value is not allowed' : 'map of string required');
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) out[key] = toGoString(item, where, name);
	return out;
}

/** A value converted to a whole number that fits a Go int64. */
function toGoInt(value: Plain, where: string, name: string): CtyNumber {
	let number: CtyNumber | undefined;
	if (value instanceof CtyNumber) number = value;
	else if (typeof value === 'string') number = CtyNumber.tryParse(value);
	if (value === null) throw unsuitable(where, name, 'null value is not allowed');
	if (!number) throw unsuitable(where, name, 'number required');
	if (!number.isInteger()) throw unsuitable(where, name, `value must be a whole number, between -9223372036854775808 and 9223372036854775807 inclusive`);
	return number;
}

/**
 * A block a required attribute of which cannot be known yet. It is left out of the configuration, the attribute
 * having been reported as unresolved, rather than decoded with a value nobody wrote.
 */
class UnresolvedBlock extends Error {}

/**
 * Reads every attribute of a body, leaving out what cannot be known, and refuses any {@link allowed} does not name.
 *
 * @throws UnresolvedBlock when a required attribute cannot be known yet.
 */
async function readAttributes(body: ConfigBody, allowed: readonly string[], required: readonly string[] = []): Promise<Attributes> {
	const values: Attributes = new Map();
	for (const [name, read] of body.attributes) {
		if (!allowed.includes(name)) throw new Error(`${body.where}: Unsupported argument; An argument named "${name}" is not expected here.`);
		const value = await read();
		if (value !== UNRESOLVED) values.set(name, value);
	}
	for (const name of required) {
		if (!body.attributes.has(name)) throw new Error(`${body.where}: Missing required argument; The argument "${name}" is required, but no definition was found.`);
		if (!values.has(name)) throw new UnresolvedBlock(name);
	}
	return values;
}

/** Decodes a block, or gives undefined for one {@link UnresolvedBlock} leaves out. */
async function unlessUnresolved<T>(decode: () => Promise<T>): Promise<T | undefined> {
	try {
		return await decode();
	} catch (error) {
		if (error instanceof UnresolvedBlock) return undefined;
		throw error;
	}
}

/** Refuses a block a body may not hold. */
function refuseBlocks(body: ConfigBody, allowed: readonly string[]): void {
	for (const block of body.blocks) {
		if (!allowed.includes(block.type)) throw new Error(`${body.where}: Unsupported block type; Blocks of type "${block.type}" are not expected here.`);
	}
}

/** The one label of a block that takes one. */
function onlyLabel(block: ConfigBlock, where: string): string {
	if (block.labels.length !== 1) throw new Error(`${where}: ${block.labels.length === 0 ? 'Missing name' : 'Extraneous label'} for ${block.type}; A ${block.type} block requires exactly one label.`);
	return block.labels[0];
}

/** At most one block of a type, as a Go pointer field decodes it. */
function singleBlock(body: ConfigBody, type: string): ConfigBlock | undefined {
	const found = body.blocks.filter(block => block.type === type);
	if (found.length > 1) throw new Error(`${body.where}: Duplicate ${type} block; Only one "${type}" block is allowed.`);
	return found[0];
}

/** A pointer field: set when the attribute is given and not null. */
function optional<T>(values: Attributes, name: string, convert: (value: Plain) => T): T | undefined {
	const value = values.get(name);
	return value === undefined || value === null ? undefined : convert(value);
}

async function decodeHook(block: ConfigBlock): Promise<Hook> {
	const where = block.body.where;
	const name = onlyLabel(block, where);
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['if', 'run_on_error', 'suppress_stdout', 'working_dir', 'commands', 'execute'], ['commands', 'execute']);
	return {
		name,
		if: optional(values, 'if', value => toGoBool(value, where, 'if')),
		runOnError: optional(values, 'run_on_error', value => toGoBool(value, where, 'run_on_error')),
		suppressStdout: optional(values, 'suppress_stdout', value => toGoBool(value, where, 'suppress_stdout')),
		workingDir: optional(values, 'working_dir', value => toGoString(value, where, 'working_dir')),
		commands: optional(values, 'commands', value => toStringList(value, where, 'commands')),
		execute: optional(values, 'execute', value => toStringList(value, where, 'execute'))
	};
}

async function decodeErrorHook(block: ConfigBlock): Promise<ErrorHook> {
	const where = block.body.where;
	const name = onlyLabel(block, where);
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['suppress_stdout', 'working_dir', 'commands', 'execute', 'on_errors'], ['commands', 'execute', 'on_errors']);
	return {
		name,
		suppressStdout: optional(values, 'suppress_stdout', value => toGoBool(value, where, 'suppress_stdout')),
		workingDir: optional(values, 'working_dir', value => toGoString(value, where, 'working_dir')),
		commands: optional(values, 'commands', value => toStringList(value, where, 'commands')),
		execute: optional(values, 'execute', value => toStringList(value, where, 'execute')),
		onErrors: optional(values, 'on_errors', value => toStringList(value, where, 'on_errors'))
	};
}

async function decodeExtraArguments(block: ConfigBlock): Promise<ExtraArguments> {
	const where = block.body.where;
	const name = onlyLabel(block, where);
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['arguments', 'required_var_files', 'optional_var_files', 'env_vars', 'commands'], ['commands']);
	return {
		name,
		arguments: optional(values, 'arguments', value => toStringList(value, where, 'arguments')),
		requiredVarFiles: optional(values, 'required_var_files', value => toStringList(value, where, 'required_var_files')),
		optionalVarFiles: optional(values, 'optional_var_files', value => toStringList(value, where, 'optional_var_files')),
		envVars: optional(values, 'env_vars', value => toStringMap(value, where, 'env_vars')),
		commands: optional(values, 'commands', value => toStringList(value, where, 'commands'))
	};
}

/**
 * The `terraform` block, after Terragrunt's check that every hook runs something.
 *
 * @throws Error when a hook's `execute` is empty or starts with an empty string.
 */
async function decodeTerraform(block: ConfigBlock): Promise<TerraformConfig> {
	const body = block.body;
	const where = body.where;
	refuseBlocks(body, ['extra_arguments', 'before_hook', 'after_hook', 'error_hook']);
	const values = await readAttributes(body, ['source', 'version', 'update_source_with_cas', 'mutable', 'include_in_copy', 'exclude_from_copy', 'copy_terraform_lock_file', 'no_dot_terragrunt_cache']);
	const terraform: TerraformConfig = {
		source: optional(values, 'source', value => toGoString(value, where, 'source')),
		version: optional(values, 'version', value => toGoString(value, where, 'version')),
		updateSourceWithCas: optional(values, 'update_source_with_cas', value => toGoBool(value, where, 'update_source_with_cas')),
		mutable: optional(values, 'mutable', value => toGoBool(value, where, 'mutable')),
		includeInCopy: optional(values, 'include_in_copy', value => toStringList(value, where, 'include_in_copy')),
		excludeFromCopy: optional(values, 'exclude_from_copy', value => toStringList(value, where, 'exclude_from_copy')),
		copyTerraformLockFile: optional(values, 'copy_terraform_lock_file', value => toGoBool(value, where, 'copy_terraform_lock_file')),
		noDotTerragruntCache: optional(values, 'no_dot_terragrunt_cache', value => toGoBool(value, where, 'no_dot_terragrunt_cache')),
		extraArguments: [],
		beforeHooks: [],
		afterHooks: [],
		errorHooks: []
	};
	for (const nested of body.blocks) {
		if (nested.type === 'extra_arguments') {
			const argument = await unlessUnresolved(() => decodeExtraArguments(nested));
			if (argument) terraform.extraArguments.push(argument);
		} else if (nested.type === 'error_hook') {
			const hook = await unlessUnresolved(() => decodeErrorHook(nested));
			if (hook) terraform.errorHooks.push(hook);
		} else {
			const hook = await unlessUnresolved(() => decodeHook(nested));
			if (hook) (nested.type === 'before_hook' ? terraform.beforeHooks : terraform.afterHooks).push(hook);
		}
	}
	for (const hook of [...terraform.beforeHooks, ...terraform.afterHooks, ...terraform.errorHooks]) {
		if (hook.execute === undefined || hook.execute.length < 1 || hook.execute[0] === '') {
			throw new Error(`Error with hook ${hook.name}. Need at least one non-empty argument in 'execute'.`);
		}
	}
	return terraform;
}

/** The settings of a `remote_state`, as remotestate.ConfigFile.Config reads them. */
function remoteStateOf(values: Attributes, where: string, weak: boolean): RemoteState {
	const flag = (name: string): boolean => {
		const value = values.get(name);
		if (value === undefined || value === null) return false;
		// The attribute form is decoded by mapstructure's WeakDecode, which also reads a number as a boolean.
		if (weak && value instanceof CtyNumber) return !value.isZero();
		return toGoBool(value, where, name);
	};
	const backend = values.get('backend');
	const generate = values.get('generate');
	let generateConfig: RemoteState['generate'];
	if (generate !== undefined && generate !== null) {
		if (!isRecord(generate)) throw unsuitable(where, 'generate', 'object required');
		for (const key of Object.keys(generate)) {
			if (key !== 'path' && key !== 'if_exists') throw unsuitable(where, 'generate', `unsupported attribute "${key}"`);
		}
		generateConfig = {
			path: generate.path === undefined ? '' : toGoString(generate.path, where, 'generate.path'),
			ifExists: generate.if_exists === undefined ? '' : toGoString(generate.if_exists, where, 'generate.if_exists')
		};
	}
	const mapping = (name: string, nullAsEmpty: boolean): Record<string, Plain> | undefined => {
		const value = values.get(name);
		if (value === undefined) return undefined;
		if (value === null) return nullAsEmpty ? {} : undefined;
		if (!isRecord(value)) throw unsuitable(where, name, 'object required');
		return value;
	};
	const state: RemoteState = {
		backend: backend === undefined || backend === null ? '' : toGoString(backend, where, 'backend'),
		disableInit: flag('disable_init'),
		disableDependencyOptimization: flag('disable_dependency_optimization'),
		generate: generateConfig,
		// The block form reads `config` with ParseCtyValueToMap, which gives an empty map for null.
		config: mapping('config', !weak),
		encryption: mapping('encryption', false)
	};
	if (state.backend === '') throw new Error('the remote_state.backend field cannot be empty');
	return state;
}

async function decodeRemoteStateBlock(block: ConfigBlock): Promise<RemoteState> {
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['backend', 'config', 'disable_init', 'disable_dependency_optimization', 'generate', 'encryption'], ['backend', 'config']);
	return remoteStateOf(values, block.body.where, false);
}

/** `remote_state = { ... }`, which Terragrunt decodes with mapstructure. */
function decodeRemoteStateAttribute(value: Plain, where: string): RemoteState {
	if (!isRecord(value)) throw unsuitable(where, 'remote_state', 'object required');
	const values: Attributes = new Map();
	for (const [key, item] of Object.entries(value)) {
		if (['backend', 'config', 'disable_init', 'disable_dependency_optimization', 'generate', 'encryption'].includes(key)) values.set(key, item);
	}
	return remoteStateOf(values, where, true);
}

async function decodeDependency(block: ConfigBlock): Promise<Dependency> {
	const where = block.body.where;
	const name = onlyLabel(block, where);
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['config_path', 'enabled', 'skip_outputs', 'mock_outputs', 'mock_outputs_allowed_terraform_commands', 'mock_outputs_merge_with_state', 'mock_outputs_merge_strategy_with_state']);
	return {
		name,
		configPath: values.has('config_path') ? values.get('config_path') : null,
		enabled: optional(values, 'enabled', value => toGoBool(value, where, 'enabled')),
		skipOutputs: optional(values, 'skip_outputs', value => toGoBool(value, where, 'skip_outputs')),
		mockOutputs: optional(values, 'mock_outputs', value => value),
		mockOutputsAllowedTerraformCommands: optional(values, 'mock_outputs_allowed_terraform_commands', value => toStringList(value, where, 'mock_outputs_allowed_terraform_commands')),
		mockOutputsMergeWithState: optional(values, 'mock_outputs_merge_with_state', value => toGoBool(value, where, 'mock_outputs_merge_with_state')),
		mockOutputsMergeStrategyWithState: optional(values, 'mock_outputs_merge_strategy_with_state', value => toGoString(value, where, 'mock_outputs_merge_strategy_with_state'))
	};
}

const IF_EXISTS = ['error', 'skip', 'overwrite', 'overwrite_terragrunt'];
const IF_DISABLED = ['skip', 'remove', 'remove_terragrunt'];

/** The settings of one `generate`, before Terragrunt checks and completes them. */
interface GenerateBlock {
	name: string;
	path: string;
	ifExists: string;
	ifDisabled?: string;
	commentPrefix?: string;
	contents: string;
	disableSignature?: boolean;
	disable?: boolean;
	hclFmt?: boolean;
	mutable?: boolean;
}

async function decodeGenerateBlock(block: ConfigBlock): Promise<GenerateBlock> {
	const where = block.body.where;
	const name = onlyLabel(block, where);
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['path', 'if_exists', 'if_disabled', 'comment_prefix', 'contents', 'disable_signature', 'disable', 'hcl_fmt', 'mutable'], ['path', 'if_exists', 'contents']);
	const required = (key: string): string => {
		const value = values.get(key);
		return value === undefined ? '' : toGoString(value, where, key);
	};
	return {
		name,
		path: required('path'),
		ifExists: required('if_exists'),
		contents: required('contents'),
		ifDisabled: optional(values, 'if_disabled', value => toGoString(value, where, 'if_disabled')),
		commentPrefix: optional(values, 'comment_prefix', value => toGoString(value, where, 'comment_prefix')),
		disableSignature: optional(values, 'disable_signature', value => toGoBool(value, where, 'disable_signature')),
		disable: optional(values, 'disable', value => toGoBool(value, where, 'disable')),
		hclFmt: optional(values, 'hcl_fmt', value => toGoBool(value, where, 'hcl_fmt')),
		mutable: optional(values, 'mutable', value => toGoBool(value, where, 'mutable'))
	};
}

/** `generate = { name = { ... } }`, which Terragrunt decodes with mapstructure's WeakDecode. */
function decodeGenerateAttribute(value: Plain, where: string): GenerateBlock[] {
	if (!isRecord(value)) throw unsuitable(where, 'generate', 'object required');
	const weakString = (item: Plain, key: string): string => item === undefined || item === null ? '' : toGoString(item, where, key);
	const weakBool = (item: Plain, key: string): boolean | undefined => {
		if (item === undefined || item === null) return undefined;
		if (item instanceof CtyNumber) return !item.isZero();
		if (item === '') return false;
		return toGoBool(item, where, key);
	};
	return Object.entries(value).map(([name, entry]) => {
		if (!isRecord(entry)) throw unsuitable(where, `generate.${name}`, 'object required');
		return {
			name,
			path: weakString(entry.path, 'path'),
			ifExists: weakString(entry.if_exists, 'if_exists'),
			contents: weakString(entry.contents, 'contents'),
			ifDisabled: entry.if_disabled === undefined || entry.if_disabled === null ? undefined : weakString(entry.if_disabled, 'if_disabled'),
			commentPrefix: entry.comment_prefix === undefined || entry.comment_prefix === null ? undefined : weakString(entry.comment_prefix, 'comment_prefix'),
			disableSignature: weakBool(entry.disable_signature, 'disable_signature'),
			disable: weakBool(entry.disable, 'disable'),
			hclFmt: weakBool(entry.hcl_fmt, 'hcl_fmt'),
			mutable: weakBool(entry.mutable, 'mutable')
		};
	});
}

/**
 * The `generate` blocks of one file, checked and completed as ConvertToTerragruntConfig does.
 *
 * @throws Error naming each label given twice, a block without `if_exists`, or an `if_exists` or `if_disabled`
 *   Terragrunt does not know.
 */
function completeGenerate(blocks: GenerateBlock[], unresolved: Set<string>): Map<string, GenerateConfig> {
	const seen = new Set<string>(unresolved);
	const duplicated: string[] = [];
	for (const block of blocks) {
		if (seen.has(block.name)) duplicated.push(block.name);
		seen.add(block.name);
	}
	if (duplicated.length > 0) throw new Error(`Detected generate blocks with the same name: [${duplicated.join(' ')}]`);
	const configs = new Map<string, GenerateConfig>();
	for (const block of blocks) {
		if (block.ifExists === '') throw new Error(`generate block "${block.name}" is missing required attribute "if_exists"`);
		if (!IF_EXISTS.includes(block.ifExists)) {
			throw new Error(`generate config ${block.name} is invalid: Invalid generate config if_exists value: ${block.ifExists}. Valid values are: ${IF_EXISTS.join(', ')}`);
		}
		const ifDisabled = block.ifDisabled ?? 'skip';
		if (!IF_DISABLED.includes(ifDisabled)) {
			throw new Error(`generate config ${block.name} is invalid: Invalid generate config if_disabled value: ${ifDisabled}. Valid values are: ${IF_DISABLED.join(', ')}`);
		}
		configs.set(block.name, {
			path: block.path,
			ifExists: block.ifExists,
			ifDisabled,
			commentPrefix: block.commentPrefix ?? '# ',
			contents: block.contents,
			disableSignature: block.disableSignature ?? false,
			disable: block.disable ?? false,
			hclFmt: block.hclFmt,
			mutable: block.mutable
		});
	}
	return configs;
}

async function decodeFeature(block: ConfigBlock): Promise<FeatureFlag> {
	const name = onlyLabel(block, block.body.where);
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['default']);
	return { name, default: optional(values, 'default', value => value) };
}

async function decodeEngine(block: ConfigBlock): Promise<EngineConfig> {
	const where = block.body.where;
	refuseBlocks(block.body, []);
	const values = await readAttributes(block.body, ['source', 'version', 'type', 'meta'], ['source']);
	const source = values.get('source');
	return {
		source: source === undefined ? '' : toGoString(source, where, 'source'),
		version: optional(values, 'version', value => toGoString(value, where, 'version')),
		type: optional(values, 'type', value => toGoString(value, where, 'type')),
		meta: optional(values, 'meta', value => value)
	};
}

/**
 * The `exclude` block, which Terragrunt evaluates on its own: each of its flags may be a string Go's ParseBool reads.
 * A block reading a value that cannot be known yet is ignored, as Terragrunt ignores it during discovery.
 */
async function decodeExclude(block: ConfigBlock): Promise<ExcludeConfig | undefined> {
	const where = block.body.where;
	refuseBlocks(block.body, []);
	const allowed = ['if', 'actions', 'no_run', 'exclude_dependencies'];
	const values: Attributes = new Map();
	for (const [name, read] of block.body.attributes) {
		if (!allowed.includes(name)) throw new Error(`${where}: Unsupported argument; An argument named "${name}" is not expected here.`);
		const value = await read();
		if (value === UNRESOLVED) return undefined;
		values.set(name, value);
	}
	if (!values.has('if')) throw new Error(`${where}: Missing required argument; The argument "if" is required, but no definition was found.`);
	if (values.get('if') === null) throw new Error(`${where}: Unsuitable value type; Unsuitable value: null value is not allowed`);
	const flag = (name: string): boolean | undefined => {
		const value = values.get(name);
		if (value === undefined || value === null) return undefined;
		if (typeof value === 'string') {
			if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(value)) return true;
			if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(value)) return false;
			throw new Error(`strconv.ParseBool: parsing ${JSON.stringify(value)}: invalid syntax`);
		}
		if (typeof value !== 'boolean') throw new Error(`Invalid exclude block in ${where}: ${name} must be a bool`);
		return value;
	};
	return {
		if: flag('if') ?? false,
		actions: optional(values, 'actions', value => toStringList(value, where, 'actions')),
		excludeDependencies: flag('exclude_dependencies'),
		noRun: flag('no_run')
	};
}

async function decodeErrors(block: ConfigBlock): Promise<ErrorsConfig> {
	const body = block.body;
	refuseBlocks(body, ['retry', 'ignore']);
	await readAttributes(body, []);
	const errors: ErrorsConfig = { retry: undefined, ignore: undefined };
	for (const nested of body.blocks) {
		const where = nested.body.where;
		const label = onlyLabel(nested, where);
		refuseBlocks(nested.body, []);
		const allowed = nested.type === 'retry' ? ['retryable_errors', 'max_attempts', 'sleep_interval_sec'] : ['ignorable_errors', 'message', 'signals'];
		const values = await unlessUnresolved(() => readAttributes(nested.body, allowed, nested.type === 'retry' ? allowed : ['ignorable_errors']));
		if (!values) continue;
		if (nested.type === 'retry') {
			const whole = (name: string): number => {
				const value = values.get(name);
				return value === undefined ? 0 : Number(toGoInt(value, where, name).toString());
			};
			(errors.retry ??= []).push({
				label,
				retryableErrors: optional(values, 'retryable_errors', value => toStringList(value, where, 'retryable_errors')),
				maxAttempts: whole('max_attempts'),
				sleepIntervalSec: whole('sleep_interval_sec')
			});
		} else {
			const signals = values.get('signals');
			if (signals !== undefined && signals !== null && !isRecord(signals)) throw unsuitable(where, 'signals', 'map required');
			(errors.ignore ??= []).push({
				label,
				ignorableErrors: optional(values, 'ignorable_errors', value => toStringList(value, where, 'ignorable_errors')),
				message: optional(values, 'message', value => toGoString(value, where, 'message')) ?? '',
				signals: signals === undefined || signals === null ? undefined : signals
			});
		}
	}
	return errors;
}

/** The names of the attributes a configuration file may set at its top level, besides `inputs`. */
const ROOT_ATTRIBUTES = [
	'terraform_binary', 'terraform_version_constraint', 'terragrunt_version_constraint', 'download_dir', 'prevent_destroy',
	'iam_role', 'iam_assume_role_duration', 'iam_assume_role_session_name', 'iam_web_identity_token', 'generate', 'remote_state'
];

/** The blocks a configuration file may hold. */
const ROOT_BLOCKS = [
	'locals', 'include', 'terraform', 'remote_state', 'dependencies', 'dependency', 'generate', 'feature', 'engine',
	'exclude', 'errors', 'catalog'
];

/**
 * One file's configuration, as ConvertToTerragruntConfig converts what the file holds: before any include is merged
 * into it, and without its locals and inputs, which the caller has.
 *
 * @param body the file.
 * @throws Error for a block or attribute Terragrunt does not take, a value of the wrong type, and each check
 *   ConvertToTerragruntConfig makes.
 */
export async function decodeConfigFile(body: ConfigBody): Promise<TerragruntConfig> {
	const where = body.where;
	refuseBlocks(body, ROOT_BLOCKS);
	const config = emptyTerragruntConfig();
	const values = await readAttributes(body, ROOT_ATTRIBUTES);
	const generate: GenerateBlock[] = [];
	for (const type of ['terraform', 'remote_state', 'dependencies', 'engine', 'errors', 'locals']) singleBlock(body, type);
	if (body.blocks.filter(item => item.type === 'exclude').length > 1) throw new Error(`only one exclude block is allowed found multiple in ${where}`);
	for (const block of body.blocks) {
		switch (block.type) {
			case 'terraform':
				config.terraform = await unlessUnresolved(() => decodeTerraform(block));
				break;
			case 'remote_state':
				config.remoteState = await unlessUnresolved(() => decodeRemoteStateBlock(block));
				break;
			case 'dependencies':
				config.dependencies = await unlessUnresolved(async () => {
					refuseBlocks(block.body, []);
					const paths = (await readAttributes(block.body, ['paths'], ['paths'])).get('paths');
					return { paths: toStringList(paths, block.body.where, 'paths') };
				});
				break;
			case 'dependency': {
				const dependency = await unlessUnresolved(() => decodeDependency(block));
				if (dependency) config.dependencyBlocks.push(dependency);
				break;
			}
			case 'generate': {
				const entry = await unlessUnresolved(() => decodeGenerateBlock(block));
				if (entry) generate.push(entry);
				else config.unresolvedGenerate.add(onlyLabel(block, where));
				break;
			}
			case 'feature':
				(config.featureFlags ??= []).push(await decodeFeature(block));
				break;
			case 'engine':
				config.engine = await unlessUnresolved(() => decodeEngine(block));
				break;
			case 'exclude':
				config.exclude = await decodeExclude(block);
				break;
			case 'errors':
				config.errors = await decodeErrors(block);
				break;
			default:
				// locals and include are read before the rest, catalog only by `terragrunt catalog`.
				break;
		}
	}
	const text = (name: string): string | undefined => optional(values, name, value => toGoString(value, where, name));
	config.terraformBinary = text('terraform_binary') ?? '';
	config.terraformVersionConstraint = text('terraform_version_constraint') ?? '';
	config.terragruntVersionConstraint = text('terragrunt_version_constraint') ?? '';
	config.downloadDir = text('download_dir') ?? '';
	config.iamRole = text('iam_role') ?? '';
	config.iamAssumeRoleSessionName = text('iam_assume_role_session_name') ?? '';
	config.iamWebIdentityToken = text('iam_web_identity_token') ?? '';
	config.preventDestroy = optional(values, 'prevent_destroy', value => toGoBool(value, where, 'prevent_destroy'));
	config.iamAssumeRoleDuration = optional(values, 'iam_assume_role_duration', value => toGoInt(value, where, 'iam_assume_role_duration'));
	const remoteStateAttribute = values.get('remote_state');
	if (remoteStateAttribute !== undefined && remoteStateAttribute !== null) {
		config.remoteState = decodeRemoteStateAttribute(remoteStateAttribute, where);
	}
	const generateAttribute = values.get('generate');
	if (generateAttribute !== undefined && generateAttribute !== null) generate.push(...decodeGenerateAttribute(generateAttribute, where));
	config.generate = completeGenerate(generate, config.unresolvedGenerate);
	return config;
}

/** The blocks of a JSON configuration, and how each is written there: one body, or bodies by label. */
const JSON_BLOCKS: Record<string, Record<string, 'single' | 'labelled'>> = {
	'': {
		locals: 'single', include: 'labelled', terraform: 'single', dependencies: 'single', dependency: 'labelled',
		feature: 'labelled', engine: 'single', exclude: 'single', errors: 'single', catalog: 'single'
	},
	terraform: { extra_arguments: 'labelled', before_hook: 'labelled', after_hook: 'labelled', error_hook: 'labelled' },
	errors: { retry: 'labelled', ignore: 'labelled' }
};

/**
 * Refuses a string of a JSON configuration that holds a template sequence: HCL evaluates `${` and `%{` in a JSON
 * string as it does in HCL, and a JSON configuration is read here as the literal values it holds.
 */
function literalJson(value: Plain, where: string): Plain {
	if (typeof value === 'string') {
		let literal = '';
		for (let index = 0; index < value.length; index++) {
			const character = value[index];
			if ((character === '$' || character === '%') && value[index + 1] === character && value[index + 2] === '{') {
				literal += `${character}{`;
				index += 2;
			} else if ((character === '$' || character === '%') && value[index + 1] === '{') {
				throw new Error(`${where}: template sequences in a JSON configuration are not evaluated: ${JSON.stringify(value)}`);
			} else {
				literal += character;
			}
		}
		return literal;
	}
	if (Array.isArray(value)) return value.map(item => literalJson(item, where));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literalJson(item, where)]));
	return value;
}

/** A body of a JSON configuration, `blocks` naming which of its keys are blocks. */
function jsonBody(value: Record<string, Plain>, where: string, blocks: Record<string, 'single' | 'labelled'>): ConfigBody {
	const body: ConfigBody = { where, attributes: new Map(), blocks: [] };
	for (const [key, item] of Object.entries(value)) {
		const kind = blocks[key];
		if (kind === undefined) {
			const literal = literalJson(item, where);
			body.attributes.set(key, async () => literal);
			continue;
		}
		if (!isRecord(item)) throw new Error(`${where}: ${key} must be an object`);
		const nested = JSON_BLOCKS[key] ?? {};
		if (kind === 'single') {
			body.blocks.push({ type: key, labels: [], body: jsonBody(item, `${where}: ${key}`, nested) });
			continue;
		}
		for (const [label, entry] of Object.entries(item)) {
			if (!isRecord(entry)) throw new Error(`${where}: ${key} "${label}" must be an object`);
			body.blocks.push({ type: key, labels: [label], body: jsonBody(entry, `${where}: ${key} "${label}"`, nested) });
		}
	}
	return body;
}

/**
 * The configuration a JSON configuration file holds, whose values are read as written.
 *
 * @param document the file's JSON document.
 * @param where the file, which the messages name.
 * @throws Error for an include, which is not read from a JSON configuration here, for a template sequence, and for
 *   everything {@link decodeConfigFile} refuses.
 */
export async function decodeJsonConfig(document: Plain, where: string): Promise<TerragruntConfig> {
	if (!isRecord(document)) throw new Error('JSON configuration must be an object');
	if ('include' in document) throw new Error(`${where}: include is not read from a JSON configuration`);
	const { inputs, ...rest } = document;
	const config = await decodeConfigFile(jsonBody(rest, where, JSON_BLOCKS['']));
	const locals = rest.locals;
	if (isRecord(locals) && Object.keys(locals).length > 0) config.locals = literalJson(locals, where) as Record<string, Plain>;
	if (inputs !== undefined && inputs !== null) {
		if (!isRecord(inputs)) throw new Error(`${where}: inputs must be an object`);
		config.inputs = literalJson(inputs, where) as Record<string, Plain>;
	}
	return config;
}

/**
 * Merges a value into another as Terragrunt's deepMergeCtyMaps does for a dependency's `mock_outputs` and a feature's
 * `default`: objects key by key, recursively, the source winning; anything else replaced by the source.
 */
function deepMergeValues(target: Plain, source: Plain): Plain {
	if (!isRecord(target) || !isRecord(source)) return source;
	const out: Record<string, Plain> = { ...target };
	for (const [key, value] of Object.entries(source)) out[key] = key in out ? deepMergeValues(out[key], value) : value;
	return out;
}

/** Appends the paths of source that target lacks, as mergeModuleDependencies does. */
function mergeModuleDependencies(target: TerragruntConfig['dependencies'], source: TerragruntConfig['dependencies']): TerragruntConfig['dependencies'] {
	if (!source) return target;
	if (!target) return { paths: [...source.paths] };
	for (const item of source.paths) if (!target.paths.includes(item)) target.paths.push(item);
	return target;
}

/** Lists target's entries, each replaced by source's of the same name, then source's others, as Terragrunt merges by name. */
function mergeByName<T>(target: T[], source: T[], name: (item: T) => string, merge: (into: T, from: T) => T): T[] {
	const order: string[] = [];
	const byName = new Map<string, T>();
	for (const item of target) {
		if (!byName.has(name(item))) order.push(name(item));
		byName.set(name(item), item);
	}
	for (const item of source) {
		const existing = byName.get(name(item));
		if (existing === undefined) order.push(name(item));
		byName.set(name(item), existing === undefined ? item : merge(existing, item));
	}
	return order.map(key => byName.get(key)!);
}

/** A child's hooks or extra_arguments over its parent's: same name replaces in place, a new name goes last. */
function overrideByName<T extends { name: string }>(parent: T[], child: T[]): T[] {
	const result = [...parent];
	for (const item of child) {
		const at = result.findIndex(existing => existing.name === item.name);
		if (at === -1) result.push(item);
		else result[at] = item;
	}
	return result;
}

function mergeTerraformAttributes(target: TerraformConfig, source: TerraformConfig): void {
	if (source.source !== undefined) target.source = source.source;
	if (source.version !== undefined) target.version = source.version;
	if (source.copyTerraformLockFile !== undefined) target.copyTerraformLockFile = source.copyTerraformLockFile;
	if (source.noDotTerragruntCache !== undefined) target.noDotTerragruntCache = source.noDotTerragruntCache;
}

function mergeScalars(target: TerragruntConfig, source: TerragruntConfig): void {
	if (source.downloadDir !== '') target.downloadDir = source.downloadDir;
	if (source.iamRole !== '') target.iamRole = source.iamRole;
	if (source.iamAssumeRoleDuration !== undefined) target.iamAssumeRoleDuration = source.iamAssumeRoleDuration;
	if (source.iamAssumeRoleSessionName !== '') target.iamAssumeRoleSessionName = source.iamAssumeRoleSessionName;
	if (source.iamWebIdentityToken !== '') target.iamWebIdentityToken = source.iamWebIdentityToken;
	if (source.terraformVersionConstraint !== '') target.terraformVersionConstraint = source.terraformVersionConstraint;
	if (source.terraformBinary !== '') target.terraformBinary = source.terraformBinary;
	if (source.preventDestroy !== undefined) target.preventDestroy = source.preventDestroy;
	if (source.terragruntVersionConstraint !== '') target.terragruntVersionConstraint = source.terragruntVersionConstraint;
}

/** The hooks and extra_arguments of source over target's, which both merges do alike. */
function mergeTerraformLists(target: TerraformConfig, source: TerraformConfig): void {
	target.extraArguments = overrideByName(target.extraArguments, source.extraArguments);
	target.beforeHooks = overrideByName(target.beforeHooks, source.beforeHooks);
	target.afterHooks = overrideByName(target.afterHooks, source.afterHooks);
	target.errorHooks = overrideByName(target.errorHooks, source.errorHooks);
}

/**
 * Merges source into target shallowly, source winning, as TerragruntConfig.Merge does. Locals and inputs are not
 * merged here: locals never are, and the caller merges inputs.
 *
 * @throws Error when both hold a generate block of the same name.
 */
export function mergeShallow(target: TerragruntConfig, source: TerragruntConfig): void {
	mergeScalars(target, source);
	if (source.engine) target.engine = { ...source.engine };
	if (source.exclude) target.exclude = { ...source.exclude };
	if (source.errors) target.errors = cloneErrors(source.errors);
	if (source.remoteState) target.remoteState = source.remoteState;
	if (source.terraform) {
		if (!target.terraform) {
			target.terraform = source.terraform;
		} else {
			mergeTerraformAttributes(target.terraform, source.terraform);
			mergeTerraformLists(target.terraform, source.terraform);
		}
	}
	target.dependencyBlocks = mergeByName(target.dependencyBlocks, source.dependencyBlocks, dependency => dependency.name, (_, from) => from);
	target.dependencies = mergeModuleDependencies(target.dependencies, source.dependencies);
	if (target.featureFlags !== undefined || source.featureFlags !== undefined) {
		target.featureFlags = mergeByName(target.featureFlags ?? [], source.featureFlags ?? [], flag => flag.name, (_, from) => from);
	}
	const sourceLabels = new Set([...source.generate.keys(), ...source.unresolvedGenerate]);
	const duplicated = [...target.generate.keys(), ...target.unresolvedGenerate].filter(name => sourceLabels.has(name));
	if (duplicated.length > 0) throw new Error(`Detected generate blocks with the same name: [${duplicated.join(' ')}]`);
	for (const [name, generate] of source.generate) target.generate.set(name, generate);
	for (const name of source.unresolvedGenerate) target.unresolvedGenerate.add(name);
}

function cloneErrors(errors: ErrorsConfig): ErrorsConfig {
	return {
		retry: errors.retry?.map(block => ({ ...block, retryableErrors: block.retryableErrors && [...block.retryableErrors] })),
		ignore: errors.ignore?.map(block => ({ ...block, ignorableErrors: block.ignorableErrors && [...block.ignorableErrors], signals: block.signals && { ...block.signals } }))
	};
}

/** Each entry of the first list, then each of the second the first lacks, as util.MergeSlices does. */
function mergeSlices(first: string[] | undefined, second: string[] | undefined): string[] | undefined {
	if (first === undefined && second === undefined) return undefined;
	const out = [...(first ?? [])];
	for (const item of second ?? []) if (!out.includes(item)) out.push(item);
	return out;
}

/**
 * The `errors` blocks of both, merged by label as ErrorsConfig.Merge does. Terragrunt collects the merged blocks from
 * a Go map, in no order of its own; they are listed by label.
 */
function mergeErrors(target: ErrorsConfig, source: ErrorsConfig): void {
	const retry = new Map((target.retry ?? []).map(block => [block.label, block]));
	for (const block of source.retry ?? []) {
		const existing = retry.get(block.label);
		if (!existing) {
			retry.set(block.label, block);
			continue;
		}
		existing.retryableErrors = mergeSlices(existing.retryableErrors, block.retryableErrors);
		if (block.maxAttempts > 0) existing.maxAttempts = block.maxAttempts;
		if (block.sleepIntervalSec > 0) existing.sleepIntervalSec = block.sleepIntervalSec;
	}
	const ignore = new Map((target.ignore ?? []).map(block => [block.label, block]));
	for (const block of source.ignore ?? []) {
		const existing = ignore.get(block.label);
		if (!existing) {
			ignore.set(block.label, block);
			continue;
		}
		existing.ignorableErrors = mergeSlices(existing.ignorableErrors, block.ignorableErrors);
		if (block.message !== '') existing.message = block.message;
		if (block.signals) existing.signals = { ...existing.signals, ...block.signals };
	}
	const byLabel = <T extends { label: string }>(blocks: Map<string, T>): T[] => [...blocks.values()].sort((left, right) => compareBytes(left.label, right.label));
	target.retry = byLabel(retry);
	target.ignore = byLabel(ignore);
}

/**
 * Merges source into target deeply, source winning, as TerragruntConfig.DeepMerge does. Locals and inputs are not
 * merged here.
 */
export function mergeDeep(target: TerragruntConfig, source: TerragruntConfig): void {
	mergeScalars(target, source);
	if (source.engine) {
		const engine = target.engine ?? { source: '' };
		if (source.engine.source !== '') engine.source = source.engine.source;
		if (source.engine.version !== undefined) engine.version = source.engine.version;
		if (source.engine.type !== undefined) engine.type = source.engine.type;
		if (source.engine.meta !== undefined) engine.meta = source.engine.meta;
		target.engine = engine;
	}
	if (source.exclude) {
		const exclude = target.exclude ?? { if: false, actions: undefined };
		exclude.if = source.exclude.if;
		if ((source.exclude.actions ?? []).length > 0) exclude.actions = source.exclude.actions;
		exclude.excludeDependencies = source.exclude.excludeDependencies;
		exclude.noRun = source.exclude.noRun;
		target.exclude = exclude;
	}
	if (source.errors) {
		target.errors ??= { retry: undefined, ignore: undefined };
		mergeErrors(target.errors, source.errors);
	}
	target.dependencies = mergeModuleDependencies(target.dependencies, source.dependencies);
	target.dependencyBlocks = mergeByName(target.dependencyBlocks, source.dependencyBlocks, dependency => dependency.name, deepMergeDependency);
	if (target.featureFlags !== undefined || source.featureFlags !== undefined) {
		target.featureFlags = mergeByName(target.featureFlags ?? [], source.featureFlags ?? [], flag => flag.name, (into, from) => ({
			name: from.name || into.name,
			default: from.default === undefined ? into.default : into.default === undefined ? from.default : deepMergeValues(into.default, from.default)
		}));
	}
	if (source.terraform) {
		if (!target.terraform) {
			target.terraform = source.terraform;
		} else {
			mergeTerraformAttributes(target.terraform, source.terraform);
			if (source.terraform.includeInCopy !== undefined) target.terraform.includeInCopy = [...source.terraform.includeInCopy, ...(target.terraform.includeInCopy ?? [])];
			if (source.terraform.excludeFromCopy !== undefined) target.terraform.excludeFromCopy = [...source.terraform.excludeFromCopy, ...(target.terraform.excludeFromCopy ?? [])];
			mergeTerraformLists(target.terraform, source.terraform);
		}
	}
	if (source.remoteState) target.remoteState = source.remoteState;
	for (const [name, generate] of source.generate) {
		target.generate.set(name, generate);
		target.unresolvedGenerate.delete(name);
	}
	for (const name of source.unresolvedGenerate) {
		target.generate.delete(name);
		target.unresolvedGenerate.add(name);
	}
}

/** A dependency block merged deeply into another of its name, as Dependency.DeepMerge does. */
function deepMergeDependency(into: Dependency, from: Dependency): Dependency {
	const merged: Dependency = { ...into };
	if (typeof from.configPath === 'string' && from.configPath !== '') merged.configPath = from.configPath;
	if (from.enabled !== undefined) merged.enabled = from.enabled;
	if (from.skipOutputs !== undefined) merged.skipOutputs = from.skipOutputs;
	if (from.mockOutputs !== undefined) merged.mockOutputs = merged.mockOutputs === undefined ? from.mockOutputs : deepMergeValues(merged.mockOutputs, from.mockOutputs);
	if (from.mockOutputsAllowedTerraformCommands !== undefined) {
		merged.mockOutputsAllowedTerraformCommands = merged.mockOutputsAllowedTerraformCommands === undefined
			? from.mockOutputsAllowedTerraformCommands
			: [...merged.mockOutputsAllowedTerraformCommands, ...from.mockOutputsAllowedTerraformCommands];
	}
	return merged;
}

/** Orders strings by their UTF-8 bytes, as Go compares them. */
export function compareBytes(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * A value carried through JSON as Terragrunt carries inputs, locals and the backend's settings: each number read back
 * from its decimal text with go-cty's 512-bit precision.
 */
export function throughJson(value: Plain): Plain {
	if (value instanceof CtyNumber) return value.isInfinite() ? value : CtyNumber.parse(value.toString());
	if (Array.isArray(value)) return value.map(throughJson);
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, throughJson(item)]));
	return value;
}

function nullable<T>(value: T | undefined): T | null {
	return value === undefined ? null : value;
}

function hookAsCty(hook: Hook): Record<string, Plain> {
	return {
		if: nullable(hook.if),
		run_on_error: nullable(hook.runOnError),
		suppress_stdout: nullable(hook.suppressStdout),
		working_dir: nullable(hook.workingDir),
		name: hook.name,
		commands: nullable(hook.commands),
		execute: nullable(hook.execute)
	};
}

function errorHookAsCty(hook: ErrorHook): Record<string, Plain> {
	return {
		suppress_stdout: nullable(hook.suppressStdout),
		working_dir: nullable(hook.workingDir),
		name: hook.name,
		commands: nullable(hook.commands),
		execute: nullable(hook.execute),
		on_errors: nullable(hook.onErrors)
	};
}

function byName<T extends { name: string }>(items: T[], convert: (item: T) => Record<string, Plain>): Record<string, Plain> {
	const out: Record<string, Plain> = {};
	for (const item of items) out[item.name] = convert(item);
	return out;
}

/** The `terraform` block as terraformConfigAsCty gives it. */
export function terraformAsCty(terraform: TerraformConfig): Record<string, Plain> {
	const out: Record<string, Plain> = {
		extra_arguments: byName(terraform.extraArguments, argument => ({
			arguments: nullable(argument.arguments),
			required_var_files: nullable(argument.requiredVarFiles),
			optional_var_files: nullable(argument.optionalVarFiles),
			env_vars: nullable(argument.envVars),
			name: argument.name,
			commands: nullable(argument.commands)
		})),
		source: nullable(terraform.source),
		include_in_copy: nullable(terraform.includeInCopy),
		exclude_from_copy: nullable(terraform.excludeFromCopy),
		copy_terraform_lock_file: nullable(terraform.copyTerraformLockFile),
		before_hook: byName(terraform.beforeHooks, hookAsCty),
		after_hook: byName(terraform.afterHooks, hookAsCty),
		error_hook: byName(terraform.errorHooks, errorHookAsCty)
	};
	if (terraform.updateSourceWithCas !== undefined) out.update_source_with_cas = terraform.updateSourceWithCas;
	if (terraform.mutable !== undefined) out.mutable = terraform.mutable;
	if (terraform.version !== undefined) out.version = terraform.version;
	if (terraform.noDotTerragruntCache !== undefined) out.no_dot_terragrunt_cache = terraform.noDotTerragruntCache;
	return out;
}

/** The `remote_state` as RemoteStateAsCty gives it. */
export function remoteStateAsCty(state: RemoteState): Record<string, Plain> {
	return {
		backend: state.backend,
		disable_init: state.disableInit,
		disable_dependency_optimization: state.disableDependencyOptimization,
		generate: state.generate ? { path: state.generate.path, if_exists: state.generate.ifExists } : null,
		config: state.config === undefined ? null : throughJson(state.config),
		encryption: state.encryption === undefined ? null : throughJson(state.encryption)
	};
}

/** A dependency block as GoTypeToCty gives it. */
export function dependencyAsCty(dependency: Dependency): Record<string, Plain> {
	return {
		config_path: dependency.configPath,
		enabled: nullable(dependency.enabled),
		skip: nullable(dependency.skipOutputs),
		mock_outputs: nullable(dependency.mockOutputs),
		mock_outputs_allowed_terraform_commands: nullable(dependency.mockOutputsAllowedTerraformCommands),
		mock_outputs_merge_with_state: nullable(dependency.mockOutputsMergeWithState),
		mock_outputs_merge_strategy_with_state: nullable(dependency.mockOutputsMergeStrategyWithState),
		outputs: nullable(dependency.outputs),
		inputs: null,
		name: dependency.name
	};
}

/** A generate block as GoTypeToCty gives it. */
export function generateAsCty(generate: GenerateConfig): Record<string, Plain> {
	return {
		hcl_fmt: nullable(generate.hclFmt),
		mutable: nullable(generate.mutable),
		path: generate.path,
		if_exists: generate.ifExists,
		if_disabled: generate.ifDisabled,
		comment_prefix: generate.commentPrefix,
		contents: generate.contents,
		disable_signature: generate.disableSignature,
		disable: generate.disable
	};
}

/**
 * The configuration as TerragruntConfigAsCty gives it, which `render --json` prints and `read_terragrunt_config()`
 * returns.
 */
export function terragruntConfigAsCty(config: TerragruntConfig): Record<string, Plain> {
	const out: Record<string, Plain> = {
		terraform_binary: config.terraformBinary,
		terraform_version_constraint: config.terraformVersionConstraint,
		terragrunt_version_constraint: config.terragruntVersionConstraint,
		download_dir: config.downloadDir,
		iam_role: config.iamRole,
		iam_assume_role_session_name: config.iamAssumeRoleSessionName,
		iam_web_identity_token: config.iamWebIdentityToken,
		dependencies: config.dependencies ? { paths: config.dependencies.paths } : null,
		dependency: byName(config.dependencyBlocks, dependencyAsCty),
		generate: Object.fromEntries([...config.generate].map(([name, generate]) => [name, generateAsCty(generate)])),
		iam_assume_role_duration: nullable(config.iamAssumeRoleDuration),
		inputs: config.inputs === undefined ? null : throughJson(config.inputs),
		locals: config.locals === undefined ? null : throughJson(config.locals),
		feature: byName(config.featureFlags ?? [], flag => ({ default: nullable(flag.default), name: flag.name }))
	};
	if (config.engine) {
		out.engine = { meta: nullable(config.engine.meta), source: config.engine.source, version: config.engine.version ?? '', type: config.engine.type ?? '' };
	}
	if (config.exclude) {
		out.exclude = {
			actions: nullable(config.exclude.actions),
			if: config.exclude.if,
			no_run: config.exclude.noRun ?? false,
			exclude_dependencies: config.exclude.excludeDependencies ?? false
		};
	}
	if (config.errors) {
		const errors: Record<string, Plain> = {
			retry: config.errors.retry === undefined ? null : config.errors.retry.map(block => ({
				name: block.label,
				retryable_errors: nullable(block.retryableErrors),
				max_attempts: CtyNumber.fromInt64(block.maxAttempts),
				sleep_interval_sec: CtyNumber.fromInt64(block.sleepIntervalSec)
			}))
		};
		if ((config.errors.ignore ?? []).length > 0) {
			errors.ignore = config.errors.ignore!.map(block => ({
				name: block.label,
				ignorable_errors: block.ignorableErrors ?? [],
				message: block.message,
				signals: block.signals && Object.keys(block.signals).length > 0 ? block.signals : {}
			}));
		}
		out.errors = errors;
	}
	if (config.terraform) out.terraform = terraformAsCty(config.terraform);
	if (config.remoteState) out.remote_state = remoteStateAsCty(config.remoteState);
	if (config.preventDestroy !== undefined) out.prevent_destroy = config.preventDestroy;
	return out;
}

/*
 * The go-cty types of what TerragruntConfigAsCty gives, which `read_terragrunt_config()` returns: a field Terragrunt
 * holds in a Go struct has the type gocty implies for it, a slice a list and a map a map, and a nil one a null of that
 * type; a field it carries through JSON (locals, inputs, the backend's settings) holds objects and tuples; and a field
 * it holds as a cty.Value (a dependency's mock outputs and outputs, a feature's default, the engine's meta) has the
 * type of the value written or read.
 */

const stringList = listOf(ctyString);
const typedObject = (attributes: Record<string, CtyType>): CtyType => objectOf(new Map(Object.entries(attributes)));

const hookType = typedObject({ if: ctyBool, run_on_error: ctyBool, suppress_stdout: ctyBool, working_dir: ctyString, name: ctyString, commands: stringList, execute: stringList });
const errorHookType = typedObject({ suppress_stdout: ctyBool, working_dir: ctyString, name: ctyString, commands: stringList, execute: stringList, on_errors: stringList });
const extraArgumentsType = typedObject({ arguments: stringList, required_var_files: stringList, optional_var_files: stringList, env_vars: mapOf(ctyString), name: ctyString, commands: stringList });
const generateType = typedObject({ hcl_fmt: ctyBool, mutable: ctyBool, path: ctyString, if_exists: ctyString, if_disabled: ctyString, comment_prefix: ctyString, contents: ctyString, disable_signature: ctyBool, disable: ctyBool });

/** Each attribute's type; the dynamic pseudo-type for a field whose type is that of its value, which {@link FieldValue} gives. */
const configType = typedObject({
	terraform_binary: ctyString,
	terraform_version_constraint: ctyString,
	terragrunt_version_constraint: ctyString,
	download_dir: ctyString,
	iam_role: ctyString,
	iam_assume_role_session_name: ctyString,
	iam_web_identity_token: ctyString,
	dependencies: typedObject({ paths: stringList }),
	dependency: ctyDynamic,
	generate: mapOf(generateType),
	iam_assume_role_duration: ctyNumber,
	inputs: ctyDynamic,
	locals: ctyDynamic,
	feature: ctyDynamic,
	engine: typedObject({ meta: ctyDynamic, source: ctyString, version: ctyString, type: ctyString }),
	exclude: typedObject({ actions: stringList, if: ctyBool, no_run: ctyBool, exclude_dependencies: ctyBool }),
	errors: typedObject({
		retry: listOf(typedObject({ name: ctyString, retryable_errors: stringList, max_attempts: ctyNumber, sleep_interval_sec: ctyNumber })),
		ignore: ctyDynamic
	}),
	terraform: typedObject({
		extra_arguments: mapOf(extraArgumentsType),
		source: ctyString,
		include_in_copy: stringList,
		exclude_from_copy: stringList,
		copy_terraform_lock_file: ctyBool,
		before_hook: mapOf(hookType),
		after_hook: mapOf(hookType),
		error_hook: mapOf(errorHookType),
		update_source_with_cas: ctyBool,
		mutable: ctyBool,
		version: ctyString,
		no_dot_terragrunt_cache: ctyBool
	}),
	remote_state: typedObject({
		backend: ctyString,
		disable_init: ctyBool,
		disable_dependency_optimization: ctyBool,
		generate: typedObject({ path: ctyString, if_exists: ctyString }),
		config: ctyDynamic,
		encryption: ctyDynamic
	}),
	prevent_destroy: ctyBool
});

const dependencyType = typedObject({
	config_path: ctyDynamic,
	enabled: ctyBool,
	skip: ctyBool,
	mock_outputs: ctyDynamic,
	mock_outputs_allowed_terraform_commands: stringList,
	mock_outputs_merge_with_state: ctyBool,
	mock_outputs_merge_strategy_with_state: ctyString,
	outputs: ctyDynamic,
	inputs: ctyDynamic,
	name: ctyString
});
const featureType = typedObject({ default: ctyDynamic, name: ctyString });
const ignoreType = typedObject({ name: ctyString, ignorable_errors: stringList, message: ctyString, signals: ctyDynamic });

/**
 * The value of a field held as a cty.Value: the one an evaluation gave for it, by its path such as
 * `dependency.vpc.mock_outputs`, when what the configuration holds is that value; a value merged from several, which
 * Terragrunt merges through JSON, holds objects and tuples.
 */
export type FieldValue = (field: string, plain: Plain) => RuntimeValue<ValueType> | undefined;

/**
 * The configuration as `read_terragrunt_config()` returns it: what {@link terragruntConfigAsCty} gives, with the go-cty
 * type Terragrunt gives each field.
 *
 * @param config the configuration.
 * @param written the values the evaluation gave for the fields Terragrunt holds as cty.Values.
 */
export function terragruntConfigValue(config: TerragruntConfig, written: FieldValue): RuntimeValue<ValueType> {
	return typedField(terragruntConfigAsCty(config), configType, '', written);
}

function typedField(plain: Plain, type: CtyType, field: string, written: FieldValue): RuntimeValue<ValueType> {
	if (type.kind === 'dynamic') return dynamicField(plain, field, written);
	if (plain === null) return makeNullValue(type);
	switch (type.kind) {
		case 'string':
			return makeStringValue(plain as string);
		case 'number':
			return makeNumberValue(plain instanceof CtyNumber ? plain : CtyNumber.fromInt64(plain as number));
		case 'bool':
			return makeBooleanValue(plain as boolean);
		case 'list':
			return makeListValue(type.element, (plain as Plain[]).map((item, index) => typedField(item, type.element, `${field}.${index}`, written)));
		case 'map':
			return makeMapValue(type.element, new Map(Object.entries(plain as Record<string, Plain>).map(([key, item]) => [key, typedField(item, type.element, `${field}.${key}`, written)])));
		case 'object': {
			const attributes = new Map<string, RuntimeValue<ValueType>>();
			for (const [name, item] of Object.entries(plain as Record<string, Plain>)) {
				const attribute = type.attributes.get(name);
				if (attribute === undefined) throw new TypeError(`TerragruntConfigAsCty has no attribute ${field ? `${field}.` : ''}${name}`);
				attributes.set(name, typedField(item, attribute, field ? `${field}.${name}` : name, written));
			}
			return makeObjectValue(attributes);
		}
		default:
			throw new TypeError(`TerragruntConfigAsCty holds no field of type ${type.kind}`);
	}
}

/** Whether two plain values are the same value, whatever the order of their keys. */
export function samePlain(left: Plain, right: Plain): boolean {
	const canonical = (value: Plain): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort(compareBytes).map(key => [key, canonical(value[key])]));
		return value instanceof CtyNumber ? `n:${value.toString()}` : value;
	};
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** A field whose type is that of the value it holds. */
function dynamicField(plain: Plain, field: string, written: FieldValue): RuntimeValue<ValueType> {
	const byName = (type: CtyType): RuntimeValue<ValueType> => makeObjectValue(new Map(Object.entries(plain as Record<string, Plain>)
		.map(([name, item]) => [name, typedField(item, type, `${field}.${name}`, written)])));
	switch (field) {
		case 'dependency':
			return byName(dependencyType);
		case 'feature':
			return byName(featureType);
		case 'errors.ignore':
			return makeArrayValue((plain as Plain[]).map((item, index) => typedField(item, ignoreType, `${field}.${index}`, written)));
		default:
			break;
	}
	if (/^errors\.ignore\.\d+\.signals$/u.test(field) && isRecord(plain) && Object.keys(plain).length === 0) return makeMapValue(ctyDynamic, new Map());
	const asWritten = /^(dependency\.[^.]+\.(config_path|mock_outputs|outputs)|feature\.[^.]+\.default|engine\.meta)$/u.test(field);
	return (asWritten ? written(field, plain) : undefined) ?? convertToRuntimeValue(plain);
}
