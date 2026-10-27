import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import type { CompletionItem, Position } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { ConfigEvaluator } from '../../src/Evaluator';
import { ParsedDocument } from '../../src/ParsedDocument';
import { Workspace } from '../../src/Workspace';

const cursorIn = (source: string): { text: string; position: Position } => {
	const offset = source.indexOf('<|>');
	const before = source.slice(0, offset).split('\n');
	return {
		text: source.replace('<|>', ''),
		position: { line: before.length - 1, character: before.at(-1)!.length }
	};
};

const labels = (items: CompletionItem[]) => items.map(item => item.label);

describe('reference completions while typing', () => {
	let directory: string;
	let workspace: Workspace;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-references-'));
		workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const write = async (relativePath: string, content: string): Promise<string> => {
		const filePath = path.join(directory, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
		return filePath;
	};

	const openUnit = async (content: string): Promise<ParsedDocument> => {
		const unitPath = await write(path.join('live', 'app', 'terragrunt.hcl'), content);
		const document = new ParsedDocument(workspace, URI.file(unitPath).toString(), content);
		await workspace.addDocument(document);
		return document;
	};

	const typeAndComplete = async (document: ParsedDocument, source: string): Promise<CompletionItem[]> => {
		const { text, position } = cursorIn(source);
		document.setContent(text);
		return document.getCompletionsAtPosition(position);
	};

	describe('a trailing dot', () => {
		const valid = `locals {
  config = { region = "eu-west-1", network = { cidr = "10.0.0.0/16" } }
  name   = "app"
}

inputs = {
  name   = local.name
  region = local.config.region
}`;

		it('is reported without losing hover, completion or the last parsed tree', async () => {
			const document = await openUnit(valid);

			const items = await typeAndComplete(document, valid.replace('local.config.region', 'local.config.<|>'));

			expect(document.getDiagnostics().map(diagnostic => diagnostic.message)).to.deep.equal(['Invalid attribute name: An attribute name is required after a dot.']);
			expect(labels(items)).to.deep.equal(['region', 'network']);
			expect(items[0].detail).to.equal('string');
			expect((await document.getHoverInfo({ line: 6, character: 11 }))?.value).to.contain('Local Value: name');
		});

		it('leaves the current tree empty until the text parses again', async () => {
			const document = await openUnit(valid);

			await typeAndComplete(document, valid.replace('local.config.region', 'local.config.<|>'));

			expect(document.getAST()).to.equal(null);
			expect(document.getTokens()).to.deep.equal([]);
			expect(document.getOwnInputKeys()).to.equal(undefined);
			expect(document.getEditorAST()).to.not.equal(null);

			document.setContent(valid);

			expect(document.getAST()).to.equal(document.getEditorAST());
			expect(document.getOwnInputKeys()).to.deep.equal(['name', 'region']);
		});

		it('finds hover tokens after the edit, mapped onto the last parsed text', async () => {
			const document = await openUnit(valid);

			const { text } = cursorIn(valid.replace('  name   = local.name\n', '  extra = local.config.<|>\n\n  name   = local.name\n'));
			document.setContent(text);

			expect((await document.getHoverInfo({ line: 8, character: 11 }))?.value).to.contain('Local Value: name');
			expect(await document.getHoverInfo({ line: 6, character: 23 })).to.equal(null);
		});

		it('finds definitions after the edit, with ranges moved onto the current text, and none inside it', async () => {
			const later = 'inputs = {\n  name = local.name\n}\n\nlocals {\n  name = "app"\n}';
			const document = await openUnit(later);

			document.setContent(later.replace('inputs = {\n', 'inputs = {\n  extra = local.\n'));

			expect(document.getAST()).to.equal(null);
			const [link, ...others] = await document.getDefinition({ line: 2, character: 12 });
			expect(others).to.deep.equal([]);
			expect(link.targetUri).to.equal(document.getUri());
			expect(link.originSelectionRange).to.deep.equal({ start: { line: 2, character: 9 }, end: { line: 2, character: 19 } });
			expect(link.targetSelectionRange).to.deep.equal({ start: { line: 6, character: 2 }, end: { line: 6, character: 6 } });
			expect(await document.getDefinition({ line: 1, character: 12 })).to.deep.equal([]);
		});

		it('keeps links, moved onto the current text, and drops one inside the edit', async () => {
			await write(path.join('live', 'vpc', 'terragrunt.hcl'), '');
			const linked = `${valid}\n\ndependency "vpc" {\n  config_path = "../vpc"\n}`;
			const document = await openUnit(linked);
			const vpc = URI.file(path.join(directory, 'live', 'vpc', 'terragrunt.hcl')).toString();
			expect((await document.getLinks()).map(link => [link.target, link.range.start])).to.deep.equal([[vpc, { line: 11, character: 16 }]]);

			document.setContent(linked.replace('local.config.region', 'local.config.\n'));
			expect((await document.getLinks()).map(link => [link.target, link.range.start])).to.deep.equal([[vpc, { line: 12, character: 16 }]]);

			document.setContent(linked.replace('"../vpc"\n}', '"../vpc\n}'));
			expect(await document.getLinks()).to.deep.equal([]);
		});

		it('falls back on the document it replaces, as an editor does on every edit', async () => {
			const previous = await openUnit(valid);
			const { text, position } = cursorIn(valid.replace('local.config.region', 'local.config.<|>'));

			const document = new ParsedDocument(workspace, previous.getUri(), text, previous);

			expect(document.getAST()).to.equal(null);
			expect(labels(await document.getCompletionsAtPosition(position))).to.deep.equal(['region', 'network']);
			expect((await document.getHoverInfo({ line: 6, character: 11 }))?.value).to.contain('Local Value: name');
		});

		it('has nothing to fall back on when the document never parsed', async () => {
			const document = await openUnit('locals {\n  config = { region = "eu-west-1" }\n}\n\nx = local.config.');

			expect(document.getEditorAST()).to.equal(null);
			expect(await document.getHoverInfo({ line: 4, character: 5 })).to.equal(null);
		});
	});

	describe('locals', () => {
		const locals = `locals {
  base   = { tags = { team = "platform" } }
  config = merge(local.base, { region = "eu-west-1" })
  alias  = local.config
}

`;

		it('offers the keys of an object local, through references and merge', async () => {
			const document = await openUnit(`${locals}x = local.config.region`);

			expect(labels(await typeAndComplete(document, `${locals}x = local.config.<|>`))).to.deep.equal(['tags', 'region']);
			expect(labels(await typeAndComplete(document, `${locals}x = local.alias.tags.<|>`))).to.deep.equal(['team']);
			expect(labels(await typeAndComplete(document, `${locals}x = local.config.r<|>`))).to.deep.equal(['region']);
		});

		it('offers the keys of an evaluated local read through an include, with values as details, while an edit does not parse', async () => {
			await write('root.hcl', 'locals {\n  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))\n}');
			await write(path.join('live', 'account.hcl'), 'locals {\n  aws_account_id = "123456789012"\n  aws            = { region = "eu-west-2" }\n}');
			const unit = (reference: string) => `include "root" {\n  path   = find_in_parent_folders("root.hcl")\n  expose = true\n}\n\nlocals {\n  account_vars = include.root.locals.account_vars.locals\n}\n\ninputs = {\n  id = ${reference}\n}`;
			const previous = await openUnit(unit('local.account_vars.aws_account_id'));
			const evaluator = new ConfigEvaluator({ environmentVariables: {}, terraformCommand: '', terraformCliArgs: [], workspaceTrusted: true });
			previous.setEvaluatedSpans(await evaluator.evaluatedSpans(URI.parse(previous.getUri()).fsPath, previous.getContent(), directory));

			const complete = async (reference: string) => {
				const { text, position } = cursorIn(unit(reference));
				return new ParsedDocument(workspace, previous.getUri(), text, previous).getCompletionsAtPosition(position);
			};

			expect((await complete('local.account_vars.<|>')).map(item => [item.label, item.detail])).to.deep.equal([['aws_account_id', '"123456789012"'], ['aws', 'object']]);
			expect(labels(await complete('local.account_vars.aws.<|>'))).to.deep.equal(['region']);
		});

		it('offers nothing where the shape is not an object or the local is unknown', async () => {
			const document = await openUnit(`${locals}x = local.config.region`);

			expect(await typeAndComplete(document, `${locals}x = local.config.region.<|>`)).to.deep.equal([]);
			expect(await typeAndComplete(document, `${locals}x = local.missing.<|>`)).to.deep.equal([]);
		});
	});

	describe('dependency outputs', () => {
		beforeEach(async () => {
			await write(path.join('modules', 'vpc', 'outputs.tf'), `output "vpc_id" {
  value = aws_vpc.this.id
}

output "subnets" {
  value = {
    private = aws_subnet.private[*].id
    public  = aws_subnet.public[*].id
  }
}`);
			await write(path.join('live', 'vpc', 'terragrunt.hcl'), 'terraform {\n  source = "../../modules/vpc"\n}');
		});

		const unit = (mocks: string, reference: string) => `dependency "vpc" {
  config_path = "../vpc"${mocks}
}

inputs = {
  vpc_id = ${reference}
}`;

		const mocks = `
  mock_outputs = {
    vpc_id  = "vpc-mock"
    subnets = { isolated = [] }
    extra   = { nested = "x" }
  }`;

		it('offers the outputs the module declares, nested keys of literal values, and mock outputs', async () => {
			const document = await openUnit(unit(mocks, 'dependency.vpc.outputs.vpc_id'));

			expect(labels(await typeAndComplete(document, unit(mocks, 'dependency.vpc.outputs.<|>')))).to.deep.equal(['vpc_id', 'subnets', 'extra']);
			expect(labels(await typeAndComplete(document, unit(mocks, 'dependency.vpc.outputs.subnets.<|>')))).to.deep.equal(['private', 'public', 'isolated']);
			expect(labels(await typeAndComplete(document, unit(mocks, 'dependency.vpc.outputs.extra.<|>')))).to.deep.equal(['nested']);
		});

		it('offers the module outputs alone when the dependency has no mocks', async () => {
			const document = await openUnit(unit('', 'dependency.vpc.outputs.vpc_id'));

			expect(labels(await typeAndComplete(document, unit('', 'dependency.vpc.outputs.<|>')))).to.deep.equal(['vpc_id', 'subnets']);
		});

		it('offers the mocks alone when the dependency module cannot be found', async () => {
			await fs.rm(path.join(directory, 'modules'), { recursive: true });
			const document = await openUnit(unit(mocks, 'dependency.vpc.outputs.vpc_id'));

			expect(labels(await typeAndComplete(document, unit(mocks, 'dependency.vpc.outputs.<|>')))).to.deep.equal(['vpc_id', 'subnets', 'extra']);
		});

		it('offers nothing for an undeclared dependency or a path other than outputs', async () => {
			const document = await openUnit(unit(mocks, 'dependency.vpc.outputs.vpc_id'));

			expect(await typeAndComplete(document, unit(mocks, 'dependency.db.outputs.<|>'))).to.deep.equal([]);
			expect(await typeAndComplete(document, unit(mocks, 'dependency.vpc.inputs.<|>'))).to.deep.equal([]);
		});
	});
});
