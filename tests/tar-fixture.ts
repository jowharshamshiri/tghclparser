import { gzipSync } from 'node:zlib';

import * as tar from 'tar-stream';

/** One entry of a fixture archive. */
export interface TarFixtureEntry {
	/** The path stored in the header, written as given, `..` included. */
	name: string;
	/** A file's content; empty when omitted. */
	content?: string;
	/** The entry type; `file` when omitted. */
	type?: 'file' | 'directory' | 'symlink' | 'link';
	/** What a symlink or hard link points to. */
	linkname?: string;
}

/**
 * Builds a tar.gz in memory, so a test can hold entries a real directory cannot, such as `..` paths.
 *
 * @param entries the entries, in archive order.
 * @returns a gzip-compressed tar archive holding them.
 */
export async function tarGz(entries: TarFixtureEntry[]): Promise<Buffer> {
	const pack = tar.pack();
	for (const entry of entries) {
		const type = entry.type ?? 'file';
		if (type === 'file') pack.entry({ name: entry.name, type }, entry.content ?? '');
		else pack.entry({ name: entry.name, type, linkname: entry.linkname });
	}
	pack.finalize();
	const chunks: Buffer[] = [];
	for await (const chunk of pack) chunks.push(chunk as Buffer);
	return gzipSync(Buffer.concat(chunks));
}
