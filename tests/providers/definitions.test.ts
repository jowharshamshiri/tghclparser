import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import type { LocationLink } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { ParsedDocument } from '../../src/ParsedDocument';
import { Workspace } from '../../src/Workspace';

describe('go to definition', () => {
	let directory: string;
	let workspace: Workspace;

	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-definitions-')));
		workspace = new Workspace();
		workspace.setWorkspaceRoot(URI.file(directory).toString());
		// The units the dependencies name.
		for (const unit of ['vpc', 'other', 'shared']) await write(path.join('live', unit, 'terragrunt.hcl'), '');
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	const write = async (relativePath: string, content: string): Promise<void> => {
		const file = path.join(directory, relativePath);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	};

	const openUnit = async (content: string, relativePath = path.join('live', 'app', 'terragrunt.hcl')): Promise<ParsedDocument> => {
		await write(relativePath, content);
		const document = new ParsedDocument(workspace, URI.file(path.join(directory, relativePath)).toString(), content);
		await workspace.addDocument(document);
		return document;
	};

	/** Opens a unit whose include names a file that does not exist, which adding it reports, as an editor shows it. */
	const openUnitWithMissingInclude = async (content: string): Promise<ParsedDocument> => {
		const relativePath = path.join('live', 'app', 'terragrunt.hcl');
		await write(relativePath, content);
		const document = new ParsedDocument(workspace, URI.file(path.join(directory, relativePath)).toString(), content);
		let reported: unknown;
		await workspace.addDocument(document).catch((error: unknown) => { reported = error; });
		expect(reported).to.be.instanceOf(Error).with.property('message').that.matches(/^Included configuration not found: /);
		return document;
	};

	/** The definitions of the reference ending at the last character of `reference`'s `occurrence`th appearance. */
	const definitionsOf = async (document: ParsedDocument, reference: string, occurrence = 0): Promise<LocationLink[]> => {
		const content = document.getContent();
		let offset = -1;
		for (let seen = 0; seen <= occurrence; seen++) offset = content.indexOf(reference, offset + 1);
		expect(offset, `the unit has no ${reference}`).to.be.greaterThan(-1);
		const before = content.slice(0, offset + reference.length - 1).split('\n');
		return document.getDefinition({ line: before.length - 1, character: before.at(-1)!.length });
	};

	/** Each definition as the file it is in and the text it selects there. */
	const described = async (links: LocationLink[]): Promise<[string, string][]> => Promise.all(links.map(async link => {
		const file = URI.parse(link.targetUri).fsPath;
		const lines = (await fs.readFile(file, 'utf8')).split('\n');
		const { start, end } = link.targetSelectionRange;
		const text = start.line === end.line
			? lines[start.line].slice(start.character, end.character)
			: [lines[start.line].slice(start.character), ...lines.slice(start.line + 1, end.line), lines[end.line].slice(0, end.character)].join('\n');
		return [path.relative(directory, file), text] as [string, string];
	}));

	const root = `locals {
  bucket = "state"
}

dependency "network" {
  config_path = "../vpc"
}

inputs = {
  region = "eu-central-1"
}
`;

	const include = (strategy?: string) => `include "root" {
  path = find_in_parent_folders("root.hcl")${strategy ? `\n  merge_strategy = "${strategy}"` : ''}
}`;

	it('leads a local to where this configuration\'s locals block sets it, also from inside an interpolation', async () => {
		const document = await openUnit(`locals {
  name   = "unit"
  prefix = "app"
}

inputs = {
  label = local.name
  title = "\${local.prefix}-\${local.name}"
}
`);
		expect(await described(await definitionsOf(document, 'local.name'))).to.deep.equal([['live/app/terragrunt.hcl', 'name']]);
		// The second interpolation of a string: the literal "-" between the two must not hide it.
		expect(await described(await definitionsOf(document, 'local.name', 1))).to.deep.equal([['live/app/terragrunt.hcl', 'name']]);
		const [link] = await definitionsOf(document, 'local.prefix');
		expect(link.originSelectionRange).to.deep.equal({ start: { line: 7, character: 13 }, end: { line: 7, character: 25 } });
	});

	it('finds nothing for a local that is not set, or away from a reference', async () => {
		const document = await openUnit('locals {\n  name = "unit"\n}\n\ninputs = {\n  label = local.missing\n}\n');
		expect(await definitionsOf(document, 'local.missing')).to.deep.equal([]);
		expect(await definitionsOf(document, '"unit"')).to.deep.equal([]);
	});

	it('leads include values to where the included configuration sets them', async () => {
		await write('root.hcl', root);
		const document = await openUnit(`${include()}

inputs = {
  bucket = include.root.locals.bucket
  region = include.root.inputs.region
  whole  = include.root
}
`);
		expect(await described(await definitionsOf(document, 'include.root.locals.bucket'))).to.deep.equal([['root.hcl', 'bucket']]);
		expect(await described(await definitionsOf(document, 'include.root.inputs.region'))).to.deep.equal([['root.hcl', 'region']]);
		const [whole] = await definitionsOf(document, 'include.root', 2);
		expect(whole.targetUri).to.equal(URI.file(path.join(directory, 'root.hcl')).toString());
		expect(whole.targetSelectionRange).to.deep.equal({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
	});

	it('leads an input the included configuration sets with an expression to its inputs, and finds no local it does not set', async () => {
		await write('root.hcl', 'locals {\n  bucket = "state"\n}\n\ninputs = merge({ region = "eu-central-1" }, {})\n');
		const document = await openUnit(`${include()}

inputs = {
  region = include.root.inputs.region
  other  = include.root.locals.other
}
`);
		expect(await described(await definitionsOf(document, 'include.root.inputs.region'))).to.deep.equal([['root.hcl', 'inputs']]);
		expect(await definitionsOf(document, 'include.root.locals.other')).to.deep.equal([]);
	});

	it('finds nothing through an include whose path does not resolve', async () => {
		const document = await openUnitWithMissingInclude('include "root" {\n  path = "../missing/root.hcl"\n}\n\ninputs = {\n  bucket = include.root.locals.bucket\n}\n');
		expect(await definitionsOf(document, 'include.root.locals.bucket')).to.deep.equal([]);
	});

	it('leads a dependency to the block of the configuration Terragrunt takes it from', async () => {
		await write('root.hcl', root);
		const inherited = await openUnit(`${include()}

inputs = {
  id = dependency.network.outputs.id
}
`);
		const [link] = await definitionsOf(inherited, 'dependency.network.outputs.id');
		expect(await described([link])).to.deep.equal([['root.hcl', '"network"']]);
		expect(link.originSelectionRange).to.deep.equal({ start: { line: 5, character: 7 }, end: { line: 5, character: 36 } });

		// The unit's own block wins over an include's.
		const own = await openUnit(`${include()}

dependency "network" {
  config_path = "../other"
}

inputs = {
  id = dependency.network.outputs.id
}
`, path.join('live', 'own', 'terragrunt.hcl'));
		expect(await described(await definitionsOf(own, 'dependency.network.outputs.id'))).to.deep.equal([['live/own/terragrunt.hcl', '"network"']]);
	});

	it('does not take a dependency from an include Terragrunt does not merge', async () => {
		await write('root.hcl', root);
		const document = await openUnit(`${include('no_merge')}

inputs = {
  id = dependency.network.outputs.id
}
`);
		expect(await definitionsOf(document, 'dependency.network.outputs.id')).to.deep.equal([]);
	});

	it('takes a dependency from the sibling autoinclude over the unit', async () => {
		await write(path.join('live', 'app', 'terragrunt.autoinclude.hcl'), 'dependency "network" {\n  config_path = "../shared"\n}\n');
		const document = await openUnit('dependency "network" {\n  config_path = "../vpc"\n}\n\ninputs = {\n  id = dependency.network.outputs.id\n}\n');
		expect(await described(await definitionsOf(document, 'dependency.network.outputs.id'))).to.deep.equal([['live/app/terragrunt.autoinclude.hcl', '"network"']]);
	});

	it('looks only at the unit\'s own dependency blocks while what it merges cannot be determined', async () => {
		const document = await openUnitWithMissingInclude(`include "root" {
  path = "../missing/root.hcl"
}

dependency "network" {
  config_path = "../vpc"
}

inputs = {
  id = dependency.network.outputs.id
}
`);
		expect(await described(await definitionsOf(document, 'dependency.network.outputs.id'))).to.deep.equal([['live/app/terragrunt.hcl', '"network"']]);
	});
});
