import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';

import { cleanPath, filterFiles, FilterRequiresDiscoveryError, FilterSyntaxError, parseFilter } from '../src/terragrunt-filter';

// What a filter selects is taken from the Terragrunt binary: tests/fixtures/format-reference/filters-reference.json
// holds, for generated filter queries, whether `terragrunt hcl format --check` failed and which files it named.
// Every file in the tree the queries run over needs formatting, so the files named are the files selected.

interface FilterCase {
	queries: string[];
	/** The working directory, with `{}` for the root of the tree. */
	workingDir: string;
	failed: boolean;
	/** The files named, relative to the root of the tree. */
	selected: string[];
}

const recorded = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/format-reference/filters-reference.json'), 'utf8')) as { files: string[]; cases: FilterCase[] };

/** Where the tree is taken to be. The filters see only paths, so nothing has to exist there. */
const root = '/work';

function select(queries: string[], workingDir: string): string[] {
	const files = recorded.files.map(file => `${root}/${file}`).filter(file => file.startsWith(`${workingDir}/`) && file.endsWith('.hcl')).sort();
	return filterFiles(queries.map(parseFilter), files, workingDir, '/').map(file => file.slice(root.length + 1));
}

describe('Terragrunt filters over files', () => {
	it('selects, for generated queries, the files the Terragrunt binary selects, and refuses the queries it refuses', () => {
		expect(recorded.cases.length).to.be.greaterThan(400);
		const outcomes = { selected: 0, nothing: 0, refused: 0 };
		for (const { queries, workingDir, failed, selected: want } of recorded.cases) {
			const name = `${JSON.stringify(queries)} in ${workingDir}`;
			let selected: string[] | undefined;
			try {
				selected = select(queries.map(query => query.split('{}').join(root)), workingDir.split('{}').join(root));
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				selected = undefined;
			}
			if (want.length > 0) {
				outcomes.selected++;
				expect(selected, name).to.deep.equal(want);
			} else if (failed) {
				outcomes.refused++;
				expect(selected, `${name}: Terragrunt refuses this`).to.equal(undefined);
			} else {
				outcomes.nothing++;
				expect(selected, name).to.deep.equal([]);
			}
		}
		// The queries have to reach all three outcomes for the comparison to mean anything.
		expect(outcomes.selected).to.be.greaterThan(30);
		expect(outcomes.nothing).to.be.greaterThan(100);
		expect(outcomes.refused).to.be.greaterThan(100);
	});

	it('says what is wrong with a query that is not a filter, and where', () => {
		const error = (() => {
			try {
				parseFilter('./a.hcl |');
			} catch (caught) {
				return caught;
			}
			return undefined;
		})();
		expect(error).to.be.instanceOf(FilterSyntaxError);
		expect((error as FilterSyntaxError).title).to.equal('Unexpected end of input');
		expect((error as FilterSyntaxError).detail).to.equal('Missing right-hand side of \'|\' operator');
		expect((error as FilterSyntaxError).position).to.equal(9);
		expect((error as FilterSyntaxError).query).to.equal('./a.hcl |');
	});

	it('refuses a filter about anything but paths, which only discovering units could answer', () => {
		for (const query of ['name=a.hcl', 'a', '[main...HEAD]', './f/a | type=unit', '...{./f/a}']) {
			expect(() => select([query], `${root}/f`), query).to.throw(FilterRequiresDiscoveryError);
		}
	});

	it('takes every file when there are no filters', () => {
		expect(select([], `${root}/f/a`)).to.deep.equal(['f/a/b/c/y.hcl', 'f/a/b/x.hcl', 'f/a/terragrunt.hcl', 'f/a/x.hcl']);
	});

	it('cleans a path as Go does', () => {
		expect(cleanPath('')).to.equal('.');
		expect(cleanPath('./a//b/../c/')).to.equal('a/c');
		expect(cleanPath('../../a')).to.equal('../../a');
		expect(cleanPath('/../a')).to.equal('/a');
		expect(cleanPath('a/..')).to.equal('.');
	});
});
