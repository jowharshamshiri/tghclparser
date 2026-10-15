import { expect } from 'chai';

import type { Token } from '../src/model';
import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';

const parse = (content: string) => new ParsedDocument(new Workspace(), 'file:///repo/live/app/terragrunt.hcl', content);

/** Every token of a type, as the source text its range covers. */
function covered(document: ParsedDocument, type: string): string[] {
	const lines = document.getContent().split('\n');
	const text = (token: Token) => {
		const { startPosition: start, endPosition: end } = token;
		if (start.line === end.line) return lines[start.line].slice(start.character, end.character);
		return [lines[start.line].slice(start.character), ...lines.slice(start.line + 1, end.line), lines[end.line].slice(0, end.character)].join('\n');
	};
	const found: string[] = [];
	const visit = (token: Token) => {
		if (token.type === type) found.push(text(token));
		token.children.forEach(visit);
	};
	document.getTokens().forEach(visit);
	return found;
}

describe('token ranges', () => {
	it('gives each literal part of an interpolated string the text it was written as', () => {
		const document = parse('a = "x\\ny${local.n}-${local.m}tail"\nb = <<EOT\none ${local.n}\ntwo\nEOT\n');
		expect(covered(document, 'string_lit')).to.deep.equal(['x\\ny', '-', 'tail', 'one ', '\ntwo']);
	});

	it('hovers a reference in a later interpolation of a string as it does the first', async () => {
		const document = parse('locals {\n  name = "unit"\n}\n\ninputs = {\n  title = "${local.name}-${local.name}"\n}\n');
		const first = await document.getHoverInfo({ line: 5, character: 20 });
		const second = await document.getHoverInfo({ line: 5, character: 33 });
		expect(first?.value).to.include('name');
		expect(second).to.deep.equal(first);
	});

	it('gives a block label the label alone, without the space before it', () => {
		const document = parse('dependency   "network" {\n  config_path = "../vpc"\n}\n\nlocals {\n}\n');
		expect(covered(document, 'parameter')).to.deep.equal(['"network"']);
	});
});
