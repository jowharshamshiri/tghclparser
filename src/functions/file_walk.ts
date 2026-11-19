import fs from 'node:fs/promises';
import path from 'node:path';

// What a walk knows of an entry: a directory read lists it with its own type,
// and a root is described by lstat, so a symbolic link is never a directory.
export interface WalkEntry {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

// The failures that mean a path cannot be read or resolved, which Terragrunt's
// walks pass over; any other failure is raised.
const unreadableCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);

export function isUnreadable(error: unknown): boolean {
	return unreadableCodes.has((error as NodeJS.ErrnoException).code ?? '');
}

// Go orders a directory's entries by the bytes of their names.
function byName(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/**
 * Visits root and everything below it as Terragrunt's WalkDir does: each directory before its entries, its entries by
 * name, and no symbolic link followed, the root's own included. A root that cannot be described, or a directory that
 * cannot be read, is passed over.
 *
 * @param root the path the walk starts from.
 * @param visit called with each path and its entry, in walk order.
 */
export async function walkDirectory(root: string, visit: (entry: string, kind: WalkEntry) => Promise<void>): Promise<void> {
	let kind: WalkEntry;
	try {
		kind = await fs.lstat(root);
	} catch (error) {
		if (isUnreadable(error)) return;
		throw error;
	}
	await walkBelow(root, kind, visit);
}

async function walkBelow(entry: string, kind: WalkEntry, visit: (entry: string, kind: WalkEntry) => Promise<void>): Promise<void> {
	await visit(entry, kind);
	if (!kind.isDirectory()) return;
	let children;
	try {
		children = await fs.readdir(entry, { withFileTypes: true });
	} catch (error) {
		if (isUnreadable(error)) return;
		throw error;
	}
	children.sort((left, right) => byName(left.name, right.name));
	for (const child of children) await walkBelow(path.join(entry, child.name), child, visit);
}

/**
 * Visits root and everything below it as Terragrunt's WalkDirWithSymlinks does: like {@link walkDirectory}, but also
 * descending into each directory a symbolic link resolves to, reported as though it lived at the link's own path.
 * Each such path is visited once, and a link back to an ancestor ends instead of looping. A root that does not
 * resolve, or a link that does not, is passed over.
 *
 * @param root the path the walk starts from, which the visited paths are spelled under.
 * @param visit called with each path and its entry, in walk order.
 */
export async function walkDirectoryFollowingLinks(root: string, visit: (entry: string, kind: WalkEntry) => Promise<void>): Promise<void> {
	let physicalRoot: string;
	try {
		physicalRoot = await fs.realpath(root);
	} catch (error) {
		if (isUnreadable(error)) return;
		throw error;
	}
	const followed = new Set<string>();
	const visited = new Set<string>();
	const walk = (physical: string, logical: string): Promise<void> => walkDirectory(physical, async (current, kind) => {
		const logicalPath = path.join(logical, path.relative(physical, current));
		if (!visited.has(logicalPath)) {
			visited.add(logicalPath);
			await visit(logicalPath, kind);
		}
		if (!kind.isSymbolicLink()) return;
		let target: string;
		let targetIsDirectory: boolean;
		try {
			target = await fs.realpath(current);
			targetIsDirectory = (await fs.stat(target)).isDirectory();
		} catch (error) {
			if (isUnreadable(error)) return;
			throw error;
		}
		const link = `${target}:${current}`;
		if (followed.has(link)) return;
		followed.add(link);
		if (targetIsDirectory) await walk(target, logicalPath);
	});
	await walk(physicalRoot, path.resolve(root));
}

/**
 * A path with its symbolic links resolved as far as it exists, and the rest appended as written, as Terragrunt
 * compares paths, so a link that leaves a directory is not counted as inside it.
 *
 * @param target an absolute path.
 * @returns the path to compare.
 */
export async function resolveForCompare(target: string): Promise<string> {
	const cleaned = path.resolve(target);
	try {
		return await fs.realpath(cleaned);
	} catch (error) {
		if (!isUnreadable(error)) throw error;
	}
	const parent = path.dirname(cleaned);
	return parent === cleaned ? cleaned : path.join(await resolveForCompare(parent), path.basename(cleaned));
}

/**
 * Whether target is directory or below it, both compared through {@link resolveForCompare}.
 *
 * @param directory the directory.
 * @param target the path.
 * @returns true when target is directory or a descendant of it.
 */
export async function isWithin(directory: string, target: string): Promise<boolean> {
	const relative = path.relative(await resolveForCompare(directory), await resolveForCompare(target));
	return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}
