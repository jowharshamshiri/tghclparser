import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseHclSyntax } from './syntax';

/** The variables `-var` and `-var-file` arguments set, as Terragrunt reads them. */
export interface VarFlags {
	/** Names set by `-var=NAME=VALUE`. */
	vars: string[];
	/** Files named by `-var-file=PATH`, as written. */
	varFiles: string[];
}

/**
 * Reads the `-var` and `-var-file` flags from a list of OpenTofu arguments, as Terragrunt 1.2 does: each argument is
 * taken as written, since OpenTofu gets it with no shell in between, so `-var=NAME=VALUE` gives `NAME` and
 * `-var-file=PATH` gives `PATH`, quotes included.
 *
 * @param args the arguments, one OpenTofu argument each.
 * @returns the variable names and var files they set.
 */
export function varFlags(args: readonly string[]): VarFlags {
	const flags: VarFlags = { vars: [], varFiles: [] };
	for (const arg of args) {
		if (arg.startsWith('-var=')) flags.vars.push(arg.slice('-var='.length).split('=')[0]);
		if (arg.startsWith('-var-file=')) flags.varFiles.push(arg.slice('-var-file='.length));
	}
	return flags;
}

/**
 * The var files OpenTofu loads from a directory without being told to: `terraform.tfvars`, `terraform.tfvars.json`
 * and every `*.auto.tfvars` and `*.auto.tfvars.json`.
 *
 * @param dir the directory to look in.
 * @returns their absolute paths, sorted; none when the directory does not exist.
 */
export async function automaticVarFiles(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter(entry => !entry.isDirectory())
		.map(entry => entry.name)
		.filter(name => name === 'terraform.tfvars' || name === 'terraform.tfvars.json' || name.endsWith('.auto.tfvars') || name.endsWith('.auto.tfvars.json'))
		.sort()
		.map(name => path.join(dir, name));
}

/**
 * The names of the variables a var file sets: the top-level keys of a `.json` file, else the attributes of an HCL
 * file.
 *
 * @param file absolute path of the var file.
 * @returns the names, in the order written.
 * @throws when the file cannot be read or parsed, or a JSON file does not hold an object.
 */
export async function varFileNames(file: string): Promise<string[]> {
	const content = await fs.readFile(file, 'utf8');
	if (file.endsWith('json')) {
		const parsed: unknown = JSON.parse(content);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} does not hold an object`);
		return Object.keys(parsed);
	}
	const ast = parseHclSyntax(content, file, file);
	return (ast.children ?? []).filter(child => child.type === 'assignment').map(child => String(child.value));
}
