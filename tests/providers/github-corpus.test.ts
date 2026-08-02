import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import { ParsedDocument } from '../../src/ParsedDocument';
import { Schema } from '../../src/Schema';
import { Workspace } from '../../src/Workspace';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const corpusDirectory = path.resolve(testDirectory, '../fixtures/github-corpus');

function visit(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const child of value) visit(child, visitor);
		return;
	}
	if (!value || typeof value !== 'object') return;
	const node = value as Record<string, unknown>;
	visitor(node);
	for (const child of Object.values(node)) visit(child, visitor);
}

function authoredStructure(value: unknown): { blocks: string[]; attributes: string[]; functions: string[] } {
	const blocks: string[] = [];
	const attributes: string[] = [];
	const functions: string[] = [];
	const walk = (candidate: unknown, parentPath = 'root'): void => {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
		const node = candidate as Record<string, unknown>;
		const children = Array.isArray(node.children) ? node.children as unknown[] : [];
		let childPath = parentPath;
		if (node.type === 'block') {
			const labels = children
				.filter(child => child && typeof child === 'object' && (child as Record<string, unknown>).type === 'parameter')
				.map(child => String((child as Record<string, unknown>).value));
			childPath = `${parentPath}/${String(node.value)}${labels.map(label => `[${label}]`).join('')}`;
			blocks.push(childPath);
		}
		if (node.type === 'function_call') functions.push(String(node.value));
		if (node.type === 'root' || node.type === 'block') {
			for (const child of children) {
				if (child && typeof child === 'object' && (child as Record<string, unknown>).type === 'attribute') {
					attributes.push(`${childPath}/${String((child as Record<string, unknown>).value)}`);
				}
			}
		}
		for (const child of children) walk(child, childPath);
	};
	walk(value);
	return { blocks: blocks.sort(), attributes: attributes.sort(), functions: functions.sort() };
}

describe('GitHub-derived Terragrunt corpus', () => {
	const contents = fs.readdirSync(corpusDirectory).filter(file => file.endsWith('_content.hcl')).sort();

	it('retains the complete representative fixture set', () => {
		expect(contents).to.have.length(30);
		const lines = contents.reduce((count, file) => count + fs.readFileSync(path.join(corpusDirectory, file), 'utf8').split('\n').length, 0);
		expect(lines).to.equal(1_529);
	});

	for (const contentFile of contents) {
		const fixture = contentFile.slice(0, -'_content.hcl'.length);
		it(`preserves the authored structure for ${fixture}`, () => {
			const source = fs.readFileSync(path.join(corpusDirectory, contentFile), 'utf8');
			const expected = JSON.parse(fs.readFileSync(path.join(corpusDirectory, `${fixture}_ast.json`), 'utf8')) as unknown;
			const document = new ParsedDocument(new Workspace(), `file:///github-corpus/${fixture}/terragrunt.hcl`, source);
			expect(document.getAST(), document.getDiagnostics().map(diagnostic => diagnostic.message).join('\n')).not.to.equal(null);
			expect(authoredStructure(document.getAST())).to.deep.equal(authoredStructure(expected));
		});
	}

	it('has metadata for every function call represented by the corpus ASTs', () => {
		const functions = new Set<string>();
		for (const contentFile of contents) {
			const fixture = contentFile.slice(0, -'_content.hcl'.length);
			const ast = JSON.parse(fs.readFileSync(path.join(corpusDirectory, `${fixture}_ast.json`), 'utf8')) as unknown;
			visit(ast, node => {
				if (node.type === 'function_call' && typeof node.value === 'string') functions.add(node.value);
			});
		}
		const schema = Schema.getInstance();
		const missing = [...functions].filter(name => !schema.getFunctionDefinition(name)).sort();
		expect(missing, `Missing function metadata: ${missing.join(', ')}`).to.deep.equal([]);
	});
});
