import fs from 'node:fs/promises';
import path from 'node:path';

import { goStatFailures, resolveForCompare } from './file_walk';

/** The variable listing directories the walk does not ascend into, as Git's own discovery reads it. */
export const gitCeilingDirectoriesVariable = 'GIT_CEILING_DIRECTORIES';

/** A walk that found no repository root, or met a failure on the way, with Terragrunt's text for it. */
export class RepoRootError extends Error {
	constructor(message: string) {
		super(`go_repo_root: ${message}`);
		this.name = 'RepoRootError';
	}
}

// Go's filepath.SplitList: nothing for an empty list, and on Windows a quoted
// separator kept and the quotes removed.
function splitList(list: string): string[] {
	if (list === '') return [];
	if (path.sep === '/') return list.split(path.delimiter);
	const entries: string[] = [];
	let start = 0;
	let quoted = false;
	for (let index = 0; index < list.length; index++) {
		if (list[index] === '"') quoted = !quoted;
		else if (list[index] === path.delimiter && !quoted) {
			entries.push(list.slice(start, index));
			start = index + 1;
		}
	}
	entries.push(list.slice(start));
	return entries.map(entry => entry.replaceAll('"', ''));
}

// Go's filepath.IsAbs: on Windows a path is absolute only with a volume and a
// separator after it, or when it starts with two separators.
function isGoAbsolute(value: string): boolean {
	if (path.sep === '/') return value.startsWith('/');
	return /^(?:[\\/]{2}|[A-Za-z]:[\\/])/.test(value);
}

// Go's filepath.VolumeName: a drive letter with its colon, or a UNC path's
// server and share; nothing on POSIX.
function volumeName(value: string): string {
	if (path.sep === '/') return '';
	if (/^[A-Za-z]:/.test(value)) return value.slice(0, 2);
	const { root } = path.win32.parse(value);
	return /^[\\/]{2}/.test(root) ? root.replace(/[\\/]$/, '') : '';
}

function toSlash(value: string): string {
	return path.sep === '/' ? value : value.split(path.sep).join('/');
}

// Whether target sits strictly below ancestor, compared on whole components.
function isStrictAncestor(ancestor: string, target: string): boolean {
	const relative = path.relative(ancestor, target);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// The strict ancestor of start that an absolute entry names once its links
// are resolved, or nothing.
async function resolvedCeiling(entry: string, start: string): Promise<string> {
	const ceiling = await resolveForCompare(entry);
	return isStrictAncestor(ceiling, start) ? ceiling : '';
}

// The strict ancestor of start that an entry kept as written names, compared
// with forward slashes and one trailing slash dropped, or nothing.
function keptCeiling(entry: string, start: string): string {
	const prefix = entry.endsWith('/') ? entry.slice(0, -1) : entry;
	const slashed = toSlash(start);
	if (!slashed.startsWith(`${prefix}/`) || slashed.length === prefix.length + 1) return '';
	if (prefix.length === volumeName(start).length) return start.slice(0, prefix.length) + path.sep;
	return start.slice(0, prefix.length);
}

// The deepest entry of the ceiling list that the walk from start must not
// ascend into, or nothing. An empty entry keeps every entry after it as
// written instead of resolving its links, and a relative entry is skipped.
async function walkCeiling(list: string, start: string): Promise<string> {
	let deepest = '';
	let kept = false;
	for (const entry of splitList(list)) {
		if (entry === '') {
			kept = true;
			continue;
		}
		if (!isGoAbsolute(entry)) continue;
		const ceiling = kept ? keptCeiling(entry, start) : await resolvedCeiling(entry, start);
		if (ceiling.length > deepest.length) deepest = ceiling;
	}
	return deepest;
}

/** How many directories the walk examines before it gives up, so a walk that never reaches a root cannot run on. */
export const maxWalkDepth = 1024;

/**
 * The root of the Git repository that holds directory, found as Terragrunt's GoRepoRoot finds it: from directory with
 * its symbolic links resolved, up to the nearest directory holding a `.git` entry of any kind, never entering the
 * deepest directory GIT_CEILING_DIRECTORIES names above it, and examining at most {@link maxWalkDepth} directories.
 *
 * @param directory the absolute directory the walk starts from.
 * @param environment the environment GIT_CEILING_DIRECTORIES is read from.
 * @param memo the run's roots by the directories walked to them, which answers a directory the run has walked before
 * and learns those this walk proves hold no `.git`, so a repository made while the run goes on is not seen.
 * @returns the root, with its links resolved.
 * @throws RepoRootError when no root is found below the ceiling or within the depth, or a `.git` entry cannot be
 * described for any reason but its absence.
 */
export async function goRepoRoot(
	directory: string,
	environment: Record<string, string | undefined>,
	memo?: Map<string, string>
): Promise<string> {
	let current = await resolveForCompare(directory);
	const ceiling = await walkCeiling(environment[gitCeilingDirectoriesVariable] ?? '', current);
	const walked: string[] = [];
	const found = (root: string): string => {
		for (const dir of walked) memo?.set(dir, root);
		return root;
	};
	for (let depth = 0; depth < maxWalkDepth; depth++) {
		// The memo is read after the ceiling, since an entry at or above it
		// comes from a walk that started there, where the ceiling did not apply.
		if (current === ceiling) throw new RepoRootError('no enclosing git repository');
		const known = memo?.get(current);
		if (known !== undefined) return found(known);
		const marker = path.join(current, '.git');
		try {
			await fs.stat(marker);
			return found(current);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? '';
			if (code !== 'ENOENT') {
				if (goStatFailures[code] === undefined) throw error;
				throw new RepoRootError(`stat ${marker}: ${goStatFailures[code]}`);
			}
		}
		walked.push(current);
		const parent = path.dirname(current);
		if (parent === current) throw new RepoRootError('no enclosing git repository');
		current = parent;
	}
	throw new RepoRootError(`depth ${maxWalkDepth}: repository-root walk exceeded max depth`);
}
