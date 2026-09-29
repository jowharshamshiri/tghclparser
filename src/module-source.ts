import { domainToASCII } from 'node:url';

import { isLocalSource, splitModuleSource } from './module-variables';

/** What a `terraform { source }` value names, once its form has been recognised. */
export type ModuleSourceClass =
	| {
		kind: 'local';
		/** The path or `file://` URL as written, before the unit directory is applied. */
		path: string;
		/** The `//subdirectory` inside it, empty for none. */
		subdirectory: string;
	}
	| {
		kind: 'registry';
		/** The registry host, lower-cased; the default host when the source gave none. */
		host: string;
		/** False for the `tfr:///` form, which names no host. */
		hostGiven: boolean;
		namespace: string;
		name: string;
		/** The target system, `aws` in `terraform-aws-modules/vpc/aws`. */
		provider: string;
		/** The `?version=` constraint as given, or undefined for the latest release. */
		constraint?: string;
		/** The `//subdirectory` inside the module, empty for none. */
		subdirectory: string;
		/** Query parameters the source carried that mean nothing here, so a hint can name them. */
		ignoredParameters: string[];
	}
	| {
		kind: 'git';
		/** The repository URL git is given, with any userinfo kept and the scp-like form rewritten to `ssh://`. */
		url: string;
		/** The repository host, lower-cased; empty for a `file://` repository. */
		host: string;
		scheme: 'https' | 'http' | 'ssh' | 'git' | 'file';
		/** The `?ref=` as given: a branch, a tag or a commit. */
		ref?: string;
		/** The `?depth=` as given, when it is a positive integer. */
		depth?: number;
		/** The `//subdirectory` inside the repository, empty for none. */
		subdirectory: string;
		/** Query parameters the source carried that are not honoured, so a hint can name them. */
		ignoredParameters: string[];
	}
	| {
		kind: 'other';
		/** The getter or form recognised, such as `hg`, `s3` or `archive`, or `malformed`. */
		getter: string;
		/** Why the source is not fetched, as a message states it. */
		reason: string;
	};

/** Where a source string came from, which decides which forms are fetched. */
export interface ClassifyOptions {
	/** The host `tfr:///` means; `registry.terraform.io` when omitted. */
	defaultRegistryHost?: string;
	/**
	 * `authored` for a source written in a configuration, `registry` for a download location a registry returned.
	 * Git repositories are fetched for registry locations; an authored git source is not fetched yet.
	 */
	origin?: 'authored' | 'registry';
}

const publicRegistryHosts = new Set(['registry.terraform.io', 'registry.opentofu.org']);
const gitShorthandHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const knownSecrets = new Set<string>();

/**
 * Recognises the form of a module source. Nothing here touches the network or the filesystem, so a malformed
 * source is reported as `other` with the reason rather than thrown.
 *
 * @param source the source as written or evaluated.
 * @param options where the source came from and what the default registry is.
 * @returns the classification.
 */
export function classifyModuleSource(source: string, options: ClassifyOptions = {}): ModuleSourceClass {
	const text = source.trim();
	if (/^tfr:\/\//i.test(text)) return classifyRegistrySource(text, options.defaultRegistryHost ?? 'registry.terraform.io');
	const parts = splitModuleSource(text);
	const subdirectoryProblem = subdirectoryFault(parts.subdirectory);
	if (subdirectoryProblem) return { kind: 'other', getter: 'malformed', reason: subdirectoryProblem };
	if (!parts.forced && isLocalSource(parts.repository)) return { kind: 'local', path: parts.repository, subdirectory: parts.subdirectory };
	if (parts.forced && parts.forced !== 'git') return { kind: 'other', getter: parts.forced, reason: `${parts.forced}:: sources are not fetched by the language service` };
	if (!parts.forced && /^https?:\/\//i.test(parts.repository)) {
		return { kind: 'other', getter: 'archive', reason: 'archive sources are not fetched by the language service' };
	}
	const git = classifyGitSource(parts);
	if (git.kind === 'git' && options.origin !== 'registry') {
		return { kind: 'other', getter: 'git', reason: 'git sources are not fetched by the language service yet' };
	}
	return git;
}

/**
 * Parses a `tfr://[host]/namespace/name/provider[//subdir][?version=…]` source by hand, since the generic splitter
 * drops query parameters. A host carrying userinfo, whitespace, `..` or a punycode prefix is refused.
 *
 * @param text the trimmed source, starting with `tfr://`.
 * @param defaultHost the host `tfr:///` means.
 * @returns the registry classification, or `other` with getter `malformed` and the reason.
 */
function classifyRegistrySource(text: string, defaultHost: string): ModuleSourceClass {
	/**
	 * Builds the classification for a source that is not a valid `tfr://` form.
	 *
	 * @param detail what is wrong with it.
	 * @returns the `malformed` classification, naming the expected form.
	 */
	const malformed = (detail: string): ModuleSourceClass => ({
		kind: 'other',
		getter: 'malformed',
		reason: `${redactSource(text)} is not a valid tfr:// source: expected tfr://[host]/namespace/name/provider[//subdir][?version=…] (${detail})`
	});
	let rest = text.slice('tfr://'.length);
	const queryIndex = rest.indexOf('?');
	const query = new URLSearchParams(queryIndex >= 0 ? rest.slice(queryIndex + 1) : '');
	if (queryIndex >= 0) rest = rest.slice(0, queryIndex);
	const slash = rest.indexOf('/');
	if (slash < 0) return malformed('no module path');
	const givenHost = rest.slice(0, slash);
	if (/[@\s]|\.\./.test(givenHost) || /^xn--/i.test(givenHost)) return malformed(`host "${givenHost}" is not allowed`);
	let modulePath = rest.slice(slash + 1);
	let subdirectory = '';
	const separator = modulePath.indexOf('//');
	if (separator >= 0) {
		subdirectory = modulePath.slice(separator + 2).replace(/^\/+/, '');
		modulePath = modulePath.slice(0, separator);
	}
	const subdirectoryProblem = subdirectoryFault(subdirectory);
	if (subdirectoryProblem) return malformed(subdirectoryProblem);
	const segments = modulePath.replace(/^\/+|\/+$/g, '').split('/');
	if (segments.length !== 3 || segments.some(segment => !/^[0-9A-Za-z][0-9A-Za-z_-]*$/.test(segment))) {
		return malformed(`module path "${modulePath}" is not namespace/name/provider`);
	}
	const versions = query.getAll('version');
	if (versions.length > 1) return malformed('more than one version query');
	if (versions.length === 1 && versions[0].trim() === '') return malformed('version query is empty');
	return {
		kind: 'registry',
		host: (givenHost || defaultHost).toLowerCase(),
		hostGiven: givenHost !== '',
		namespace: segments[0],
		name: segments[1],
		provider: segments[2],
		constraint: versions.length === 1 ? versions[0].trim() : undefined,
		subdirectory,
		ignoredParameters: [...new Set(query.keys())].filter(key => key !== 'version')
	};
}

/**
 * Recognises a git repository and rewrites it to a URL git takes: the `github.com/org/repo` shorthand for the
 * known hosts becomes `https://…/repo.git`, and the scp-like `user@host:path` becomes `ssh://`. A ref starting with
 * a dash is refused, since git would read it as an option.
 *
 * @param parts the split source.
 * @returns the git classification, or `other` when the repository has no recognised scheme or URL, or its ref is
 *   unsafe.
 */
function classifyGitSource(parts: ReturnType<typeof splitModuleSource>): ModuleSourceClass {
	if (parts.ref?.startsWith('-')) return { kind: 'other', getter: 'malformed', reason: `ref "${redactSource(parts.ref)}" must not start with a dash` };
	let url = parts.repository;
	const shorthand = url.match(/^([a-z0-9.-]+)\/([^/]+)\/([^/]+)$/i);
	if (!parts.forced && shorthand && gitShorthandHosts.has(shorthand[1].toLowerCase())) {
		url = `https://${shorthand[1]}/${shorthand[2]}/${shorthand[3].replace(/\.git$/, '')}.git`;
	}
	const scpLike = !url.includes('://') && url.match(/^([^@/\s]+@)?([^:/\s]+):(.+)$/);
	if (scpLike) url = `ssh://${scpLike[1] ?? ''}${scpLike[2]}/${scpLike[3]}`;
	const schemeMatch = url.match(/^(https|http|ssh|git|file):\/\//i);
	if (!schemeMatch) {
		if (!parts.forced) return { kind: 'other', getter: 'unknown', reason: `${redactSource(parts.repository)} is not a form the language service recognises` };
		return { kind: 'other', getter: 'git', reason: `git source ${redactSource(url)} has no recognised scheme` };
	}
	const scheme = schemeMatch[1].toLowerCase() as 'https' | 'http' | 'ssh' | 'git' | 'file';
	let host = '';
	if (scheme !== 'file') {
		try {
			host = new URL(url).hostname.toLowerCase();
		} catch {
			return { kind: 'other', getter: 'git', reason: `git source ${redactSource(url)} is not a valid URL` };
		}
	}
	const depth = parts.depth !== undefined && /^[1-9]\d*$/.test(parts.depth) ? Number(parts.depth) : undefined;
	return {
		kind: 'git',
		url,
		host,
		scheme,
		ref: parts.ref,
		depth,
		subdirectory: parts.subdirectory,
		ignoredParameters: parts.parameters.filter(key => key !== 'ref' && key !== 'depth')
	};
}

/**
 * Checks a subdirectory before it can reach git or the filesystem: no `..` segment, backslash, NUL or leading dash,
 * which git would read as an option.
 *
 * @param subdirectory a `//subdirectory` after leading slashes were dropped.
 * @returns why it must not be used, or undefined when it is acceptable.
 */
export function subdirectoryFault(subdirectory: string): string | undefined {
	if (subdirectory === '') return undefined;
	if (subdirectory.includes('\0') || subdirectory.includes('\\')) return `subdirectory "${subdirectory}" contains a character that is not allowed`;
	if (subdirectory.startsWith('-')) return `subdirectory "${subdirectory}" must not start with a dash`;
	if (subdirectory.split('/').some(segment => segment === '..')) return `subdirectory "${subdirectory}" leaves the module`;
	return undefined;
}

/**
 * Recognises an archive by its file extension, which is how the CLI decides to download and unpack a source.
 *
 * @param source the repository part of a module source.
 * @returns true when it names an archive by extension.
 */
export function isArchiveSource(source: string): boolean {
	return /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)(?:\?.*)?$/i.test(source);
}

/**
 * Tells a full commit id from a branch or tag name, since a commit is fetched directly and never moves.
 *
 * @param ref a `?ref=` value.
 * @returns true for a full SHA-1 or SHA-256 commit id.
 */
export function isCommitSha(ref: string): boolean {
	return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(ref);
}

/**
 * The form a host takes in cache keys, credential lookups and approvals, so spellings that name the same host
 * agree.
 *
 * @param host a hostname, optionally with a port.
 * @returns the lower-cased ASCII hostname, with the port kept only when it is not 443.
 */
export function canonicalHost(host: string): string {
	const match = host.trim().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
	const name = (match?.[1] ?? host.trim()).toLowerCase();
	const ascii = domainToASCII(name) || name;
	const port = match?.[2];
	return port && port !== '443' ? `${ascii}:${port}` : ascii;
}

/**
 * Recognises the public registries, which need no token and are never sent Terragrunt's registry-wide one.
 *
 * @param host a canonical host.
 * @returns true for the public Terraform and OpenTofu registries.
 */
export function isPublicRegistry(host: string): boolean {
	return publicRegistryHosts.has(host);
}

/**
 * Records a secret so {@link redactSource} can remove it from any text that leaves the fetch layer.
 *
 * @param value the secret; empty values are ignored.
 */
export function registerSecret(value: string): void {
	if (value.length >= 4) knownSecrets.add(value);
}

/**
 * Removes credentials from text that will be shown, stored or logged: URL userinfo, `sshkey` values,
 * authorization headers and every registered secret.
 *
 * @param text any text derived from a source, a command or a response.
 * @returns the text with each credential replaced by `***`.
 */
export function redactSource(text: string): string {
	let redacted = text
		.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')
		.replace(/([?&]sshkey=)[^&\s]*/gi, '$1***')
		.replace(/(authorization:\s*)(?:(?:bearer|basic)\s+)?\S+/gi, '$1***')
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
	for (const secret of knownSecrets) redacted = redacted.split(secret).join('***');
	return redacted;
}

/**
 * The string a store dedupes in-flight work by: everything that decides what is fetched, before resolution.
 *
 * @param source a registry or git classification.
 * @returns the key, with no credentials in it.
 */
export function requestKey(source: ModuleSourceClass & { kind: 'registry' | 'git' }): string {
	if (source.kind === 'registry') {
		return `tfr|${source.host}|${source.namespace}/${source.name}/${source.provider}|${source.constraint ?? ''}|${source.subdirectory}`;
	}
	return `git|${stripUserinfo(source.url)}|${source.ref ?? ''}|${source.subdirectory}`;
}

/**
 * Removes credentials written into a URL.
 *
 * @param url a repository URL.
 * @returns the URL without any `user:password@` part, which is how cache keys and labels name a repository.
 */
export function stripUserinfo(url: string): string {
	return url.replace(/^(\w+:\/\/)[^/@\s]+@/, '$1');
}
