import { expect } from 'chai';

import { canonicalHost, classifyModuleSource, isCommitSha, redactSource, registerSecret, requestKey, subdirectoryFault } from '../src/module-source';
import { splitModuleSource } from '../src/module-variables';

describe('module source classification', () => {
	it('recognises registry sources with and without a host, a subdirectory and a version constraint', () => {
		expect(classifyModuleSource('tfr:///terraform-aws-modules/vpc/aws')).to.deep.equal({
			kind: 'registry', host: 'registry.terraform.io', hostGiven: false, namespace: 'terraform-aws-modules', name: 'vpc', provider: 'aws',
			constraint: undefined, subdirectory: '', ignoredParameters: []
		});
		expect(classifyModuleSource('tfr:///ns/name/aws', { defaultRegistryHost: 'registry.opentofu.org' })).to.include({ host: 'registry.opentofu.org', hostGiven: false });
		expect(classifyModuleSource('tfr://Registry.Example.com:8443/ns/name/aws//modules/sub?version=~> 5.0')).to.deep.include({
			kind: 'registry', host: 'registry.example.com:8443', hostGiven: true, constraint: '~> 5.0', subdirectory: 'modules/sub'
		});
		expect(classifyModuleSource('tfr:///ns/name/aws?version=~>%205.0')).to.include({ constraint: '~> 5.0' });
		expect(classifyModuleSource('tfr:///ns/name/aws?version=5.0.0&depth=1')).to.deep.include({ constraint: '5.0.0', ignoredParameters: ['depth'] });
		expect(classifyModuleSource('tfr:///ns/name/aws///')).to.include({ subdirectory: '' });
	});

	it('reports malformed registry sources with the reason', () => {
		const reasons = [
			['tfr:///ns/name', 'is not namespace/name/provider'],
			['tfr:///ns/name/aws/extra', 'is not namespace/name/provider'],
			['tfr:///ns/na me/aws', 'is not namespace/name/provider'],
			['tfr://host', 'no module path'],
			['tfr://user@host/ns/name/aws', 'is not allowed'],
			['tfr://xn--bcher-kva.example/ns/name/aws', 'is not allowed'],
			['tfr:///ns/name/aws?version=1.0&version=2.0', 'more than one version query'],
			['tfr:///ns/name/aws?version=', 'version query is empty'],
			['tfr:///ns/name/aws//../escape', 'leaves the module']
		];
		for (const [source, reason] of reasons) {
			const result = classifyModuleSource(source);
			expect(result.kind, source).to.equal('other');
			if (result.kind === 'other') {
				expect(result.getter, source).to.equal('malformed');
				expect(result.reason, source).to.include(reason);
			}
		}
	});

	it('keeps local sources local', () => {
		expect(classifyModuleSource('../../modules/app//sub')).to.deep.equal({ kind: 'local', path: '../../modules/app', subdirectory: 'sub' });
		expect(classifyModuleSource('./app')).to.include({ kind: 'local' });
		expect(classifyModuleSource('/abs/app')).to.include({ kind: 'local' });
		expect(classifyModuleSource('file:///abs/app')).to.include({ kind: 'local', path: 'file:///abs/app' });
	});

	it('does not fetch authored git sources yet, but classifies registry download locations as git', () => {
		const authored = classifyModuleSource('git::https://gitlab.com/org/repo.git//modules/app?ref=v1.2.0');
		expect(authored).to.deep.equal({ kind: 'other', getter: 'git', reason: 'git sources are not fetched by the language service yet' });
		expect(classifyModuleSource('git::https://gitlab.com/org/repo.git//modules/app?ref=v1.2.0', { origin: 'registry' })).to.deep.equal({
			kind: 'git', url: 'https://gitlab.com/org/repo.git', host: 'gitlab.com', scheme: 'https', ref: 'v1.2.0', depth: undefined,
			subdirectory: 'modules/app', ignoredParameters: []
		});
	});

	it('rewrites scp-like and shorthand git forms and keeps userinfo for git', () => {
		const registry = { origin: 'registry' as const };
		expect(classifyModuleSource('git::git@github.com:org/repo.git?ref=abc', registry)).to.include({ url: 'ssh://git@github.com/org/repo.git', host: 'github.com', scheme: 'ssh', ref: 'abc' });
		expect(classifyModuleSource('github.com/org/repo//sub', registry)).to.include({ url: 'https://github.com/org/repo.git', host: 'github.com', subdirectory: 'sub' });
		expect(classifyModuleSource('git::https://user:pw@host.example/org/repo.git', registry)).to.include({ url: 'https://user:pw@host.example/org/repo.git', host: 'host.example' });
		expect(classifyModuleSource('git::file:///tmp/repo//mod?ref=v1&depth=2&sshkey=abc', registry)).to.deep.include({ scheme: 'file', host: '', depth: 2, ignoredParameters: ['sshkey'] });
		expect(classifyModuleSource('git::https://host.example/repo?depth=zero', registry)).to.include({ depth: undefined });
		expect(classifyModuleSource('git::ftp://host.example/repo', registry)).to.deep.include({ kind: 'other', getter: 'git' });
	});

	it('refuses a ref git would read as an option', () => {
		expect(classifyModuleSource('git::https://host.example/repo.git?ref=--upload-pack=touch%20pwned', { origin: 'registry' })).to.deep.equal({
			kind: 'other',
			getter: 'malformed',
			reason: 'ref "--upload-pack=touch pwned" must not start with a dash'
		});
		expect(classifyModuleSource('git::https://host.example/repo.git?ref=v1-0', { origin: 'registry' })).to.include({ kind: 'git', ref: 'v1-0' });
	});

	it('names every other getter and archive as not fetched', () => {
		expect(classifyModuleSource('hg::https://host.example/repo')).to.deep.include({ kind: 'other', getter: 'hg' });
		expect(classifyModuleSource('s3::https://s3.amazonaws.com/bucket/module.zip')).to.deep.include({ kind: 'other', getter: 's3' });
		expect(classifyModuleSource('https://host.example/module.zip//sub')).to.deep.include({ kind: 'other', getter: 'archive' });
		expect(classifyModuleSource('https://host.example/module.tar.xz')).to.deep.include({ kind: 'other', getter: 'archive' });
		expect(classifyModuleSource('https://archivist.terraform.io/v1/object/dmF1bHQ6djY6abc', { origin: 'registry' })).to.deep.include({ kind: 'other', getter: 'archive' });
		expect(classifyModuleSource('https://gitlab.example/org/repo.git', { origin: 'registry' })).to.deep.include({ kind: 'other', getter: 'archive' });
		expect(classifyModuleSource('https://github.com/org/repo', { origin: 'registry' })).to.deep.include({ kind: 'other', getter: 'archive' });
		expect(classifyModuleSource('something-odd')).to.deep.include({ kind: 'other', getter: 'unknown' });
	});

	it('rejects subdirectories that escape or carry unsafe characters', () => {
		expect(subdirectoryFault('')).to.equal(undefined);
		expect(subdirectoryFault('modules/app')).to.equal(undefined);
		expect(subdirectoryFault('a/../../b')).to.include('leaves the module');
		expect(subdirectoryFault('-flag')).to.include('dash');
		expect(subdirectoryFault('a\\b')).to.include('not allowed');
		expect(classifyModuleSource('../../modules//..')).to.deep.include({ kind: 'other', getter: 'malformed' });
	});

	it('recognises commit ids and canonical hosts', () => {
		expect(isCommitSha('0123456789abcdef0123456789abcdef01234567')).to.equal(true);
		expect(isCommitSha('0123456789abcdef0123456789abcdef01234567'.repeat(1).slice(0, 39))).to.equal(false);
		expect(isCommitSha('v1.2.3')).to.equal(false);
		expect(canonicalHost('GitLab.Example.com')).to.equal('gitlab.example.com');
		expect(canonicalHost('gitlab.example.com:443')).to.equal('gitlab.example.com');
		expect(canonicalHost('gitlab.example.com:8443')).to.equal('gitlab.example.com:8443');
		expect(canonicalHost('bücher.example')).to.equal('xn--bcher-kva.example');
	});

	it('redacts credentials from source text, headers and registered secrets', () => {
		expect(redactSource('https://user:secret@host.example/repo.git')).to.equal('https://***@host.example/repo.git');
		expect(redactSource('git::ssh://git@host.example/repo?sshkey=QUJD&ref=v1')).to.equal('git::ssh://***@host.example/repo?sshkey=***&ref=v1');
		expect(redactSource('Authorization: Bearer abcdefghijkl')).to.equal('Authorization: ***');
		expect(redactSource('fatal: bearer abcdefghijkl rejected')).to.equal('fatal: bearer *** rejected');
		registerSecret('s3cr3t-value');
		expect(redactSource('token s3cr3t-value leaked')).to.equal('token *** leaked');
	});

	it('derives one request key for every spelling of the same request', () => {
		const registry = { origin: 'registry' as const };
		const short = classifyModuleSource('tfr:///ns/name/aws?version=1.0');
		const long = classifyModuleSource('tfr://registry.terraform.io/ns/name/aws?version=1.0');
		if (short.kind !== 'registry' || long.kind !== 'registry') throw new Error('expected registry sources');
		expect(requestKey(short)).to.equal(requestKey(long));
		const plain = classifyModuleSource('git::https://host.example/repo.git?ref=v1', registry);
		const withUser = classifyModuleSource('git::https://u:p@host.example/repo.git?ref=v1', registry);
		if (plain.kind !== 'git' || withUser.kind !== 'git') throw new Error('expected git sources');
		expect(requestKey(plain)).to.equal(requestKey(withUser));
		expect(requestKey(plain)).not.to.include('u:p');
	});

	it('splits the version, depth and parameter list from a source query', () => {
		expect(splitModuleSource('https://host.example/repo.git//sub?ref=v1&depth=3&sshkey=x')).to.deep.include({
			repository: 'https://host.example/repo.git', subdirectory: 'sub', ref: 'v1', depth: '3', parameters: ['ref', 'depth', 'sshkey']
		});
		expect(splitModuleSource('../local').parameters).to.deep.equal([]);
	});
});
