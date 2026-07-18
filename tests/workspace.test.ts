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
});
