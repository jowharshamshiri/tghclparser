import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { canonicalHost, isPublicRegistry, registerSecret } from './module-source';
import { parse } from './parser';

/** Supplies the API token for a registry host, or nothing when the host is to be contacted anonymously. */
export interface CredentialProvider {
	/**
	 * Supplies the token for a host that is about to be contacted.
	 *
	 * @param host the canonical host about to be contacted.
	 * @returns the token for that host, or undefined when none is known.
	 */
	tokenFor(host: string): Promise<string | undefined>;
}

/** Where the ambient provider looks, as Terraform and Terragrunt do. */
export interface AmbientCredentialOptions {
	/** The environment to read, `process.env` in production. */
	env: NodeJS.ProcessEnv;
	/** The home directory holding `.terraformrc` and `.terraform.d`. */
	homeDir: string;
	/** `process.platform` in production; `win32` reads `%APPDATA%` and compares environment names case-insensitively. */
	platform?: NodeJS.Platform;
}

/** The largest CLI configuration file read; anything bigger is ignored rather than parsed. */
const maximumConfigurationBytes = 1024 * 1024;

/**
 * Encodes a host into Terraform's token variable name, `-` as `__` and `.` as `_`, so messages can name the
 * variable to set.
 *
 * @param host a canonical host without a port.
 * @returns the environment variable Terraform reads a token for that host from.
 */
export function tokenEnvName(host: string): string {
	return `TF_TOKEN_${host.replace(/-/g, '__').replace(/\./g, '_')}`;
}

/**
 * Decodes the host from a `TF_TOKEN_` variable name, the reverse of {@link tokenEnvName}.
 *
 * @param name an environment variable name.
 * @returns the host a `TF_TOKEN_` variable names, decoded the way Terraform does, or undefined for any other name.
 */
export function hostFromTokenEnvName(name: string): string | undefined {
	const match = name.match(/^TF_TOKEN_(.+)$/i);
	if (!match) return undefined;
	return match[1].split('__').map(part => part.replace(/_/g, '.')).join('-').toLowerCase();
}

/**
 * Tokens from the environment and the Terraform CLI configuration files, in Terraform's order: `TF_TOKEN_<host>`,
 * then the `credentials` blocks of the main configuration file and of every file in `terraform.d`, later files
 * overriding earlier ones, then Terragrunt's registry-wide token for hosts other than the public registries.
 * Credential helpers are not run. Every token found is registered for redaction.
 *
 * @param options the environment and home directory to read.
 * @returns the provider.
 */
export function ambientCredentials(options: AmbientCredentialOptions): CredentialProvider {
	const platform = options.platform ?? process.platform;
	return {
		/**
		 * Looks a host's token up in the environment, then the CLI configuration, then Terragrunt's registry-wide
		 * token, and registers what it finds for redaction.
		 *
		 * @param host the host about to be contacted, with any port.
		 * @returns the token, or undefined when none applies.
		 */
		async tokenFor(host: string): Promise<string | undefined> {
			const canonical = canonicalHost(host);
			const hostname = canonical.replace(/:\d+$/, '');
			const token = tokenFromEnvironment(options.env, hostname, platform)
				?? await tokenFromConfiguration(options, platform, canonical, hostname)
				?? (isPublicRegistry(canonical) ? undefined : options.env.TG_TF_REGISTRY_TOKEN || options.env.TERRAGRUNT_TF_REGISTRY_TOKEN || undefined);
			if (token) registerSecret(token);
			return token;
		}
	};
}

/**
 * Finds a `TF_TOKEN_` variable naming the host. Names are compared case-insensitively on Windows, as its
 * environment is.
 *
 * @param env the environment.
 * @param hostname the canonical host without a port.
 * @param platform decides how names are compared.
 * @returns the variable's value, or undefined when none names the host.
 */
function tokenFromEnvironment(env: NodeJS.ProcessEnv, hostname: string, platform: NodeJS.Platform): string | undefined {
	for (const [name, value] of Object.entries(env)) {
		if (!value) continue;
		const candidate = platform === 'win32' ? name.toUpperCase() : name;
		if (hostFromTokenEnvName(candidate) === hostname) return value;
	}
	return undefined;
}

/**
 * Collects the `credentials` blocks of every CLI configuration file, a later file overriding an earlier one for
 * the same host, and picks the one for this host.
 *
 * @param options the environment and home directory.
 * @param platform decides where the files are.
 * @param canonical the canonical host, with any port.
 * @param hostname the same host without its port, which a block may name instead.
 * @returns the token, or undefined when no block names the host.
 */
async function tokenFromConfiguration(options: AmbientCredentialOptions, platform: NodeJS.Platform, canonical: string, hostname: string): Promise<string | undefined> {
	const tokens = new Map<string, string>();
	for (const file of await configurationFiles(options, platform)) {
		for (const [host, token] of await readCredentials(file)) tokens.set(canonicalHost(host), token);
	}
	return tokens.get(canonical) ?? tokens.get(hostname);
}

/**
 * Lists the CLI configuration files Terraform reads, in its order: `TF_CLI_CONFIG_FILE`, else the platform's main
 * file (`.terraformrc`, or `terraform.rc` under `%APPDATA%`), then every `.tfrc` and `.tfrc.json` in `terraform.d`,
 * sorted by name.
 *
 * @param options the environment and home directory.
 * @param platform decides where the files are.
 * @returns the paths, which may not exist.
 */
async function configurationFiles(options: AmbientCredentialOptions, platform: NodeJS.Platform): Promise<string[]> {
	const files: string[] = [];
	const configured = options.env.TF_CLI_CONFIG_FILE;
	const appData = options.env.APPDATA;
	if (configured) files.push(configured);
	else if (platform === 'win32') { if (appData) files.push(path.join(appData, 'terraform.rc')); }
	else files.push(path.join(options.homeDir, '.terraformrc'));
	const directory = platform === 'win32' ? (appData ? path.join(appData, 'terraform.d') : undefined) : path.join(options.homeDir, '.terraform.d');
	if (directory) {
		try {
			const entries = await fs.readdir(directory);
			files.push(...entries.filter(entry => entry.endsWith('.tfrc') || entry.endsWith('.tfrc.json')).sort().map(entry => path.join(directory, entry)));
		} catch {}
	}
	return files;
}

/**
 * Reads the credentials a CLI configuration file holds, as JSON for `.json` files and HCL otherwise. A file that is
 * missing, not a regular file, over 1 MiB or unreadable holds none.
 *
 * @param file the path.
 * @returns host and token pairs, in the file's order.
 */
async function readCredentials(file: string): Promise<[string, string][]> {
	let content: string;
	try {
		const stats = await fs.stat(file);
		if (!stats.isFile() || stats.size > maximumConfigurationBytes) return [];
		content = await fs.readFile(file, 'utf8');
	} catch {
		return [];
	}
	if (file.endsWith('.json')) return credentialsFromJson(content);
	return credentialsFromHcl(content, file);
}

/**
 * Reads `{ "credentials": { "<host>": { "token": "…" } } }`, the form `terraform login` writes.
 *
 * @param content the file's text.
 * @returns host and token pairs, skipping entries without a string token; none when the text is not JSON.
 */
function credentialsFromJson(content: string): [string, string][] {
	try {
		const parsed: unknown = JSON.parse(content);
		const credentials = (parsed as { credentials?: unknown })?.credentials;
		if (!credentials || typeof credentials !== 'object') return [];
		return Object.entries(credentials as Record<string, unknown>)
			.map(([host, entry]) => [host, (entry as { token?: unknown })?.token] as const)
			.filter((pair): pair is readonly [string, string] => typeof pair[1] === 'string' && pair[1] !== '')
			.map(([host, token]) => [host, token]);
	} catch {
		return [];
	}
}

/**
 * Reads `credentials "<host>" { token = "…" }` blocks with the project's own parser. Nothing is evaluated, so only
 * a literal token counts.
 *
 * @param content the file's text.
 * @param file the path, for the parser's locations.
 * @returns host and token pairs, in the file's order; none when the text does not parse.
 */
function credentialsFromHcl(content: string, file: string): [string, string][] {
	let ast: any;
	try {
		ast = parse(content, { grammarSource: file, tracer: { trace() {} } });
	} catch {
		return [];
	}
	const found: [string, string][] = [];
	for (const block of ast.children ?? []) {
		if (block.type !== 'block' || block.value !== 'credentials') continue;
		const label = block.children?.find((child: any) => child.type === 'parameter');
		const attribute = block.children?.find((child: any) => child.type === 'attribute' && child.value === 'token');
		const value = attribute?.children?.find((child: any) => child.type === 'string_lit');
		if (label && value && typeof value.value === 'string' && value.value !== '') found.push([String(label.value), value.value]);
	}
	return found;
}

/**
 * Combines providers, so the host of the language service can add its own after the ambient ones.
 *
 * @param providers providers in the order to ask them.
 * @returns a provider that answers with the first token any of them supplies.
 */
export function chainCredentials(...providers: CredentialProvider[]): CredentialProvider {
	return {
		/**
		 * Asks each provider in turn.
		 *
		 * @param host the host about to be contacted.
		 * @returns the first token supplied, or undefined when none is.
		 */
		async tokenFor(host: string): Promise<string | undefined> {
			for (const provider of providers) {
				const token = await provider.tokenFor(host);
				if (token) return token;
			}
			return undefined;
		}
	};
}
