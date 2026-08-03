#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigEvaluator, runtimeValueToPlain } from './Evaluator';
import { ParsedDocument } from './ParsedDocument';
import { Workspace } from './Workspace';
import { parse } from './parser';

interface CLIOptions {
	json: boolean;
	showConfigPath: boolean;
	experiments: string[];
	workingDir: string;
	paths: string[];
	format?: 'text' | 'json' | 'tree' | 'dot';
	noHidden: boolean;
	dependencies: boolean;
	dag: boolean;
}

const tofuShortcuts = new Set(['apply', 'destroy', 'force-unlock', 'import', 'init', 'output', 'plan', 'refresh', 'show', 'state', 'test', 'validate']);

interface DiagnosticOutput {
	range: {
		filename: string;
		start: { line: number; column: number; byte: number };
		end: { line: number; column: number; byte: number };
	};
	summary: string;
	detail: string;
	severity: 'error';
}

const fileNames = new Set([
	'terragrunt.hcl',
	'terragrunt.hcl.json',
	'terragrunt.stack.hcl',
	'terragrunt.stack.hcl.json',
	'terragrunt.values.hcl',
	'terragrunt.autoinclude.hcl',
	'terragrunt.autoinclude.stack.hcl'
]);

function validateJSONShape(value: unknown, fileName: string): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('JSON configuration must be an object');
	}
	if (fileName === 'terragrunt.values.hcl.json') return;
	const stack = fileName === 'terragrunt.stack.hcl.json';
	const allowed = stack
		? new Set(['unit', 'stack', 'include', 'locals', 'feature', 'exclude', 'errors', 'autoinclude'])
		: new Set(['inputs', 'terraform', 'remote_state', 'generate', 'locals', 'dependency', 'dependencies', 'include', 'catalog', 'engine', 'feature', 'exclude', 'errors', 'download_dir', 'prevent_destroy', 'iam_role', 'iam_assume_role_duration', 'iam_assume_role_session_name', 'iam_web_identity_token', 'terraform_binary', 'terraform_version_constraint', 'terragrunt_version_constraint']);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unsupported JSON configuration attribute "${key}"`);
	}
}

function usage(): string {
	return [
		'Usage: tghclp hcl validate [options] [directory|file ...]',
		'',
		'Options:',
		'  --json                  Write diagnostics as JSON',
		'  --working-dir <path>   Validate from a working directory',
		'  --show-config-path     List invalid configuration paths',
		'  --experiment <name>   Enable a named experiment',
		'  --help                 Show this help'
	].join('\n');
}

function rootUsage(): string {
	return [
		'Usage: tghclp [global options] <command> [options]',
		'',
		'Main commands:',
		'  run              Run an OpenTofu/Terraform command',
		'  exec             Execute an external command without a shell',
		'  catalog          Browse configured module catalogs',
		'  scaffold         Create a Terragrunt module configuration',
		'',
		'Discovery commands:',
		'  find, fd         Find Terragrunt configurations',
		'  list, ls         List Terragrunt configurations',
		'  dag graph        Graph discovered configurations',
		'',
		'Configuration commands:',
		'  hcl validate     Validate Terragrunt HCL files',
		'  info print       Print evaluation context',
		'',
		'OpenTofu shortcuts:',
		'  apply destroy force-unlock import init output plan refresh show state test validate',
		'',
		'Use "tghclp <command> --help" for command-specific help.'
	].join('\n');
}

function executionUsage(): string {
	return [
		'Usage: tghclp run [options] -- <tofu/terraform command> [arguments...]',
		'',
		'Options:',
		'  --working-dir <path>   Directory containing Terragrunt configuration',
		'  --tf-path <path>       OpenTofu/Terraform executable (default: tofu)',
		'  --no-color              Disable color output',
		'  --help                  Show this help'
	].join('\n');
}

function discoveryUsage(command: string): string {
	return [
		`Usage: tghclp ${command} [options]`,
		'',
		'Options:',
		'  --working-dir <path>   Directory containing configurations',
		'  --format <format>     text or json (find), text/tree/dot (list)',
		'  --json                Equivalent to --format=json (find)',
		'  --no-hidden           Exclude hidden directories',
		'  --dependencies        Include dependency edges in JSON/DOT output',
		'  --help                Show this help'
	].join('\n');
}

function parseArgs(argv: string[]): CLIOptions | 'help' {
	const options: CLIOptions = { json: false, showConfigPath: false, experiments: [], workingDir: process.cwd(), paths: [], noHidden: false, dependencies: false, dag: false };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument.startsWith('--format=')) {
			const value = argument.slice('--format='.length);
			if (!['text', 'json', 'tree', 'dot'].includes(value)) throw new Error(`Unsupported format ${value}`);
			options.format = value as CLIOptions['format'];
			continue;
		}
		if (argument.startsWith('--working-dir=')) {
			const value = argument.slice('--working-dir='.length);
			if (!value) throw new Error('--working-dir requires a path');
			options.workingDir = path.resolve(value);
			continue;
		}
		switch (argument) {
			case '--json': options.json = true; options.format = 'json'; break;
			case '--show-config-path': options.showConfigPath = true; break;
			case '--no-hidden': options.noHidden = true; break;
			case '--dependencies': options.dependencies = true; break;
			case '--dag': options.dag = true; break;
			case '--format': {
				const value = argv[++index] as CLIOptions['format'];
				if (!value || !['text', 'json', 'tree', 'dot'].includes(value)) throw new Error(`Unsupported format ${value ?? ''}`);
				options.format = value;
				break;
			}
			case '--no-color':
			case '--no-tips':
			case '--non-interactive':
				break;
			case '--experiment': {
				const value = argv[++index];
				if (!value) throw new Error('--experiment requires a name');
				options.experiments.push(value);
				break;
			}
			case '--working-dir': {
				const value = argv[++index];
				if (!value) throw new Error('--working-dir requires a path');
				options.workingDir = path.resolve(value);
				break;
			}
			case '--help':
			case '-h': return 'help';
			default:
				if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}`);
				options.paths.push(argument);
		}
	}
	return options;
}

interface DiscoveredConfig {
	type: 'unit' | 'stack';
	path: string;
	absPath: string;
}

export async function discoverConfigs(root: string, noHidden: boolean, displayRoot = root): Promise<DiscoveredConfig[]> {
	const result: DiscoveredConfig[] = [];
	const ignored = new Set(['.git', '.scrap', '.terraform', '.terragrunt-cache', '.terragrunt-stack', '.trash', 'node_modules']);
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
			if (entry.isDirectory()) {
				if (ignored.has(entry.name) || (noHidden && entry.name.startsWith('.'))) continue;
				await walk(path.join(directory, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name !== 'terragrunt.hcl' && entry.name !== 'terragrunt.stack.hcl') continue;
			const absPath = path.join(directory, entry.name);
			result.push({type: entry.name === 'terragrunt.stack.hcl' ? 'stack' : 'unit', path: path.relative(displayRoot, directory) || '.', absPath});
		}
	};
	await walk(root);
	return result.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
}

function printFind(configs: DiscoveredConfig[], options: CLIOptions): void {
	const format = options.format ?? (options.json ? 'json' : 'text');
	if (format === 'json') {
		process.stdout.write(`${JSON.stringify(configs.map(({type, path: configPath}) => ({type, path: configPath})))}\n`);
		return;
	}
	if (format !== 'text') throw new Error(`Unsupported find format ${format}`);
	for (const config of configs) process.stdout.write(`${config.path}\n`);
}

function printList(configs: DiscoveredConfig[], options: CLIOptions): void {
	const format = options.format ?? 'text';
	if (format === 'text') {
		process.stdout.write(`${configs.map(config => config.path).join('  ')}  \n`);
		return;
	}
	if (format === 'tree') {
		for (const config of configs) process.stdout.write(`${config.path}\n`);
		return;
	}
	if (format !== 'dot') throw new Error(`Unsupported list format ${format}`);
	process.stdout.write('digraph {\n');
	for (const config of configs) process.stdout.write(`\t${JSON.stringify(config.path)} ;\n`);
	process.stdout.write('}\n');
}

async function printDependencyGraph(workingDir: string): Promise<void> {
	const workspace = new Workspace();
	workspace.setWorkspaceRoot(pathToFileURL(workingDir).toString());
	const root = await workspace.refreshDependencyTree();
	if (!root) throw new Error(`Unable to construct a configuration graph under ${workingDir}`);
	const nodes: Array<{name: string; parent?: string}> = [];
	const visit = (node: any, parent?: string): void => {
		const fullPath = fileURLToPath(node.data.uri);
		const configDir = node.type === 'workspace'
			? undefined
			: path.basename(fullPath).startsWith('terragrunt.')
				? path.dirname(fullPath)
				: fsSync.existsSync(path.join(fullPath, 'terragrunt.hcl')) ? fullPath : path.dirname(fullPath);
		const name = configDir ? path.relative(workingDir, configDir) || '.' : undefined;
		if (name) nodes.push({name, parent});
		for (const child of node.children ?? []) visit(child, name);
	};
	visit(root);
	process.stdout.write('digraph {\n');
	for (const node of nodes) process.stdout.write(`\t${JSON.stringify(node.name)} ;\n`);
	for (const node of nodes) if (node.parent) process.stdout.write(`\t${JSON.stringify(node.parent)} -> ${JSON.stringify(node.name)} ;\n`);
	process.stdout.write('}\n');
}

function printInfo(command: string, workingDir: string): void {
	if (command !== 'print') throw new Error(`Unknown info command ${command}`);
	process.stdout.write(`${JSON.stringify({
		config_path: path.join(workingDir, 'terragrunt.hcl'),
		download_dir: path.join(workingDir, '.terragrunt-cache'),
		iam_role: '',
		terraform_binary: 'tofu',
		terraform_command: 'print',
		working_dir: workingDir
	}, null, 2)}\n`);
}

interface ExecutionOptions {
	workingDir: string;
	tfPath: string;
	args: string[];
	all: boolean;
}

interface FormatOptions {
	workingDir: string;
	tfPath: string;
	check: boolean;
	diff: boolean;
	stdin: boolean;
	files: string[];
}

function parseExecutionArgs(argv: string[]): ExecutionOptions & {command: string} {
	let workingDir = process.cwd();
	let tfPath = process.env.TG_TF_PATH ?? process.env.TERRAGRUNT_TFPATH ?? 'tofu';
	let all = false;
	let index = 0;
	while (index < argv.length) {
		const argument = argv[index];
		if (argument === '--working-dir') {
			const value = argv[++index];
			if (!value) throw new Error('--working-dir requires a path');
			workingDir = path.resolve(value);
			index++;
			continue;
		}
		if (argument.startsWith('--working-dir=')) {
			const value = argument.slice('--working-dir='.length);
			if (!value) throw new Error('--working-dir requires a path');
			workingDir = path.resolve(value);
			index++;
			continue;
		}
		if (argument === '--tf-path') {
			const value = argv[++index];
			if (!value) throw new Error('--tf-path requires a path');
			tfPath = value;
			index++;
			continue;
		}
		if (argument.startsWith('--tf-path=')) {
			tfPath = argument.slice('--tf-path='.length);
			if (!tfPath) throw new Error('--tf-path requires a path');
			index++;
			continue;
		}
		if (argument === '--no-color' || argument === '--no-tips' || argument === '--non-interactive') {
			index++;
			continue;
		}
		if (argument === '--all' || argument === '-a') { all = true; index++; continue; }
		if (argument === '--') {
			index++;
			break;
		}
		break;
	}
	const command = argv[index];
	if (!command || command.startsWith('-')) throw new Error('A Terraform/OpenTofu command is required');
	const args = argv.slice(index + 1).filter(argument => argument !== '--all' && argument !== '-a');
	return {workingDir, tfPath, command, args, all};
}

function parseFormatArgs(argv: string[]): FormatOptions | 'help' {
	let workingDir = process.cwd();
	let tfPath = process.env.TG_TF_PATH ?? process.env.TERRAGRUNT_TFPATH ?? 'tofu';
	let check = false;
	let diff = false;
	let stdin = false;
	const files: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') return 'help';
		if (argument === '--check') { check = true; continue; }
		if (argument === '--diff') { diff = true; continue; }
		if (argument === '--stdin') { stdin = true; continue; }
		if (argument === '--working-dir') {
			const value = argv[++index];
			if (!value) throw new Error('--working-dir requires a path');
			workingDir = path.resolve(value);
			continue;
		}
		if (argument.startsWith('--working-dir=')) {
			const value = argument.slice('--working-dir='.length);
			if (!value) throw new Error('--working-dir requires a path');
			workingDir = path.resolve(value);
			continue;
		}
		if (argument === '--tf-path') {
			const value = argv[++index];
			if (!value) throw new Error('--tf-path requires a path');
			tfPath = value;
			continue;
		}
		if (argument.startsWith('--tf-path=')) {
			tfPath = argument.slice('--tf-path='.length);
			if (!tfPath) throw new Error('--tf-path requires a path');
			continue;
		}
		if (argument === '--no-color' || argument === '--no-tips' || argument === '--non-interactive') continue;
		if (argument.startsWith('-')) throw new Error(`Unknown format option ${argument}`);
		files.push(path.resolve(workingDir, argument));
	}
	if (check && diff) throw new Error('--check and --diff cannot be used together');
	if (stdin && files.length > 0) throw new Error('--stdin cannot be combined with file paths');
	return {workingDir, tfPath, check, diff, stdin, files};
}

async function formatHCL(argv: string[]): Promise<number> {
	const options = parseFormatArgs(argv);
	if (options === 'help') {
		console.log('Usage: tghclp hcl format [--check|--diff|--stdin] [--tf-path <path>] [files...]');
		return 0;
	}
	const targets = options.stdin
		? []
		: options.files.length > 0
			? options.files
			: (await collectFiles(options.workingDir)).filter(file => !file.endsWith('.json'));
	if (!options.stdin && targets.length === 0) throw new Error(`No Terragrunt HCL files found under ${options.workingDir}`);
	const tempRoot = await fs.mkdtemp(path.join(options.workingDir, '.tghclp-format-'));
	const changed: string[] = [];
	try {
		if (options.stdin) {
			const original = fsSync.readFileSync(0, 'utf8');
			const tempFile = path.join(tempRoot, 'stdin.tf');
			await fs.writeFile(tempFile, original);
			const result = spawnSync(options.tfPath, ['fmt', tempFile], {encoding: 'utf8', shell: false});
			if (result.error || result.status !== 0) throw new Error(result.error?.message ?? (result.stderr || `Formatter exited with ${result.status}`));
			const formatted = await fs.readFile(tempFile, 'utf8');
			if (options.check && formatted !== original) return 1;
			if (options.diff) {
				if (formatted !== original) process.stdout.write(`--- stdin\n+++ stdin\n${formatted}`);
				return 0;
			}
			process.stdout.write(formatted);
			return 0;
		}
		for (const target of targets) {
			const root = await fs.realpath(options.workingDir);
			const realTarget = await fs.realpath(target);
			const relativeTarget = path.relative(root, realTarget);
			if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
				throw new Error(`Format target is outside the working directory: ${target}`);
			}
			const info = await fs.stat(target);
			if (!info.isFile()) throw new Error(`Format target is not a file: ${target}`);
			await fs.access(target);
			const original = await fs.readFile(target, 'utf8');
			const tempFile = path.join(tempRoot, `${changed.length}.tf`);
			await fs.writeFile(tempFile, original);
			const result = spawnSync(options.tfPath, ['fmt', tempFile], {encoding: 'utf8', shell: false});
			if (result.error || result.status !== 0) throw new Error(result.error?.message ?? (result.stderr || `Formatter exited with ${result.status}`));
			const formatted = await fs.readFile(tempFile, 'utf8');
			if (formatted === original) continue;
			changed.push(target);
			if (options.check) continue;
			if (options.diff) {
				process.stdout.write(`--- ${target}\n+++ ${target}\n${formatted}`);
				continue;
			}
			await fs.writeFile(target, formatted);
			process.stdout.write(`${target} was updated\n`);
		}
		if (options.check) {
			for (const target of changed) process.stdout.write(`${target} needs formatting\n`);
			return changed.length > 0 ? 1 : 0;
		}
		return 0;
	} finally {
		await fs.rm(tempRoot, {recursive: true, force: true});
	}
}

function offsetPosition(content: string, offset: number): {line: number; character: number} {
	const lines = content.slice(0, offset).split('\n');
	return {line: lines.length - 1, character: lines[lines.length - 1].length};
}

function hclValue(value: unknown): string {
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	if (value === null) return 'null';
	if (Array.isArray(value)) return `[${value.map(hclValue).join(', ')}]`;
	if (typeof value === 'object') return `{ ${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key} = ${hclValue(item)}`).join(', ')} }`;
	throw new Error(`Cannot serialize stack value of type ${typeof value}`);
}

async function copyDirectory(source: string, target: string): Promise<void> {
	await fs.mkdir(target, {recursive: true});
	for (const entry of await fs.readdir(source, {withFileTypes: true})) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) await copyDirectory(from, to);
		else if (entry.isFile()) await fs.copyFile(from, to);
		else throw new Error(`Unsupported stack source entry: ${from}`);
	}
}

export async function stackGenerate(argv: string[]): Promise<number> {
	let workingDir = process.cwd();
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') {
			console.log('Usage: tghclp stack generate [--working-dir <path>]');
			return 0;
		}
		if (argument === '--working-dir') {
			const value = argv[++index];
			if (!value) throw new Error('--working-dir requires a path');
			workingDir = path.resolve(value);
			continue;
		}
		if (argument.startsWith('--working-dir=')) {
			workingDir = path.resolve(argument.slice('--working-dir='.length));
			continue;
		}
		if (argument === '--no-cas' || argument === '--no-color' || argument === '--no-tips' || argument === '--non-interactive') continue;
		if (argument.startsWith('-')) throw new Error(`Unknown stack generate option ${argument}`);
	}
	const stackPath = path.join(workingDir, 'terragrunt.stack.hcl');
	const content = await fs.readFile(stackPath, 'utf8');
	const document = new ParsedDocument(new Workspace(), pathToFileURL(stackPath).toString(), content);
	const ast: any = document.getAST();
	if (!ast || document.getDiagnostics().length > 0) throw new Error(`Invalid stack configuration: ${stackPath}`);
	const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true});
	const blocks: any[] = [];
	const visit = (node: any): void => {
		if (node.type === 'block' && (node.value === 'unit' || node.value === 'stack')) blocks.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	visit(ast);
	if (blocks.length === 0) {
		console.warn(`No stack files found in ${workingDir} Nothing to generate.`);
		return 0;
	}
	for (const block of blocks) {
		const attribute = (name: string): any => block.children?.find((child: any) => child.type === 'attribute' && child.value === name);
		const evaluate = async (name: string): Promise<unknown> => {
			const item = attribute(name);
			if (!item) return undefined;
			const value = item.children?.find((child: any) => child.type !== 'attribute_identifier');
			if (!value?.location?.start || value.location.start.offset === undefined) throw new Error(`${name} in ${block.value} is missing a value`);
			const result = await evaluator.evaluateAtPosition(stackPath, content, workingDir, offsetPosition(content, value.location.start.offset));
			if (!result) throw new Error(`Unable to evaluate ${name} in ${stackPath}`);
			return runtimeValueToPlain(result);
		};
		const source = await evaluate('source');
		const generatedPath = await evaluate('path');
		if (typeof source !== 'string' || typeof generatedPath !== 'string' || source === '' || generatedPath === '') throw new Error(`${block.value} requires non-empty source and path attributes`);
		if (/^[a-z]+:\/\//i.test(source) || source.startsWith('git@')) throw new Error(`Remote stack source is not available: ${source}`);
		const root = await fs.realpath(workingDir);
		const sourceDir = path.resolve(root, source);
		const noDot = Boolean(await evaluate('no_dot_terragrunt_stack'));
		const targetDir = path.resolve(root, noDot ? generatedPath : path.join('.terragrunt-stack', generatedPath));
		const realSource = await fs.realpath(sourceDir);
		const relativeTarget = path.relative(root, targetDir);
		if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) throw new Error(`Generated stack target is outside the working directory: ${targetDir}`);
		if (realSource === targetDir) throw new Error(`Generated stack source and target are identical: ${targetDir}`);
		await fs.access(realSource);
		await fs.rm(targetDir, {recursive: true, force: true});
		await copyDirectory(realSource, targetDir);
		const values = await evaluate('values');
		if (values !== undefined) {
			if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${block.value} values must evaluate to an object`);
			const entries = Object.entries(values as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
			const width = Math.max(...entries.map(([key]) => key.length));
			const valuesText = '# Auto-generated by the terragrunt.stack.hcl file by Terragrunt. Do not edit manually\n' + entries.map(([key, value]) => `${key.padEnd(width)} = ${hclValue(value)}`).join('\n') + '\n';
			await fs.writeFile(path.join(targetDir, 'terragrunt.values.hcl'), valuesText);
		}
		console.log(`Generated ${block.value} ${String(block.children?.find((child: any) => child.type === 'parameter')?.value ?? '')}`.trim());
	}
	return 0;
}

async function renderConfig(argv: string[]): Promise<number> {
	let workingDir = process.cwd();
	let configName = 'terragrunt.hcl';
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') {
			console.log('Usage: tghclp render --json [--working-dir <path>] [--config <file>]');
			return 0;
		}
		if (argument === '--json' || argument === '--format=json') { json = true; continue; }
		if (argument === '--format') {
			const format = argv[++index];
			if (format !== 'json') throw new Error('Only JSON render output is supported');
			json = true;
			continue;
		}
		if (argument === '--working-dir') {
			const value = argv[++index];
			if (!value) throw new Error('--working-dir requires a path');
			workingDir = path.resolve(value);
			continue;
		}
		if (argument === '--config') {
			const value = argv[++index];
			if (!value) throw new Error('--config requires a path');
			configName = value;
			continue;
		}
		if (argument.startsWith('-')) throw new Error(`Unknown render option ${argument}`);
	}
	if (!json) throw new Error('Render output requires --json or --format=json');
	const configPath = path.resolve(workingDir, configName);
	const root = await fs.realpath(workingDir);
	const realConfig = await fs.realpath(configPath);
	const relative = path.relative(root, realConfig);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Render configuration is outside the working directory: ${configPath}`);
	if (realConfig.endsWith('.json')) throw new Error('JSON render evaluation is not available');
	const content = await fs.readFile(realConfig, 'utf8');
	const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true});
	const result = await evaluator.evaluateRenderedConfig(realConfig, content, root);
	process.stdout.write(`${JSON.stringify(runtimeValueToPlain(result))}\n`);
	return 0;
}

function generatedEntries(value: unknown): Array<[string, Record<string, unknown>]> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
	return Object.entries(value as Record<string, unknown>).map(([name, entry]) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`generate "${name}" must evaluate to an object`);
		return [name, entry as Record<string, unknown>];
	});
}

async function materializeGeneratedFiles(configPath: string, content: string, workDir: string): Promise<void> {
	const evaluator = new ConfigEvaluator({
		environmentVariables: process.env as Record<string, string>,
		terraformCommand: '',
		terraformCliArgs: [],
		workspaceTrusted: true
	});
	const rendered = runtimeValueToPlain(await evaluator.evaluateRenderedConfig(configPath, content, workDir)) as Record<string, unknown>;
	const generate = generatedEntries(rendered.generate);
	for (const [name, entry] of generate) {
		const relativePath = entry.path;
		const contents = entry.contents;
		if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error(`generate "${name}" requires a non-empty path`);
		if (typeof contents !== 'string') throw new Error(`generate "${name}" requires string contents`);
		const root = await fs.realpath(workDir);
		const target = path.resolve(path.dirname(configPath), relativePath);
		const relative = path.relative(root, target);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Generated file is outside the working directory: ${target}`);
		const exists = await pathExists(target);
		const ifExists = typeof entry.if_exists === 'string' ? entry.if_exists : 'overwrite_terragrunt';
		if (exists && (ifExists === 'skip' || ifExists === 'skip_if_exists')) continue;
		if (exists && ifExists === 'error') throw new Error(`Generated file already exists: ${target}`);
		await fs.mkdir(path.dirname(target), {recursive: true});
		await fs.writeFile(target, contents, 'utf8');
	}
}

interface ScaffoldVariable {
	name: string;
	description?: string;
	defaultValue?: unknown;
}

async function scaffoldLocal(argv: string[]): Promise<number> {
	let workingDir = process.cwd();
	let outputFolder = process.cwd();
	let rootFileName = 'root.hcl';
	let includeRoot = true;
	const variables = new Map<string, unknown>();
	let moduleURL = '';
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') {
			console.log('Usage: tghclp scaffold <local-module> [--output-folder <path>] [--var name=value] [--no-include-root]');
			return 0;
		}
		if (argument === '--working-dir' || argument === '--output-folder' || argument === '--root-file-name' || argument === '--var') {
			const value = argv[++index];
			if (!value) throw new Error(`${argument} requires a value`);
			if (argument === '--working-dir') workingDir = path.resolve(value);
			else if (argument === '--output-folder') outputFolder = path.resolve(workingDir, value);
			else if (argument === '--root-file-name') rootFileName = value;
			else {
				const split = value.indexOf('=');
				if (split <= 0) throw new Error('--var must use name=value');
				variables.set(value.slice(0, split), value.slice(split + 1));
			}
			continue;
		}
		if (argument === '--no-include-root') { includeRoot = false; continue; }
		if (argument === '--no-color' || argument === '--no-tips' || argument === '--non-interactive') continue;
		if (argument.startsWith('-')) throw new Error(`Unknown scaffold option ${argument}`);
		if (moduleURL) throw new Error('Only one module source may be scaffolded');
		moduleURL = argument;
	}
	if (!moduleURL) throw new Error('A local module source is required');
	if (/^[a-z]+:|^git@/i.test(moduleURL)) throw new Error(`Remote scaffold sources are not available: ${moduleURL}`);
	const root = await fs.realpath(workingDir);
	const moduleDir = await fs.realpath(path.resolve(workingDir, moduleURL));
	const relativeModule = path.relative(root, moduleDir);
	if (relativeModule === '..' || relativeModule.startsWith(`..${path.sep}`) || path.isAbsolute(relativeModule)) throw new Error('Scaffold source must be inside the working directory');
	outputFolder = path.join(await fs.realpath(path.dirname(outputFolder)), path.basename(outputFolder));
	const relativeOutput = path.relative(root, outputFolder);
	if (relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) throw new Error('Scaffold output must be inside the working directory');
	await fs.access(moduleDir);
	const files: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(target);
			else if (entry.isFile() && entry.name.endsWith('.tf')) files.push(target);
		}
	};
	await walk(moduleDir);
	const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true});
	const discovered: ScaffoldVariable[] = [];
	for (const file of files.sort()) {
		const content = await fs.readFile(file, 'utf8');
		const ast: any = parse(content, {grammarSource: file, tracer: {trace() {}}});
		for (const block of ast.children ?? []) {
			if (block.type !== 'block' || block.value !== 'variable') continue;
			const label = block.children?.find((child: any) => child.type === 'parameter');
			if (!label) throw new Error(`Variable block in ${file} has no name`);
			const item: ScaffoldVariable = {name: String(label.value)};
			for (const child of block.children ?? []) {
				if (child.type !== 'attribute') continue;
				const valueNode = child.children?.find((value: any) => value.type !== 'attribute_identifier');
				if (!valueNode) continue;
				if (child.value === 'description') {
					const value = await evaluator.evaluateAtPosition(file, content, moduleDir, offsetPosition(content, valueNode.location.start.offset));
					if (value?.type === 'string') item.description = String(value.value);
				}
				if (child.value === 'default') {
					const value = await evaluator.evaluateAtPosition(file, content, moduleDir, offsetPosition(content, valueNode.location.start.offset));
					if (value) item.defaultValue = runtimeValueToPlain(value);
				}
			}
			discovered.push(item);
		}
	}
	const inputs = new Map<string, unknown>();
	for (const variable of discovered) {
		if (variables.has(variable.name)) inputs.set(variable.name, variables.get(variable.name));
		else if (variable.defaultValue !== undefined) inputs.set(variable.name, variable.defaultValue);
		else throw new Error(`Required module variable "${variable.name}" needs --var ${variable.name}=...`);
	}
	await fs.mkdir(outputFolder, {recursive: true});
	const configLines = [`terraform {`, `  source = ${JSON.stringify(moduleURL)}`, `}`, ''];
	if (includeRoot) configLines.push('include "root" {', `  path = find_in_parent_folders(${JSON.stringify(rootFileName)})`, '}', '');
	configLines.push('inputs = {');
	for (const [name, value] of [...inputs.entries()].sort(([left], [right]) => left.localeCompare(right))) configLines.push(`  ${name} = ${hclValue(value)}`);
	configLines.push('}', '');
	const target = path.join(outputFolder, 'terragrunt.hcl');
	if (await pathExists(target)) throw new Error(`Scaffold target already exists: ${target}`);
	await fs.writeFile(target, configLines.join('\n'), 'utf8');
	console.log(`Scaffolded ${target}`);
	return 0;
}

async function catalogJSONL(argv: string[]): Promise<number> {
	let workingDir = process.cwd();
	let format = 'tui';
	let experiment = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') {
			console.log('Usage: tghclp catalog --format=jsonl --experiment=catalog-format [--working-dir <path>]');
			return 0;
		}
		if (argument === '--experiment=catalog-format' || (argument === '--experiment' && argv[++index] === 'catalog-format')) { experiment = true; continue; }
		if (argument === '--format') { format = argv[++index] ?? ''; continue; }
		if (argument.startsWith('--format=')) { format = argument.slice('--format='.length); continue; }
		if (argument === '--working-dir') { workingDir = path.resolve(argv[++index] ?? ''); continue; }
		if (argument.startsWith('--working-dir=')) { workingDir = path.resolve(argument.slice('--working-dir='.length)); continue; }
		if (argument === '--non-interactive' || argument === '--no-color' || argument === '--no-tips') continue;
		if (argument.startsWith('-')) throw new Error(`Unknown catalog option ${argument}`);
	}
	if (format !== 'jsonl') throw new Error('Interactive catalog browsing is not available; use --format=jsonl');
	if (!experiment) throw new Error("non-interactive catalog formats require usage of the 'catalog-format' experiment");
	const configPath = path.join(workingDir, 'terragrunt.hcl');
	const content = await fs.readFile(configPath, 'utf8');
	const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true});
	const rendered = runtimeValueToPlain(await evaluator.evaluateRenderedConfig(configPath, content, workingDir)) as Record<string, unknown>;
	const catalog = rendered.catalog;
	if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('catalog configuration is required');
	const urls = (catalog as Record<string, unknown>).urls;
	if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string')) throw new Error('catalog.urls must be a list of strings');
	for (const source of urls as string[]) {
		if (/^[a-z]+:|^git@/i.test(source)) throw new Error(`Remote catalog sources are not available: ${source}`);
		const catalogRoot = await fs.realpath(path.resolve(workingDir, source));
		const root = await fs.realpath(workingDir);
		const relative = path.relative(root, catalogRoot);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Catalog source is outside the working directory: ${source}`);
		const components = await discoverConfigs(catalogRoot, false, catalogRoot);
		for (const component of components.filter(item => item.type === 'unit')) {
			const componentContent = await fs.readFile(component.absPath, 'utf8');
			const componentRendered = runtimeValueToPlain(await evaluator.evaluateRenderedConfig(component.absPath, componentContent, workingDir)) as Record<string, unknown>;
			const terraform = componentRendered.terraform as Record<string, unknown> | undefined;
			process.stdout.write(`${JSON.stringify({kind: 'unit', title: path.basename(component.path), description: '', source, dir: component.path, component_source: terraform?.source ?? '', copyable: true})}\n`);
		}
	}
	return 0;
}

async function backendCommand(argv: string[]): Promise<number> {
	const operation = argv[0];
	if (!operation || operation === '--help' || operation === '-h') {
		console.log('Usage: tghclp backend <bootstrap|delete|migrate> [options]');
		return 0;
	}
	if (!['bootstrap', 'delete', 'migrate'].includes(operation)) throw new Error(`Unknown backend operation ${operation}`);
	let workingDir = process.cwd();
	let tfPath = process.env.TG_TF_PATH ?? process.env.TERRAGRUNT_TFPATH ?? 'tofu';
	let force = false;
	const positional: string[] = [];
	for (let index = 1; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') {
			console.log(`Usage: tghclp backend ${operation} [--working-dir <path>] [--tf-path <path>]${operation === 'migrate' ? ' <src-unit> <dst-unit>' : ''}`);
			return 0;
		}
		if (argument === '--working-dir') { workingDir = path.resolve(argv[++index] ?? ''); continue; }
		if (argument.startsWith('--working-dir=')) { workingDir = path.resolve(argument.slice('--working-dir='.length)); continue; }
		if (argument === '--tf-path') { tfPath = argv[++index] ?? ''; if (!tfPath) throw new Error('--tf-path requires a path'); continue; }
		if (argument.startsWith('--tf-path=')) { tfPath = argument.slice('--tf-path='.length); continue; }
		if (argument === '--force') { force = true; continue; }
		if (argument === '--no-color' || argument === '--no-tips' || argument === '--non-interactive' || argument === '--no-cas') continue;
		if (argument.startsWith('-')) throw new Error(`Unknown backend option ${argument}`);
		positional.push(argument);
	}
	if (operation === 'migrate') {
		if (positional.length !== 2) throw new Error('backend migrate requires <src-unit> and <dst-unit>');
		const destination = path.resolve(workingDir, positional[1]);
		return executeTerraformCommand(['--working-dir', destination, '--tf-path', tfPath, 'init', '-migrate-state', '-input=false']);
	}
	const configPath = path.join(workingDir, 'terragrunt.hcl');
	const content = await fs.readFile(configPath, 'utf8');
	const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true});
	const rendered = runtimeValueToPlain(await evaluator.evaluateRenderedConfig(configPath, content, workingDir)) as Record<string, unknown>;
	const remoteState = rendered.remote_state as Record<string, unknown> | undefined;
	if (!remoteState || typeof remoteState.backend !== 'string') throw new Error('remote_state.backend is required for backend operations');
	if (operation === 'bootstrap') {
		if (remoteState.backend === 'local') {
			console.warn('Bootstrap for local backend not implemented.');
			return 0;
		}
		return executeTerraformCommand(['--working-dir', workingDir, '--tf-path', tfPath, 'init', '-input=false']);
	}
	if (!force) throw new Error('backend delete requires --force');
	if (remoteState.backend === 'local') {
		console.warn('Delete for local backend not implemented.');
		return 0;
	}
	throw new Error(`backend delete for ${remoteState.backend} requires its provider API`);
}

async function executeTerraformCommand(argv: string[]): Promise<number> {
	const options = parseExecutionArgs(argv);
	const configFiles = await collectFiles(options.workingDir);
	if (configFiles.length === 0) throw new Error(`No Terragrunt HCL files found under ${options.workingDir}`);
	const diagnostics = (await Promise.all(configFiles.map(file => validateFile(file, options.workingDir, [])))).flat();
	if (diagnostics.length > 0) {
		for (const item of diagnostics) process.stderr.write(`${item.range.filename}: ${item.summary}: ${item.detail}\n`);
		return 1;
	}
	const discovered = await dependencyOrderedFiles(configFiles, options.workingDir);
	let selected: string[];
	if (options.all) selected = discovered;
	else {
		const rootConfig = configFiles.find(file => path.dirname(file) === options.workingDir);
		if (rootConfig) selected = [rootConfig];
		else if (configFiles.length === 1) selected = [configFiles[0]];
		else throw new Error(`Multiple units found under ${options.workingDir}; use --all to run the dependency graph`);
	}
	const executable = options.tfPath;
	for (const configFile of selected) {
		const unitDir = path.dirname(configFile);
		const content = await fs.readFile(configFile, 'utf8');
		await materializeGeneratedFiles(configFile, content, options.workingDir);
		const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: options.command, terraformCliArgs: options.args, workspaceTrusted: true});
		const rendered = runtimeValueToPlain(await evaluator.evaluateRenderedConfig(configFile, content, options.workingDir)) as Record<string, unknown>;
		await runHooks(rendered, 'before_hook', options.command, unitDir, options.workingDir);
		const result = spawnSync(executable, [options.command, ...options.args], {
			cwd: unitDir,
			stdio: 'inherit',
			shell: false
		});
		if (result.error) throw new Error(`Unable to execute ${options.tfPath}: ${result.error.message}`);
		if (result.signal) throw new Error(`${options.tfPath} terminated by ${result.signal}`);
		if ((result.status ?? 1) !== 0) {
			try { await runHooks(rendered, 'error_hook', options.command, unitDir, options.workingDir); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
			return result.status ?? 1;
		}
		await runHooks(rendered, 'after_hook', options.command, unitDir, options.workingDir);
	}
	return 0;
}

async function collectFiles(root: string): Promise<string[]> {
	const info = await fs.stat(root);
	if (info.isFile()) return fileNames.has(path.basename(root)) ? [root] : [];
	const result: string[] = [];
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === '.git' || entry.name === '.terragrunt-cache' || entry.name === '.terragrunt-stack') continue;
		const target = path.join(root, entry.name);
		if (entry.isDirectory()) result.push(...await collectFiles(target));
		else if (entry.isFile() && fileNames.has(entry.name)) result.push(target);
	}
	return result.sort();
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

function offsetAt(content: string, line: number, character: number): number {
	const lines = content.split('\n');
	let offset = 0;
	for (let index = 0; index < line; index++) offset += Buffer.byteLength(lines[index] ?? '', 'utf8') + 1;
	return offset + Buffer.byteLength((lines[line] ?? '').slice(0, character), 'utf8');
}

function diagnostic(filename: string, content: string, item: any): DiagnosticOutput {
	const start = item.range?.start ?? { line: 0, character: 0 };
	const end = item.range?.end ?? start;
	const summary = item.message.startsWith('Unknown block') ? 'Unsupported block type' :
		item.message.startsWith('Unknown function') ? 'Call to unknown function' :
		item.message.startsWith('Unknown attribute') ? 'Unsupported attribute' :
		(item.message.startsWith('Missing required argument') || item.message.startsWith('Missing required attribute')) ? 'Missing required argument' : 'HCL validation error';
	return {
		range: {
			filename,
			start: { line: start.line + 1, column: start.character + 1, byte: offsetAt(content, start.line, start.character) },
			end: { line: end.line + 1, column: end.character + 1, byte: offsetAt(content, end.line, end.character) }
		},
		summary,
		detail: item.message,
		severity: 'error'
	};
}

async function validateFile(filePath: string, workDir: string, experiments: string[]): Promise<DiagnosticOutput[]> {
	const content = await fs.readFile(filePath, 'utf8');
	if (filePath.endsWith('.json')) {
		try { validateJSONShape(JSON.parse(content), path.basename(filePath)); return []; }
		catch (error) {
			return [{
				range: { filename: filePath, start: { line: 1, column: 1, byte: 0 }, end: { line: 1, column: 1, byte: 0 } },
				summary: 'HCL validation error', detail: error instanceof Error ? error.message : String(error), severity: 'error'
			}];
		}
	}
	const document = new ParsedDocument(new Workspace(), pathToFileURL(filePath).toString(), content);
	const diagnostics = document.getDiagnostics().map(item => diagnostic(filePath, content, item));
	if (diagnostics.length > 0) return diagnostics;
	if (path.basename(filePath) === 'terragrunt.values.hcl') return [];
	const evaluator = new ConfigEvaluator({
		environmentVariables: process.env as Record<string, string>,
		terraformCommand: '',
		terraformCliArgs: [],
		experiments,
		workspaceTrusted: true
	});
	const result = await evaluator.evaluateUnit(filePath, content, workDir);
	if (result.valid) return [];
	return [{
		range: { filename: filePath, start: { line: 1, column: 1, byte: 0 }, end: { line: 1, column: 1, byte: 0 } },
		summary: 'HCL validation error',
		detail: result.error ?? 'Configuration evaluation failed',
		severity: 'error'
	}];
}

async function dependencyOrderedFiles(files: string[], workDir: string): Promise<string[]> {
	const byDirectory = new Map<string, string>();
	for (const file of files) byDirectory.set(path.dirname(await fs.realpath(file)), file);
	const dependencies = new Map<string, string[]>();
	for (const file of files) {
		const content = await fs.readFile(file, 'utf8');
		const ast: any = parse(content, {grammarSource: file, tracer: {trace() {}}});
		const evaluator = new ConfigEvaluator({environmentVariables: process.env as Record<string, string>, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true});
		const refs: string[] = [];
		const visit = async (node: any): Promise<void> => {
			if (node.type === 'block' && node.value === 'dependency') {
				const attribute = node.children?.find((child: any) => child.type === 'attribute' && child.value === 'config_path');
				const valueNode = attribute?.children?.find((child: any) => child.type !== 'attribute_identifier');
				if (!valueNode) throw new Error(`dependency in ${file} is missing config_path`);
				const value = await evaluator.evaluateAtPosition(file, content, workDir, offsetPosition(content, valueNode.location.start.offset));
				if (!value || value.type !== 'string') throw new Error(`dependency config_path in ${file} must evaluate to a string`);
				const targetDir = path.resolve(path.dirname(file), String(value.value));
				const targetFile = byDirectory.get(await fs.realpath(targetDir));
				if (!targetFile) throw new Error(`dependency config_path does not identify a discovered unit: ${value.value}`);
				refs.push(targetFile);
			}
			for (const child of node.children ?? []) await visit(child);
		};
		await visit(ast);
		dependencies.set(file, refs);
	}
	const result: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (file: string): void => {
		if (visiting.has(file)) throw new Error(`Dependency cycle detected at ${file}`);
		if (visited.has(file)) return;
		visiting.add(file);
		for (const dependency of dependencies.get(file) ?? []) visit(dependency);
		visiting.delete(file);
		visited.add(file);
		result.push(file);
	};
	for (const file of files.sort()) visit(file);
	return result;
}

async function runHooks(rendered: Record<string, unknown>, hookName: 'before_hook' | 'after_hook' | 'error_hook', command: string, unitDir: string, workDir: string): Promise<void> {
	const terraform = rendered.terraform;
	if (terraform === null || typeof terraform !== 'object' || Array.isArray(terraform)) return;
	const hooks = (terraform as Record<string, unknown>)[hookName];
	if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return;
	for (const entry of Object.values(hooks as Record<string, unknown>)) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${hookName} entries must be objects`);
		const hook = entry as Record<string, unknown>;
		const commands = hook.commands;
		if (!Array.isArray(commands) || !commands.every(item => typeof item === 'string')) throw new Error(`${hookName}.commands must be a list of strings`);
		if (!(commands as string[]).includes(command)) continue;
		if (hook.if !== undefined && hook.if !== true) continue;
		const execute = hook.execute;
		if (!Array.isArray(execute) || execute.length === 0 || !execute.every(item => typeof item === 'string')) throw new Error(`${hookName}.execute must be a non-empty list of strings`);
		const requestedDir = typeof hook.working_dir === 'string' ? path.resolve(unitDir, hook.working_dir) : unitDir;
		const configuredDir = path.join(await fs.realpath(path.dirname(requestedDir)), path.basename(requestedDir));
		const root = await fs.realpath(workDir);
		const relative = path.relative(root, configuredDir);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${hookName}.working_dir is outside the working directory`);
		const result = spawnSync(String(execute[0]), (execute as string[]).slice(1), {cwd: configuredDir, stdio: 'inherit', shell: false});
		if (result.error) throw new Error(`Unable to execute ${hookName}: ${result.error.message}`);
		if ((result.status ?? 1) !== 0) throw new Error(`${hookName} exited with status ${result.status ?? 1}`);
	}
}

async function main(argv: string[]): Promise<number> {
	if (argv[0] === 'hcl' && (argv[1] === 'format' || argv[1] === 'fmt')) return formatHCL(argv.slice(2));
	if (argv[0] === 'stack' && argv[1] === 'generate') return stackGenerate(argv.slice(2));
	if (argv[0] === 'scaffold') return scaffoldLocal(argv.slice(1));
	if (argv[0] === 'catalog') return catalogJSONL(argv.slice(1));
	if (argv[0] === 'backend') return backendCommand(argv.slice(1));
	if (argv[0] === 'render') return renderConfig(argv.slice(1));
	if (argv[0] === 'run') {
		if (argv.includes('--help')) {
			console.log(executionUsage());
			return 0;
		}
		return executeTerraformCommand(argv.slice(1));
	}
	if (tofuShortcuts.has(argv[0] ?? '')) return executeTerraformCommand(argv);
	if (argv[0] === 'exec') {
		const command = argv[1];
		if (!command || command.startsWith('-')) throw new Error('Usage: tghclp exec <command> [arguments...]');
		const result = spawnSync(command, argv.slice(2), {cwd: process.cwd(), stdio: 'inherit', shell: false});
		if (result.error) throw new Error(`Unable to execute ${command}: ${result.error.message}`);
		return result.status ?? 1;
	}
	if (argv[0] === 'find' || argv[0] === 'fd' || argv[0] === 'list' || argv[0] === 'ls') {
		const command = argv[0] === 'find' || argv[0] === 'fd' ? 'find' : 'list';
		const parsed = parseArgs(argv.slice(1));
		if (parsed === 'help') { console.log(discoveryUsage(command)); return 0; }
		if (parsed.dependencies && parsed.format !== 'dot') throw new Error('--dependencies is only supported with --format=dot');
		const roots = parsed.paths.length > 0 ? parsed.paths.map(target => path.resolve(parsed.workingDir, target)) : [parsed.workingDir];
		const configs = (await Promise.all(roots.map(root => discoverConfigs(root, parsed.noHidden, parsed.workingDir)))).flat().sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
		if (configs.length === 0) throw new Error(`No Terragrunt configurations found under ${parsed.workingDir}`);
		if (command === 'find') printFind(configs, parsed);
		else if (parsed.dependencies && parsed.format === 'dot') await printDependencyGraph(parsed.workingDir);
		else printList(configs, parsed);
		return 0;
	}
	if (argv[0] === 'dag') {
		if (argv[1] !== 'graph') throw new Error('Usage: tghclp dag graph [options]');
		const parsed = parseArgs(argv.slice(2));
		if (parsed === 'help') { console.log(discoveryUsage('dag graph')); return 0; }
		if (parsed.dependencies && parsed.format && parsed.format !== 'dot') throw new Error('--dependencies is only supported with DOT output');
		await printDependencyGraph(parsed.workingDir);
		return 0;
	}
	if (argv[0] === 'info') {
		const parsed = parseArgs(argv.slice(2));
		if (parsed === 'help') { console.log('Usage: tghclp info print [options]'); return 0; }
		printInfo(argv[1] ?? '', parsed.workingDir);
		return 0;
	}
	if (argv[0] !== 'hcl' || argv[1] !== 'validate') throw new Error('Unsupported command; use "tghclp hcl validate", "find", "list", "dag graph", or "info print"');
	const parsed = parseArgs(argv.slice(2));
	if (parsed === 'help') { console.log(usage()); return 0; }
	const roots = parsed.paths.length > 0 ? parsed.paths.map(target => path.resolve(parsed.workingDir, target)) : [parsed.workingDir];
	const files = (await Promise.all(roots.map(collectFiles))).flat().sort();
	if (files.length === 0) throw new Error(`No Terragrunt HCL files found under ${parsed.workingDir}`);
	const diagnostics = (await Promise.all(files.map(file => validateFile(file, parsed.workingDir, parsed.experiments)))).flat();
	if (parsed.showConfigPath) {
		if (diagnostics.length > 0) {
			const paths = [...new Set(diagnostics.map(item => item.range.filename))];
			if (parsed.json) process.stdout.write(`${JSON.stringify(paths)}\n`);
			else for (const file of paths) process.stdout.write(`${file}\n`);
		}
	} else if (parsed.json) {
		if (diagnostics.length > 0) process.stdout.write(`${JSON.stringify(diagnostics)}\n`);
	} else if (diagnostics.length > 0) {
		for (const item of diagnostics) process.stderr.write(`${item.range.filename}: ${item.summary}: ${item.detail}\n`);
	}
	return diagnostics.length === 0 ? 0 : 1;
}

const invokedAsCLI = process.argv[1]?.endsWith('/cli.js') === true || process.argv[1]?.endsWith('/cli.cjs') === true || process.argv[1]?.endsWith('/cli.ts') === true;
if (invokedAsCLI) {
	try {
		if (process.argv.includes('--help') && process.argv.length <= 3) console.log(rootUsage());
		else main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
