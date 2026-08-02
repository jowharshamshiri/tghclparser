import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parse } from './parser';
import { Schema } from './Schema';
import type { FunctionContext, RuntimeValue, ValueType } from './model';
import {
	coerceToBool,
	coerceToString,
	makeArrayValue,
	makeBooleanValue,
	makeNullValue,
	makeNumberValue,
	makeObjectValue,
	makeStringValue,
	unwrapSensitive
} from './functions/utils';

interface TNode {
	type: string;
	value?: string | number | boolean | null;
	children?: TNode[];
}

export interface ConfigEvaluatorOptions {
	environmentVariables: Record<string, string>;
	terraformCommand?: string;
	terraformCliArgs?: string[];
}

export interface ConfigEvaluationResult {
	valid: boolean;
	inputs: RuntimeValue<ValueType> | null;
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
	dir: string;
	locals: Map<string, TNode>;
	localCache: Map<string, RuntimeValue<ValueType> | 'pending'>;
	includes: Map<string, IncludeRef>;
	autoinclude: FileResult | null;
	rootAttrs: Map<string, TNode>;
	terraform: Map<string, TNode>;
	comprehension: Array<Map<string, RuntimeValue<ValueType>>>;
}

const AUTOINCLUDE_FILES = new Set(['terragrunt.autoinclude.hcl', 'terragrunt.autoinclude.stack.hcl']);

function requiredValueNode(node: TNode, excludedType = 'attribute_identifier'): TNode {
	const value = node.children?.find(child => child.type !== excludedType);
	if (!value) throw new Error(`Missing value for ${node.type}`);
	return value;
}

export class ConfigEvaluator {
	private readonly schema = Schema.getInstance();
	private readonly options: ConfigEvaluatorOptions;

	constructor(options: ConfigEvaluatorOptions) {
		this.options = options;
	}

	async evaluateUnit(configPath: string, content: string, workDir: string): Promise<ConfigEvaluationResult> {
		try {
			const result = await this.evaluateFile(configPath, content, workDir);
			if (result.inputs === null) return { valid: true, inputs: null };
			return { valid: true, inputs: makeObjectValue(result.inputs) };
		} catch {
			return { valid: false, inputs: null };
		}
	}

	private async evaluateFile(filePath: string, content: string, workDir: string): Promise<FileResult> {
		const ast = parse(content, { grammarSource: filePath, tracer: { trace() {} } });
		const dir = path.dirname(filePath);
		const baseName = path.basename(filePath);

		const blocks: TNode[] = [];
		const assignments: TNode[] = [];
		for (const child of ast.children ?? []) {
			if (child.type === 'block') blocks.push(child);
			else if (child.type === 'assignment') assignments.push(child);
		}

		const scope: Scope = {
			filePath,
			content,
			dir,
			locals: new Map(),
			localCache: new Map(),
			includes: new Map(),
			autoinclude: null,
			rootAttrs: new Map(),
			terraform: new Map(),
			comprehension: []
		};

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
			const includeContent = await fs.readFile(includePath, 'utf8');
			const includeResult = await this.evaluateFile(includePath, includeContent, workDir);
			scope.includes.set(name, { expose, mergeStrategy, dir: path.dirname(includePath), result: includeResult });
		}

		if (!AUTOINCLUDE_FILES.has(baseName)) {
			const autoPath = path.join(dir, 'terragrunt.autoinclude.hcl');
			if (await pathExists(autoPath)) {
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
		const repoRoot = await this.repoRoot(scope.dir);
		return {
			workingDirectory: scope.dir,
			environmentVariables: this.options.environmentVariables,
			document: {
				uri: scope.filePath,
				content: scope.content
			},
			terraformCommand: this.options.terraformCommand,
			terraformCliArgs: this.options.terraformCliArgs,
			fs: {
				access: (target: string) => fs.access(target)
			},
			terragruntDir: scope.dir,
			originalTerragruntDir: scope.dir,
			includeDir: scope.includes.size > 0 ? [...scope.includes.values()][0].dir : undefined,
			repoRoot,
			readTerragruntConfig: async (relativePath: string) => {
				const target = path.isAbsolute(relativePath) ? relativePath : path.resolve(scope.dir, relativePath);
				if (!(await pathExists(target))) return undefined;
				const fileContent = await fs.readFile(target, 'utf8');
					const result = await this.evaluateFile(target, fileContent, scope.dir);
					return this.readConfigObject(result);
			},
			readTFVarsFile: async (relativePath: string) => {
				const target = path.isAbsolute(relativePath) ? relativePath : path.resolve(scope.dir, relativePath);
				if (!(await pathExists(target))) return undefined;
				const fileContent = await fs.readFile(target, 'utf8');
					return this.readTFVars(target, fileContent);
			},
			runCommand: async (program: string, args: string[]) => {
				const output = execFileSync(program, args, {
					cwd: scope.dir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe']
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

	private async readConfigObject(result: FileResult): Promise<RuntimeValue<ValueType>> {
		const output = new Map<string, RuntimeValue<ValueType>>();
		const locals = new Map<string, RuntimeValue<ValueType>>();
		for (const name of result.scope.locals.keys()) {
			locals.set(name, await this.resolveLocal(result.scope, name));
		}
		if (locals.size > 0) output.set('locals', makeObjectValue(locals));
		if (result.inputs !== null) output.set('inputs', makeObjectValue(result.inputs));
		const terraform = new Map<string, RuntimeValue<ValueType>>();
		for (const [name, node] of result.scope.terraform) {
			terraform.set(name, await this.evalNode(node, result.scope));
		}
		if (terraform.size > 0) output.set('terraform', makeObjectValue(terraform));
		for (const [name, node] of result.scope.rootAttrs) {
			output.set(name, await this.evalNode(node, result.scope));
		}
		return makeObjectValue(output);
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
				if (valueNode) values.set(name, await this.evalNode(valueNode, makeRootScope(target, content)));
			}
		}
		const plain: Record<string, unknown> = {};
		for (const key of [...values.keys()].sort()) plain[key] = plainValue(values.get(key)!);
		return makeStringValue(JSON.stringify(plain));
	}

	private async repoRoot(startDir: string): Promise<string> {
		let current = path.resolve(startDir);
		while (true) {
			if (await pathExists(path.join(current, '.git'))) return current;
			const parent = path.dirname(current);
			if (parent === current) throw new Error(`No Git repository contains ${startDir}`);
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
			throw new Error('dependency references are not supported during input evaluation');
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
				const key = String(child.value);
				const valueNode = child.children?.find(c => c.type !== 'attribute_identifier');
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

		if (!this.schema.getFunctionDefinition(name)) throw new Error(`Unknown function "${name}"`);
		if (!this.schema.getFunctionRegistry().hasFunction(name)) {
			throw new Error(`Function "${name}" has no evaluator`);
		}

		const evaluatedArgs: RuntimeValue<ValueType>[] = [];
		for (const arg of args) evaluatedArgs.push(await this.evalNode(arg, scope));

		const context = await this.makeContext(scope);
		return this.schema.getFunctionRegistry().evaluateFunction(name, evaluatedArgs, context);
	}
}

function makeRootScope(filePath: string, content: string): Scope {
	return {
		filePath,
		content,
		dir: path.dirname(filePath),
		locals: new Map(),
		localCache: new Map(),
		includes: new Map(),
		autoinclude: null,
		rootAttrs: new Map(),
		terraform: new Map(),
		comprehension: []
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

function plainValue(value: RuntimeValue<ValueType>): unknown {
	switch (value.type) {
		case 'string':
		case 'number':
		case 'boolean':
			return value.value;
		case 'null':
			return null;
		case 'array':
			return (value.value as RuntimeValue<ValueType>[]).map(plainValue);
		case 'object':
		case 'block': {
			const out: Record<string, unknown> = {};
			for (const [key, entry] of (value.value as Map<string, RuntimeValue<ValueType>>).entries()) {
				out[key] = plainValue(entry);
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
