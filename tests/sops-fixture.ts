import fs from 'node:fs/promises';
import path from 'node:path';

/** A sops YAML file as sops writes it: the keys in clear, every value encrypted, and its own metadata at the end. */
export const ENCRYPTED_SOPS_YAML = [
	'token: ENC[AES256_GCM,data:nq2Z7w==,iv:A1B2,tag:C3D4,type:str]',
	'db:',
	'    password: ENC[AES256_GCM,data:x9Yz,iv:E5F6,tag:G7H8,type:str]',
	'sops:',
	'    kms:',
	'        - arn: arn:aws:kms:eu-west-2:123456789012:key/00000000-0000-0000-0000-000000000000',
	'          created_at: "2026-10-27T10:00:00Z"',
	'          enc: AQICAHg=',
	'    lastmodified: "2026-10-27T10:00:00Z"',
	'    mac: ENC[AES256_GCM,data:bWFj,iv:I9J0,tag:K1L2,type:str]',
	'    version: 3.9.0',
	''
].join('\n');

/** The same document as sops writes it to a JSON file. */
export const ENCRYPTED_SOPS_JSON = JSON.stringify({
	token: 'ENC[AES256_GCM,data:nq2Z7w==,iv:A1B2,tag:C3D4,type:str]',
	db: { password: 'ENC[AES256_GCM,data:x9Yz,iv:E5F6,tag:G7H8,type:str]' },
	sops: { kms: [{ arn: 'arn:aws:kms:eu-west-2:123456789012:key/00000000-0000-0000-0000-000000000000' }], version: '3.9.0' }
}, null, '\t');

/** What the fixture's `sops` reports on every decrypt. */
export const SOPS_KEY_FAILURE = 'Failed to get the data key required to decrypt the SOPS file.';

/**
 * Runs `work` with a `sops` on `PATH` that cannot decrypt anything, as on a machine without access to the key.
 *
 * @param directory a directory the fixture binary can be written under.
 * @param work what to run while that `sops` is first on `PATH`.
 * @returns whatever `work` returns.
 */
export async function withoutSopsKey<T>(directory: string, work: () => Promise<T>): Promise<T> {
	const bin = path.join(directory, 'sops-bin');
	await fs.mkdir(bin, { recursive: true });
	await fs.writeFile(path.join(bin, 'sops'), `#!/bin/sh\necho "${SOPS_KEY_FAILURE}" >&2\nexit 1\n`, { mode: 0o755 });
	const previous = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
	try {
		return await work();
	} finally {
		process.env.PATH = previous;
	}
}
