import fs from 'node:fs/promises';
import path from 'node:path';

import { goQuoted } from '../go-quote';
import { isWithin, resolveForCompare, walkDirectory } from './file_walk';

function isEscaped(value: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) slashes++;
	return slashes % 2 === 1;
}

function expandBraces(pattern: string): string[] {
	let opening = -1;
	for (let index = 0; index < pattern.length; index++) {
		if (pattern[index] === '{' && !isEscaped(pattern, index)) {
			opening = index;
			break;
		}
	}
	if (opening < 0) return [pattern];

	let depth = 0;
	let closing = -1;
	for (let index = opening; index < pattern.length; index++) {
		if (isEscaped(pattern, index)) continue;
		if (pattern[index] === '{') depth++;
		if (pattern[index] === '}' && --depth === 0) {
			closing = index;
			break;
		}
	}
	if (closing < 0) throw new Error(`Unclosed brace alternative in glob: ${pattern}`);

	const alternatives: string[] = [];
	let alternativeStart = opening + 1;
	depth = 0;
	for (let index = alternativeStart; index < closing; index++) {
		if (isEscaped(pattern, index)) continue;
		if (pattern[index] === '{') depth++;
		if (pattern[index] === '}') depth--;
		if (pattern[index] === ',' && depth === 0) {
			alternatives.push(pattern.slice(alternativeStart, index));
			alternativeStart = index + 1;
		}
	}
	alternatives.push(pattern.slice(alternativeStart, closing));
	if (alternatives.length < 2) throw new Error(`Glob brace expression requires alternatives: ${pattern}`);

	return alternatives.flatMap(alternative => expandBraces(pattern.slice(0, opening) + alternative + pattern.slice(closing + 1)));
}

function escapeRegex(character: string): string {
	return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern: string): RegExp {
	let source = '^';
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === '\\') {
			if (index + 1 >= pattern.length) throw new Error(`Trailing escape in glob: ${pattern}`);
			source += escapeRegex(pattern[++index]);
			continue;
		}
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				source += '.*';
				index++;
			} else source += '[^/]*';
			continue;
		}
		if (character === '?') {
			source += '[^/]';
			continue;
		}
		if (character === '[') {
			let closing = index + 1;
			while (closing < pattern.length && (pattern[closing] !== ']' || isEscaped(pattern, closing))) closing++;
			if (closing >= pattern.length) throw new Error(`Unclosed character class in glob: ${pattern}`);
			let contents = pattern.slice(index + 1, closing);
			if (!contents) throw new Error(`Empty character class in glob: ${pattern}`);
			if (contents[0] === '!') contents = `^${contents.slice(1)}`;
			source += `[${contents}]`;
			index = closing;
			continue;
		}
		source += escapeRegex(character);
	}
	return new RegExp(`${source}$`);
}

// The pattern stays '/'-separated from end to end, as Terragrunt keeps it, so
// a '\' in it is always the escape it was written as.
function toSlash(value: string): string {
	return path.sep === '/' ? value : value.split(path.sep).join('/');
}

function fromSlash(value: string): string {
	return path.sep === '/' ? value : value.split('/').join(path.sep);
}

// Go's path.Clean: '.' and '..' resolved lexically, and repeated and trailing
// separators dropped.
function cleanSlashPath(value: string): string {
	const cleaned = path.posix.normalize(value);
	return cleaned.length > 1 && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
}

// The walk starts from the longest leading directory of the pattern that holds
// none of *?[{\, so a brace or an escape ends it as a wildcard does, before
// any brace is expanded. A pattern holding none of them names one path, which
// is its own root.
function splitRoot(pattern: string): { root: string; hasMeta: boolean } {
	const metaIndex = pattern.search(/[*?[{\\]/);
	if (metaIndex < 0) return { root: fromSlash(pattern), hasMeta: false };
	const separator = pattern.lastIndexOf('/', metaIndex);
	const prefix = separator < 0 ? '.' : pattern.slice(0, separator) || '/';
	return { root: fromSlash(prefix), hasMeta: true };
}

// The enclosing Git repository's root, found from the working directory with
// its symbolic links resolved, as Terragrunt finds it.
async function gitBoundary(startDirectory: string): Promise<string | undefined> {
	let directory = await resolveForCompare(startDirectory);
	while (true) {
		try {
			await fs.access(path.join(directory, '.git'));
			return directory;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

// Go's text for the failures a stat of a named path can meet.
const statFailures: Record<string, string> = {
	EACCES: 'permission denied',
	ELOOP: 'too many levels of symbolic links',
	ENAMETOOLONG: 'file name too long',
	ENOTDIR: 'not a directory',
	EPERM: 'operation not permitted'
};

const boundaryFlag = '--terragrunt-boundary';

// A leading argument that starts with the flag sets the boundary, inline
// ("--terragrunt-boundary=<directory>") or as the next argument
// ("--terragrunt-boundary", "<directory>"), resolved against the working
// directory; the arguments after it are the pattern's.
function parseBoundary(args: string[], workingDirectory: string): { boundary?: string; rest: string[] } {
	if (args.length === 0 || !args[0].startsWith(boundaryFlag)) return { rest: args };
	let configuredBoundary: string;
	let rest: string[];
	if (args[0] === boundaryFlag) {
		if (args.length < 2) throw new Error(`${boundaryFlag} requires a directory value`);
		configuredBoundary = args[1];
		rest = args.slice(2);
	} else if (args[0].startsWith(`${boundaryFlag}=`)) {
		configuredBoundary = args[0].slice(boundaryFlag.length + 1);
		rest = args.slice(1);
	} else throw new Error(`unrecognized flag ${goQuoted(args[0])} for mark_glob_as_read`);
	if (!configuredBoundary) throw new Error(`${boundaryFlag} requires a non-empty directory value`);
	return { boundary: path.resolve(workingDirectory, configuredBoundary), rest };
}

export async function expandTerragruntGlob(args: string[], workingDirectory: string): Promise<string[]> {
	const { boundary: configuredBoundary, rest } = parseBoundary(args, workingDirectory);
	if (rest.length !== 1) throw new Error(`Expected 1 params for function mark_glob_as_read, but got ${rest.length}`);
	const boundary = configuredBoundary ?? await gitBoundary(workingDirectory);
	const raw = rest[0];
	// An empty pattern names the working directory, which is no file.
	const pattern = cleanSlashPath(path.isAbsolute(raw) ? raw : `${toSlash(workingDirectory)}/${raw}`);
	const { root, hasMeta } = splitRoot(pattern);
	if (boundary && !await isWithin(boundary, root)) {
		throw new Error(`mark_glob_as_read pattern ${goQuoted(raw)} resolves outside the boundary ${goQuoted(boundary)}; `
			+ `widen the boundary by passing ${boundaryFlag} as the first argument, `
			+ `for example mark_glob_as_read(${goQuoted(`${boundaryFlag}=/`)}, ${goQuoted(raw)}): `
			+ `glob pattern resolves outside the configured boundary: ${goQuoted(root)} is outside ${goQuoted(boundary)}`);
	}
	if (!hasMeta) {
		try {
			return (await fs.stat(root)).isDirectory() ? [] : [root];
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? '';
			if (code === 'ENOENT') return [];
			if (statFailures[code] === undefined) throw error;
			throw new Error(`could not expand glob ${goQuoted(raw)}: stat ${root}: ${statFailures[code]}`);
		}
	}
	const matchers = expandBraces(pattern).map(globRegex);
	// The matches come in the order the walk meets them, which is Terragrunt's.
	const matches: string[] = [];
	await walkDirectory(root, async (entry, kind) => {
		if (!kind.isDirectory() && matchers.some(matcher => matcher.test(toSlash(entry)))) matches.push(entry);
	});
	return matches;
}
