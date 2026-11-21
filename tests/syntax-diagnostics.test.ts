import { expect } from 'chai';

import { ParsedDocument } from '../src/ParsedDocument';
import { Workspace } from '../src/Workspace';

// What an editor shows for source Terragrunt refuses to parse. The problems are those Terragrunt v1.2.2's hcl validate
// reports for the same source.

const shown = (uri: string, content: string) => new ParsedDocument(new Workspace(), uri, content).getDiagnostics()
	.map(({ range, message, source }) => [message, source, range.start.line, range.start.character, range.end.line, range.end.character]);

describe('syntax diagnostics in the editor', () => {
	it('shows every problem in a file, not only the first', () => {
		expect(shown('file:///repo/app/terragrunt.hcl', 'inputs = {\n  smile = "\\uD83D\\uDE00"\n  bad = "\\q"\n}\n')).to.deep.equal([
			['Invalid escape sequence: Cannot encode character U+d83d in UTF-8.', 'terragrunt', 1, 11, 1, 17],
			['Invalid escape sequence: Cannot encode character U+de00 in UTF-8.', 'terragrunt', 1, 17, 1, 23],
			['Invalid escape sequence: The symbol "q" is not a valid escape sequence selector.', 'terragrunt', 2, 9, 2, 11]
		]);
	});

	it('shows the problems of the blocks after a block that failed', () => {
		expect(shown('file:///repo/app/terragrunt.hcl', 'locals {\n  a = 1 +\n}\n\nterraform {\n  source = "../modules/app"\n}\n\ninputs = {\n  z = "\\q"\n}\n')).to.deep.equal([
			['Invalid expression: Expected the start of an expression, but found an invalid expression token.', 'terragrunt', 1, 9, 2, 0],
			['Invalid escape sequence: The symbol "q" is not a valid escape sequence selector.', 'terragrunt', 9, 7, 9, 9]
		]);
	});

	it('shows a problem once for each range, as hcl validate does', () => {
		// The placeholder for ")" is refused at its own range; the one for the missing operand is at the first error's.
		expect(shown('file:///repo/app/terragrunt.hcl', 'locals {\n  b = 1 +\n  c = )\n}\n')).to.deep.equal([
			['Invalid expression: Expected the start of an expression, but found an invalid expression token.', 'terragrunt', 1, 9, 2, 0],
			['Number out of range: number is outside the supported range of 1e-4096 to 1e4096', 'terragrunt', 2, 6, 2, 7]
		]);
	});

	it('refuses an out-of-range number in a Terragrunt file, and leaves it to OpenTofu in an OpenTofu file', () => {
		const content = 'locals {\n  big = 1e5000\n}\n';
		expect(shown('file:///repo/app/terragrunt.hcl', content)).to.deep.equal([
			['Number out of range: number is outside the supported range of 1e-4096 to 1e4096', 'terragrunt', 1, 8, 1, 14]
		]);
		expect(shown('file:///repo/modules/app/main.tf', content).map(([message]) => message)).not.to.include('Number out of range: number is outside the supported range of 1e-4096 to 1e4096');
	});
});
