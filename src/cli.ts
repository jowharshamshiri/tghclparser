#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ConfigEvaluator, runtimeValueToPlain } from './Evaluator';
import { ParsedDocument } from './ParsedDocument';
import { Workspace } from './Workspace';

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
		if (argument === '--') {
			index++;
			break;
		}
		break;
	}
	const command = argv[index];
	if (!command || command.startsWith('-')) throw new Error('A Terraform/OpenTofu command is required');
	return {workingDir, tfPath, command, args: argv.slice(index + 1)};
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

async function executeTerraformCommand(argv: string[]): Promise<number> {
	const options = parseExecutionArgs(argv);
	const configFiles = await collectFiles(options.workingDir);
	if (configFiles.length === 0) throw new Error(`No Terragrunt HCL files found under ${options.workingDir}`);
	const diagnostics = (await Promise.all(configFiles.map(file => validateFile(file, options.workingDir, [])))).flat();
	if (diagnostics.length > 0) {
		for (const item of diagnostics) process.stderr.write(`${item.range.filename}: ${item.summary}: ${item.detail}\n`);
		return 1;
	}
	for (const configFile of configFiles) {
		await materializeGeneratedFiles(configFile, await fs.readFile(configFile, 'utf8'), options.workingDir);
	}
	const executable = path.isAbsolute(options.tfPath) ? options.tfPath : options.tfPath;
	const result = spawnSync(executable, [options.command, ...options.args], {
		cwd: options.workingDir,
		stdio: 'inherit',
		 shell: false
	});
	if (result.error) throw new Error(`Unable to execute ${options.tfPath}: ${result.error.message}`);
	if (result.signal) throw new Error(`${options.tfPath} terminated by ${result.signal}`);
	return result.status ?? 1;
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

async function main(argv: string[]): Promise<number> {
	if (argv[0] === 'hcl' && (argv[1] === 'format' || argv[1] === 'fmt')) return formatHCL(argv.slice(2));
	if (argv[0] === 'stack' && argv[1] === 'generate') return stackGenerate(argv.slice(2));
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
