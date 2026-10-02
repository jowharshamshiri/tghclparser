import { createGunzip } from 'node:zlib';

import * as tar from 'tar-stream';

import { asRemoteSourceError, RemoteSourceError } from './remote-errors';

/** How much of a module is read, the same bounds a git fetch applies. */
export interface ModuleFileLimits {
	/** The largest `.tf` file read. */
	maximumFileBytes: number;
	/** The most bytes of `.tf` files read from one module. */
	maximumModuleBytes: number;
	/** The most `.tf` files read from one module. */
	maximumModuleFiles: number;
	/** The most bytes the archive may decompress to, whatever it holds. */
	maximumArchiveBytes: number;
}

/**
 * Tells a gzip stream from anything else by its first two bytes, whatever the URL or content type claims.
 *
 * @param data the start of a download.
 * @returns true when it carries the gzip magic number.
 */
export function isGzip(data: Uint8Array): boolean {
	return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Reads a module's top-level `.tf` files out of a gzip-compressed tar archive without writing anything to disk.
 * Only regular files named `*.tf` directly inside the subdirectory are kept; links, dotfiles, nested files and any
 * entry whose path climbs out with `..` are skipped.
 *
 * @param archive the downloaded archive.
 * @param subdirectory the directory inside the archive holding the module, empty for its root.
 * @param label how messages name the module.
 * @param limits how much is read.
 * @returns the kept files by name, sorted.
 * @throws {RemoteSourceError} `ArchiveMalformed` when the data is not a readable tar.gz, `SubdirectoryMissing` when
 *   nothing lies inside the subdirectory, `ModuleTooLarge` when a limit is passed.
 */
export async function readTarGzModule(archive: Uint8Array, subdirectory: string, label: string, limits: ModuleFileLimits): Promise<Map<string, Buffer>> {
	if (!isGzip(archive)) throw new RemoteSourceError('ArchiveMalformed', `${label} is not a gzip-compressed tar archive`);
	const wanted = pathSegments(subdirectory);
	const files = new Map<string, Buffer>();
	let subdirectoryFound = wanted.length === 0;
	let total = 0;
	try {
		for await (const entry of extractEntries(archive, label, limits.maximumArchiveBytes)) {
			const segments = pathSegments(entry.header.name);
			const relative = within(segments, wanted);
			if (relative && (relative.length > 0 || entry.header.type === 'directory')) subdirectoryFound = true;
			const name = relative?.length === 1 && entry.header.type === 'file' ? relative[0] : undefined;
			if (!name || !isModuleFile(name)) {
				entry.resume();
				continue;
			}
			const content = await readEntry(entry, `${name} in ${label}`, limits.maximumFileBytes);
			total += content.length - (files.get(name)?.length ?? 0);
			files.set(name, content);
			if (total > limits.maximumModuleBytes) throw new RemoteSourceError('ModuleTooLarge', `${label} has more than ${limits.maximumModuleBytes} bytes of Terraform files`);
			if (files.size > limits.maximumModuleFiles) throw new RemoteSourceError('ModuleTooLarge', `${label} has more than ${limits.maximumModuleFiles} Terraform files at the top level`);
		}
	} catch (error) {
		throw asRemoteSourceError(error, 'ArchiveMalformed', `${label} could not be read as a tar.gz archive`);
	}
	if (!subdirectoryFound) throw new RemoteSourceError('SubdirectoryMissing', `subdirectory ${subdirectory} does not exist in ${label}`);
	return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Decompresses an archive into a tar entry stream, counting the decompressed bytes so a gzip bomb is stopped
 * before it is expanded.
 *
 * @param archive the gzip-compressed tar archive.
 * @param label how messages name the module.
 * @param maximumBytes the most bytes the archive may decompress to.
 * @returns the tar entries, streamed; iterating fails with `ModuleTooLarge` once the limit is passed.
 */
function extractEntries(archive: Uint8Array, label: string, maximumBytes: number): tar.Extract {
	const gunzip = createGunzip();
	const extract = tar.extract();
	let produced = 0;
	gunzip.on('data', (chunk: Buffer) => {
		produced += chunk.length;
		if (produced > maximumBytes) gunzip.destroy(new RemoteSourceError('ModuleTooLarge', `${label} decompresses to more than ${maximumBytes} bytes`));
	});
	gunzip.on('error', error => extract.destroy(error));
	gunzip.pipe(extract);
	gunzip.end(archive);
	return extract;
}

/**
 * Reads one tar entry's content into memory once its header shows it is within the limit.
 *
 * @param entry a tar entry.
 * @param label how messages name the file.
 * @param maximumBytes the largest file read.
 * @returns the entry's content.
 * @throws {RemoteSourceError} `ModuleTooLarge` when the header declares more than the limit, before reading it.
 */
async function readEntry(entry: AsyncIterable<unknown> & { header: tar.Header }, label: string, maximumBytes: number): Promise<Buffer> {
	if (entry.header.size > maximumBytes) throw new RemoteSourceError('ModuleTooLarge', `${label} is ${entry.header.size} bytes; at most ${maximumBytes} are read`);
	const chunks: Buffer[] = [];
	for await (const chunk of entry) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/**
 * Splits a path so `./a/b`, `a//b` and `a/b/` compare equal.
 *
 * @param name a slash-separated path, as a tar entry or a subdirectory gives it.
 * @returns its segments, without empty and `.` segments.
 */
function pathSegments(name: string): string[] {
	return name.split('/').filter(segment => segment !== '' && segment !== '.');
}

/**
 * Places an entry relative to the module's subdirectory, treating any `..` as outside it.
 *
 * @param segments an entry's path segments.
 * @param directory the subdirectory's path segments.
 * @returns the entry's segments below the directory, or undefined when it lies outside it or climbs with `..`.
 */
function within(segments: string[], directory: string[]): string[] | undefined {
	if (segments.includes('..')) return undefined;
	if (!directory.every((segment, index) => segments[index] === segment)) return undefined;
	return segments.slice(directory.length);
}

/**
 * Decides whether a file name is one Terraform reads as part of a module.
 *
 * @param name a file name.
 * @returns true for a visible `.tf` file, the ones Terraform reads.
 */
function isModuleFile(name: string): boolean {
	return name.endsWith('.tf') && !name.startsWith('.');
}
