/*
 * This file ports `TerragruntConfig.WriteTo` from Terragrunt v1.2.2 (pkg/config/config.go,
 * https://github.com/gruntwork-io/terragrunt, MIT License) and hclwrite's `TokensForValue` from
 * https://github.com/hashicorp/hcl (Copyright IBM Corp. 2014, 2026), which is subject to the terms of the Mozilla
 * Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at
 * https://mozilla.org/MPL/2.0/.
 *
 * `terragrunt render` writes a unit's configuration as HCL by building an hclwrite file from it, one block or
 * attribute per field that is set, each value written as hclwrite writes a constant, and laying the file out with
 * hclwrite's formatter.
 */

import { CtyNumber } from './cty-number';
import { isGoPrint } from './go-quote';
import { layOutHclTokens } from './hcl-format';
import { type HclTokenType, scanHclTokens } from './hcl-scanner';
import type { Dependency, ErrorHook, ExtraArguments, GenerateConfig, Hook, Plain, SourceBlock, TerragruntConfig } from './terragrunt-config';
import { compareBytes, dependencyAsCty, dependencyGroups, terragruntConfigAsCty } from './terragrunt-config';

interface Token {
	type: HclTokenType;
	text: string;
}

/** What hclwrite's ValidIdentifier accepts: one identifier token and nothing else. */
const identifier = /^[\p{ID_Start}_][\p{ID_Continue}-]*$/u;

function isRecord(value: Plain): value is Record<string, Plain> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof CtyNumber);
}

/** A string as hclwrite's escapeQuotedStringLit writes it between quotes. */
function escapeQuoted(text: string): string {
	let out = '';
	const characters = [...text];
	for (let index = 0; index < characters.length; index++) {
		const character = characters[index];
		switch (character) {
			case '\n': out += '\\n'; break;
			case '\r': out += '\\r'; break;
			case '\t': out += '\\t'; break;
			case '"': out += '\\"'; break;
			case '\\': out += '\\\\'; break;
			case '$':
			case '%':
				// A template introducer is escaped by doubling its symbol.
				out += characters[index + 1] === '{' ? character + character : character;
				break;
			default: {
				if (isGoPrint(character)) {
					out += character;
					break;
				}
				const code = character.codePointAt(0)!;
				out += code < 0x10000 ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`;
			}
		}
	}
	return out;
}

/** The tokens of a quoted string, as TokensForValue gives them: no literal token for an empty one. */
function stringTokens(text: string, out: Token[]): void {
	out.push({ type: 'OQuote', text: '"' });
	if (text !== '') out.push({ type: 'QuotedLit', text: escapeQuoted(text) });
	out.push({ type: 'CQuote', text: '"' });
}

/**
 * The tokens of a constant, as hclwrite's appendTokensForValue gives them: an object's or map's attributes in the
 * order of their bytes, each name bare when it is an identifier and quoted otherwise, a number in plain decimal.
 *
 * @throws Error for a value cty has no constant for.
 */
function valueTokens(value: Plain, out: Token[]): void {
	if (value === null) {
		out.push({ type: 'Ident', text: 'null' });
	} else if (typeof value === 'boolean') {
		out.push({ type: 'Ident', text: value ? 'true' : 'false' });
	} else if (value instanceof CtyNumber) {
		out.push({ type: 'NumberLit', text: value.text('f', -1) });
	} else if (typeof value === 'string') {
		stringTokens(value, out);
	} else if (Array.isArray(value)) {
		out.push({ type: 'OBrack', text: '[' });
		value.forEach((item, index) => {
			if (index > 0) out.push({ type: 'Comma', text: ',' });
			valueTokens(item, out);
		});
		out.push({ type: 'CBrack', text: ']' });
	} else if (isRecord(value)) {
		const keys = Object.keys(value).sort(compareBytes);
		out.push({ type: 'OBrace', text: '{' });
		if (keys.length > 0) out.push({ type: 'Newline', text: '\n' });
		for (const key of keys) {
			if (identifier.test(key)) out.push({ type: 'Ident', text: key });
			else stringTokens(key, out);
			out.push({ type: 'Equal', text: '=' });
			valueTokens(value[key], out);
			out.push({ type: 'Newline', text: '\n' });
		}
		out.push({ type: 'CBrace', text: '}' });
	} else {
		throw new Error(`cannot produce tokens for ${typeof value}`);
	}
}

/** The body of a block or file being built: its items' tokens, in the order they are appended. */
class Body {
	readonly tokens: Token[] = [];

	attribute(name: string, value: Plain): void {
		this.tokens.push({ type: 'Ident', text: name }, { type: 'Equal', text: '=' });
		valueTokens(value, this.tokens);
		this.tokens.push({ type: 'Newline', text: '\n' });
	}

	block(type: string, labels: string[], build: (body: Body) => void): void {
		this.tokens.push({ type: 'Ident', text: type });
		for (const label of labels) stringTokens(label, this.tokens);
		this.tokens.push({ type: 'OBrace', text: '{' }, { type: 'Newline', text: '\n' });
		const body = new Body();
		build(body);
		this.tokens.push(...body.tokens, { type: 'CBrace', text: '}' }, { type: 'Newline', text: '\n' });
	}
}

function attr(value: Plain, name: string): Plain {
	if (!isRecord(value) || !(name in value)) throw new Error(`the rendered configuration has no attribute ${name}`);
	return value[name];
}

function extraArgumentsBlock(body: Body, argument: ExtraArguments, asCty: Plain): void {
	body.block('extra_arguments', [argument.name], block => {
		if (argument.commands !== undefined) block.attribute('commands', attr(asCty, 'commands'));
		if (argument.arguments !== undefined) block.attribute('arguments', attr(asCty, 'arguments'));
		if (argument.requiredVarFiles !== undefined) block.attribute('required_var_files', attr(asCty, 'required_var_files'));
		if (argument.optionalVarFiles !== undefined) block.attribute('optional_var_files', attr(asCty, 'optional_var_files'));
		if (argument.envVars !== undefined) block.attribute('env_vars', attr(asCty, 'env_vars'));
	});
}

function hookBlock(body: Body, type: string, hook: Hook, asCty: Plain): void {
	body.block(type, [hook.name], block => {
		if (hook.if !== undefined) block.attribute('if', attr(asCty, 'if'));
		if (hook.runOnError !== undefined) block.attribute('run_on_error', attr(asCty, 'run_on_error'));
		block.attribute('commands', attr(asCty, 'commands'));
		block.attribute('execute', attr(asCty, 'execute'));
		if (hook.workingDir !== undefined) block.attribute('working_dir', attr(asCty, 'working_dir'));
	});
}

/** An error hook, which runs on the errors it names rather than on a command, so it has no `if` or `run_on_error`. */
function errorHookBlock(body: Body, hook: ErrorHook, asCty: Plain): void {
	body.block('error_hook', [hook.name], block => {
		block.attribute('commands', attr(asCty, 'commands'));
		block.attribute('execute', attr(asCty, 'execute'));
		block.attribute('on_errors', attr(asCty, 'on_errors'));
		if (hook.workingDir !== undefined) block.attribute('working_dir', attr(asCty, 'working_dir'));
	});
}

function dependencyBlock(body: Body, dependency: Dependency): void {
	const asCty = dependencyAsCty(dependency);
	body.block('dependency', [dependency.name], block => {
		block.attribute('config_path', asCty.config_path);
		if (dependency.enabled !== undefined) block.attribute('enabled', dependency.enabled);
		if (dependency.skipOutputs !== undefined) block.attribute('skip_outputs', dependency.skipOutputs);
		if (dependency.mockOutputs !== undefined) block.attribute('mock_outputs', asCty.mock_outputs);
		if (dependency.mockOutputsAllowedTerraformCommands !== undefined) {
			block.attribute('mock_outputs_allowed_terraform_commands', asCty.mock_outputs_allowed_terraform_commands);
		}
		// Terragrunt writes the merge strategy and never mock_outputs_merge_with_state.
		if (dependency.mockOutputsMergeStrategyWithState !== undefined) {
			block.attribute('mock_outputs_merge_strategy_with_state', asCty.mock_outputs_merge_strategy_with_state);
		}
	});
}

/**
 * An expanded dependency block as render writes it, by appendExpansionPreview: the block as it is written, then the
 * elements it expanded into, each as `dependencyBlock` writes it, as lines of a comment set off by a blank line. They
 * stay comments because every element repeats the block's label.
 *
 * @param body the file's body.
 * @param source the block as it is written.
 * @param elements the dependencies it expanded into, in the order they were decoded.
 */
function expansionPreview(body: Body, source: SourceBlock, elements: Dependency[]): void {
	// The block's own tokens, comments and all, end at its closing brace.
	body.tokens.push(...scanHclTokens(source.text).filter(token => token.type !== 'EOF').map(token => ({ type: token.type, text: token.text })));
	const lines = ['Expands to:', ''];
	elements.forEach((dependency, index) => {
		if (index > 0) lines.push('');
		const element = new Body();
		dependencyBlock(element, dependency);
		lines.push(...layOutHclTokens(element.tokens).replace(/\n+$/, '').split('\n'));
	});
	// The first newline ends the block's last line, the second sets the preview off from it.
	body.tokens.push({ type: 'Newline', text: '\n' }, { type: 'Newline', text: '\n' });
	for (const line of lines) body.tokens.push({ type: 'Comment', text: line === '' ? '#\n' : `# ${line}\n` });
	body.tokens.push({ type: 'Newline', text: '\n' });
}

function generateBlock(body: Body, name: string, generate: GenerateConfig): void {
	body.block('generate', [name], block => {
		block.attribute('path', generate.path);
		block.attribute('if_exists', generate.ifExists);
		block.attribute('if_disabled', generate.ifDisabled);
		block.attribute('contents', generate.contents);
		if (generate.commentPrefix !== '# ') block.attribute('comment_prefix', generate.commentPrefix);
		if (generate.disableSignature) block.attribute('disable_signature', true);
		if (generate.disable) block.attribute('disable', true);
		if (generate.hclFmt !== undefined) block.attribute('hcl_fmt', generate.hclFmt);
		if (generate.mutable !== undefined) block.attribute('mutable', generate.mutable);
	});
}

/**
 * The configuration as `terragrunt render` writes it in HCL, by `TerragruntConfig.WriteTo`: the blocks of each field
 * that is set, in a fixed order, then the attributes set at the top level.
 *
 * Terragrunt holds the locals and the generate blocks in Go maps and writes them in the order it iterates them, which
 * changes from run to run; they are written here in the order of their names' bytes.
 *
 * @param config the configuration.
 * @returns the text.
 */
export function terragruntConfigAsHcl(config: TerragruntConfig): string {
	const asCty = terragruntConfigAsCty(config);
	const root = new Body();
	const locals = config.locals;
	if (locals !== undefined && Object.keys(locals).length > 0) {
		const localsAsCty = attr(asCty, 'locals');
		root.block('locals', [], block => {
			for (const name of Object.keys(locals).sort(compareBytes)) block.attribute(name, attr(localsAsCty, name));
		});
	}
	const terraform = config.terraform;
	if (terraform) {
		const terraformAsCty = attr(asCty, 'terraform');
		root.block('terraform', [], block => {
			if (terraform.source !== undefined) block.attribute('source', attr(terraformAsCty, 'source'));
			if (terraform.updateSourceWithCas !== undefined) block.attribute('update_source_with_cas', attr(terraformAsCty, 'update_source_with_cas'));
			if (terraform.mutable !== undefined) block.attribute('mutable', attr(terraformAsCty, 'mutable'));
			for (const argument of terraform.extraArguments) {
				extraArgumentsBlock(block, argument, attr(attr(terraformAsCty, 'extra_arguments'), argument.name));
			}
			for (const hook of terraform.beforeHooks) hookBlock(block, 'before_hook', hook, attr(attr(terraformAsCty, 'before_hook'), hook.name));
			for (const hook of terraform.afterHooks) hookBlock(block, 'after_hook', hook, attr(attr(terraformAsCty, 'after_hook'), hook.name));
			for (const hook of terraform.errorHooks) errorHookBlock(block, hook, attr(attr(terraformAsCty, 'error_hook'), hook.name));
		});
	}
	const remoteState = config.remoteState;
	if (remoteState) {
		const remoteStateAsCty = attr(asCty, 'remote_state');
		root.block('remote_state', [], block => {
			block.attribute('backend', attr(remoteStateAsCty, 'backend'));
			if (remoteState.disableInit) block.attribute('disable_init', attr(remoteStateAsCty, 'disable_init'));
			if (remoteState.disableDependencyOptimization) {
				block.attribute('disable_dependency_optimization', attr(remoteStateAsCty, 'disable_dependency_optimization'));
			}
			if (remoteState.config !== undefined) block.attribute('config', attr(remoteStateAsCty, 'config'));
		});
	}
	if (config.dependencies && config.dependencies.paths.length > 0) {
		const paths = attr(attr(asCty, 'dependencies'), 'paths');
		root.block('dependencies', [], block => block.attribute('paths', paths));
	}
	for (const group of dependencyGroups(config.dependencyBlocks)) {
		if (group.source) expansionPreview(root, group.source, group.dependencies);
		else for (const dependency of group.dependencies) dependencyBlock(root, dependency);
	}
	for (const name of [...config.generate.keys()].sort(compareBytes)) generateBlock(root, name, config.generate.get(name)!);
	for (const flag of config.featureFlags ?? []) {
		const flagAsCty = attr(attr(asCty, 'feature'), flag.name);
		root.block('feature', [flag.name], block => {
			if (flag.default !== undefined) block.attribute('default', attr(flagAsCty, 'default'));
		});
	}
	const engine = config.engine;
	if (engine) {
		const engineAsCty = attr(asCty, 'engine');
		root.block('engine', [], block => {
			if (engine.source !== '') block.attribute('source', attr(engineAsCty, 'source'));
			if (engine.version !== undefined) block.attribute('version', attr(engineAsCty, 'version'));
			if (engine.type !== undefined) block.attribute('type', attr(engineAsCty, 'type'));
			if (engine.meta !== undefined) block.attribute('meta', attr(engineAsCty, 'meta'));
		});
	}
	const exclude = config.exclude;
	if (exclude) {
		const excludeAsCty = attr(asCty, 'exclude');
		root.block('exclude', [], block => {
			if (exclude.excludeDependencies !== undefined) block.attribute('exclude_dependencies', attr(excludeAsCty, 'exclude_dependencies'));
			if ((exclude.actions ?? []).length > 0) block.attribute('actions', attr(excludeAsCty, 'actions'));
			if (exclude.noRun !== undefined) block.attribute('no_run', attr(excludeAsCty, 'no_run'));
			block.attribute('if', attr(excludeAsCty, 'if'));
		});
	}
	const errors = config.errors;
	if (errors) {
		// The retry and ignore values are written from the configuration itself, as Terragrunt writes them.
		root.block('errors', [], block => {
			for (const retry of errors.retry ?? []) {
				block.block('retry', [retry.label], body => {
					if (retry.maxAttempts > 0) body.attribute('max_attempts', CtyNumber.fromInt64(retry.maxAttempts));
					if (retry.sleepIntervalSec > 0) body.attribute('sleep_interval_sec', CtyNumber.fromInt64(retry.sleepIntervalSec));
					if ((retry.retryableErrors ?? []).length > 0) body.attribute('retryable_errors', retry.retryableErrors!);
				});
			}
			for (const ignore of errors.ignore ?? []) {
				block.block('ignore', [ignore.label], body => {
					if ((ignore.ignorableErrors ?? []).length > 0) body.attribute('ignorable_errors', ignore.ignorableErrors!);
					if (ignore.message !== '') body.attribute('message', ignore.message);
					if (ignore.signals !== undefined) body.attribute('signals', ignore.signals);
				});
			}
		});
	}
	if (config.terraformBinary !== '') root.attribute('terraform_binary', attr(asCty, 'terraform_binary'));
	if (config.terraformVersionConstraint !== '') root.attribute('terraform_version_constraint', attr(asCty, 'terraform_version_constraint'));
	if (config.terragruntVersionConstraint !== '') root.attribute('terragrunt_version_constraint', attr(asCty, 'terragrunt_version_constraint'));
	if (config.downloadDir !== '') root.attribute('download_dir', attr(asCty, 'download_dir'));
	if (config.preventDestroy !== undefined) root.attribute('prevent_destroy', attr(asCty, 'prevent_destroy'));
	if (config.iamRole !== '') root.attribute('iam_role', attr(asCty, 'iam_role'));
	if (config.iamAssumeRoleDuration !== undefined) root.attribute('iam_assume_role_duration', attr(asCty, 'iam_assume_role_duration'));
	if (config.iamAssumeRoleSessionName !== '') root.attribute('iam_assume_role_session_name', attr(asCty, 'iam_assume_role_session_name'));
	if (config.inputs !== undefined && Object.keys(config.inputs).length > 0) root.attribute('inputs', attr(asCty, 'inputs'));
	return layOutHclTokens(root.tokens);
}
