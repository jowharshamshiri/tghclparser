import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { URI } from 'vscode-uri';

import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';

describe('current Terragrunt workspace graph', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-'));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const rejectionMessage = async (operation: Promise<unknown>): Promise<string> => {
		try {
			await operation;
			throw new Error('Expected operation to reject');
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};

	it('resolves the explicit include argument to root.hcl without a terragrunt.hcl fallback', async () => {
		const childDirectory = path.join(directory, 'production', 'app');
		await fs.mkdir(childDirectory, { recursive: true });
		const rootPath = path.join(directory, 'root.hcl');
		const childPath = path.join(childDirectory, 'terragrunt.hcl');
		await fs.writeFile(rootPath, 'locals { environment = "production" }');
		const childContent = 'include "root" { path = find_in_parent_folders("root.hcl") }';
		await fs.writeFile(childPath, childContent);

		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		await workspace.addDocument(new ParsedDocument(workspace, URI.file(childPath).toString(), childContent));
		const graph = await workspace.refreshDependencyTree();

		expect(graph?.children).to.have.length(1);
		expect(graph?.children[0].name).to.equal(path.join('production', 'app', 'terragrunt.hcl'));
		expect(graph?.children[0].children[0].name).to.equal('root.hcl');
	});

	it('models units and nested stacks before stack generation', async () => {
		const stackPath = path.join(directory, 'terragrunt.stack.hcl');
		const content = `unit "network" {
  source = "../catalog/network"
  path = "network"
}
stack "services" {
  source = "../catalog/services"
  path = "services"
}`;
		await fs.writeFile(stackPath, content);

		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		await workspace.addDocument(new ParsedDocument(workspace, URI.file(stackPath).toString(), content));
		const graph = await workspace.refreshDependencyTree();
		const stack = graph?.children.find(node => node.name === 'terragrunt.stack.hcl');

		expect(stack?.children.map(node => [node.type, node.data.parameterValue])).to.deep.equal([
			['unit', 'network'],
			['stack', 'services']
		]);
	});

	it('resolves stack dependency references and attaches them to the owning generated unit', async () => {
		const stackPath = path.join(directory, 'terragrunt.stack.hcl');
		const content = `unit "network" {
  source = "../catalog/network"
  path   = "network"
}
unit "app" {
  source = "../catalog/app"
  path   = "app"
  autoinclude {
    dependency "network" {
      config_path = unit.network.path
    }
  }
}`;
		await fs.writeFile(stackPath, content);

		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		const document = new ParsedDocument(workspace, URI.file(stackPath).toString(), content);
		await workspace.addDocument(document);
		const links = await document.getLinks();
		const graph = await workspace.refreshDependencyTree();
		const stack = graph?.children.find(node => node.name === 'terragrunt.stack.hcl');
		const app = stack?.children.find(node => node.data.parameterValue === 'app');

		expect(links).to.have.length(1);
		expect(URI.parse(links[0].target!).fsPath).to.equal(path.join(directory, '.terragrunt-stack', 'network', 'terragrunt.hcl'));
		expect(app?.children.map(node => [node.type, node.data.parameterValue])).to.deep.equal([['unit', 'network']]);
	});

	it('rejects ambiguous dependency directories instead of choosing a file type', async () => {
		const appDirectory = path.join(directory, 'app');
		const targetDirectory = path.join(directory, 'target');
		await fs.mkdir(appDirectory, { recursive: true });
		await fs.mkdir(targetDirectory, { recursive: true });
		await fs.writeFile(path.join(targetDirectory, 'terragrunt.hcl'), 'inputs = {}');
		await fs.writeFile(path.join(targetDirectory, 'terragrunt.stack.hcl'), 'unit "x" { source = "x" path = "x" }');
		const appPath = path.join(appDirectory, 'terragrunt.hcl');
		const content = 'dependency "target" { config_path = "../target" }';
		await fs.writeFile(appPath, content);

		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		const message = await rejectionMessage(workspace.addDocument(
			new ParsedDocument(workspace, URI.file(appPath).toString(), content)
		));

		expect(message).to.include('Ambiguous dependency path');
	});

	it('rejects dependency cycles when constructing the graph', async () => {
		const firstDirectory = path.join(directory, 'first');
		const secondDirectory = path.join(directory, 'second');
		await fs.mkdir(firstDirectory, { recursive: true });
		await fs.mkdir(secondDirectory, { recursive: true });
		await fs.writeFile(path.join(firstDirectory, 'terragrunt.hcl'), 'dependency "second" { config_path = "../second" }');
		await fs.writeFile(path.join(secondDirectory, 'terragrunt.hcl'), 'dependency "first" { config_path = "../first" }');

		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		const message = await rejectionMessage(workspace.refreshDependencyTree());

		expect(message).to.match(/no roots|cycle/i);
	});

	it('discovers hidden units and preserves distinct include, dependency, and reading lineage', async () => {
		const appDirectory = path.join(directory, '.platform', 'app');
		const networkDirectory = path.join(directory, 'network');
		await fs.mkdir(appDirectory, { recursive: true });
		await fs.mkdir(path.join(appDirectory, 'config', 'nested'), { recursive: true });
		await fs.mkdir(networkDirectory, { recursive: true });
		await fs.writeFile(path.join(directory, 'root.hcl'), 'locals { environment = "production" }');
		await fs.writeFile(path.join(directory, 'account-policy.json'), '{"owner":"platform"}');
		await fs.writeFile(path.join(directory, 'account.hcl'), `locals {
  account_id = "123456789012"
  policy     = mark_as_read("\${get_terragrunt_dir()}/account-policy.json")
}`);
		await fs.writeFile(path.join(appDirectory, 'policy.yaml'), 'approvals: 2');
		await fs.writeFile(path.join(appDirectory, 'config', 'direct.yaml'), 'enabled: true');
		await fs.writeFile(path.join(appDirectory, 'config', 'nested', 'service.yaml'), 'replicas: 2');
		await fs.writeFile(path.join(networkDirectory, 'terragrunt.hcl'), 'inputs = {}');
		await fs.writeFile(path.join(appDirectory, 'terragrunt.hcl'), `include "root" {
  path = find_in_parent_folders("root.hcl")
}
locals {
  account = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  policy  = mark_as_read("\${get_terragrunt_dir()}/policy.yaml")
  configs = mark_glob_as_read("\${get_terragrunt_dir()}/config/{*.yaml,**/*.yaml}")
}
dependency "network" {
  config_path = "../../network"
}`);

		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		const discovered = await workspace.findTerragruntConfigs(URI.file(directory).toString());
		const graph = await workspace.refreshDependencyTree();
		const app = graph?.children.find(node => node.name.endsWith(path.join('.platform', 'app', 'terragrunt.hcl')));
		if (!app) throw new Error('Hidden application unit is missing from the workspace graph');
		if (!app.data.reading) throw new Error('Hidden application unit has no complete reading metadata');
		const account = app.children.find(node => node.name.endsWith('account.hcl'));
		if (!account) throw new Error('Parent-discovered account configuration is missing from reading lineage');

		expect(discovered.map(uri => URI.parse(uri).fsPath)).to.include(path.join(appDirectory, 'terragrunt.hcl'));
		expect(app.children.map(node => [node.type, path.basename(node.name)])).to.deep.include.members([
			['include', 'root.hcl'],
			['dependency', 'terragrunt.hcl'],
			['read', 'account.hcl'],
			['read', 'policy.yaml']
		]);
		expect(account.data.readBy).to.deep.equal([URI.file(path.join(appDirectory, 'terragrunt.hcl')).toString()]);
		expect(app.data.reading).to.deep.equal([...app.data.reading].sort());
		expect(app.data.reading.map(uri => path.basename(URI.parse(uri).fsPath)).sort()).to.deep.equal([
			'account-policy.json',
			'account.hcl',
			'direct.yaml',
			'policy.yaml',
			'service.yaml'
		]);
		expect(account.children.map(node => [node.type, path.basename(node.name)])).to.deep.equal([
			['read', 'account-policy.json']
		]);
	});

	it('fails when an authored read target does not exist', async () => {
		const unitPath = path.join(directory, 'terragrunt.hcl');
		await fs.writeFile(unitPath, 'locals { policy = mark_as_read("${get_terragrunt_dir()}/required-policy.yaml") }');
		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());

		const message = await rejectionMessage(workspace.refreshDependencyTree());
		expect(message).to.include('mark_as_read target not found');
	});

	it('enforces an explicit mark_glob_as_read boundary before walking', async () => {
		const unitPath = path.join(directory, 'terragrunt.hcl');
		await fs.writeFile(unitPath, `locals {
  files = mark_glob_as_read("--terragrunt-boundary=.", "../*.yaml")
}`);
		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());

		const message = await rejectionMessage(workspace.refreshDependencyTree());
		expect(message).to.include('starts outside Terragrunt boundary');
	});

	it('resolves repository path functions in reading expressions', async () => {
		const unitDirectory = path.join(directory, 'live', 'app');
		await fs.mkdir(path.join(directory, '.git'));
		await fs.mkdir(unitDirectory, { recursive: true });
		await fs.writeFile(path.join(directory, 'shared.yaml'), 'owner: platform');
		await fs.writeFile(path.join(unitDirectory, 'terragrunt.hcl'), `locals {
  shared = mark_as_read("\${get_repo_root()}/shared.yaml")
}`);
		const workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());

		const graph = await workspace.refreshDependencyTree();
		const app = graph?.children.find(node => node.name.endsWith(path.join('live', 'app', 'terragrunt.hcl')));
		expect(app?.children.map(node => [node.type, path.basename(node.name)])).to.deep.equal([['read', 'shared.yaml']]);
	});
});
