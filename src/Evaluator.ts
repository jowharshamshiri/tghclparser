import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { FunctionOperation, invokeFunctionOperation, readArgs, FUNCTION_CONTEXT_KEY } from './function-ops';
import type { InlineFunctionDefinition } from './inline-functions';
import { checkTypeConstraint, readInlineFunction, readTypeConstraint, synthesizeDefinition } from './inline-functions';
import { parse } from './parser';
import { Schema } from './Schema';
import type { FunctionContext, FunctionDefinition, RuntimeValue, ValueType } from './model';
import {
	coerceToBool,
	coerceToString,
	convertToRuntimeValue,
	makeArrayValue,
	makeBooleanValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeStringValue,
	runtimeToPlain,
	unwrapSensitive
} from './functions/utils';

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
	resolveDependency?: (configPath: string, name: string) => Promise<RuntimeValue<ValueType> | undefined>;
}

export interface ConfigEvaluationResult {
	valid: boolean;
	inputs: RuntimeValue<ValueType> | null;
	error?: string;
}

interface IncludeRef {
	expose: boolean;
	mergeStrategy: 'shallow' | 'deep' | 'no_merge';
	dir: string;
	result: FileResult;
}

interface FileResult {
	filePath: string;
	dir: string;
	content: string;
	scope: Scope;
	inputs: Map<string, RuntimeValue<ValueType>> | null;
	hasInputs: boolean;
}

interface Scope {
	filePath: string;
	content: string;
	ast: TNode;
	dir: string;
	workspaceRoot: string;
	locals: Map<string, TNode>;
	localCache: Map<string, RuntimeValue<ValueType> | 'pending'>;
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
	/** Depth of nested inline function calls, bounded by MAX_INLINE_CALL_DEPTH. */
	private inlineCallDepth = 0;
	/**
	 * The files currently being evaluated, outermost first.
	 *
	 * A stack rather than a counter so that a cycle can be REPORTED: the chain
	 * names the files that lead back to the repeat, which is the difference
	 * between "something recursed" and "this unit includes itself".
	 */
	private readonly includeChain: string[] = [];
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
				error: error instanceof Error ? error.message : String(error)
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

		const own = new Set<string>();
		for (const node of declaredInlineFunctions(parse(content, { grammarSource: configPath, tracer: { trace() {} } }))) {
			own.add(String(node.value ?? ''));
		}

		// Breadth-first over the include graph so that nearer declarations are
		// recorded first and never replaced by a same-named one further along,
		// matching the resolution order findInlineFunction uses.
		const queue: string[] = await this.includeTargets(configPath, content, workspaceRoot);

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
				ast = parse(includedContent, { grammarSource: resolved, tracer: { trace() {} } });
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

			queue.push(...await this.includeTargets(resolved, includedContent, workspaceRoot));
		}

		return inherited;
	}

	/**
	 * Absolute paths of the configurations a file includes, plus its
	 * autoinclude when one exists. Include paths are evaluated because they may
	 * be computed — `find_in_parent_folders("root.hcl")` is the common form — but
	 * a path that cannot be resolved is skipped rather than failing the walk.
	 */
	private async includeTargets(filePath: string, content: string, workspaceRoot: string): Promise<string[]> {
		const targets: string[] = [];
		let ast: TNode;
		try {
			ast = parse(content, { grammarSource: filePath, tracer: { trace() {} } });
		} catch {
			return targets;
		}

		const dir = path.dirname(filePath);
		const scope: Scope = {
			filePath,
			content,
			ast,
			dir,
			workspaceRoot,
			locals: new Map(),
			localCache: new Map(),
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

	async evaluateRenderedConfig(configPath: string, content: string, workDir: string): Promise<RuntimeValue<ValueType>> {
		this.assertTrusted('Rendered configuration evaluation');
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		const result = await this.evaluateFile(configPath, content, workspaceRoot);
		return this.readConfigObject(result);
	}

	async evaluateAtPosition(
		configPath: string,
		content: string,
		workDir: string,
		position: { line: number; character: number }
	): Promise<RuntimeValue<ValueType> | undefined> {
		this.assertTrusted('Semantic evaluation');
		const workspaceRoot = await this.resolveWorkspaceRoot(workDir);
		const result = await this.evaluateFile(configPath, content, workspaceRoot);
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

	private nodeWidth(node: TNode): number {
		if (!node.location) return Number.MAX_SAFE_INTEGER;
		return node.location.end.offset - node.location.start.offset;
	}

	private async evaluateFile(filePath: string, content: string, workDir: string): Promise<FileResult> {
		const resolvedPath = path.resolve(filePath);
		const repeatedAt = this.includeChain.indexOf(resolvedPath);
		if (repeatedAt !== -1) {
			const cycle = [...this.includeChain.slice(repeatedAt), resolvedPath];
			throw new Error(`Include cycle: ${cycle.join(' -> ')}`);
		}
		if (this.includeChain.length >= MAX_INCLUDE_DEPTH) {
			throw new Error(
				`Includes nested deeper than ${MAX_INCLUDE_DEPTH} levels, starting at ${this.includeChain[0]}`
			);
		}
		this.includeChain.push(resolvedPath);
		try {
			return await this.evaluateFileUnguarded(filePath, content, workDir);
		} finally {
			this.includeChain.pop();
		}
	}

	private async evaluateFileUnguarded(filePath: string, content: string, workDir: string): Promise<FileResult> {
		const ast = parse(content, { grammarSource: filePath, tracer: { trace() {} } });
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
			workspaceRoot: path.resolve(workDir),
			locals: new Map(),
			localCache: new Map(),
			includes: new Map(),
			autoinclude: null,
			rootAttrs: new Map(),
			terraform: new Map(),
			generate: new Map(),
			blocks,
			comprehension: [],
			functions: new Map()
		};

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
			const nameNode = (block.children ?? []).find(c => c.type === 'parameter');
			const name = nameNode ? String(nameNode.value) : 'root';
			let expose = false;
			let mergeStrategy: IncludeRef['mergeStrategy'] = 'shallow';
			let pathNode: TNode | undefined;
			for (const child of block.children ?? []) {
				if (child.type !== 'attribute') continue;
				const attrName = String(child.value);
				if (attrName === 'path') {
					pathNode = child;
				} else if (attrName === 'expose') {
					expose = coerceToBool(await this.evalNode(requiredValueNode(child), scope));
				} else if (attrName === 'merge_strategy') {
					const value = await this.evalNode(requiredValueNode(child), scope);
					mergeStrategy = value.type === 'string' && (value.value === 'deep' || value.value === 'no_merge') ? value.value : 'shallow';
				}
			}
			if (!pathNode) throw new Error(`include "${name}" in ${filePath} is missing a path attribute`);
			const pathValue = await this.evalNode(requiredValueNode(pathNode), scope);
			if (pathValue.type !== 'string') throw new Error(`include "${name}" in ${filePath} must have a string path`);
			const includePath = path.isAbsolute(String(pathValue.value))
				? String(pathValue.value)
				: path.resolve(dir, String(pathValue.value));
			this.assertTrusted('Included configuration evaluation');
			await this.assertPathAllowed(includePath, scope.workspaceRoot);
			const includeContent = await fs.readFile(includePath, 'utf8');
			const includeResult = await this.evaluateFile(includePath, includeContent, workDir);
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
				scope.autoinclude = await this.evaluateFile(autoPath, autoContent, workDir);
			}
		}

		const inputsAssignment = assignments.find(assignment => String(assignment.value) === 'inputs');
		let ownInputs: Map<string, RuntimeValue<ValueType>> | null = null;
		if (inputsAssignment) {
			const value = await this.evalNode(requiredValueNode(inputsAssignment, 'root_assignment_identifier'), scope);
			if (value.type !== 'object' && value.type !== 'block') {
				throw new Error(`inputs in ${filePath} must evaluate to an object`);
			}
			ownInputs = new Map(value.value as Map<string, RuntimeValue<ValueType>>);
		}

		let mergedInputs: Map<string, RuntimeValue<ValueType>> | null = ownInputs ? new Map(ownInputs) : new Map();
		if (scope.autoinclude?.inputs) {
			for (const [key, value] of scope.autoinclude.inputs) mergedInputs.set(key, value);
		}
		for (const name of [...scope.includes.keys()].reverse()) {
			const include = scope.includes.get(name)!;
			const includeInputs = include.result.inputs;
			if (!includeInputs || include.mergeStrategy === 'no_merge') continue;
			if (include.mergeStrategy === 'deep') {
				mergedInputs = deepMergeInputs(mergedInputs, includeInputs);
			} else {
				const next = new Map(includeInputs);
				for (const [key, value] of mergedInputs) next.set(key, value);
				mergedInputs = next;
			}
		}

		if (ownInputs === null && mergedInputs.size === 0) mergedInputs = null;

		return {
			filePath,
			dir,
			content,
			scope,
			inputs: mergedInputs,
			hasInputs: inputsAssignment !== undefined
		};
	}

	private async makeContext(scope: Scope): Promise<FunctionContext> {
		// A configuration need not live in a Git repository. Functions that
		// genuinely require the repository root resolve it themselves and raise
		// their own error, so resolving it eagerly here would fail evaluations
		// that never ask for it.
		const repoRoot = await this.findRepoRoot(scope.dir);
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
			// that is what a relative `file()` resolves against. These two
			// report the unit being rendered, which differs only for a
			// `generate` block inherited through an include.
			terragruntDir: scope.unitDir ?? scope.dir,
			originalTerragruntDir: scope.unitDir ?? scope.dir,
			includeDir: scope.includes.size > 0 ? [...scope.includes.values()][0].dir : undefined,
			repoRoot,
			readTerragruntConfig: async (relativePath: string) => {
				this.assertTrusted('read_terragrunt_config');
				const target = path.isAbsolute(relativePath) ? relativePath : path.resolve(scope.dir, relativePath);
				await this.assertPathAllowed(target, scope.workspaceRoot);
				if (!(await pathExists(target))) return undefined;
				const fileContent = await fs.readFile(target, 'utf8');
					const result = await this.evaluateFile(target, fileContent, scope.workspaceRoot);
					return this.readConfigObject(result);
			},
			readTFVarsFile: async (relativePath: string) => {
				this.assertTrusted('read_tfvars_file');
				const target = path.isAbsolute(relativePath) ? relativePath : path.resolve(scope.dir, relativePath);
				await this.assertPathAllowed(target, scope.workspaceRoot);
				if (!(await pathExists(target))) return undefined;
				const fileContent = await fs.readFile(target, 'utf8');
					return this.readTFVars(target, fileContent);
			},
			runCommand: async (program: string, args: string[]) => {
				this.assertTrusted('run_cmd');
				const output = execFileSync(program, args, {
					cwd: scope.dir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: 10_000,
					maxBuffer: 1024 * 1024,
					 windowsHide: true
				});
				return output.endsWith('\n') ? output.slice(0, -1) : output;
			},
			evaluateFunction: async (name: string, args: RuntimeValue<ValueType>[]) => {
					if (!this.schema.getFunctionDefinition(name)) throw new Error(`Unknown function ${name}`);
					if (!this.schema.getFunctionRegistry().hasFunction(name)) {
					throw new Error(`Function ${name} has no evaluator`);
				}
					return this.schema.getFunctionRegistry().evaluateFunction(name, args, await this.makeContext(scope));
			}
		};
	}

	/**
	 * Every `generate` block that applies to a unit, by label.
	 *
	 * Inherited through includes, which is the whole reason this is not simply
	 * a read of the unit's own blocks: the near-universal arrangement puts the
	 * blocks in a root configuration and the units include it, so a unit's own
	 * file usually declares none. Rendering only the unit's own left the
	 * generated files unwritten, and OpenTofu then ran against a directory
	 * whose `.tf` files referenced locals nothing had defined -- "Undefined
	 * local local.base_terragrunt_dir", from a `main.tf` that was correct.
	 *
	 * Includes are read first and the unit's own last, so a unit overrides an
	 * inherited block of the same label rather than gaining a second one.
	 * Each block is evaluated in the scope that DECLARED it, because its
	 * contents interpolate that file's locals.
	 */
	private async readGenerateBlocks(result: FileResult): Promise<Map<string, RuntimeValue<ValueType>>> {
		const blocks = new Map<string, RuntimeValue<ValueType>>();
		const collect = async (from: FileResult): Promise<void> => {
			for (const include of from.scope.includes.values()) {
				await collect(include.result);
			}
			if (from.scope.autoinclude) await collect(from.scope.autoinclude);
			// The declaring file's locals, the INCLUDING unit's paths. An
			// inherited block interpolates the root's locals, so it has to be
			// evaluated where they are defined; but `get_terragrunt_dir` and
			// `get_parent_terragrunt_dir` in the same block are questions
			// about the unit being rendered, and the root has no including
			// config of its own to answer the second one with.
			const scope: Scope = from === result
				? from.scope
				: { ...from.scope, unitDir: result.scope.dir, includes: result.scope.includes };
			for (const [label, attributes] of from.scope.generate) {
				const rendered = new Map<string, RuntimeValue<ValueType>>();
				for (const [name, node] of attributes) {
					rendered.set(name, await this.evalNode(node, scope));
				}
				blocks.set(label, makeObjectValue(rendered));
			}
		};
		await collect(result);
		return blocks;
	}

	private async readConfigObject(result: FileResult): Promise<RuntimeValue<ValueType>> {
		const output = new Map<string, RuntimeValue<ValueType>>();
		const locals = new Map<string, RuntimeValue<ValueType>>();
		for (const name of result.scope.locals.keys()) {
			locals.set(name, await this.resolveLocal(result.scope, name));
		}
		output.set('dependencies', makeNullValue());
		output.set('dependency', makeObjectValue(new Map()));
		output.set('download_dir', makeStringValue(''));
		output.set('feature', makeObjectValue(new Map()));
		output.set('generate', makeObjectValue(await this.readGenerateBlocks(result)));
		output.set('iam_assume_role_duration', makeNullValue());
		output.set('iam_assume_role_session_name', makeStringValue(''));
		output.set('iam_role', makeStringValue(''));
		output.set('iam_web_identity_token', makeStringValue(''));
		output.set('terraform_binary', makeStringValue(''));
		output.set('terraform_version_constraint', makeStringValue(''));
		output.set('terragrunt_version_constraint', makeStringValue(''));
		output.set('locals', locals.size > 0 ? makeObjectValue(locals) : makeNullValue());
		output.set('inputs', result.inputs !== null ? makeObjectValue(result.inputs) : makeObjectValue(new Map()));
		const terraform = new Map<string, RuntimeValue<ValueType>>();
		for (const [name, node] of result.scope.terraform) {
			terraform.set(name, await this.evalNode(node, result.scope));
		}
		const terraformDefaults = new Map<string, RuntimeValue<ValueType>>([
			['after_hook', makeObjectValue(new Map())],
			['before_hook', makeObjectValue(new Map())],
			['copy_terraform_lock_file', makeNullValue()],
			['error_hook', makeObjectValue(new Map())],
			['exclude_from_copy', makeNullValue()],
			['extra_arguments', makeObjectValue(new Map())],
			['include_in_copy', makeNullValue()]
		]);
		for (const [name, value] of terraform) terraformDefaults.set(name, value);
		const terraformBlock = result.scope.blocks.find(block => block.value === 'terraform');
		if (terraformBlock) {
			for (const child of terraformBlock.children ?? []) {
				if (child.type !== 'block') continue;
				const name = String(child.value);
				const value = await this.evaluateBlock(child, result.scope);
				const labels = (child.children ?? []).filter(item => item.type === 'parameter').map(item => String(item.value));
				if (labels.length > 0) {
					const current = terraformDefaults.get(name);
					const entries = current && (current.type === 'object' || current.type === 'block') ? new Map(current.value as Map<string, RuntimeValue<ValueType>>) : new Map<string, RuntimeValue<ValueType>>();
					entries.set(labels[0], value);
					terraformDefaults.set(name, makeObjectValue(entries));
				} else {
					terraformDefaults.set(name, value);
				}
			}
		}
		output.set('terraform', makeObjectValue(terraformDefaults));
		for (const block of result.scope.blocks) {
			if (['locals', 'terraform', 'include'].includes(String(block.value))) continue;
			const name = String(block.value);
			const labels = (block.children ?? []).filter(child => child.type === 'parameter').map(child => String(child.value));
			const value = await this.evaluateBlock(block, result.scope);
			if (labels.length > 0) {
				const existing = output.get(name);
				const entries = existing && (existing.type === 'object' || existing.type === 'block')
					? new Map(existing.value as Map<string, RuntimeValue<ValueType>>)
					: new Map<string, RuntimeValue<ValueType>>();
				entries.set(labels[0], value);
				output.set(name, makeObjectValue(entries));
			} else if (!output.has(name) || (output.get(name)?.type === 'object' && (output.get(name)?.value as Map<string, RuntimeValue<ValueType>>).size === 0)) {
				output.set(name, value);
			}
		}
		for (const [name, node] of result.scope.rootAttrs) {
			output.set(name, await this.evalNode(node, result.scope));
		}
		return makeObjectValue(output);
	}

	private async evaluateBlock(block: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const values = new Map<string, RuntimeValue<ValueType>>();
		for (const child of block.children ?? []) {
			if (child.type !== 'attribute') continue;
			const value = child.children?.find(item => item.type !== 'attribute_identifier');
			if (value) values.set(String(child.value), await this.evalNode(value, scope));
		}
		for (const child of block.children ?? []) {
			if (child.type !== 'block') continue;
			const name = String(child.value);
			const value = await this.evaluateBlock(child, scope);
			const labels = (child.children ?? []).filter(item => item.type === 'parameter').map(item => String(item.value));
			if (labels.length > 0) {
				const current = values.get(name);
				const entries = current && (current.type === 'object' || current.type === 'block') ? new Map(current.value as Map<string, RuntimeValue<ValueType>>) : new Map<string, RuntimeValue<ValueType>>();
				entries.set(labels[0], value);
				values.set(name, makeObjectValue(entries));
			} else {
				values.set(name, value);
			}
		}
		return makeObjectValue(values);
	}

	private async readTFVars(target: string, content: string): Promise<RuntimeValue<ValueType>> {
		if (target.endsWith('.tfvars.json')) {
			return makeStringValue(content);
		}
		const ast = parse(content, { grammarSource: target, tracer: { trace() {} } });
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

	/**
	 * Locates the Git repository containing `startDir`, or undefined when the
	 * configuration is not inside a repository. Callers that require a
	 * repository report that themselves.
	 */
	private async findRepoRoot(startDir: string): Promise<string | undefined> {
		let current = path.resolve(startDir);
		while (true) {
			if (await pathExists(path.join(current, '.git'))) return current;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}

	private async resolveLocal(scope: Scope, name: string): Promise<RuntimeValue<ValueType>> {
		const cached = scope.localCache.get(name);
		if (cached === 'pending') throw new Error(`Cycle detected in locals involving "${name}"`);
		if (cached !== undefined) return cached;
		const node = scope.locals.get(name);
		if (!node) throw new Error(`Undefined local value "${name}"`);
		scope.localCache.set(name, 'pending');
		const value = await this.evalNode(node, scope);
		scope.localCache.set(name, value);
		return value;
	}

	private async resolveReference(parts: string[], scope: Scope): Promise<RuntimeValue<ValueType>> {
		if (parts.length === 0) throw new Error('Empty reference');
		const namespace = parts[0];

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
			const dependency = await this.options.resolveDependency?.(scope.filePath, parts[1]);
			if (!dependency) throw new Error(`Dependency "${parts[1]}" has no evaluated outputs`);
			return this.traverse(dependency, parts.slice(2), parts[1]);
		}

		if (parts.length === 1) {
			for (let index = scope.comprehension.length - 1; index >= 0; index--) {
				const frame = scope.comprehension[index];
				if (frame.has(namespace)) return frame.get(namespace)!;
			}
			throw new Error(`Undefined reference "${namespace}"`);
		}

		throw new Error(`Undefined reference "${parts.join('.')}"`);
	}

	private async resolveIncludePath(include: IncludeRef, parts: string[]): Promise<RuntimeValue<ValueType>> {
		if (parts.length === 0) throw new Error('include reference requires a path');
		const head = parts[0];
		const result = include.result;
		if (head === 'locals') {
			if (parts.length < 2) throw new Error('include locals reference requires a name');
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
			if (index.type !== 'number') throw new Error('List index must be a number');
			const items = current.value as RuntimeValue<ValueType>[];
			const position = Number(index.value);
			if (!Number.isInteger(position) || position < 0 || position >= items.length) {
				throw new Error(`List index ${position} out of range`);
			}
			return unwrapSensitive(items[position]);
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

	private async evalNode(node: TNode | undefined, scope: Scope): Promise<RuntimeValue<ValueType>> {
		if (!node) throw new Error('Cannot evaluate an empty expression');
		switch (node.type) {
			case 'string_lit':
				return makeStringValue(String(node.value ?? ''));
			case 'number_lit':
				return makeNumberValue(Number(node.value));
			case 'boolean_lit':
				return makeBooleanValue(Boolean(node.value));
			case 'null_lit':
				return makeNullValue();
			case 'array_lit':
				return makeArrayValue(await Promise.all((node.children ?? []).map(child => this.evalNode(child, scope))));
			case 'object':
				return this.evalObject(node, scope);
			case 'interpolated_string':
				return this.evalInterpolatedString(node, scope);
			case 'interpolation':
				return this.evalNode(node.children?.[0], scope);
			case 'ternary_expression': {
				const [condition, whenTrue, whenFalse] = node.children ?? [];
				const truth = coerceToBool(await this.evalNode(condition, scope));
				return truth ? this.evalNode(whenTrue, scope) : this.evalNode(whenFalse, scope);
			}
			case 'logical_expression': {
				const operator = node.value === undefined ? '' : String(node.value);
				if (operator === '!') {
					return makeBooleanValue(!coerceToBool(await this.evalNode(node.children?.[0], scope)));
				}
				const left = coerceToBool(await this.evalNode(node.children?.[0], scope));
				if (operator === '&&') return makeBooleanValue(left && coerceToBool(await this.evalNode(node.children?.[1], scope)));
				if (operator === '||') return makeBooleanValue(left || coerceToBool(await this.evalNode(node.children?.[1], scope)));
				throw new Error(`Unknown logical operator "${operator}"`);
			}
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
			case 'index_expression':
				return this.indexValue(await this.evalNode(node.children?.[0], scope), await this.evalNode(node.children?.[1], scope));
			case 'range_expression': {
				const start = await this.evalNode(node.children?.[0], scope);
				const end = await this.evalNode(node.children?.[1], scope);
				if (start.type !== 'number' || end.type !== 'number') throw new Error('range requires number arguments');
				const items: RuntimeValue<ValueType>[] = [];
				for (let value = Number(start.value); value < Number(end.value); value++) items.push(makeNumberValue(value));
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
		const map = new Map<string, RuntimeValue<ValueType>>();
		for (const child of node.children ?? []) {
			if (child.type === 'attribute') {
				const keyNode = child.children?.find(c => c.type === 'object_key');
				const key = keyNode
					? coerceToString(await this.evalNode(keyNode.children?.[0], scope))
					: String(child.value);
				const valueNode = child.children?.find(c => c.type !== 'attribute_identifier' && c.type !== 'object_key');
				map.set(key, await this.evalNode(valueNode, scope));
			} else if (child.type === 'inheritance') {
				const source = await this.evalNode(child.children?.[0], scope);
				if (source.type !== 'object' && source.type !== 'block') throw new Error('inherit requires an object source');
				for (const [key, value] of source.value as Map<string, RuntimeValue<ValueType>>) {
					if (!map.has(key)) map.set(key, value);
				}
			}
		}
		return makeObjectValue(map);
	}

	private async evalInterpolatedString(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		let output = '';
		for (const child of node.children ?? []) {
			if (child.type === 'string_lit') {
				output += String(child.value ?? '');
			} else if (child.type === 'interpolation') {
				output += coerceToString(await this.evalNode(child.children?.[0], scope));
			} else if (child.type === 'if_directive' || child.type === 'for_directive' || child.type === 'else_directive' || child.type === 'endif_directive') {
				throw new Error('Template directives inside quoted strings are not supported');
			}
		}
		return makeStringValue(output);
	}

	private async evalComparison(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const left = unwrapSensitive(await this.evalNode(node.children?.[0], scope));
		const right = unwrapSensitive(await this.evalNode(node.children?.[1], scope));
		const operator = node.value === undefined ? '' : String(node.value);
		const a = comparisonValue(left);
		const b = comparisonValue(right);
		let result = false;
		switch (operator) {
			case '==': result = a === b; break;
			case '!=': result = a !== b; break;
			case '<': result = a < b; break;
			case '<=': result = a <= b; break;
			case '>': result = a > b; break;
			case '>=': result = a >= b; break;
			default: throw new Error(`Unknown comparison operator "${operator}"`);
		}
		return makeBooleanValue(result);
	}

	private async evalArithmetic(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const operator = node.value === undefined ? '' : String(node.value);
		if (operator === '-' && (node.children?.length ?? 0) === 1) {
			const value = await this.evalNode(node.children?.[0], scope);
			if (value.type !== 'number') throw new Error('Unary minus requires a number');
			return makeNumberValue(-Number(value.value));
		}
		const left = await this.evalNode(node.children?.[0], scope);
		const right = await this.evalNode(node.children?.[1], scope);
		if (left.type !== 'number' || right.type !== 'number') throw new Error('Arithmetic requires numbers');
		const a = Number(left.value);
		const b = Number(right.value);
		switch (operator) {
			case '+': return makeNumberValue(a + b);
			case '-': return makeNumberValue(a - b);
			case '*': return makeNumberValue(a * b);
			case '/': return makeNumberValue(a / b);
			case '%': return makeNumberValue(a % b);
			default: throw new Error(`Unknown arithmetic operator "${operator}"`);
		}
	}

	private async evalListComprehension(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const [identifier, collection, expr] = node.children ?? [];
		const collectionValue = await this.evalNode(collection, scope);
		const results: RuntimeValue<ValueType>[] = [];
		for (const [, item] of iterateValue(collectionValue)) {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			frame.set(String(identifier?.value ?? ''), item);
			scope.comprehension.push(frame);
			try {
				results.push(await this.evalNode(expr, scope));
			} finally {
				scope.comprehension.pop();
			}
		}
		return makeArrayValue(results);
	}

	private async evalMapComprehension(node: TNode, scope: Scope): Promise<RuntimeValue<ValueType>> {
		const [identifier, collection, keyNode, valueNode] = node.children ?? [];
		const collectionValue = await this.evalNode(collection, scope);
		const map = new Map<string, RuntimeValue<ValueType>>();
		for (const [, item] of iterateValue(collectionValue)) {
			const frame = new Map<string, RuntimeValue<ValueType>>();
			frame.set(String(identifier?.value ?? ''), item);
			scope.comprehension.push(frame);
			try {
				const key = coerceToString(await this.evalNode(keyNode, scope));
				map.set(key, await this.evalNode(valueNode, scope));
			} finally {
				scope.comprehension.pop();
			}
		}
		return makeObjectValue(map);
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
		const args = (node.children ?? []).filter(child => child.type !== 'function_identifier');

		if (name === 'can') {
			try {
				await this.evalNode(args[0], scope);
				return makeBooleanValue(true);
			} catch {
				return makeBooleanValue(false);
			}
		}

		if (name === 'try') {
			for (const arg of args) {
				try {
					return await this.evalNode(arg, scope);
				} catch {
					// fall through to the next candidate
				}
			}
			return makeNullValue();
		}

		// Inline functions resolve before built-ins. A name may not be both:
		// definition-time shadow checking rejects that, so the order below can
		// never mask a built-in.
		const inline = this.findInlineFunction(scope, name);
		if (inline) {
			const evaluatedArgs: RuntimeValue<ValueType>[] = [];
			for (const arg of args) evaluatedArgs.push(await this.evalNode(arg, scope));
			return this.callInlineFunction(inline, evaluatedArgs);
		}

		if (!this.schema.getFunctionDefinition(name)) throw new Error(`Unknown function "${name}"`);
		if (name === 'deep_merge' && !this.options.experiments?.includes('deep-merge')) {
			throw new Error('deep_merge requires the deep-merge experiment to be enabled');
		}
		if (!this.schema.getFunctionRegistry().hasFunction(name)) {
			throw new Error(`Function "${name}" has no evaluator`);
		}

		const evaluatedArgs: RuntimeValue<ValueType>[] = [];
		for (const arg of args) evaluatedArgs.push(await this.evalNode(arg, scope));

		const context = await this.makeContext(scope);
		return this.schema.getFunctionRegistry().evaluateFunction(name, evaluatedArgs, context);
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
		if (this.inlineCallDepth >= MAX_INLINE_CALL_DEPTH) {
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

		this.inlineCallDepth += 1;
		try {
			const value = await invokeFunctionOperation(operation, args, context);
			if (!value) throw new Error(`Inline function "${definition.name}" returned no value`);
			return value;
		} finally {
			this.inlineCallDepth -= 1;
		}
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

		const plainArgs = args.map(value => runtimeToPlain(value));
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
		for (const name of scope.locals.keys()) {
			if (scope.localCache.get(name) === 'pending') continue;
			resolved[name] = runtimeToPlain(await this.resolveLocal(scope, name));
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
				exposed.inputs = runtimeToPlain(makeObjectValue(include.result.inputs));
			}
			includes[name] = exposed;
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
					return runtimeToPlain(await this.callInlineFunction(inline, runtimeArgs));
				}
				if (!this.schema.getFunctionDefinition(name)) {
					throw new Error(`tg.call in inline function "${definition.name}" named unknown function "${name}"`);
				}
				if (!context.evaluateFunction) {
					throw new Error(
						`tg.call is unavailable to inline function "${definition.name}": the evaluation context has no function evaluator`
					);
				}
				return runtimeToPlain(await context.evaluateFunction(name, runtimeArgs));
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
				terragruntDir: context.terragruntDir ?? scope.dir,
				repoRoot: context.repoRoot ?? null,
				workingDirectory: context.workingDirectory,
				environmentVariables: { ...context.environmentVariables }
			}
		};
	}
}

function makeRootScope(filePath: string, content: string, workspaceRoot = path.dirname(filePath)): Scope {
	const ast = parse(content, { grammarSource: filePath, tracer: { trace() {} } });
	return {
		filePath,
		content,
		ast,
		dir: path.dirname(filePath),
		workspaceRoot,
		locals: new Map(),
		localCache: new Map(),
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

function iterateValue(value: RuntimeValue<ValueType>): Array<[string, RuntimeValue<ValueType>]> {
	const items: Array<[string, RuntimeValue<ValueType>]> = [];
	if (value.type === 'array') {
		(value.value as RuntimeValue<ValueType>[]).forEach((item, index) => items.push([String(index), item]));
	} else if (value.type === 'object' || value.type === 'block') {
		for (const [key, item] of (value.value as Map<string, RuntimeValue<ValueType>>).entries()) items.push([key, item]);
	} else {
		throw new Error(`Comprehension collection must be a list or object, got ${value.type}`);
	}
	return items;
}

function comparisonValue(value: RuntimeValue<ValueType>): string | number {
	switch (value.type) {
		case 'string':
		case 'number':
		case 'boolean':
			return value.value as string | number;
		case 'null':
			return '';
		default:
			return JSON.stringify(value.value);
	}
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

function isObjectValue(value: RuntimeValue<ValueType>): boolean {
	return value.type === 'object' || value.type === 'block';
}

export function runtimeValueToPlain(value: RuntimeValue<ValueType>): unknown {
	switch (value.type) {
		case 'string':
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

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}
