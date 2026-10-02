import { tokenEnvName } from './credentials';
import { canonicalHost } from './module-source';
import type { RemoteSourceErrorCode } from './remote-errors';
import { asRemoteSourceError, RemoteSourceError } from './remote-errors';
import type { RegistryModule, RegistryRequest, RegistryResolver } from './remote-modules';
import { resolveVersion } from './versions';

/** How the registry client reaches registries. */
export interface RegistryClientOptions {
	/** Hosts that may be reached over plain HTTP, for a loopback test registry; everything else must be HTTPS. */
	allowInsecureHosts?: string[];
	/** The fetch implementation; the global one when omitted. */
	fetch?: typeof fetch;
	/** How long one request may take; 10 seconds when omitted. */
	timeoutMs?: number;
	/** The `User-Agent` sent. */
	userAgent?: string;
	/** The clock, for cache expiry. */
	now?: () => number;
}

/** A registry API answer, read whole. */
interface RegistryResponse {
	status: number;
	headers: Headers;
	/** The body as UTF-8, at most 256 KiB. */
	text: string;
	/** The URL that answered after redirects, which relative locations resolve against. */
	url: string;
}

/** Who a request may carry a token to and what it must pass on the way. */
interface AuthorizedRequest extends RegistryRequest {
	/** The canonical registry host; the token is sent to no other. */
	tokenHost: string;
}

const discoveryTtlMs = 24 * 60 * 60 * 1000;
const versionsTtlMs = 15 * 60 * 1000;
const maximumBodyBytes = 256 * 1024;
const maximumArchiveBytes = 32 * 1024 * 1024;
const archiveTimeoutMs = 60 * 1000;
const maximumRedirects = 5;
const maximumRetries = 2;
const maximumRetryAfterMs = 30 * 1000;
const maximumVersions = 2000;

/**
 * A resolver that speaks the Terraform module registry protocol: service discovery, the versions listing and the
 * download endpoint. A token is sent only to the host it was looked up for, over HTTPS, on every hop of a redirect
 * chain. A download location is fetched here only when it is an archive.
 *
 * @param options how to reach registries.
 * @returns the resolver.
 */
export function createRegistryResolver(options: RegistryClientOptions = {}): RegistryResolver {
	const doFetch = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const insecure = new Set((options.allowInsecureHosts ?? []).map(host => host.toLowerCase()));
	const discovered = new Map<string, { base: string; at: number }>();
	const listed = new Map<string, { versions: string[]; at: number }>();

	/**
	 * Chooses the scheme a registry host is first contacted with.
	 *
	 * @param host the registry host, with any port.
	 * @returns `http` for a host named in `allowInsecureHosts`, else `https`.
	 */
	const schemeFor = (host: string): 'https' | 'http' => insecure.has(host.replace(/:\d+$/, '')) ? 'http' : 'https';

	/**
	 * Sends a GET, following redirects by hand so each hop is checked, the first included: HTTPS unless the host is
	 * insecure-allowed, the caller's host check, and the token only for the host it was looked up for.
	 *
	 * @param url the URL.
	 * @param auth the token host, credentials, signal and host check.
	 * @param accept the `Accept` header.
	 * @param requestTimeoutMs how long each hop may take.
	 * @returns the first response that is not a redirect, unread, and the URL it came from.
	 */
	const send = async (url: string, auth: AuthorizedRequest, accept: string, requestTimeoutMs: number): Promise<{ response: Response; url: string }> => {
		let current = url;
		for (let hop = 0; hop <= maximumRedirects; hop++) {
			const target = new URL(current);
			if (target.protocol !== 'https:' && !(target.protocol === 'http:' && insecure.has(target.hostname.toLowerCase()))) {
				throw new RemoteSourceError('HostUnreachable', `${redactedUrl(target)} is not an https URL; registries are only contacted over TLS`);
			}
			await auth.checkHost(canonicalHost(target.host));
			const headers: Record<string, string> = { accept, 'user-agent': options.userAgent ?? 'tghclparser' };
			if (canonicalHost(target.host) === auth.tokenHost) {
				const token = await auth.credentials.tokenFor(auth.tokenHost);
				if (token) headers.authorization = `Bearer ${token}`;
			}
			const response = await withRetries(() => doFetch(current, {
				method: 'GET',
				headers,
				redirect: 'manual',
				signal: AbortSignal.any([auth.signal, AbortSignal.timeout(requestTimeoutMs)])
			}), target, auth.signal);
			if (response.status < 300 || response.status >= 400) return { response, url: response.url || current };
			const location = response.headers.get('location');
			await response.body?.cancel();
			if (!location) throw new RemoteSourceError('HostUnreachable', `${redactedUrl(target)} redirected without a location`);
			current = new URL(location, current).toString();
		}
		throw new RemoteSourceError('HostUnreachable', `${redactedUrl(new URL(url))} redirected more than ${maximumRedirects} times`);
	};

	/**
	 * Sends a registry API request and reads its body, capped at 256 KiB.
	 *
	 * @param url the URL.
	 * @param auth the token host, credentials and signal.
	 * @returns the status, headers and body text of the first response that is not a redirect, and the URL it came
	 *   from, against which relative locations resolve.
	 */
	const request = async (url: string, auth: AuthorizedRequest): Promise<RegistryResponse> => {
		const { response, url: finalUrl } = await send(url, auth, 'application/json', timeoutMs);
		const body = await readBody(response, maximumBodyBytes, 'HostUnreachable');
		return { status: response.status, headers: response.headers, text: body.toString('utf8'), url: finalUrl };
	};

	/**
	 * Finds where a host serves the module registry API, from its `/.well-known/terraform.json`, cached for a day.
	 *
	 * @param host the registry host, with any port.
	 * @param auth the token host, credentials and signal.
	 * @returns the absolute `modules.v1` base URL, ending in a slash.
	 * @throws {RemoteSourceError} `RegistryAuth` for 401 and 403, `HostUnreachable` for a server error that outlasted
	 *   the retries, `NotAModuleRegistry` when the document is missing, is not JSON or has no usable `modules.v1`
	 *   entry.
	 */
	const discover = async (host: string, auth: AuthorizedRequest): Promise<string> => {
		const cached = discovered.get(host);
		if (cached && now() - cached.at < discoveryTtlMs) return cached.base;
		const url = `${schemeFor(host)}://${host}/.well-known/terraform.json`;
		const response = await request(url, auth);
		if (response.status === 401 || response.status === 403) throw authError(host, response.status);
		if (isServerError(response.status)) throw serverError(`${host} /.well-known/terraform.json`, response.status);
		if (response.status !== 200) throw new RemoteSourceError('NotAModuleRegistry', `${host} is not a Terraform module registry: /.well-known/terraform.json answered ${response.status}`);
		const document = parseJson(response.text, host);
		const modules = (document as { 'modules.v1'?: unknown })['modules.v1'];
		if (typeof modules !== 'string' || modules === '') throw new RemoteSourceError('NotAModuleRegistry', `${host} is not a Terraform module registry: /.well-known/terraform.json has no modules.v1 entry`);
		let base: string;
		try {
			base = new URL(modules, response.url).toString();
		} catch {
			throw new RemoteSourceError('NotAModuleRegistry', `${host} announces an invalid modules.v1 location`);
		}
		if (!base.endsWith('/')) base += '/';
		discovered.set(host, { base, at: now() });
		return base;
	};

	/**
	 * Names a module the way registry API paths and messages do.
	 *
	 * @param module the module.
	 * @returns `namespace/name/provider`.
	 */
	const modulePath = (module: RegistryModule): string => `${module.namespace}/${module.name}/${module.provider}`;

	/**
	 * Lists the versions a registry publishes for a module, cached for fifteen minutes and capped at 2000.
	 *
	 * @param module the module.
	 * @param auth the token host, credentials and signal.
	 * @returns the versions as the registry lists them.
	 * @throws {RemoteSourceError} `ModuleNotFound` for 404, `RegistryAuth` for 401 and 403, `NoVersions` when the
	 *   listing is empty, `HostUnreachable` for any other failing status.
	 */
	const listVersions = async (module: RegistryModule, auth: AuthorizedRequest): Promise<string[]> => {
		const key = `${module.host}|${modulePath(module)}`;
		const cached = listed.get(key);
		if (cached && now() - cached.at < versionsTtlMs) return cached.versions;
		const base = await discover(module.host, auth);
		const response = await request(`${base}${modulePath(module)}/versions`, auth);
		if (response.status === 404) throw new RemoteSourceError('ModuleNotFound', `module ${modulePath(module)} was not found on ${module.host} (404)`);
		if (response.status === 401 || response.status === 403) throw authError(module.host, response.status);
		if (isServerError(response.status)) throw serverError(`${module.host}, listing versions of ${modulePath(module)},`, response.status);
		if (response.status !== 200) throw new RemoteSourceError('HostUnreachable', `${module.host} answered ${response.status} when listing versions of ${modulePath(module)}`);
		const document = parseJson(response.text, module.host) as { modules?: unknown };
		const entries = Array.isArray(document.modules) ? document.modules : [];
		const first = entries[0] as { versions?: unknown } | undefined;
		const versions = (Array.isArray(first?.versions) ? first.versions : [])
			.map(entry => (entry as { version?: unknown })?.version)
			.filter((version): version is string => typeof version === 'string' && version !== '')
			.slice(0, maximumVersions);
		if (versions.length === 0) throw new RemoteSourceError('NoVersions', `module ${modulePath(module)} on ${module.host} has no published versions`);
		listed.set(key, { versions, at: now() });
		return versions;
	};

	return {
		/**
		 * Picks the version a constraint selects from the registry's listing, the way Terraform does.
		 *
		 * @param module the module.
		 * @param constraint the `?version=` constraint, or undefined for the highest release.
		 * @param access where the registry token comes from, what aborts the requests and the host check.
		 * @returns the chosen version and every version listed.
		 * @throws {RemoteSourceError} `InvalidConstraint` for a constraint that does not parse, `NoStableVersion` when
		 *   there is no constraint and only pre-releases exist, `NoMatchingVersion` naming the newest versions when
		 *   none matches, and whatever listing the versions throws.
		 */
		async resolveVersion(module, constraint, access) {
			const auth: AuthorizedRequest = { ...access, tokenHost: module.host };
			const available = await listVersions(module, auth);
			let version: string | undefined;
			try {
				version = resolveVersion(constraint, available);
			} catch (error) {
				throw new RemoteSourceError('InvalidConstraint', `version constraint "${constraint}" is not valid: ${error instanceof Error ? error.message : String(error)} (operators = != > >= < <= ~>, comma-separated)`);
			}
			if (version === undefined) {
				const newest = available.slice(-10).join(', ');
				if (constraint === undefined) throw new RemoteSourceError('NoStableVersion', `module ${modulePath(module)} on ${module.host} has only pre-release versions (${newest}); pin one with ?version=`);
				throw new RemoteSourceError('NoMatchingVersion', `no version of ${modulePath(module)} on ${module.host} satisfies "${constraint}"; available: ${newest}`);
			}
			return { version, available };
		},

		/**
		 * Asks the registry where a version is downloaded from. The answer is not remembered, since a signed location
		 * expires and the store only asks when its cache has no entry for the version. The location comes from the
		 * `X-Terraform-Get` header, else a JSON `location` body; a relative one is made absolute against the download
		 * URL.
		 *
		 * @param module the module.
		 * @param version the resolved version.
		 * @param access where the registry token comes from, what aborts the requests and the host check.
		 * @returns the download location.
		 * @throws {RemoteSourceError} `VersionNotFound` for 404, `RegistryAuth` for 401 and 403, `NoDownloadLocation`
		 *   when the answer names none, `HostUnreachable` for any other failing status.
		 */
		async downloadLocation(module, version, access) {
			const auth: AuthorizedRequest = { ...access, tokenHost: module.host };
			const base = await discover(module.host, auth);
			const url = `${base}${modulePath(module)}/${version}/download`;
			const response = await request(url, auth);
			if (response.status === 404) throw new RemoteSourceError('VersionNotFound', `${module.host} has no download for ${modulePath(module)} version ${version} (404)`);
			if (response.status === 401 || response.status === 403) throw authError(module.host, response.status);
			if (isServerError(response.status)) throw serverError(`${module.host}, asked for the download of ${modulePath(module)} ${version},`, response.status);
			if (response.status !== 204 && response.status !== 200) throw new RemoteSourceError('HostUnreachable', `${module.host} answered ${response.status} for the download of ${modulePath(module)} ${version}`);
			let location = response.headers.get('x-terraform-get') ?? undefined;
			if (!location && response.status === 200 && response.text.trim() !== '') {
				const body = parseJson(response.text, module.host) as { location?: unknown };
				if (typeof body.location === 'string' && body.location !== '') location = body.location;
			}
			if (!location) throw new RemoteSourceError('NoDownloadLocation', `${module.host} returned no X-Terraform-Get header or location for ${modulePath(module)} ${version}`);
			if (/^(\/|\.\/|\.\.\/)/.test(location)) location = new URL(location, response.url).toString();
			return { location };
		},

		/**
		 * Downloads a module archive, capped at 32 MiB and given at least 60 seconds. The token goes only to the
		 * registry host, so a signed location on another host, such as HCP Terraform's archivist, is fetched without it.
		 *
		 * @param location the archive URL, go-getter's parameters already removed.
		 * @param request the registry host the token belongs to, the credentials, the signal and the check each host
		 *   on the redirect chain must pass.
		 * @returns the archive's bytes.
		 * @throws {RemoteSourceError} `HostUnreachable` for a server error that outlasted the retries,
		 *   `ArchiveDownloadFailed` for any other status but 200, naming an expired signature for 401 and 403;
		 *   `ModuleTooLarge` past the cap.
		 */
		async downloadArchive(location, { tokenHost, credentials, signal, checkHost }) {
			const { response, url } = await send(location, { tokenHost, credentials, signal, checkHost }, '*/*', Math.max(timeoutMs, archiveTimeoutMs));
			if (response.status !== 200) {
				await response.body?.cancel();
				const target = redactedUrl(new URL(url));
				if (response.status === 401 || response.status === 403) {
					throw new RemoteSourceError('ArchiveDownloadFailed', `${target} refused the module archive with ${response.status}; a signed download location may have expired, so try again`);
				}
				if (isServerError(response.status)) throw serverError(`${target}, serving the module archive,`, response.status);
				throw new RemoteSourceError('ArchiveDownloadFailed', `${target} answered ${response.status} for the module archive`);
			}
			return readBody(response, maximumArchiveBytes, 'ModuleTooLarge');
		}
	};
}

/**
 * Runs a request, retrying twice after a network error, a 429 or a server error, as Terraform's registry client
 * does. The wait starts at a second and triples, or follows `Retry-After` up to 30 seconds. Once the fetch's signal
 * aborts, the current wait ends and the timeout is reported rather than retried.
 *
 * @param attempt sends the request once.
 * @param target the URL, for messages.
 * @param signal the whole fetch's signal.
 * @returns the first response that is not retried, or the last one.
 * @throws {RemoteSourceError} `HostUnreachable` when every attempt failed to connect or the fetch timed out,
 *   `RateLimited` when the last answer was still 429.
 */
async function withRetries(attempt: () => Promise<Response>, target: URL, signal: AbortSignal): Promise<Response> {
	/**
	 * Builds the error for a fetch that ran out of time while this request was pending or waiting to retry.
	 *
	 * @returns the `HostUnreachable` error naming the URL.
	 */
	const timedOut = () => new RemoteSourceError('HostUnreachable', `${redactedUrl(target)} did not answer before the fetch timed out`);
	let delay = 1000;
	for (let tries = 0; ; tries++) {
		let response: Response;
		try {
			response = await attempt();
		} catch (error) {
			if (signal.aborted) throw timedOut();
			if (tries >= maximumRetries) throw asRemoteSourceError(error, 'HostUnreachable', `could not reach ${redactedUrl(target)}`);
			await sleep(delay, signal);
			if (signal.aborted) throw timedOut();
			delay *= 3;
			continue;
		}
		if (!(response.status === 429 || isServerError(response.status)) || tries >= maximumRetries) {
			if (response.status === 429) throw new RemoteSourceError('RateLimited', `${target.host} is rate limiting requests (429); retried ${tries} times`);
			return response;
		}
		await response.body?.cancel();
		await sleep(Math.min(retryAfterMs(response.headers.get('retry-after')) ?? delay, maximumRetryAfterMs), signal);
		if (signal.aborted) throw timedOut();
		delay *= 3;
	}
}

/**
 * Reads a `Retry-After` header in either of its forms.
 *
 * @param header the header value, or null when absent.
 * @returns the wait in milliseconds for a number of seconds or an HTTP date, or undefined when absent or unreadable.
 */
function retryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined;
	if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Waits between retries, ending early when the fetch aborts.
 *
 * @param ms how long to wait.
 * @param signal ends the wait when it aborts.
 * @returns a promise that resolves once the time has passed or the signal aborted.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
		/** Ends the wait, whichever of the timer and the abort comes first. */
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
	});
}

/**
 * Reads a response body into memory, refusing it as soon as the declared length or the bytes streamed so far pass
 * the limit, so an oversized answer is never held whole.
 *
 * @param response a response whose body is unread.
 * @param limit the most bytes read.
 * @param code the error code when the body is larger.
 * @returns the body.
 * @throws {RemoteSourceError} with the code when the declared or streamed length passes the limit.
 */
async function readBody(response: Response, limit: number, code: RemoteSourceErrorCode): Promise<Buffer> {
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (declared > limit) {
		await response.body?.cancel();
		throw new RemoteSourceError(code, `${redactedUrl(new URL(response.url))} answered with ${declared} bytes; at most ${limit} are read`);
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel();
			throw new RemoteSourceError(code, `${redactedUrl(new URL(response.url))} answered with more than ${limit} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/**
 * Parses a registry answer that must be a JSON object.
 *
 * @param text the body.
 * @param host the registry host, for messages.
 * @returns the parsed object.
 * @throws {RemoteSourceError} `NotAModuleRegistry` when the body is not JSON or not an object.
 */
function parseJson(text: string, host: string): unknown {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
		return parsed;
	} catch (error) {
		throw new RemoteSourceError('NotAModuleRegistry', `${host} answered with something other than a JSON object: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Tells a server-side failure, which may pass, from an answer about the request itself. 501 Not Implemented is
 * left out, as go-retryablehttp leaves it out, since the server will never answer that request.
 *
 * @param status an HTTP status.
 * @returns true for 500 to 599 except 501.
 */
function isServerError(status: number): boolean {
	return status >= 500 && status <= 599 && status !== 501;
}

/**
 * Builds the error for a server that still failed after the retries, so the user knows to wait rather than fix
 * the source.
 *
 * @param what the host and request, as the message names them.
 * @param status the 5xx it answered.
 * @returns the `HostUnreachable` error.
 */
function serverError(what: string, status: number): RemoteSourceError {
	return new RemoteSourceError('HostUnreachable', `${what} answered ${status}, a server error, after ${maximumRetries} retries; try again later`);
}

/**
 * Builds the error for a registry that refused the request, naming the variables a token can be set in.
 *
 * @param host the registry host, with any port.
 * @param status the status it answered, 401 or 403.
 * @returns the `RegistryAuth` error.
 */
function authError(host: string, status: number): RemoteSourceError {
	return new RemoteSourceError('RegistryAuth', `${host} rejected the request with ${status}; set ${tokenEnvName(host.replace(/:\d+$/, ''))} or TG_TF_REGISTRY_TOKEN to a registry API token, or store one for the host`);
}

/**
 * Names a URL in a message without its userinfo, query or fragment, where credentials and signatures would be.
 *
 * @param url the URL.
 * @returns the scheme, host and path.
 */
function redactedUrl(url: URL): string {
	return `${url.protocol}//${url.host}${url.pathname}`;
}
