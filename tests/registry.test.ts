import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { ambientCredentials } from '../src/credentials';
import { ParsedDocument } from '../src/ParsedDocument';
import { createRegistryResolver } from '../src/registry';
import { gitEnvironment } from '../src/remote-modules';
import type { RemoteModuleOptions } from '../src/remote-modules';
import { Workspace } from '../src/Workspace';
import { tarGz } from './tar-fixture';

interface RegistryBehaviour {
	discovery?: (response: ServerResponse) => void;
	versions?: (response: ServerResponse) => void;
	download?: (version: string, response: ServerResponse) => void;
	archive?: (url: string, response: ServerResponse) => void;
}

interface LoggedRequest {
	path: string;
	authorization: string | undefined;
}

const git = (cwd: string, ...args: string[]) => {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
	expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).to.equal(0);
	return result.stdout.trim();
};

describe('registry module sources', function () {
	this.timeout(30000);

	let root: string;
	let repository: string;
	let cacheDir: string;
	let gitLog: string;
	let gitShim: string;
	let server: Server;
	let host: string;
	let requests: LoggedRequest[];
	let behaviour: RegistryBehaviour;
	let retries: number;
	let archive: Buffer;
	let archiveSha256: string;

	before(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-registry-')));
		repository = path.join(root, 'repo');
		await fs.mkdir(path.join(repository, 'modules', 'vpc', 'nested'), { recursive: true });
		await fs.writeFile(path.join(repository, 'modules', 'vpc', 'variables.tf'), 'variable "name" {\n  description = "VPC name"\n  type = string\n}\nvariable "cidr" {\n  type = string\n  default = "10.0.0.0/16"\n}\n');
		await fs.writeFile(path.join(repository, 'modules', 'vpc', 'main.tf'), 'resource "null_resource" "vpc" {}\n');
		await fs.writeFile(path.join(repository, 'modules', 'vpc', '.hidden.tf'), 'variable "hidden" {}\n');
		await fs.writeFile(path.join(repository, 'modules', 'vpc', 'nested', 'inner.tf'), 'variable "inner" {}\n');
		await fs.writeFile(path.join(repository, 'outside.tf'), 'variable "outside" {}\n');
		await fs.symlink('../../outside.tf', path.join(repository, 'modules', 'vpc', 'link.tf'));
		for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'tghclp-test'], ['add', '.'], ['commit', '-qm', 'v1'], ['tag', 'v1.0.0']]) git(repository, ...args);
		await fs.writeFile(path.join(repository, 'modules', 'vpc', 'variables.tf'), 'variable "name" {\n  description = "VPC name"\n  type = string\n}\nvariable "cidr" {\n  type = string\n  default = "10.1.0.0/16"\n}\nvariable "tags" {\n  type = map(string)\n  default = {}\n}\n');
		for (const args of [['add', '.'], ['commit', '-qm', 'v1.1'], ['tag', '-a', 'v1.1.0', '-m', 'release']]) git(repository, ...args);

		archive = await tarGz([
			{ name: 'outside.tf', content: 'variable "outside" {}\n' },
			{ name: 'modules/vpc/variables.tf', content: 'variable "name" {\n  type = string\n}\nvariable "subnets" {\n  type = list(string)\n  default = []\n}\n' },
			{ name: 'modules/vpc/main.tf', content: 'resource "null_resource" "vpc" {}\n' },
			{ name: 'modules/vpc/.hidden.tf', content: 'variable "hidden" {}\n' },
			{ name: 'modules/vpc/nested/inner.tf', content: 'variable "inner" {}\n' },
			{ name: 'modules/vpc/link.tf', type: 'symlink', linkname: '../../outside.tf' }
		]);
		archiveSha256 = createHash('sha256').update(archive).digest('hex');

		gitLog = path.join(root, 'git.log');
		gitShim = path.join(root, 'git-shim');
		await fs.writeFile(gitShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TGHCLP_TEST_GIT_LOG"\ncase "$1" in fetch) env | sort > "$TGHCLP_TEST_GIT_LOG.env";; esac\nexec git "$@"\n`, { mode: 0o755 });

		server = createServer((request, response) => handle(request, response));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('registry test server did not expose a TCP port');
		host = `127.0.0.1:${address.port}`;
	});

	after(async () => {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await fs.rm(root, { recursive: true, force: true });
	});

	beforeEach(async () => {
		cacheDir = path.join(root, `cache-${Math.random().toString(36).slice(2)}`);
		requests = [];
		behaviour = {};
		retries = 0;
		await fs.rm(gitLog, { force: true });
		await fs.rm(`${gitLog}.env`, { force: true });
	});

	const handle = (request: IncomingMessage, response: ServerResponse) => {
		const url = request.url ?? '/';
		requests.push({ path: url, authorization: request.headers.authorization });
		if (url === '/.well-known/terraform.json') {
			if (behaviour.discovery) return behaviour.discovery(response);
			response.writeHead(200, { 'content-type': 'application/json' });
			return response.end(JSON.stringify({ 'modules.v1': '/v1/modules/' }));
		}
		if (url === '/v1/modules/acme/vpc/aws/versions') {
			if (behaviour.versions) return behaviour.versions(response);
			response.writeHead(200, { 'content-type': 'application/json' });
			return response.end(JSON.stringify({ modules: [{ versions: [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '2.0.0-rc.1' }] }] }));
		}
		const download = url.match(/^\/v1\/modules\/acme\/vpc\/aws\/([^/]+)\/download$/);
		if (download) {
			if (behaviour.download) return behaviour.download(download[1], response);
			response.writeHead(204, { 'x-terraform-get': `git::file://${repository}//modules/vpc?ref=v${download[1]}` });
			return response.end();
		}
		if (url.startsWith('/archives/')) {
			if (behaviour.archive) return behaviour.archive(url, response);
			response.writeHead(200, { 'content-type': 'application/octet-stream' });
			return response.end(archive);
		}
		response.writeHead(404);
		response.end();
	};

	const options = (extra: Partial<RemoteModuleOptions> = {}): RemoteModuleOptions => ({
		cacheDir,
		env: { ...process.env, TGHCLP_TEST_GIT_LOG: gitLog },
		allowedHosts: ['127.0.0.1'],
		gitExecutable: gitShim,
		registry: createRegistryResolver({ allowInsecureHosts: ['127.0.0.1'] }),
		...extra
	});

	const workspaceFor = (extra: Partial<RemoteModuleOptions> = {}) => {
		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(root).toString());
		workspace.configureRemoteModules({ enabled: true, trusted: true }, options(extra));
		return workspace;
	};

	const unit = (source: string, inputs = '  name = "x"\n  nam  = "y"') => `terraform {\n  source = "${source}"\n}\n\ninputs = {\n${inputs}\n}`;

	const openUnit = async (workspace: Workspace, content: string, name = 'app'): Promise<ParsedDocument> => {
		const unitPath = path.join(root, 'live', name, 'terragrunt.hcl');
		await fs.mkdir(path.dirname(unitPath), { recursive: true });
		await fs.writeFile(unitPath, content);
		const document = new ParsedDocument(workspace, URI.file(unitPath).toString(), content);
		await workspace.addDocument(document);
		return document;
	};

	const gitCalls = async () => (await fs.readFile(gitLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
	const messages = (document: ParsedDocument) => document.getDiagnostics().map(diagnostic => [diagnostic.message, diagnostic.severity]);

	it('fetches the module a registry names, in the background, and checks inputs against it', async () => {
		const workspace = workspaceFor();
		const notified: string[] = [];
		workspace.onModuleVariablesChanged(uri => notified.push(uri));
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=~> 1.0`));
		expect(document.getModuleVariables()).to.deep.include({ status: 'loading', sourceText: `tfr://${host}/acme/vpc/aws?version=~> 1.0`, sourceInThisFile: true });
		expect(messages(document)).to.deep.equal([]);

		await workspace.remoteModulesSettled();
		expect(notified).to.deep.equal([document.getUri()]);
		const state = document.getModuleVariables();
		expect(state?.status).to.equal('loaded');
		if (state?.status !== 'loaded') return;
		expect(state.remote?.label).to.equal(`tfr://${host}/acme/vpc/aws@1.1.0`);
		expect(state.remote?.resolved.version).to.equal('1.1.0');
		expect(state.remote?.resolved.commit).to.equal(git(repository, 'rev-parse', 'v1.1.0^{commit}'));
		expect(state.moduleDir.startsWith(cacheDir)).to.equal(true);
		expect(state.variables.map(variable => variable.name)).to.deep.equal(['name', 'cidr', 'tags']);
		expect(state.files.map(file => path.basename(file))).to.deep.equal(['main.tf', 'variables.tf']);
		expect(messages(document)).to.deep.equal([
			[`Input "nam" is not declared by module tfr://${host}/acme/vpc/aws@1.1.0`, DiagnosticSeverity.Warning]
		]);

		const hover = await document.getHoverInfo({ line: 5, character: 3 });
		expect(hover?.value).to.include('## Input: name');
		expect(hover?.value).to.include(`- *Declared in:* [tfr://${host}/acme/vpc/aws@1.1.0 › variables.tf:1](${URI.file(path.join(state.moduleDir, 'variables.tf')).toString()}#L1)`);
		const summary = await document.getHoverInfo({ line: 4, character: 2 });
		expect(summary?.value).to.include(`Fetched from \`tfr://${host}/acme/vpc/aws@1.1.0\` (cached)`);
		expect(summary?.value).to.include(`[tfr://${host}/acme/vpc/aws@1.1.0](${URI.file(path.join(state.moduleDir, 'variables.tf')).toString()})`);
		const links = await document.getLinks();
		expect(links.map(link => link.target)).to.deep.equal([URI.file(path.join(state.moduleDir, 'variables.tf')).toString()]);

		expect(requests.map(request => request.path)).to.deep.equal(['/.well-known/terraform.json', '/v1/modules/acme/vpc/aws/versions', '/v1/modules/acme/vpc/aws/1.1.0/download']);
		expect(requests.every(request => request.authorization === undefined)).to.equal(true);
		const calls = await gitCalls();
		expect(calls.filter(call => call.startsWith('fetch '))).to.have.length(1);
		expect(calls.some(call => call.includes('file://'))).to.equal(false);
	});

	it('takes the highest release when no version is given', async () => {
		const workspace = workspaceFor();
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()).to.deep.nested.include({ status: 'loaded', 'remote.resolved.version': '1.1.0' });
	});

	it('serves a second workspace from the cache without downloading or running git', async () => {
		const first = workspaceFor();
		await openUnit(first, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await first.remoteModulesSettled();
		const before = (await gitCalls()).length;
		requests = [];

		const second = workspaceFor();
		const document = await openUnit(second, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`), 'other');
		await second.remoteModulesSettled();
		expect(document.getModuleVariables()?.status).to.equal('loaded');
		expect(requests.map(request => request.path)).not.to.include('/v1/modules/acme/vpc/aws/1.1.0/download');
		expect((await gitCalls()).length).to.equal(before);
	});

	it('fetches once for two units naming the same module and tells each of them', async () => {
		const workspace = workspaceFor();
		const notified: string[] = [];
		workspace.onModuleVariablesChanged(uri => notified.push(uri));
		const [first, second] = await Promise.all([
			openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`), 'one'),
			openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`), 'two')
		]);
		await workspace.remoteModulesSettled();
		expect(first.getModuleVariables()?.status).to.equal('loaded');
		expect(second.getModuleVariables()?.status).to.equal('loaded');
		expect(notified.sort()).to.deep.equal([first.getUri(), second.getUri()].sort());
		expect((await gitCalls()).filter(call => call.startsWith('fetch '))).to.have.length(1);
	});

	it('does not tell a unit that was closed before its fetch landed, but keeps the fetched module', async () => {
		const workspace = workspaceFor();
		const notified: string[] = [];
		workspace.onModuleVariablesChanged(uri => notified.push(uri));
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		workspace.removeDocument(document.getUri());
		await workspace.remoteModulesSettled();
		expect(notified).to.deep.equal([]);
		expect(document.getModuleVariables()?.status).to.equal('loading');
		const entries = await fs.readdir(path.join(cacheDir, 'modules'));
		expect(entries.length).to.be.greaterThan(0);
	});

	it('updates the instance that replaced a unit edited during its fetch', async () => {
		const workspace = workspaceFor();
		const notified: string[] = [];
		workspace.onModuleVariablesChanged(uri => notified.push(uri));
		const stale = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		const current = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`, '  name = "edited"'));
		await workspace.remoteModulesSettled();
		expect(notified).to.deep.equal([current.getUri()]);
		expect(stale.getModuleVariables()?.status).to.equal('loading');
		expect(current.getModuleVariables()?.status).to.equal('loaded');
		expect(messages(current)).to.deep.equal([]);
	});

	it('selects a subdirectory inside the module and refuses one that escapes it', async () => {
		const workspace = workspaceFor();
		const nested = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws//nested?version=1.1.0`, '  inner = 1'));
		await workspace.remoteModulesSettled();
		const state = nested.getModuleVariables();
		expect(state?.status).to.equal('loaded');
		if (state?.status === 'loaded') expect(state.variables.map(variable => variable.name)).to.deep.equal(['inner']);
		const escaping = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws//../outside?version=1.1.0`), 'escape');
		expect(escaping.getModuleVariables()).to.deep.include({ status: 'unsupported' });
	});

	it('reads only top-level Terraform files and skips symlinks, dotfiles and nested directories', async () => {
		const workspace = workspaceFor();
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.0.0`));
		await workspace.remoteModulesSettled();
		const state = document.getModuleVariables();
		expect(state?.status).to.equal('loaded');
		if (state?.status !== 'loaded') return;
		expect(state.files.map(file => path.basename(file))).to.deep.equal(['main.tf', 'variables.tf']);
		expect(state.variables.map(variable => variable.name)).to.deep.equal(['name', 'cidr']);
		const meta = JSON.parse(await fs.readFile(path.join(state.remote!.entryDir, 'meta.json'), 'utf8'));
		expect(meta).to.include({ schema: 1, kind: 'git', refKind: 'tag', immutable: true, subdirectory: 'modules/vpc' });
		expect(meta.files).to.deep.equal(['main.tf', 'variables.tf']);
		if (process.platform !== 'win32') {
			expect((await fs.stat(cacheDir)).mode & 0o777).to.equal(0o700);
			expect((await fs.stat(path.join(state.moduleDir, 'variables.tf'))).mode & 0o777).to.equal(0o600);
		}
	});

	it('accepts a download location in the response body and resolves a relative one against the download URL', async () => {
		behaviour.download = (version, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ location: `git::file://${repository}//modules/vpc?ref=v${version}` }));
		};
		const workspace = workspaceFor();
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()?.status).to.equal('loaded');

		behaviour.download = (version, response) => {
			response.writeHead(204, { 'x-terraform-get': `/archives/${version}/vpc.tgz` });
			response.end();
		};
		const relative = await openUnit(workspaceFor(), unit(`tfr://${host}/acme/vpc/aws//modules/vpc?version=1.0.0`), 'archive');
		await relative.getWorkspace().remoteModulesSettled();
		expect(relative.getModuleVariables()).to.deep.nested.include({ status: 'loaded', 'remote.resolved.version': '1.0.0' });
		expect(requests.map(request => request.path)).to.include('/archives/1.0.0/vpc.tgz');
	});

	it('fetches a module a registry serves as a tar.gz archive, without git and without the token on the archive host', async () => {
		const archiveHost = host.replace('127.0.0.1', 'localhost');
		behaviour.download = (version, response) => {
			response.writeHead(204, { 'x-terraform-get': `http://${archiveHost}/archives/object/dmF1bHQ6djY6//modules/vpc?archive=tar.gz&signature=a%2Bb&checksum=sha256:${archiveSha256}` });
			response.end();
		};
		const workspace = workspaceFor({
			allowedHosts: ['127.0.0.1', 'localhost'],
			registry: createRegistryResolver({ allowInsecureHosts: ['127.0.0.1', 'localhost'] }),
			credentials: { tokenFor: async requested => requested.startsWith('127.0.0.1') ? 'registry-secret-token' : undefined }
		});
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		const state = document.getModuleVariables();
		expect(state?.status).to.equal('loaded');
		if (state?.status !== 'loaded') return;
		expect(state.remote?.label).to.equal(`tfr://${host}/acme/vpc/aws@1.1.0`);
		expect(state.remote?.resolved).to.deep.equal({ version: '1.1.0' });
		expect(state.files.map(file => path.basename(file))).to.deep.equal(['main.tf', 'variables.tf']);
		expect(state.variables.map(variable => variable.name)).to.deep.equal(['name', 'subnets']);
		expect(messages(document)).to.deep.equal([[`Input "nam" is not declared by module tfr://${host}/acme/vpc/aws@1.1.0`, DiagnosticSeverity.Warning]]);

		expect(requests.map(request => [request.path, request.authorization])).to.deep.equal([
			['/.well-known/terraform.json', 'Bearer registry-secret-token'],
			['/v1/modules/acme/vpc/aws/versions', 'Bearer registry-secret-token'],
			['/v1/modules/acme/vpc/aws/1.1.0/download', 'Bearer registry-secret-token'],
			['/archives/object/dmF1bHQ6djY6?signature=a%2Bb', undefined]
		]);
		expect(await gitCalls()).to.deep.equal([]);

		const meta = JSON.parse(await fs.readFile(path.join(state.remote!.entryDir, 'meta.json'), 'utf8'));
		expect(meta).to.include({ schema: 1, kind: 'tfr', resolvedVersion: '1.1.0', immutable: true, downloadTarget: `http://${archiveHost}/archives/object/dmF1bHQ6djY6` });
		expect(meta.files).to.deep.equal(['main.tf', 'variables.tf']);
		expect(meta).not.to.have.property('underlyingKey');
		if (process.platform !== 'win32') expect((await fs.stat(path.join(state.moduleDir, 'variables.tf'))).mode & 0o777).to.equal(0o600);

		requests = [];
		const second = workspaceFor();
		const cached = await openUnit(second, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`), 'other');
		await second.remoteModulesSettled();
		expect(cached.getModuleVariables()).to.deep.nested.include({ status: 'loaded', moduleDir: state.moduleDir });
		expect(requests.map(request => request.path)).to.deep.equal(['/.well-known/terraform.json', '/v1/modules/acme/vpc/aws/versions']);
	});

	it('clears the cache, keeps its root, and fetches open units again from a fresh download location', async () => {
		let signature = 0;
		behaviour.download = (_, response) => {
			signature++;
			response.writeHead(204, { 'x-terraform-get': `/archives/vpc.tgz//modules/vpc?signature=${signature}` });
			response.end();
		};
		behaviour.archive = (url, response) => {
			if (url !== `/archives/vpc.tgz?signature=${signature}`) {
				response.writeHead(403);
				return response.end();
			}
			response.writeHead(200);
			response.end(archive);
		};
		const workspace = workspaceFor();
		const notified: string[] = [];
		workspace.onModuleVariablesChanged(uri => notified.push(uri));
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		const before = document.getModuleVariables();
		expect(before?.status).to.equal('loaded');
		if (before?.status !== 'loaded') return;
		await fs.writeFile(path.join(cacheDir, 'keep.txt'), 'not ours');
		notified.length = 0;
		requests = [];

		expect(await workspace.clearRemoteModuleCache()).to.equal(cacheDir);
		expect(document.getModuleVariables()?.status).to.equal('loading');
		expect(notified).to.deep.equal([document.getUri()]);
		expect(await fs.stat(before.remote!.entryDir).catch(() => undefined)).to.equal(undefined);
		expect(await fs.readFile(path.join(cacheDir, 'keep.txt'), 'utf8')).to.equal('not ours');

		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()).to.deep.include({ status: 'loaded', moduleDir: before.moduleDir });
		expect(notified).to.deep.equal([document.getUri(), document.getUri()]);
		expect(requests.map(request => request.path)).to.include.members(['/v1/modules/acme/vpc/aws/1.1.0/download', '/archives/vpc.tgz?signature=2']);
	});

	it('reports each registry failure by what the user can do about it', async () => {
		const cases: { name: string; behaviour: RegistryBehaviour; code: string; reason: string }[] = [
			{ name: 's3', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': 's3::https://s3.example/bucket/vpc.zip' }); response.end(); } }, code: 'UnsupportedDownloadForm', reason: 'as s3' },
			{ name: 'notfound', behaviour: { versions: response => { response.writeHead(404); response.end(); } }, code: 'ModuleNotFound', reason: 'was not found' },
			{ name: 'auth', behaviour: { versions: response => { response.writeHead(401); response.end(); } }, code: 'RegistryAuth', reason: 'set TF_TOKEN_127_0_0_1 or TG_TF_REGISTRY_TOKEN' },
			{ name: 'noversions', behaviour: { versions: response => { response.writeHead(200); response.end(JSON.stringify({ modules: [{ versions: [] }] })); } }, code: 'NoVersions', reason: 'no published versions' },
			{ name: 'nomatch', behaviour: {}, code: 'NoMatchingVersion', reason: 'satisfies "> 5"; available: 1.0.0, 1.1.0, 2.0.0-rc.1' },
			{ name: 'invalid', behaviour: {}, code: 'InvalidConstraint', reason: 'is not valid' },
			{ name: 'noregistry', behaviour: { discovery: response => { response.writeHead(200); response.end(JSON.stringify({ 'providers.v1': '/v1/providers/' })); } }, code: 'NotAModuleRegistry', reason: 'no modules.v1 entry' },
			{ name: 'nolocation', behaviour: { download: (_, response) => { response.writeHead(204); response.end(); } }, code: 'NoDownloadLocation', reason: 'no X-Terraform-Get header' },
			{ name: 'badgit', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': `git::file://${root}/missing-repo?ref=v1.0.0` }); response.end(); } }, code: 'GitFetchFailed', reason: 'git ls-remote failed' },
			{ name: 'discovery500', behaviour: { discovery: response => { response.writeHead(500, { 'retry-after': '0' }); response.end(); } }, code: 'HostUnreachable', reason: `${host} /.well-known/terraform.json answered 500, a server error, after 2 retries; try again later` },
			{ name: 'versions503', behaviour: { versions: response => { response.writeHead(503, { 'retry-after': '0' }); response.end(); } }, code: 'HostUnreachable', reason: `${host}, listing versions of acme/vpc/aws, answered 503, a server error, after 2 retries; try again later` },
			{ name: 'download502', behaviour: { download: (_, response) => { response.writeHead(502, { 'retry-after': '0' }); response.end(); } }, code: 'HostUnreachable', reason: `${host}, asked for the download of acme/vpc/aws 1.0.0, answered 502, a server error, after 2 retries; try again later` },
			{ name: 'archive504', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': '/archives/vpc.tgz' }); response.end(); }, archive: (_, response) => { response.writeHead(504, { 'retry-after': '0' }); response.end(); } }, code: 'HostUnreachable', reason: `http://${host}/archives/vpc.tgz, serving the module archive, answered 504, a server error, after 2 retries; try again later` },
			{ name: 'discovery501', behaviour: { discovery: response => { response.writeHead(501); response.end(); } }, code: 'NotAModuleRegistry', reason: '/.well-known/terraform.json answered 501' },
			{ name: 'dashref', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': `git::file://${repository}//modules/vpc?ref=--upload-pack=touch%20${root}/pwned` }); response.end(); } }, code: 'UnsupportedDownloadForm', reason: `returned a download location for acme/vpc/aws 1.0.0 that cannot be used: ref "--upload-pack=touch ${root}/pwned" must not start with a dash` },
			{ name: 'zip', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': '/archives/vpc.zip' }); response.end(); } }, code: 'UnsupportedDownloadForm', reason: `as a zip archive (http://${host}/archives/vpc.zip); only git repositories and tar.gz archives can be fetched` },
			{ name: 'checksum', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': `/archives/vpc.tgz?checksum=sha256:${'0'.repeat(64)}` }); response.end(); } }, code: 'ChecksumMismatch', reason: `downloaded with sha256 ${archiveSha256}, not the ${'0'.repeat(64)} its location names` },
			{ name: 'notgzip', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': '/archives/vpc' }); response.end(); }, archive: (_, response) => { response.writeHead(200); response.end('<html>sign in</html>'); } }, code: 'ArchiveMalformed', reason: 'is not a gzip-compressed tar archive' },
			{ name: 'archivemissing', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': '/archives/vpc.tgz' }); response.end(); }, archive: (_, response) => { response.writeHead(404); response.end(); } }, code: 'ArchiveDownloadFailed', reason: `http://${host}/archives/vpc.tgz answered 404 for the module archive` },
			{ name: 'archiveexpired', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': '/archives/vpc.tgz' }); response.end(); }, archive: (_, response) => { response.writeHead(403); response.end(); } }, code: 'ArchiveDownloadFailed', reason: 'a signed download location may have expired' },
			{ name: 'archivesubdir', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': '/archives/vpc.tgz//modules/eks' }); response.end(); } }, code: 'SubdirectoryMissing', reason: 'subdirectory modules/eks does not exist' },
			{ name: 'archiveaddress', behaviour: { download: (_, response) => { response.writeHead(204, { 'x-terraform-get': 'https://169.254.169.254/vpc.tgz' }); response.end(); } }, code: 'HostNotAllowed', reason: '169.254.169.254 is an IP address' }
		];
		for (const testCase of cases) {
			behaviour = testCase.behaviour;
			const constraint = testCase.name === 'nomatch' ? '?version=> 5' : testCase.name === 'invalid' ? '?version=>= 1 < 2' : '?version=1.0.0';
			const workspace = workspaceFor();
			const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws${constraint}`), testCase.name);
			await workspace.remoteModulesSettled();
			const state = document.getModuleVariables();
			expect(state?.status, testCase.name).to.equal('fetchFailed');
			if (state?.status !== 'fetchFailed') continue;
			expect(state.code, testCase.name).to.equal(testCase.code);
			expect(state.reason, testCase.name).to.include(testCase.reason);
			expect(messages(document)[0][0], testCase.name).to.equal(`Module source could not be fetched: ${state.reason}`);
		}
		expect(await fs.stat(path.join(root, 'pwned')).catch(() => undefined)).to.equal(undefined);
	});

	it('retries a transient 500 and not a 501', async () => {
		behaviour.versions = response => {
			if (retries++ === 0) {
				response.writeHead(500, { 'retry-after': '0' });
				return response.end();
			}
			response.writeHead(200);
			response.end(JSON.stringify({ modules: [{ versions: [{ version: '1.1.0' }] }] }));
		};
		const workspace = workspaceFor();
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()?.status).to.equal('loaded');
		expect(requests.filter(request => request.path.endsWith('/versions'))).to.have.length(2);

		requests = [];
		behaviour.versions = response => { response.writeHead(501); response.end(); };
		const refused = await openUnit(workspaceFor(), unit(`tfr://${host}/acme/vpc/aws`), 'refused');
		await refused.getWorkspace().remoteModulesSettled();
		expect(refused.getModuleVariables()).to.deep.include({ status: 'fetchFailed', code: 'HostUnreachable' });
		expect(requests.filter(request => request.path.endsWith('/versions'))).to.have.length(1);
	});

	it('reports a registry that does not answer in time without retrying past the timeout', async () => {
		behaviour.versions = () => {};
		const workspace = workspaceFor({ fetchTimeoutMs: 300 });
		const started = Date.now();
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.0.0`));
		await workspace.remoteModulesSettled();
		expect(Date.now() - started).to.be.below(2000);
		expect(document.getModuleVariables()).to.deep.include({ status: 'fetchFailed', code: 'HostUnreachable', reason: `http://${host}/v1/modules/acme/vpc/aws/versions did not answer before the fetch timed out` });
		expect(requests.filter(request => request.path.endsWith('/versions'))).to.have.length(1);
	});

	it('gives an archive download its own timeout, whatever the registry calls took', async () => {
		const delayed = (response: ServerResponse, write: () => void) => setTimeout(write, 700);
		behaviour.versions = response => delayed(response, () => {
			response.writeHead(200);
			response.end(JSON.stringify({ modules: [{ versions: [{ version: '1.0.0' }] }] }));
		});
		behaviour.download = (_, response) => {
			response.writeHead(204, { 'x-terraform-get': '/archives/vpc.tgz//modules/vpc' });
			response.end();
		};
		behaviour.archive = (_, response) => delayed(response, () => {
			response.writeHead(200);
			response.end(archive);
		});
		const workspace = workspaceFor({ fetchTimeoutMs: 1200 });
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.0.0`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()?.status).to.equal('loaded');
	});

	it('does not run git again for a source whose fetch failed', async () => {
		behaviour.download = (_, response) => { response.writeHead(204, { 'x-terraform-get': `git::file://${root}/missing-repo?ref=v1.0.0` }); response.end(); };
		const workspace = workspaceFor();
		await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.0.0`));
		await workspace.remoteModulesSettled();
		const before = (await gitCalls()).length;
		const again = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.0.0`));
		expect(again.getModuleVariables()).to.deep.include({ status: 'fetchFailed', code: 'GitFetchFailed' });
		expect((await gitCalls()).length).to.equal(before);
	});

	it('retries a rate-limited request once the registry says it may', async () => {
		behaviour.versions = response => {
			if (retries++ === 0) {
				response.writeHead(429, { 'retry-after': '0' });
				return response.end();
			}
			response.writeHead(200);
			response.end(JSON.stringify({ modules: [{ versions: [{ version: '1.1.0' }] }] }));
		};
		const workspace = workspaceFor();
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()?.status).to.equal('loaded');
		expect(requests.filter(request => request.path.endsWith('/versions'))).to.have.length(2);
	});

	it('sends a token only to the registry host, on every registry request and never to git', async () => {
		const workspace = workspaceFor({ credentials: { tokenFor: async requested => requested.startsWith('127.0.0.1') ? 'registry-secret-token' : undefined } });
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()?.status).to.equal('loaded');
		expect(requests.map(request => request.authorization)).to.deep.equal(['Bearer registry-secret-token', 'Bearer registry-secret-token', 'Bearer registry-secret-token']);
		const environment = await fs.readFile(`${gitLog}.env`, 'utf8');
		expect(environment).not.to.include('registry-secret-token');
		const state = document.getModuleVariables();
		if (state?.status === 'loaded') {
			expect(await fs.readFile(path.join(state.remote!.entryDir, 'meta.json'), 'utf8')).not.to.include('registry-secret-token');
		}
	});

	it('reads an ambient token for the registry host', async () => {
		const home = path.join(root, 'home');
		await fs.mkdir(home, { recursive: true });
		const workspace = workspaceFor({ credentials: ambientCredentials({ env: { TF_TOKEN_127_0_0_1: 'ambient-token' }, homeDir: home, platform: 'linux' }) });
		await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		expect(requests[0].authorization).to.equal('Bearer ambient-token');
	});

	it('asks before contacting a host that is not allowed outright, and fetches nothing when refused', async () => {
		const asked: [string, string][] = [];
		const workspace = workspaceFor({ allowedHosts: [], approveHost: async (requested, kind) => { asked.push([requested, kind]); return false; } });
		const document = await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()).to.deep.include({ status: 'fetchFailed', code: 'HostNotAllowed' });
		expect(asked).to.deep.equal([]);
		expect(requests).to.deep.equal([]);
		expect(await gitCalls()).to.deep.equal([]);

		const named = workspaceFor({ allowedHosts: [], approveHost: async (requested, kind) => { asked.push([requested, kind]); return false; } });
		const tofu = await openUnit(named, `terraform_binary = "tofu"\n${unit('tfr:///acme/vpc/aws')}`, 'tofu');
		await named.remoteModulesSettled();
		expect(tofu.getModuleVariables()).to.deep.include({ status: 'fetchFailed', code: 'HostNotApproved' });
		expect(asked).to.deep.equal([['registry.opentofu.org', 'registry']]);
	});

	it('resolves tfr:/// against the registry the environment or terraform_binary names', async () => {
		const workspace = workspaceFor({ env: { ...process.env, TGHCLP_TEST_GIT_LOG: gitLog, TG_TF_DEFAULT_REGISTRY_HOST: host } });
		const document = await openUnit(workspace, unit('tfr:///acme/vpc/aws?version=1.1.0'));
		await workspace.remoteModulesSettled();
		expect(document.getModuleVariables()).to.deep.nested.include({ status: 'loaded', 'remote.label': 'tfr:///acme/vpc/aws@1.1.0' });
	});

	it('starts git with a hardened environment and never puts the repository on its command line', async () => {
		const workspace = workspaceFor();
		await openUnit(workspace, unit(`tfr://${host}/acme/vpc/aws?version=1.1.0`));
		await workspace.remoteModulesSettled();
		const environment = Object.fromEntries((await fs.readFile(`${gitLog}.env`, 'utf8')).split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
		expect(environment).to.include({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:file', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: `file://${repository}` });
		expect(environment).not.to.have.any.keys('GIT_ASKPASS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_TRACE');
		expect(environment.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=15').to.include('BatchMode=yes');
		const calls = await gitCalls();
		expect(calls.find(call => call.startsWith('fetch '))).to.equal('fetch -q --depth 1 --no-tags --no-recurse-submodules --end-of-options origin v1.1.0');
		expect(calls.some(call => call.includes(repository))).to.equal(false);
		expect(calls.find(call => call.startsWith('ls-remote '))).to.equal('ls-remote --heads --tags --end-of-options origin v1.1.0 v1.1.0^{}');
	});

	it('builds the git environment without prompts, traces or credentials on the command line', () => {
		const env = gitEnvironment({ PATH: '/usr/bin', GIT_ASKPASS: '/askpass', GIT_TRACE: '1', GIT_DIR: '/elsewhere', VSCODE_GIT_IPC_HANDLE: '/sock', SSH_AUTH_SOCK: '/agent' }, 'https://user:pw@host.example/org/repo.git', false);
		expect(env).to.include({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/agent', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15', GIT_CONFIG_VALUE_0: 'https://user:pw@host.example/org/repo.git' });
		expect(env).not.to.have.any.keys('GIT_ASKPASS', 'GIT_TRACE', 'GIT_DIR', 'VSCODE_GIT_IPC_HANDLE');
		expect(gitEnvironment({ GIT_SSH_COMMAND: 'plink' }, 'https://host.example/repo', false).GIT_SSH_COMMAND).to.equal('plink');
		expect(gitEnvironment({}, 'https://host.example/repo', true)).not.to.have.any.keys('GIT_SSH_COMMAND');
	});
});
