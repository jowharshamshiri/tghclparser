import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

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

function unescapePattern(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index++) {
		if (value[index] === '\\') {
			if (index + 1 >= value.length) throw new Error(`Trailing escape in glob: ${value}`);
			result += value[++index];
		} else result += value[index];
	}
	return result;
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

function hasMeta(pattern: string): boolean {
	for (let index = 0; index < pattern.length; index++) {
		if ('*?['.includes(pattern[index]) && !isEscaped(pattern, index)) return true;
	}
	return false;
}

function walkRoot(pattern: string): string {
	let firstMeta = pattern.length;
	for (let index = 0; index < pattern.length; index++) {
		if ('*?['.includes(pattern[index]) && !isEscaped(pattern, index)) {
			firstMeta = index;
			break;
		}
	}
	const prefix = pattern.slice(0, firstMeta);
	return unescapePattern(prefix.endsWith('/') ? prefix.slice(0, -1) || '/' : path.dirname(prefix));
}

async function gitBoundary(startDirectory: string): Promise<string | undefined> {
	let directory = path.resolve(startDirectory);
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

function assertWithinBoundary(directory: string, boundary: string | undefined, pattern: string): void {
	if (!boundary) return;
	const relative = path.relative(boundary, directory);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Glob walk for ${pattern} starts outside Terragrunt boundary ${boundary}`);
	}
}

async function filesBelow(directory: string): Promise<string[]> {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return [];
		throw error;
	}
	for (const entry of entries) {
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await filesBelow(target));
		else if (entry.isFile()) files.push(target);
	}
	return files;
}

export async function expandTerragruntGlob(args: string[], workingDirectory: string): Promise<string[]> {
	if (args.length < 1 || args.length > 2) throw new Error('mark_glob_as_read requires a pattern and an optional leading --terragrunt-boundary argument');
	let boundary = await gitBoundary(workingDirectory);
	let pattern = args[0];
	if (args.length === 2) {
		if (!args[0].startsWith('--terragrunt-boundary=')) throw new Error('mark_glob_as_read boundary must use --terragrunt-boundary=<directory>');
		const configuredBoundary = args[0].slice('--terragrunt-boundary='.length);
		if (!configuredBoundary) throw new Error('mark_glob_as_read boundary cannot be empty');
		boundary = path.resolve(workingDirectory, configuredBoundary);
		pattern = args[1];
	}
	if (!pattern) throw new Error('mark_glob_as_read pattern cannot be empty');
	const matches = new Set<string>();
	for (const expandedPattern of expandBraces(path.isAbsolute(pattern) ? path.normalize(pattern) : path.resolve(workingDirectory, pattern))) {
		const root = walkRoot(expandedPattern);
		assertWithinBoundary(root, boundary, expandedPattern);
		if (!hasMeta(expandedPattern)) {
			try {
				const literalPath = unescapePattern(expandedPattern);
				if ((await fs.stat(literalPath)).isFile()) matches.add(path.resolve(literalPath));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
			}
			continue;
		}
		const matcher = globRegex(expandedPattern);
		for (const candidate of await filesBelow(root)) {
			if (matcher.test(candidate.split(path.sep).join('/'))) matches.add(path.resolve(candidate));
		}
	}
	return [...matches].sort();
}
