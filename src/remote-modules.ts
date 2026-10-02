import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTarGzModule } from './archive';
import type { CredentialProvider } from './credentials';
import type { ModuleSourceClass } from './module-source';
import { canonicalHost, classifyModuleSource, isCommitSha, redactSource, requestKey, stripUserinfo, subdirectoryFault } from './module-source';
import { splitModuleSource } from './module-variables';
import { asRemoteSourceError, RemoteSourceError } from './remote-errors';

/** Decides whether a host may be contacted; the editor asks the user, a test answers by itself. */
export type HostApprover = (host: string, kind: 'git' | 'registry') => Promise<boolean>;

/** A module as a registry names it. */
export interface RegistryModule {
	/** The canonical registry host. */
	host: string;
	namespace: string;
	name: string;
	provider: string;
}

/** Resolves registry modules to versions and download locations; implemented over HTTP in `registry.ts`. */
export interface RegistryResolver {
	/**
	 * Chooses the version of a module a constraint selects.
	 *
	 * @param module the module.
	 * @param constraint the version constraint, or undefined for the latest release.
	 * @param request whose token may be sent, what aborts the requests, and the check every host on the way must pass.
	 * @returns the chosen version as the registry lists it, and every version listed.
	 */
	resolveVersion(module: RegistryModule, constraint: string | undefined, request: RegistryRequest): Promise<{ version: string; available: string[] }>;
	/**
	 * Asks the registry where a version is downloaded from.
	 *
	 * @param module the module.
	 * @param version the resolved version.
	 * @param request whose token may be sent, what aborts the requests, and the check every host on the way must pass.
	 * @returns the download location the registry serves for the version, made absolute.
	 */
	downloadLocation(module: RegistryModule, version: string, request: RegistryRequest): Promise<{ location: string }>;
	/**
	 * Downloads an archive a registry named as a module's location.
	 *
	 * @param location an archive download location, with go-getter's `archive` and `checksum` parameters removed.
	 * @param request whose token may be sent, to which host only, and the check every host on the way must pass.
	 * @returns the archive's bytes.
	 */
	downloadArchive(location: string, request: ArchiveRequest): Promise<Buffer>;
}

/** How a registry is asked about a module. */
export interface RegistryRequest {
	/** Where the token for the registry host comes from. */
	credentials: CredentialProvider;
	/** Aborts the requests, redirects included. */
	signal: AbortSignal;
	/**
	 * Throws when a host must not be contacted. Every host a request reaches passes it: the registry itself, the
	 * host its discovery document places the module API on, and each host a redirect names.
	 */
	checkHost: (host: string) => Promise<void>;
}

/** How an archive download is made. */
export interface ArchiveRequest extends RegistryRequest {
	/** The registry host, the only one the token is sent to. */
	tokenHost: string;
}

/** How the store fetches and where it keeps what it fetched. */
export interface RemoteModuleOptions {
	/** The cache root; {@link defaultCacheDir} when omitted. */
	cacheDir?: string;
	/** The environment git children start from, `process.env` in production; hardened before use. */
	env?: NodeJS.ProcessEnv;
	/** Where registry tokens come from; none when omitted. */
	credentials?: CredentialProvider;
	/** Asked before the first contact with a host that is not in `allowedHosts`; every host is refused when omitted. */
	approveHost?: HostApprover;
	/** Hosts contacted without asking and without the literal-address checks, such as a loopback test registry. */
	allowedHosts?: string[];
	/** The git executable; `git` on PATH when omitted. */
	gitExecutable?: string;
	/** How long one git process may run; 60 seconds when omitted. */
	fetchTimeoutMs?: number;
	/** Resolves registry sources; registry sources fail as unsupported when omitted. */
	registry?: RegistryResolver;
}

/** A module fetched into the cache, ready for its `.tf` files to be read. */
export interface RemoteModuleCheckout {
	/** The cache key of the entry holding the files. */
	key: string;
	/** The cache entry directory. */
	entryDir: string;
	/** The directory holding the module's top-level `.tf` files. */
	moduleDir: string;
	/** How messages and hovers name the module: the source without credentials plus the version or commit. */
	label: string;
	/** What the source resolved to. */
	resolved: { commit?: string; version?: string };
	/** True when the same source can never resolve differently, so the entry is never refetched. */
	immutable: boolean;
}

/**
 * The `meta.json` of a cache entry. Its presence marks the entry complete, since it is written into the staging
 * directory before that is renamed into place.
 */
interface CacheEntryMeta {
	/** The layout version; an entry with any other is ignored and refetched. */
	schema: 1;
	/** `git` for a repository checkout, `tfr` for a registry version. */
	kind: 'git' | 'tfr';
	/** The cache key the entry directory is hashed from. */
	key: string;
	/** The source without credentials, as labels name it. */
	source: string;
	/** The repository or registry host. */
	host: string;
	/** The repository path, or `namespace/name/provider` for a registry module. */
	path: string;
	/** The `?ref=` a git source asked for. */
	requestedRef?: string;
	/** The `?version=` constraint a registry source asked for. */
	constraint?: string;
	/** What the git ref named; a branch or the default branch can move, so such an entry is mutable. */
	refKind?: 'branch' | 'tag' | 'sha' | 'default';
	/** The commit the files came from. */
	resolvedCommit?: string;
	/** The registry version the constraint chose. */
	resolvedVersion?: string;
	/** Where the registry said to download from, without credentials or query. */
	downloadTarget?: string;
	/** The git entry holding a registry version's files; absent when the files came from an archive and are here. */
	underlyingKey?: string;
	/** The `//subdirectory` the source named. */
	subdirectory: string;
	/** True when the same key can never hold different files. */
	immutable: boolean;
	/** When the entry was written, as an ISO 8601 timestamp. */
	fetchedAt: string;
	/** The names of the `.tf` files in the entry's `files` directory. */
	files: string[];
}

/** Everything {@link RemoteModuleStore.fetchArchive} needs about the registry request it serves. */
interface ArchiveFetch {
	/** The resolver that downloads the archive. */
	resolver: RegistryResolver;
	/** The module, with its canonical registry host. */
	module: RegistryModule;
	/** The version the constraint chose. */
	version: string;
	/** The download location the registry returned, go-getter parameters and `//subdirectory` included. */
	location: string;
	/** The registry source as written, for its subdirectory and constraint. */
	source: ModuleSourceClass & { kind: 'registry' };
	/** How labels name the module, without the version. */
	sourceLabel: string;
	/** The cache key of the registry entry. */
	key: string;
	/** The registry entry directory the files are written to. */
	entryDir: string;
	/** The cache root. */
	cacheDir: string;
	/** Where the registry token comes from. */
	credentials: CredentialProvider;
}

/** What a finished child process produced. */
interface GitRunResult {
	/** The exit status, or -1 when the process was killed or ended by a signal. */
	status: number;
	/** Standard output, capped by the caller's limit. */
	stdout: Buffer;
	/** Standard error, capped at 64 KiB, with the reason appended when the process was stopped. */
	stderr: string;
}

const failureRetryMs = 5 * 60 * 1000;
const maximumFileBytes = 1024 * 1024;
const maximumModuleBytes = 16 * 1024 * 1024;
const maximumModuleFiles = 200;
const maximumArchiveBytes = 256 * 1024 * 1024;
const maximumStderrBytes = 64 * 1024;
const staleTemporaryMs = 60 * 60 * 1000;
const minimumGitVersion = [2, 31];
const removedGitVariables = [
	'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_CURL_VERBOSE', 'GIT_TRACE',
	'GIT_TRACE_PACKET', 'GIT_TRACE_CURL', 'GIT_TRACE_CURL_NO_DATA', 'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_SETUP',
	'GIT_TRACE_REDACT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'
];
const blockedHostNames = new Set(['localhost', 'metadata.google.internal']);
const blockedHostSuffixes = ['.localhost', '.local', '.internal'];

/**
 * Chooses where fetched modules are cached for this user.
 *
 * @param env the environment to read overrides from.
 * @param platform the platform whose conventions decide the location.
 * @param homeDir the user's home directory.
 * @returns the per-user cache root: `TGHCLPARSER_CACHE_DIR`, else the platform's cache directory.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, homeDir = os.homedir()): string {
	if (env.TGHCLPARSER_CACHE_DIR) return env.TGHCLPARSER_CACHE_DIR;
	if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'tghclparser');
	if (platform === 'darwin') return path.join(homeDir, 'Library', 'Caches', 'tghclparser');
	return path.join(env.XDG_CACHE_HOME || path.join(homeDir, '.cache'), 'tghclparser');
}

/**
 * The environment a git child is started with: the caller's, minus variables that would redirect writes, dump
 * secrets or open a prompt, plus the settings that keep git non-interactive and the remote URL passed as
 * configuration so it never appears on a command line.
 *
 * @param base the environment to start from.
 * @param remoteUrl the repository URL, credentials included.
 * @param sshCommandConfigured true when git's own `core.sshCommand` is set, so no batch-mode ssh is injected.
 * @returns the environment.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv, remoteUrl: string, sshCommandConfigured: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (removedGitVariables.includes(key) || /^VSCODE_GIT_/.test(key)) continue;
		env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = '0';
	env.GIT_ALLOW_PROTOCOL = 'https:ssh:file';
	env.GCM_INTERACTIVE = 'never';
	env.GIT_LFS_SKIP_SMUDGE = '1';
	env.LC_ALL = 'C';
	if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !sshCommandConfigured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=15';
	const config: [string, string][] = [
		['remote.origin.url', remoteUrl],
		['fetch.recurseSubmodules', 'false'],
		['submodule.recurse', 'false'],
		['credential.interactive', 'never'],
		['core.askPass', ''],
		['http.lowSpeedLimit', '1024'],
		['http.lowSpeedTime', '30']
	];
	env.GIT_CONFIG_COUNT = String(config.length);
	config.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/**
 * Fetches registry and git module sources into a per-user cache and hands back the directory holding their
 * top-level `.tf` files. One fetch runs per distinct request however many units ask; a result, or a failure, is
 * remembered for the session so re-parsing a unit on every keystroke never touches the network again.
 */
export class RemoteModuleStore {
	private options: RemoteModuleOptions = {};
	private inFlight = new Map<string, Promise<RemoteModuleCheckout>>();
	private resolved = new Map<string, RemoteModuleCheckout>();
	private failed = new Map<string, { error: RemoteSourceError; at: number }>();
	private approvals = new Map<string, Promise<boolean>>();
	private gitProbe: Promise<{ version: string; sshCommandConfigured: boolean }> | undefined;
	private cacheReady: Promise<string> | undefined;

	/**
	 * Creates a store with nothing fetched yet.
	 *
	 * @param options how the store fetches; with none, every host is refused and registry sources are unsupported.
	 */
	constructor(options: RemoteModuleOptions = {}) {
		this.configure(options);
	}

	/**
	 * Replaces the options. Session memos of successes survive, since a fetched entry stays valid; failures and
	 * host decisions are forgotten, since new credentials or approvals may change them.
	 *
	 * @param options the new options.
	 */
	configure(options: RemoteModuleOptions): void {
		const cacheChanged = options.cacheDir !== this.options.cacheDir;
		this.options = { ...options };
		this.failed.clear();
		this.approvals.clear();
		this.gitProbe = undefined;
		if (cacheChanged) {
			this.cacheReady = undefined;
			this.resolved.clear();
		}
	}

	/**
	 * Answers from this session's memo without fetching, so a unit can be given its state at once.
	 *
	 * @param request a request key from {@link requestKey}.
	 * @returns the memoised checkout, the memoised failure while it still stands, or undefined when the request has
	 *   not been resolved this session.
	 */
	peek(request: string): { checkout: RemoteModuleCheckout } | { failed: RemoteSourceError } | undefined {
		const checkout = this.resolved.get(request);
		if (checkout) return { checkout };
		const failure = this.failed.get(request);
		if (failure && Date.now() - failure.at < failureRetryMs) return { failed: failure.error };
		return undefined;
	}

	/**
	 * Fetches a source, or returns what an earlier fetch of the same request produced.
	 *
	 * @param source a registry or git source.
	 * @returns the checkout.
	 * @throws {RemoteSourceError} when the source cannot be fetched; the same error is thrown again for the next
	 *   five minutes without another attempt.
	 */
	resolve(source: ModuleSourceClass & { kind: 'registry' | 'git' }): Promise<RemoteModuleCheckout> {
		const request = requestKey(source);
		const known = this.peek(request);
		if (known && 'checkout' in known) return Promise.resolve(known.checkout);
		if (known) return Promise.reject(known.failed);
		const running = this.inFlight.get(request);
		if (running) return running;
		const work = this.fetch(source)
			.then(checkout => {
				this.resolved.set(request, checkout);
				return checkout;
			})
			.catch((error: unknown) => {
				const failure = asRemoteSourceError(error, 'GitFetchFailed', 'fetching the module failed');
				this.failed.set(request, { error: failure, at: Date.now() });
				throw failure;
			})
			.finally(() => this.inFlight.delete(request));
		this.inFlight.set(request, work);
		return work;
	}

	/** Resolves once no fetch is running. */
	async settled(): Promise<void> {
		while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
	}

	/**
	 * Deletes every fetched module from the cache and forgets this session's results and failures, so the next
	 * request fetches again. Fetches in flight are waited for first. Only the `modules` and `tmp` directories are
	 * removed, never the root itself, which the user may have chosen. Host decisions are kept.
	 *
	 * @returns the cache root that was cleared.
	 * @throws {RemoteSourceError} `CacheWrite` when the root cannot be used or its entries cannot be removed.
	 */
	async clearCache(): Promise<string> {
		await this.settled();
		const root = await this.cacheRoot();
		this.resolved.clear();
		this.failed.clear();
		this.cacheReady = undefined;
		try {
			await fs.rm(path.join(root, 'modules'), { recursive: true, force: true });
			await fs.rm(path.join(root, 'tmp'), { recursive: true, force: true });
		} catch (error) {
			throw asRemoteSourceError(error, 'CacheWrite', `could not clear the module cache at ${root}`);
		}
		return root;
	}

	/** Forgets memoised failures and host decisions, so the next request tries again. */
	forgetFailures(): void {
		this.failed.clear();
		this.approvals.clear();
	}

	/**
	 * Fetches a source into the cache, once the cache root is ready, by the path its kind takes.
	 *
	 * @param source a registry or git source.
	 * @returns the checkout.
	 * @throws {RemoteSourceError} whatever the cache or the fetch throws.
	 */
	private async fetch(source: ModuleSourceClass & { kind: 'registry' | 'git' }): Promise<RemoteModuleCheckout> {
		const cacheDir = await this.cacheRoot();
		if (source.kind === 'git') return this.fetchGit(source, cacheDir);
		return this.fetchRegistry(source, cacheDir);
	}

	/**
	 * Fetches a registry module. The version is resolved first, and a cached entry for that version is used without
	 * asking for the download location. Otherwise the location decides the path: an archive is read into the
	 * registry entry, a git repository is fetched into a git entry that the registry entry then points to.
	 *
	 * @param source the registry source.
	 * @param cacheDir the cache root.
	 * @returns the checkout, labelled with the registry source and version.
	 * @throws {RemoteSourceError} `UnsupportedDownloadForm` without a resolver or for a location that is neither git
	 *   nor an archive, `SubdirectoryEscapes` when the joined subdirectory climbs out, and whatever the host check,
	 *   the registry or the fetch throws.
	 */
	private async fetchRegistry(source: ModuleSourceClass & { kind: 'registry' }, cacheDir: string): Promise<RemoteModuleCheckout> {
		const resolver = this.options.registry;
		if (!resolver) throw new RemoteSourceError('UnsupportedDownloadForm', 'registry sources cannot be fetched: no registry resolver is configured');
		const host = canonicalHost(source.host);
		await this.checkHost(host, 'registry');
		const module: RegistryModule = { host, namespace: source.namespace, name: source.name, provider: source.provider };
		const credentials = this.options.credentials ?? { tokenFor: async () => undefined };
		const request: RegistryRequest = { credentials, signal: AbortSignal.timeout(this.timeoutMs()), checkHost: contacted => this.checkRedirectHost(contacted) };
		const { version } = await resolver.resolveVersion(module, source.constraint, request);
		const key = `tfr|${host}|${module.namespace}/${module.name}/${module.provider}|${version}|${source.subdirectory}`;
		const sourceLabel = `tfr://${source.hostGiven ? source.host : ''}/${module.namespace}/${module.name}/${module.provider}`;
		const entryDir = this.entryDir(cacheDir, key);
		const existing = await this.readMeta(entryDir);
		if (existing?.underlyingKey) {
			const underlying = await this.readMeta(this.entryDir(cacheDir, existing.underlyingKey));
			if (underlying) {
				return {
					key: existing.underlyingKey,
					entryDir: this.entryDir(cacheDir, existing.underlyingKey),
					moduleDir: path.join(this.entryDir(cacheDir, existing.underlyingKey), 'files'),
					label: `${sourceLabel}@${version}`,
					resolved: { version, commit: underlying.resolvedCommit },
					immutable: true
				};
			}
		}
		if (existing && !existing.underlyingKey) {
			return { key, entryDir, moduleDir: path.join(entryDir, 'files'), label: `${sourceLabel}@${version}`, resolved: { version }, immutable: true };
		}
		const { location } = await resolver.downloadLocation(module, version, request);
		const target = classifyModuleSource(location, { origin: 'registry' });
		if (target.kind === 'other' && target.getter === 'archive') {
			return this.fetchArchive({ resolver, module, version, location, source, sourceLabel, key, entryDir, cacheDir, credentials });
		}
		if (target.kind === 'other' && target.getter === 'malformed') {
			throw new RemoteSourceError('UnsupportedDownloadForm', `${host} returned a download location for ${module.namespace}/${module.name}/${module.provider} ${version} that cannot be used: ${target.reason}`);
		}
		if (target.kind !== 'git') {
			const form = target.kind === 'other' ? target.getter : target.kind;
			throw unsupportedForm(module, version, form, location);
		}
		const subdirectory = [target.subdirectory, source.subdirectory].filter(Boolean).join('/');
		const fault = subdirectoryFault(subdirectory);
		if (fault) throw new RemoteSourceError('SubdirectoryEscapes', fault);
		const checkout = await this.fetchGit({ ...target, subdirectory }, cacheDir);
		await this.writeEntry(cacheDir, entryDir, {
			schema: 1,
			kind: 'tfr',
			key,
			source: sourceLabel,
			host,
			path: `${module.namespace}/${module.name}/${module.provider}`,
			constraint: source.constraint,
			resolvedVersion: version,
			resolvedCommit: checkout.resolved.commit,
			downloadTarget: redactSource(location),
			underlyingKey: checkout.key,
			subdirectory: source.subdirectory,
			immutable: true,
			fetchedAt: new Date().toISOString(),
			files: []
		}, undefined);
		return { ...checkout, label: `${sourceLabel}@${version}`, resolved: { version, commit: checkout.resolved.commit }, immutable: true };
	}

	/**
	 * Downloads the tar.gz archive a registry names as a module's location and keeps its top-level `.tf` files in
	 * the registry entry itself. The archive host is not asked about, since approving the registry covers it, and
	 * the registry's token is not sent to it. go-getter's `archive` and `checksum` parameters are honoured and
	 * removed from the URL before the request, and a `//subdirectory` in the location is joined to the source's.
	 * The download has a fetch timeout of its own, so time the registry calls took is not taken from it.
	 *
	 * @param fetch the registry request being served, its resolved version and download location, and the cache
	 *   entry to write.
	 * @returns the checkout.
	 * @throws {RemoteSourceError} `UnsupportedDownloadForm` for an archive format other than tar.gz,
	 *   `ChecksumMismatch` when the download does not match its checksum, and whatever the download and the
	 *   archive reader throw.
	 */
	private async fetchArchive(fetch: ArchiveFetch): Promise<RemoteModuleCheckout> {
		const { module, version, location, key, entryDir, cacheDir } = fetch;
		const label = `${fetch.sourceLabel}@${version}`;
		const archive = parseArchiveLocation(location);
		if (archive.format !== undefined && archive.format !== 'tar.gz' && archive.format !== 'tgz') {
			throw unsupportedForm(module, version, `a ${archive.format} archive`, location);
		}
		const subdirectory = [archive.subdirectory, fetch.source.subdirectory].filter(Boolean).join('/');
		const fault = subdirectoryFault(subdirectory);
		if (fault) throw new RemoteSourceError('SubdirectoryEscapes', fault);
		const data = await fetch.resolver.downloadArchive(archive.url, {
			tokenHost: module.host,
			credentials: fetch.credentials,
			signal: AbortSignal.timeout(this.timeoutMs()),
			checkHost: host => this.checkRedirectHost(host)
		});
		if (archive.checksum) verifyChecksum(data, archive.checksum, label);
		const files = await readTarGzModule(data, subdirectory, label, {
			maximumFileBytes,
			maximumModuleBytes,
			maximumModuleFiles,
			maximumArchiveBytes
		});
		const temporary = await this.temporaryDir(cacheDir);
		try {
			const filesDir = path.join(temporary, 'files');
			await fs.mkdir(filesDir, { mode: 0o700 });
			for (const [name, content] of files) await fs.writeFile(path.join(filesDir, name), content, { mode: 0o600 });
			await this.writeEntry(cacheDir, entryDir, {
				schema: 1,
				kind: 'tfr',
				key,
				source: fetch.sourceLabel,
				host: module.host,
				path: `${module.namespace}/${module.name}/${module.provider}`,
				constraint: fetch.source.constraint,
				resolvedVersion: version,
				downloadTarget: redactSource(archive.url.split('?')[0]),
				subdirectory: fetch.source.subdirectory,
				immutable: true,
				fetchedAt: new Date().toISOString(),
				files: [...files.keys()]
			}, temporary);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
		return { key, entryDir, moduleDir: path.join(entryDir, 'files'), label, resolved: { version }, immutable: true };
	}

	/**
	 * Fetches one commit of a git repository into a cache entry keyed by that commit, keeping only the module's
	 * top-level `.tf` files. The bare repository exists before any contact with the remote, so even the ref lookup
	 * addresses `origin`, whose URL git reads from the environment rather than from its command line. An entry
	 * already cached for the resolved commit is used without fetching.
	 *
	 * @param source a git source over https, ssh or file.
	 * @param cacheDir the cache root.
	 * @returns the checkout, mutable when the ref was a branch or the default branch.
	 * @throws {RemoteSourceError} `GitFetchFailed` for any other scheme or a failed git run, and whatever the host
	 *   check, the git probe, ref resolution or file reading throws.
	 */
	private async fetchGit(source: ModuleSourceClass & { kind: 'git' }, cacheDir: string): Promise<RemoteModuleCheckout> {
		if (source.scheme !== 'https' && source.scheme !== 'ssh' && source.scheme !== 'file') {
			throw new RemoteSourceError('GitFetchFailed', `${stripUserinfo(source.url)} uses ${source.scheme}://, which is not fetched; only https, ssh and file repositories are`);
		}
		if (source.scheme !== 'file') await this.checkHost(canonicalHost(source.host), 'git');
		const probe = await this.probeGit();
		const env = gitEnvironment(this.options.env ?? process.env, source.url, probe.sshCommandConfigured);
		const repositoryPath = this.repositoryPath(source);
		const label = stripUserinfo(source.url);

		const temporary = await this.temporaryDir(cacheDir);
		try {
			const repository = path.join(temporary, 'repo');
			await fs.mkdir(repository, { mode: 0o700 });
			await this.git(['init', '-q', '--bare'], repository, env, label);

			let refKind: CacheEntryMeta['refKind'];
			let commit: string;
			let fetchRef: string;
			if (source.ref !== undefined && isCommitSha(source.ref)) {
				refKind = 'sha';
				commit = source.ref.toLowerCase();
				fetchRef = commit;
			} else {
				const remote = await this.resolveRemoteRef(repository, source.ref, env, label);
				refKind = remote.kind;
				commit = remote.commit;
				fetchRef = remote.fetchRef;
			}
			const key = `git|${source.host}|${repositoryPath}|${commit}|${source.subdirectory}`;
			const entryDir = this.entryDir(cacheDir, key);
			const checkout: RemoteModuleCheckout = {
				key,
				entryDir,
				moduleDir: path.join(entryDir, 'files'),
				label: `${label}@${commit.slice(0, 7)}`,
				resolved: { commit },
				immutable: refKind !== 'branch' && refKind !== 'default'
			};
			if (await this.readMeta(entryDir)) return checkout;

			const tree = await this.fetchCommit(repository, env, fetchRef, commit, label);
			const files = await this.readModuleFiles(repository, env, tree, source.subdirectory, label);
			const filesDir = path.join(temporary, 'files');
			await fs.mkdir(filesDir, { mode: 0o700 });
			for (const [name, content] of files) await fs.writeFile(path.join(filesDir, name), content, { mode: 0o600 });
			await fs.rm(repository, { recursive: true, force: true });
			await this.writeEntry(cacheDir, entryDir, {
				schema: 1,
				kind: 'git',
				key,
				source: label,
				host: source.host,
				path: repositoryPath,
				requestedRef: source.ref,
				refKind,
				resolvedCommit: commit,
				subdirectory: source.subdirectory,
				immutable: refKind !== 'branch' && refKind !== 'default',
				fetchedAt: new Date().toISOString(),
				files: [...files.keys()]
			}, temporary);
			return checkout;
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}

	/**
	 * Resolves a ref to a commit with `ls-remote`, before anything is fetched. A branch wins over a tag of the same
	 * name, and an annotated tag is peeled to its commit.
	 *
	 * @param repository the bare repository whose `origin` is the remote.
	 * @param ref the branch or tag, or undefined for the remote's default branch.
	 * @param env the hardened environment.
	 * @param label how messages name the repository.
	 * @returns what the ref named, its commit, and the ref to fetch.
	 * @throws {RemoteSourceError} `GitRefNotFound` when the ref is neither a branch nor a tag, or the remote has no
	 *   HEAD; `GitFetchFailed` when `ls-remote` fails.
	 */
	private async resolveRemoteRef(repository: string, ref: string | undefined, env: NodeJS.ProcessEnv, label: string): Promise<{ kind: 'branch' | 'tag' | 'default'; commit: string; fetchRef: string }> {
		const args = ref === undefined
			? ['ls-remote', '--symref', 'origin', 'HEAD']
			: ['ls-remote', '--heads', '--tags', '--end-of-options', 'origin', ref, `${ref}^{}`];
		const result = await this.git(args, repository, env, label);
		const lines = result.stdout.toString('utf8').split('\n').filter(Boolean);
		if (ref === undefined) {
			const head = lines.find(line => /\tHEAD$/.test(line) && !line.startsWith('ref:'));
			const commit = head?.split('\t')[0];
			if (!commit || !isCommitSha(commit)) throw new RemoteSourceError('GitRefNotFound', `${label} has no HEAD to fetch`);
			return { kind: 'default', commit: commit.toLowerCase(), fetchRef: 'HEAD' };
		}
		const entries = lines.map(line => line.split('\t') as [string, string]);
		const branch = entries.find(([, name]) => name === `refs/heads/${ref}`);
		if (branch) return { kind: 'branch', commit: branch[0].toLowerCase(), fetchRef: ref };
		const peeled = entries.find(([, name]) => name === `refs/tags/${ref}^{}`);
		const tag = peeled ?? entries.find(([, name]) => name === `refs/tags/${ref}`);
		if (tag) return { kind: 'tag', commit: tag[0].toLowerCase(), fetchRef: ref };
		throw new RemoteSourceError('GitRefNotFound', `${ref} is not a branch or tag in ${label}`);
	}

	/**
	 * Fetches the one commit a module needs. A shallow fetch of the ref comes first, and its result must be the
	 * commit resolved earlier. A commit id that the server will not serve directly falls back to a blobless fetch of
	 * the whole history, then a full one.
	 *
	 * @param repository the bare repository.
	 * @param env the hardened environment.
	 * @param fetchRef the ref, or the commit id itself.
	 * @param commit the commit expected.
	 * @param label how messages name the repository.
	 * @returns the tree-ish to read the files from: `FETCH_HEAD` or the commit id.
	 * @throws {RemoteSourceError} `GitFetchFailed` when git cannot fetch or served another commit, `GitRefNotFound`
	 *   when the commit is not in the repository.
	 */
	private async fetchCommit(repository: string, env: NodeJS.ProcessEnv, fetchRef: string, commit: string, label: string): Promise<string> {
		const shallow = await this.tryGit(['fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--end-of-options', 'origin', fetchRef], repository, env);
		if (shallow.status === 0) {
			const head = (await this.git(['rev-parse', 'FETCH_HEAD^{commit}'], repository, env, label)).stdout.toString('utf8').trim();
			if (head !== commit) throw new RemoteSourceError('GitFetchFailed', `${label} served ${head.slice(0, 7)} for ${fetchRef}, not ${commit.slice(0, 7)}`);
			return 'FETCH_HEAD';
		}
		if (fetchRef !== commit) throw this.gitFailure(shallow, `git could not fetch ${fetchRef} from ${label}`);
		const partial = await this.tryGit(['fetch', '-q', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin'], repository, env);
		if (partial.status !== 0) {
			const full = await this.tryGit(['fetch', '-q', '--no-tags', '--no-recurse-submodules', 'origin'], repository, env);
			if (full.status !== 0) throw this.gitFailure(full, `git could not fetch ${label}`);
		}
		const present = await this.tryGit(['cat-file', '-e', `${commit}^{commit}`], repository, env);
		if (present.status !== 0) throw new RemoteSourceError('GitRefNotFound', `${commit.slice(0, 7)} is not a commit in ${label}`);
		return commit;
	}

	/**
	 * Reads a module's top-level `.tf` files straight out of the object store, with no working tree. Only regular
	 * blobs are kept, so symlinks, gitlinks, dotfiles and nested directories are skipped, and every limit is checked
	 * before a file is held.
	 *
	 * @param repository the bare repository.
	 * @param env the hardened environment.
	 * @param tree the tree-ish {@link fetchCommit} returned.
	 * @param subdirectory the directory holding the module, empty for the root.
	 * @param label how messages name the repository.
	 * @returns the files by name, in git's order.
	 * @throws {RemoteSourceError} `SubdirectoryMissing` when the directory does not exist, `ModuleTooLarge` past a
	 *   limit, `GitFetchFailed` when git's object output cannot be read.
	 */
	private async readModuleFiles(repository: string, env: NodeJS.ProcessEnv, tree: string, subdirectory: string, label: string): Promise<Map<string, Buffer>> {
		const treeish = subdirectory ? `${tree}:${subdirectory}` : `${tree}:`;
		const listing = await this.tryGit(['ls-tree', '-z', treeish], repository, env);
		if (listing.status !== 0) {
			throw new RemoteSourceError('SubdirectoryMissing', subdirectory ? `subdirectory ${subdirectory} does not exist in ${label}` : `${label} has no tree to read`);
		}
		const entries: { name: string; oid: string }[] = [];
		for (const line of listing.stdout.toString('utf8').split('\0').filter(Boolean)) {
			const match = line.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/);
			if (!match) continue;
			const [, mode, type, oid, name] = match;
			if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
			if (!name.endsWith('.tf') || name.startsWith('.') || name.includes('/')) continue;
			entries.push({ name, oid });
		}
		if (entries.length > maximumModuleFiles) throw new RemoteSourceError('ModuleTooLarge', `${label} has ${entries.length} Terraform files at the top level; at most ${maximumModuleFiles} are read`);
		const files = new Map<string, Buffer>();
		if (entries.length === 0) return files;
		const batch = await this.git(['cat-file', '--batch'], repository, env, label, entries.map(entry => entry.oid).join('\n') + '\n', maximumModuleBytes + entries.length * 128);
		let offset = 0;
		let total = 0;
		const output = batch.stdout;
		for (const entry of entries) {
			const headerEnd = output.indexOf('\n', offset);
			if (headerEnd < 0) throw new RemoteSourceError('GitFetchFailed', `git returned a short object listing for ${label}`);
			const header = output.subarray(offset, headerEnd).toString('utf8');
			offset = headerEnd + 1;
			const parsed = header.match(/^([0-9a-f]+) blob (\d+)$/);
			if (!parsed) throw new RemoteSourceError('GitFetchFailed', `git could not read ${entry.name} in ${label}: ${header}`);
			const size = Number(parsed[2]);
			if (size > maximumFileBytes) throw new RemoteSourceError('ModuleTooLarge', `${entry.name} in ${label} is ${size} bytes; at most ${maximumFileBytes} are read`);
			total += size;
			if (total > maximumModuleBytes) throw new RemoteSourceError('ModuleTooLarge', `${label} has more than ${maximumModuleBytes} bytes of Terraform files`);
			files.set(entry.name, Buffer.from(output.subarray(offset, offset + size)));
			offset += size + 1;
		}
		return files;
	}

	/**
	 * Decides whether a host a source names may be contacted: refused by name first, then approved by the user,
	 * remembered until the options change, then refused by address. Approval comes before DNS, so a refused host
	 * costs no lookup. The user is asked once per host however many fetches reach it at the same time, since each
	 * waits for the same answer. A host in `allowedHosts` skips every check.
	 *
	 * @param host the canonical host, with any port.
	 * @param kind what would be fetched from it, for the approval prompt.
	 * @throws {RemoteSourceError} `HostNotAllowed` for a literal or local address, `HostNotApproved` when the user
	 *   declined, `HostUnreachable` when the name does not resolve.
	 */
	private async checkHost(host: string, kind: 'git' | 'registry'): Promise<void> {
		if (this.isAllowedHost(host)) return;
		this.refuseLocalName(host);
		let decision = this.approvals.get(host);
		if (!decision) {
			decision = (this.options.approveHost ?? (async () => false))(host, kind);
			this.approvals.set(host, decision);
		}
		let approved: boolean;
		try {
			approved = await decision;
		} catch (error) {
			if (this.approvals.get(host) === decision) this.approvals.delete(host);
			throw asRemoteSourceError(error, 'HostNotApproved', `asking whether modules may be fetched from ${host} failed`);
		}
		if (!approved) throw new RemoteSourceError('HostNotApproved', `fetching modules from ${host} has not been approved`);
		await this.refuseLocalAddress(host);
	}

	/**
	 * Checks a host an approved registry sent the request to: the one its discovery document places the module API
	 * on, one a redirect names, or the one serving its archives. No approval is asked, since approving the registry
	 * covers the locations it hands out, but a local address is still refused.
	 *
	 * @param host the canonical host, with any port.
	 * @throws {RemoteSourceError} `HostNotAllowed` for a literal or local address, `HostUnreachable` when the name
	 *   does not resolve.
	 */
	private async checkRedirectHost(host: string): Promise<void> {
		if (this.isAllowedHost(host)) return;
		this.refuseLocalName(host);
		await this.refuseLocalAddress(host);
	}

	/**
	 * Decides whether a host skips every check, as a loopback test registry does.
	 *
	 * @param host the canonical host, with any port.
	 * @returns true when `allowedHosts` names it, with or without its port.
	 */
	private isAllowedHost(host: string): boolean {
		const allowed = (this.options.allowedHosts ?? []).map(canonicalHost);
		return allowed.includes(host) || allowed.includes(bareHostname(host));
	}

	/**
	 * Refuses a host by its name alone, before any lookup: an IP literal, `localhost`, `*.local`, `*.internal` or
	 * the cloud metadata name.
	 *
	 * @param host the canonical host, with any port.
	 * @throws {RemoteSourceError} `HostNotAllowed` when the name is refused.
	 */
	private refuseLocalName(host: string): void {
		const hostname = bareHostname(host);
		if (net.isIP(hostname) !== 0) throw new RemoteSourceError('HostNotAllowed', `${host} is an IP address; modules are only fetched from named hosts`);
		if (blockedHostNames.has(hostname) || blockedHostSuffixes.some(suffix => hostname.endsWith(suffix))) {
			throw new RemoteSourceError('HostNotAllowed', `${host} names a local address; modules are not fetched from it`);
		}
	}

	/**
	 * Refuses a host by what its name resolves to, which catches a public name pointed at a local address.
	 *
	 * @param host the canonical host, with any port.
	 * @throws {RemoteSourceError} `HostNotAllowed` when the name resolves to a loopback or link-local address,
	 *   `HostUnreachable` when it does not resolve.
	 */
	private async refuseLocalAddress(host: string): Promise<void> {
		const hostname = bareHostname(host);
		let addresses: { address: string }[];
		try {
			addresses = await dns.lookup(hostname, { all: true });
		} catch (error) {
			throw asRemoteSourceError(error, 'HostUnreachable', `could not resolve ${host}`);
		}
		if (addresses.some(({ address }) => isLocalAddress(address))) {
			throw new RemoteSourceError('HostNotAllowed', `${host} resolves to a local address; modules are not fetched from it`);
		}
	}

	/**
	 * Checks once per configuration that git can be run and is new enough for environment configuration, and
	 * whether the user set `core.sshCommand`. A failure to run git is not remembered, so installing it takes effect.
	 *
	 * @returns the git version and whether `core.sshCommand` is set.
	 * @throws {RemoteSourceError} `GitNotFound` when git cannot be run or reports no version, `GitTooOld` below 2.31.
	 */
	private async probeGit(): Promise<{ version: string; sshCommandConfigured: boolean }> {
		this.gitProbe ??= (async () => {
			const executable = this.options.gitExecutable ?? 'git';
			const env = this.options.env ?? process.env;
			let probe: GitRunResult;
			try {
				probe = await this.run(executable, ['--version'], os.tmpdir(), env, undefined, 4096);
			} catch (error) {
				this.gitProbe = undefined;
				throw new RemoteSourceError('GitNotFound', `${executable} could not be run: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			const version = probe.stdout.toString('utf8').match(/git version (\d+)\.(\d+)/);
			if (probe.status !== 0 || !version) {
				this.gitProbe = undefined;
				throw new RemoteSourceError('GitNotFound', `${executable} did not report a version`);
			}
			const [major, minor] = [Number(version[1]), Number(version[2])];
			if (major < minimumGitVersion[0] || (major === minimumGitVersion[0] && minor < minimumGitVersion[1])) {
				throw new RemoteSourceError('GitTooOld', `git ${version[1]}.${version[2]} is older than ${minimumGitVersion.join('.')}, which fetching modules needs`);
			}
			const sshCommand = await this.run(executable, ['config', '--get', 'core.sshCommand'], os.tmpdir(), env, undefined, 4096).catch(() => undefined);
			return { version: `${version[1]}.${version[2]}`, sshCommandConfigured: sshCommand?.status === 0 && sshCommand.stdout.length > 0 };
		})();
		return this.gitProbe;
	}

	/**
	 * Runs git and requires it to succeed.
	 *
	 * @param args the git arguments.
	 * @param cwd the directory git runs in.
	 * @param env the hardened environment.
	 * @param label how messages name the repository.
	 * @param input what is written to git's standard input, if anything.
	 * @param maxStdout the most output kept; 1 MiB when omitted.
	 * @returns the result.
	 * @throws {RemoteSourceError} `GitFetchFailed` with the last line git wrote to standard error when it exits
	 *   non-zero.
	 */
	private async git(args: string[], cwd: string, env: NodeJS.ProcessEnv, label: string, input?: string, maxStdout?: number): Promise<GitRunResult> {
		const result = await this.tryGit(args, cwd, env, input, maxStdout);
		if (result.status !== 0) throw this.gitFailure(result, `git ${args[0]} failed for ${label}`);
		return result;
	}

	/**
	 * Runs git and hands back its result whatever the exit status, for callers that fall back on failure.
	 *
	 * @param args the git arguments.
	 * @param cwd the directory git runs in.
	 * @param env the hardened environment.
	 * @param input what is written to git's standard input, if anything.
	 * @param maxStdout the most output kept; 1 MiB when omitted.
	 * @returns the result.
	 */
	private tryGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string, maxStdout?: number): Promise<GitRunResult> {
		return this.run(this.options.gitExecutable ?? 'git', args, cwd, env, input, maxStdout ?? 1024 * 1024);
	}

	/**
	 * Builds the error for a failed git run from the last line it wrote to standard error, where git states the
	 * cause, cut at 200 characters.
	 *
	 * @param result the failed run.
	 * @param context what was being done, which the message starts with.
	 * @returns the `GitFetchFailed` error.
	 */
	private gitFailure(result: GitRunResult, context: string): RemoteSourceError {
		const line = result.stderr.split('\n').map(text => text.trim()).filter(Boolean).at(-1) ?? `exit status ${result.status}`;
		return new RemoteSourceError('GitFetchFailed', `${context}: ${line.slice(0, 200)}`);
	}

	/**
	 * Spawns a process without a shell and collects its output. It is stopped, SIGTERM then SIGKILL five seconds
	 * later, when it outlives the fetch timeout or writes more than `maxStdout` bytes; standard error is kept to
	 * 64 KiB.
	 *
	 * @param executable the program.
	 * @param args its arguments.
	 * @param cwd the directory it runs in.
	 * @param env its environment.
	 * @param input what is written to its standard input; standard input is closed when undefined.
	 * @param maxStdout the most output kept.
	 * @returns the result once the process closes.
	 * @throws the spawn error when the program cannot be started.
	 */
	private run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string | undefined, maxStdout: number): Promise<GitRunResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let settled = false;
			let killed: string | undefined;
			/**
			 * Settles the promise once, whichever of the error and close events comes first.
			 *
			 * @param error the spawn error, when the process could not start.
			 * @param status the exit status, null when a signal ended it.
			 */
			const finish = (error?: Error, status?: number | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve({ status: status ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') + (killed ? `\n${killed}` : '') });
			};
			/**
			 * Stops the process, forcibly if it ignores SIGTERM, and records why for its standard error.
			 *
			 * @param reason why it was stopped, as a message states it.
			 */
			const kill = (reason: string) => {
				killed = reason;
				child.kill('SIGTERM');
				setTimeout(() => child.kill('SIGKILL'), 5000).unref();
			};
			const timer = setTimeout(() => kill(`git took longer than ${this.timeoutMs()} ms and was stopped`), this.timeoutMs());
			child.stdout?.on('data', (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > maxStdout) kill(`git produced more than ${maxStdout} bytes of output and was stopped`);
				else stdout.push(chunk);
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				if (stderrBytes < maximumStderrBytes) stderr.push(chunk.subarray(0, maximumStderrBytes - stderrBytes));
				stderrBytes += chunk.length;
			});
			child.on('error', error => finish(error));
			child.on('close', status => finish(undefined, killed ? -1 : status));
			if (input !== undefined) child.stdin?.end(input);
		});
	}

	/**
	 * How long one git process or one registry fetch may take.
	 *
	 * @returns `fetchTimeoutMs`, else 60 seconds.
	 */
	private timeoutMs(): number {
		return this.options.fetchTimeoutMs ?? 60_000;
	}

	/**
	 * Names a repository by its path alone, so the same repository keys the same cache entry however its URL is
	 * spelt: with or without `.git`, a trailing slash or credentials.
	 *
	 * @param source a git source.
	 * @returns the path on the host, or the filesystem path of a `file://` repository.
	 */
	private repositoryPath(source: ModuleSourceClass & { kind: 'git' }): string {
		try {
			const pathname = source.scheme === 'file' ? fileURLToPath(new URL(source.url)) : new URL(source.url).pathname;
			return pathname.replace(/\/+$/, '').replace(/\.git$/, '');
		} catch {
			return stripUserinfo(source.url);
		}
	}

	/**
	 * Places a cache entry by a hash of its key, so no part of a source becomes a path.
	 *
	 * @param cacheDir the cache root.
	 * @param key the entry's cache key.
	 * @returns the entry directory.
	 */
	private entryDir(cacheDir: string, key: string): string {
		return path.join(cacheDir, 'modules', createHash('sha256').update(key).digest('hex').slice(0, 32));
	}

	/**
	 * Reads a cache entry's metadata, treating anything unreadable, of another schema, or missing the files it
	 * should hold as absent, so it is fetched again.
	 *
	 * @param entryDir the entry directory.
	 * @returns the metadata, or undefined when the entry cannot be used.
	 */
	private async readMeta(entryDir: string): Promise<CacheEntryMeta | undefined> {
		try {
			const meta = JSON.parse(await fs.readFile(path.join(entryDir, 'meta.json'), 'utf8')) as CacheEntryMeta;
			if (meta.schema !== 1 || !meta.key) return undefined;
			if (meta.kind === 'git' || !meta.underlyingKey) await fs.access(path.join(entryDir, 'files'));
			return meta;
		} catch {
			return undefined;
		}
	}

	/**
	 * Publishes a cache entry by renaming a staging directory into place, so a half-written entry is never visible.
	 * When another process published the same entry first, its copy is kept.
	 *
	 * @param cacheDir the cache root.
	 * @param entryDir where the entry goes.
	 * @param meta the metadata, written into the staging directory last.
	 * @param temporary the staging directory already holding the entry's files, or undefined for an entry with none,
	 *   which gets a staging directory of its own.
	 * @throws {RemoteSourceError} `CacheWrite` when the entry can be neither written nor found written by another.
	 */
	private async writeEntry(cacheDir: string, entryDir: string, meta: CacheEntryMeta, temporary: string | undefined): Promise<void> {
		const staging = temporary ?? await this.temporaryDir(cacheDir);
		try {
			await fs.writeFile(path.join(staging, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
			await fs.mkdir(path.dirname(entryDir), { recursive: true, mode: 0o700 });
			try {
				await fs.rename(staging, entryDir);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw asRemoteSourceError(error, 'CacheWrite', `could not write the module cache at ${entryDir}`);
				if (!(await this.readMeta(entryDir))) throw asRemoteSourceError(error, 'CacheWrite', `could not write the module cache at ${entryDir}`);
			}
		} finally {
			if (temporary === undefined) await fs.rm(staging, { recursive: true, force: true });
		}
	}

	/**
	 * Creates a private staging directory under the cache's `tmp`, on the same filesystem as the entries so the
	 * final rename is atomic.
	 *
	 * @param cacheDir the cache root.
	 * @returns the new directory.
	 * @throws {RemoteSourceError} `CacheWrite` when it cannot be created.
	 */
	private async temporaryDir(cacheDir: string): Promise<string> {
		const temporary = path.join(cacheDir, 'tmp', randomBytes(8).toString('hex'));
		try {
			await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
		} catch (error) {
			throw asRemoteSourceError(error, 'CacheWrite', `could not create ${temporary}`);
		}
		return temporary;
	}

	/**
	 * Prepares the cache root once per configuration: created `0700`, refused when it is a symlink or owned by
	 * someone else, and swept of stale staging directories. A failure is not remembered, so it is tried again.
	 *
	 * @returns the cache root.
	 * @throws {RemoteSourceError} `CacheWrite` when the root cannot be used.
	 */
	private cacheRoot(): Promise<string> {
		this.cacheReady ??= (async () => {
			const root = this.options.cacheDir ?? defaultCacheDir(this.options.env);
			try {
				await fs.mkdir(root, { recursive: true, mode: 0o700 });
				const stats = await fs.lstat(root);
				if (stats.isSymbolicLink()) throw new Error(`${root} is a symbolic link`);
				if (process.platform !== 'win32') {
					if (stats.uid !== process.getuid?.()) throw new Error(`${root} is not owned by the current user`);
					if ((stats.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
				}
				await fs.mkdir(path.join(root, 'modules'), { recursive: true, mode: 0o700 });
				await fs.mkdir(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });
				await this.sweepTemporary(path.join(root, 'tmp'));
			} catch (error) {
				this.cacheReady = undefined;
				throw asRemoteSourceError(error, 'CacheWrite', `the module cache at ${root} cannot be used`);
			}
			return root;
		})();
		return this.cacheReady;
	}

	/**
	 * Removes staging directories older than an hour, which a process that died mid-fetch left behind. Errors are
	 * ignored, since another process may be sweeping at the same time.
	 *
	 * @param directory the cache's `tmp` directory.
	 */
	private async sweepTemporary(directory: string): Promise<void> {
		const cutoff = Date.now() - staleTemporaryMs;
		for (const entry of await fs.readdir(directory).catch(() => [] as string[])) {
			const target = path.join(directory, entry);
			const stats = await fs.stat(target).catch(() => undefined);
			if (stats && stats.mtimeMs < cutoff) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

/**
 * Reads go-getter's directives off an archive download location. The query string is edited as text, not parsed
 * and rebuilt, so the parameters of a signed URL reach the server exactly as the registry wrote them.
 *
 * @param location the download location a registry returned.
 * @returns the URL to request, the `//subdirectory` inside the archive, the format named by `?archive=` or the
 *   file extension, and the `?checksum=` value.
 */
function parseArchiveLocation(location: string): { url: string; subdirectory: string; format?: string; checksum?: string } {
	const { repository, subdirectory } = splitModuleSource(location);
	const queryIndex = location.indexOf('?');
	const parameters = queryIndex >= 0 ? location.slice(queryIndex + 1).split('&').filter(Boolean) : [];
	/**
	 * Reads one go-getter parameter off the raw query.
	 *
	 * @param name the parameter name.
	 * @returns its decoded value, or undefined when absent.
	 */
	const directive = (name: string) => {
		const parameter = parameters.find(entry => entry.startsWith(`${name}=`));
		return parameter === undefined ? undefined : decodeURIComponent(parameter.slice(name.length + 1));
	};
	const kept = parameters.filter(entry => !entry.startsWith('archive=') && !entry.startsWith('checksum='));
	const extension = repository.match(/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|zip|tar)$/i)?.[1].toLowerCase();
	return {
		url: kept.length > 0 ? `${repository}?${kept.join('&')}` : repository,
		subdirectory,
		format: directive('archive')?.toLowerCase() || extension,
		checksum: directive('checksum')
	};
}

/**
 * Checks a download against go-getter's `checksum` value: `type:hex` with a type of md5, sha1, sha256 or sha512,
 * or a bare hex digest whose length names the type.
 *
 * @param data the downloaded archive.
 * @param checksum the `?checksum=` value.
 * @param label how messages name the module.
 * @throws {RemoteSourceError} `UnsupportedDownloadForm` for a checksum form that cannot be checked,
 *   `ChecksumMismatch` when the digest differs.
 */
function verifyChecksum(data: Buffer, checksum: string, label: string): void {
	const lengths: Record<number, string> = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };
	const separator = checksum.indexOf(':');
	const type = separator >= 0 ? checksum.slice(0, separator).toLowerCase() : lengths[checksum.length];
	const expected = (separator >= 0 ? checksum.slice(separator + 1) : checksum).toLowerCase();
	if (!type || !Object.values(lengths).includes(type)) throw new RemoteSourceError('UnsupportedDownloadForm', `${label} names a checksum that cannot be checked (${checksum.slice(0, 20)})`);
	const actual = createHash(type).update(data).digest('hex');
	if (actual !== expected) throw new RemoteSourceError('ChecksumMismatch', `${label} downloaded with ${type} ${actual}, not the ${expected} its location names`);
}

/**
 * Builds the error for a download location in a form that is not fetched, naming the form and where it points.
 *
 * @param module the module.
 * @param version the resolved version.
 * @param form how the registry serves it, as a message names it.
 * @param location the download location, named in the message without its query, where a signature would be.
 * @returns the error for a download location that is not fetched.
 */
function unsupportedForm(module: RegistryModule, version: string, form: string, location: string): RemoteSourceError {
	return new RemoteSourceError(
		'UnsupportedDownloadForm',
		`${module.host} serves ${module.namespace}/${module.name}/${module.provider} ${version} as ${form} (${location.split('?')[0]}); only git repositories and tar.gz archives can be fetched`
	);
}

/**
 * Strips a host down to the name that DNS and the literal-address checks take.
 *
 * @param host a host with an optional port, IPv6 literals in brackets.
 * @returns the hostname alone, without port or brackets.
 */
function bareHostname(host: string): string {
	return host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

/**
 * Recognises the addresses a module host must not resolve to: loopback, unspecified and link-local, where cloud
 * metadata services live, including IPv4 addresses mapped into IPv6.
 *
 * @param address an IPv4 or IPv6 address.
 * @returns true when it is local.
 */
function isLocalAddress(address: string): boolean {
	if (net.isIPv4(address)) {
		const [first, second] = address.split('.').map(Number);
		return first === 127 || first === 0 || (first === 169 && second === 254);
	}
	const lower = address.toLowerCase();
	if (lower === '::1' || lower === '::') return true;
	if (/^fe[89ab]/.test(lower)) return true;
	const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	return mapped ? isLocalAddress(mapped[1]) : false;
}
