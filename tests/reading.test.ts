import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import { URI } from 'vscode-uri';

import { ConfigEvaluator } from '../src/Evaluator';
import type { TerragruntConfig, TreeNode } from '../src/model';
import { Workspace } from '../src/Workspace';
import { readingCases } from './reading-cases';

// What the workspace lists each unit and stack as reading is what Terragrunt v1.2.2's discovery lists, for every
// reading function, in every block and attribute, through includes, conditionals and configurations it reads.
describe('the files a unit reads', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-reading-')));
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	for (const readingCase of readingCases) {
		it(`lists ${readingCase.name} as Terragrunt v1.2.2 does`, async () => {
			for (const [file, content] of Object.entries(readingCase.files)) {
				await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
				await fs.writeFile(path.join(directory, file), content);
			}
			const workspace = new Workspace();
			workspace.setTrusted(true);
			workspace.setWorkspaceRoot(URI.file(directory).toString());
			const graph = await workspace.refreshDependencyTree();

			// Every unit and stack, whether the graph shows it at its top or as another's dependency.
			const reading: Record<string, string[]> = {};
			const visit = (node: TreeNode<TerragruntConfig>): void => {
				const file = URI.parse(node.data.uri).fsPath;
				if ((node.type === 'root' || node.type === 'dependency') && ['terragrunt.hcl', 'terragrunt.stack.hcl'].includes(path.basename(file))) {
					reading[path.relative(directory, path.dirname(file))] = (node.data.reading ?? []).map(uri => path.relative(directory, URI.parse(uri).fsPath)).sort();
				}
				for (const child of node.children) visit(child);
			};
			for (const node of graph?.children ?? []) visit(node);
			expect(reading).to.deep.equal(readingCase.reading);
		});
	}

	// A directory is not a file fileexists can answer for, and the hashing functions open it before they fail to read
	// it, which is why they read it and fileexists does not: Terragrunt v1.2.2's messages.
	for (const [call, message] of [
		['fileexists("dir")', (dir: string) => `${JSON.stringify(dir)} is a directory, not a file`],
		['filemd5("dir")', (dir: string) => `read ${dir}: is a directory`],
		['filebase64sha512("dir")', (dir: string) => `read ${dir}: is a directory`]
	] as const) {
		it(`refuses ${call} on a directory as Terragrunt v1.2.2 does`, async () => {
			await fs.mkdir(path.join(directory, 'dir'));
			const evaluator = new ConfigEvaluator({ environmentVariables: {}, workspaceTrusted: true });
			const result = await evaluator.evaluateUnit(path.join(directory, 'terragrunt.hcl'), `locals {\n  v = ${call}\n}\n`, directory);
			expect(result.valid).to.equal(false);
			expect(result.error).to.equal(message(path.join(directory, 'dir')));
		});
	}
});
