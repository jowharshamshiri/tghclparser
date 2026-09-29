import { redactSource } from './module-source';

/** Every way fetching a remote module can fail, so a message can be chosen by code and tests can assert on it. */
export type RemoteSourceErrorCode =
	| 'MalformedTfrSource'
	| 'HostUnreachable'
	| 'NotAModuleRegistry'
	| 'RegistryAuth'
	| 'RateLimited'
	| 'ModuleNotFound'
	| 'NoVersions'
	| 'NoStableVersion'
	| 'InvalidConstraint'
	| 'NoMatchingVersion'
	| 'VersionNotFound'
	| 'NoDownloadLocation'
	| 'UnsupportedDownloadForm'
	| 'ArchiveDownloadFailed'
	| 'ArchiveMalformed'
	| 'ChecksumMismatch'
	| 'GitNotFound'
	| 'GitTooOld'
	| 'GitRefNotFound'
	| 'GitFetchFailed'
	| 'SubdirectoryEscapes'
	| 'SubdirectoryMissing'
	| 'ModuleTooLarge'
	| 'HostNotAllowed'
	| 'HostNotApproved'
	| 'CacheWrite';

/**
 * A failure to fetch a remote module, with a code the caller can act on and a message fit to show. The message is
 * redacted on construction, so nothing built from a URL, a response or a command's output can carry a credential.
 */
export class RemoteSourceError extends Error {
	/**
	 * Creates the error with its message redacted.
	 *
	 * @param code what went wrong, for the caller to act on.
	 * @param message the message, which may still carry credentials.
	 * @param options the underlying error, if any.
	 */
	constructor(public readonly code: RemoteSourceErrorCode, message: string, options?: { cause?: unknown }) {
		super(redactSource(message), options);
		this.name = 'RemoteSourceError';
	}
}

/**
 * Turns anything thrown into a {@link RemoteSourceError}, keeping one that already is, so its more specific code
 * survives.
 *
 * @param error anything thrown.
 * @param code the code for an error that is not already a {@link RemoteSourceError}.
 * @param context what was being done, which the wrapped message starts with.
 * @returns the error itself when it is a {@link RemoteSourceError}, else one with the given code wrapping it.
 */
export function asRemoteSourceError(error: unknown, code: RemoteSourceErrorCode, context: string): RemoteSourceError {
	if (error instanceof RemoteSourceError) return error;
	const detail = error instanceof Error ? error.message : String(error);
	return new RemoteSourceError(code, `${context}: ${detail}`, { cause: error });
}
