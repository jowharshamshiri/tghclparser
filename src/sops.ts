import fs from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';

/** The file extensions sops reads as a YAML or JSON document, which are the formats whose keys stay readable. */
const STRUCTURED_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/**
 * The document a sops file decrypts to, with every value still encrypted: the keys as sops wrote them, the `sops`
 * metadata left out, in the file's own format so the `yamldecode` or `jsondecode` around the read still parses it.
 *
 * @param filePath absolute path of the sops file.
 * @returns the document, or undefined when the file is not YAML or JSON by extension, cannot be read or parsed, or
 *   is not a map holding sops metadata. A file without that metadata is not one sops encrypted, so its values are
 *   not encrypted ones and the failed decrypt is the answer.
 */
export async function encryptedSopsDocument(filePath: string): Promise<string | undefined> {
	const extension = path.extname(filePath).toLowerCase();
	if (!STRUCTURED_EXTENSIONS.has(extension)) return undefined;
	let parsed: unknown;
	try {
		const content = await fs.readFile(filePath, 'utf8');
		parsed = extension === '.json' ? JSON.parse(content) : yaml.load(content);
	} catch {
		return undefined;
	}
	if (!isMap(parsed) || !isMap(parsed.sops)) return undefined;
	const document: Record<string, unknown> = { ...parsed };
	delete document.sops;
	return extension === '.json' ? JSON.stringify(document) : yaml.dump(document);
}

/**
 * @param value a parsed document or part of one.
 * @returns true when it is a map of keys to values.
 */
function isMap(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
