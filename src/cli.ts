#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigEvaluator } from './Evaluator';
import { ParsedDocument } from './ParsedDocument';
import { Workspace } from './Workspace';

interface CLIOptions {
	json: boolean;
	workingDir: string;
	paths: string[];
}

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

function usage(): string {
	return [
		'Usage: tghclp hcl validate [options] [directory|file ...]',
		'',
		'Options:',
		'  --json                  Write diagnostics as JSON',
		'  --working-dir <path>   Validate from a working directory',
		'  --help                 Show this help'
	].join('\n');
}

function parseArgs(argv: string[]): CLIOptions | 'help' {
	const options: CLIOptions = { json: false, workingDir: process.cwd(), paths: [] };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		switch (argument) {
			case '--json': options.json = true; break;
			case '--no-color':
			case '--no-tips':
			case '--non-interactive':
			case '--strict':
			case '--inputs':
				break;
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
		item.message.startsWith('Unknown attribute') ? 'Unsupported attribute' : 'HCL validation error';
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

async function validateFile(filePath: string, workDir: string): Promise<DiagnosticOutput[]> {
	const content = await fs.readFile(filePath, 'utf8');
	if (filePath.endsWith('.json')) {
		try { JSON.parse(content); return []; }
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
	if (argv[0] !== 'hcl' || argv[1] !== 'validate') throw new Error('Only "tghclp hcl validate" is supported');
	const parsed = parseArgs(argv.slice(2));
	if (parsed === 'help') { console.log(usage()); return 0; }
	const roots = parsed.paths.length > 0 ? parsed.paths.map(target => path.resolve(parsed.workingDir, target)) : [parsed.workingDir];
	const files = (await Promise.all(roots.map(collectFiles))).flat().sort();
	if (files.length === 0) throw new Error(`No Terragrunt HCL files found under ${parsed.workingDir}`);
	const diagnostics = (await Promise.all(files.map(file => validateFile(file, parsed.workingDir)))).flat();
	if (parsed.json) {
		if (diagnostics.length > 0) process.stdout.write(`${JSON.stringify(diagnostics)}\n`);
	} else if (diagnostics.length > 0) {
		for (const item of diagnostics) process.stderr.write(`${item.range.filename}: ${item.summary}: ${item.detail}\n`);
	}
	return diagnostics.length === 0 ? 0 : 1;
}

try {
	if (process.argv.includes('--help') && process.argv.length <= 3) console.log(usage());
	else main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
