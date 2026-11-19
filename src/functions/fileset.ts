import fs from 'node:fs/promises';
import path from 'node:path';

import { goQuoted } from '../go-quote';
import { BadPatternError, doublestarMatch, validDoublestarPattern } from './doublestar';
import { isUnreadable, walkDirectoryFollowingLinks } from './file_walk';

// Go orders a set of strings by their bytes.
function byBytes(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/**
 * fileset as Terragrunt v1.2.2 has it: the regular files below a directory, the directories symbolic links in it
 * resolve to included, whose '/'-separated path relative to the directory matches a doublestar pattern, answered
 * relative to it in lexical order. A relative directory resolves from the working directory, no boundary applies,
 * and a directory that is not there has no files.
 *
 * @param directory the directory to search.
 * @param pattern the pattern its files' relative paths are matched against.
 * @param workingDirectory the directory a relative one resolves from.
 * @returns the matching files' paths relative to the directory.
 */
export async function fileset(directory: string, pattern: string, workingDirectory: string): Promise<string[]> {
	const root = path.isAbsolute(directory) ? directory : path.join(workingDirectory, directory);
	const failure = () => {
		const joined = path.join(root, pattern);
		const cleaned = joined.length > 1 && joined.endsWith(path.sep) ? joined.slice(0, -1) : joined;
		return new Error(`failed to glob pattern ${goQuoted(cleaned)}: syntax error in pattern`);
	};
	if (!validDoublestarPattern(pattern)) throw failure();
	const matches = new Set<string>();
	try {
		await walkDirectoryFollowingLinks(root, async (entry, kind) => {
			if (kind.isDirectory()) return;
			const relative = path.relative(root, entry).split(path.sep).join('/') || '.';
			if (!doublestarMatch(pattern, relative)) return;
			if (kind.isSymbolicLink()) {
				// A link counts when it resolves to a regular file.
				try {
					if (!(await fs.stat(entry)).isFile()) return;
				} catch (error) {
					if (isUnreadable(error)) return;
					throw error;
				}
			} else if (!kind.isFile()) return;
			matches.add(relative);
		});
	} catch (error) {
		if (error instanceof BadPatternError) throw failure();
		throw error;
	}
	return [...matches].sort(byBytes);
}
