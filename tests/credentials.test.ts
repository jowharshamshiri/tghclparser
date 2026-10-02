import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';

import { ambientCredentials, chainCredentials, hostFromTokenEnvName, tokenEnvName } from '../src/credentials';

describe('ambient registry credentials', () => {
	let home: string;

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-credentials-'));
	});

	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true });
	});

	it('encodes and decodes host names the way Terraform names token variables', () => {
		expect(tokenEnvName('app.terraform.io')).to.equal('TF_TOKEN_app_terraform_io');
		expect(tokenEnvName('my-host.example.com')).to.equal('TF_TOKEN_my__host_example_com');
		expect(hostFromTokenEnvName('TF_TOKEN_app_terraform_io')).to.equal('app.terraform.io');
		expect(hostFromTokenEnvName('TF_TOKEN_my__host_example_com')).to.equal('my-host.example.com');
		expect(hostFromTokenEnvName('TF_TOKEN_127_0_0_1')).to.equal('127.0.0.1');
		expect(hostFromTokenEnvName('TF_VAR_region')).to.equal(undefined);
	});

	it('reads a host token from the environment, ignoring the port', async () => {
		const provider = ambientCredentials({ env: { TF_TOKEN_registry_example_com: 'env-token' }, homeDir: home, platform: 'linux' });
		expect(await provider.tokenFor('registry.example.com')).to.equal('env-token');
		expect(await provider.tokenFor('registry.example.com:8443')).to.equal('env-token');
		expect(await provider.tokenFor('other.example.com')).to.equal(undefined);
	});

	it('reads credentials blocks from .terraformrc and terraform.d, later files winning', async () => {
		await fs.writeFile(path.join(home, '.terraformrc'), 'credentials "registry.example.com" {\n  token = "rc-token"\n}\ncredentials "old.example.com" {\n  token = "old-token"\n}\n');
		await fs.mkdir(path.join(home, '.terraform.d'));
		await fs.writeFile(path.join(home, '.terraform.d', 'credentials.tfrc.json'), JSON.stringify({ credentials: { 'registry.example.com': { token: 'json-token' }, 'json.example.com': { token: 'only-json' } } }));
		await fs.writeFile(path.join(home, '.terraform.d', 'broken.tfrc'), 'credentials "x" {');
		const provider = ambientCredentials({ env: {}, homeDir: home, platform: 'linux' });
		expect(await provider.tokenFor('registry.example.com')).to.equal('json-token');
		expect(await provider.tokenFor('old.example.com')).to.equal('old-token');
		expect(await provider.tokenFor('JSON.example.com')).to.equal('only-json');
		expect(await provider.tokenFor('missing.example.com')).to.equal(undefined);
	});

	it('prefers the environment over files and honours TF_CLI_CONFIG_FILE', async () => {
		const configured = path.join(home, 'custom.tfrc');
		await fs.writeFile(configured, 'credentials "registry.example.com" {\n  token = "custom-token"\n}\n');
		await fs.writeFile(path.join(home, '.terraformrc'), 'credentials "registry.example.com" {\n  token = "rc-token"\n}\n');
		const fromFile = ambientCredentials({ env: { TF_CLI_CONFIG_FILE: configured }, homeDir: home, platform: 'linux' });
		expect(await fromFile.tokenFor('registry.example.com')).to.equal('custom-token');
		const fromEnv = ambientCredentials({ env: { TF_CLI_CONFIG_FILE: configured, TF_TOKEN_registry_example_com: 'env-token' }, homeDir: home, platform: 'linux' });
		expect(await fromEnv.tokenFor('registry.example.com')).to.equal('env-token');
	});

	it('uses the Terragrunt registry token only for hosts that are not the public registries', async () => {
		const provider = ambientCredentials({ env: { TG_TF_REGISTRY_TOKEN: 'tg-token' }, homeDir: home, platform: 'linux' });
		expect(await provider.tokenFor('private.example.com')).to.equal('tg-token');
		expect(await provider.tokenFor('registry.terraform.io')).to.equal(undefined);
		expect(await provider.tokenFor('registry.opentofu.org')).to.equal(undefined);
		const legacy = ambientCredentials({ env: { TERRAGRUNT_TF_REGISTRY_TOKEN: 'legacy-token' }, homeDir: home, platform: 'linux' });
		expect(await legacy.tokenFor('private.example.com')).to.equal('legacy-token');
		const specific = ambientCredentials({ env: { TG_TF_REGISTRY_TOKEN: 'tg-token', TF_TOKEN_private_example_com: 'host-token' }, homeDir: home, platform: 'linux' });
		expect(await specific.tokenFor('private.example.com')).to.equal('host-token');
	});

	it('asks chained providers in order and stops at the first token', async () => {
		const asked: string[] = [];
		const provider = chainCredentials(
			{ tokenFor: async host => { asked.push(`first:${host}`); return undefined; } },
			{ tokenFor: async host => { asked.push(`second:${host}`); return 'second-token'; } },
			{ tokenFor: async host => { asked.push(`third:${host}`); return 'third-token'; } }
		);
		expect(await provider.tokenFor('registry.example.com')).to.equal('second-token');
		expect(asked).to.deep.equal(['first:registry.example.com', 'second:registry.example.com']);
	});
});
