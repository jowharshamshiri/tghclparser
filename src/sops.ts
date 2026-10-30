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
 *   does not hold a map.
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
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
	const document: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	delete document.sops;
	return extension === '.json' ? JSON.stringify(document) : yaml.dump(document);
}
