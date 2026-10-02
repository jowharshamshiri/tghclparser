import { expect } from 'chai';

import { compareVersions, parseConstraint, parseVersion, resolveVersion, satisfies } from '../src/versions';

const version = (text: string) => {
	const parsed = parseVersion(text);
	if (!parsed) throw new Error(`${text} did not parse`);
	return parsed;
};

const matches = (candidate: string, constraint: string) => satisfies(version(candidate), parseConstraint(constraint));

describe('module versions and constraints', () => {
	it('parses versions with an optional v prefix, short segment lists, pre-releases and metadata', () => {
		expect(parseVersion('5.1.0')).to.deep.equal({ original: '5.1.0', segments: [5, 1, 0], segmentCount: 3, prerelease: [] });
		expect(parseVersion('v1.2')).to.deep.equal({ original: 'v1.2', segments: [1, 2, 0], segmentCount: 2, prerelease: [] });
		expect(parseVersion('2')).to.deep.equal({ original: '2', segments: [2, 0, 0], segmentCount: 1, prerelease: [] });
		expect(parseVersion('1.2.3.4')?.segments).to.deep.equal([1, 2, 3, 4]);
		expect(parseVersion('2.0.0-rc.1+build.7')).to.deep.equal({ original: '2.0.0-rc.1+build.7', segments: [2, 0, 0], segmentCount: 3, prerelease: ['rc', '1'] });
		expect(parseVersion('latest')).to.equal(undefined);
		expect(parseVersion('1.2.x')).to.equal(undefined);
		expect(parseVersion('')).to.equal(undefined);
	});

	it('orders versions the way SemVer does, with a release above its pre-releases', () => {
		const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1', '2'];
		for (let index = 1; index < ordered.length; index++) {
			expect(compareVersions(version(ordered[index - 1]), version(ordered[index])), `${ordered[index - 1]} < ${ordered[index]}`).to.be.lessThan(0);
			expect(compareVersions(version(ordered[index]), version(ordered[index - 1])), `${ordered[index]} > ${ordered[index - 1]}`).to.be.greaterThan(0);
		}
		expect(compareVersions(version('1.2.0'), version('v1.2'))).to.equal(0);
		expect(compareVersions(version('1.0.0+a'), version('1.0.0+b'))).to.equal(0);
	});

	it('parses comma-separated terms and rejects anything else', () => {
		expect(parseConstraint('>= 1.2, < 2.0').map(term => [term.operator, term.version.original])).to.deep.equal([['>=', '1.2'], ['<', '2.0']]);
		expect(parseConstraint('5.0.0').map(term => term.operator)).to.deep.equal(['=']);
		expect(parseConstraint('~>5.0').map(term => [term.operator, term.version.original])).to.deep.equal([['~>', '5.0']]);
		expect(parseConstraint('!= 1.0.0, = v2.0.0').map(term => term.operator)).to.deep.equal(['!=', '=']);
		expect(() => parseConstraint('')).to.throw('empty term');
		expect(() => parseConstraint('>= 1.2,')).to.throw('empty term');
		expect(() => parseConstraint('>= 1.2 < 2.0')).to.throw('not an operator followed by a version');
		expect(() => parseConstraint('=> 1.0')).to.throw('not an operator followed by a version');
		expect(() => parseConstraint('latest')).to.throw('not an operator followed by a version');
	});

	it('applies each operator', () => {
		expect(matches('1.2.3', '= 1.2.3')).to.equal(true);
		expect(matches('1.2.3', '1.2.3')).to.equal(true);
		expect(matches('1.2.4', '= 1.2.3')).to.equal(false);
		expect(matches('1.2.4', '!= 1.2.3')).to.equal(true);
		expect(matches('1.2.3', '> 1.2.3')).to.equal(false);
		expect(matches('1.2.3', '>= 1.2.3')).to.equal(true);
		expect(matches('1.2.2', '< 1.2.3')).to.equal(true);
		expect(matches('1.2.3', '<= 1.2.3')).to.equal(true);
		expect(matches('1.5.0', '>= 1.2, < 2.0')).to.equal(true);
		expect(matches('2.0.0', '>= 1.2, < 2.0')).to.equal(false);
	});

	it('applies the pessimistic operator by the segments written', () => {
		expect(matches('1.0.4', '~> 1.0.4')).to.equal(true);
		expect(matches('1.0.9', '~> 1.0.4')).to.equal(true);
		expect(matches('1.1.0', '~> 1.0.4')).to.equal(false);
		expect(matches('1.0.3', '~> 1.0.4')).to.equal(false);
		expect(matches('1.1.0', '~> 1.1')).to.equal(true);
		expect(matches('1.9.9', '~> 1.1')).to.equal(true);
		expect(matches('2.0.0', '~> 1.1')).to.equal(false);
		expect(matches('1.0.0', '~> 1.1')).to.equal(false);
		expect(matches('1.0.0', '~> 1')).to.equal(true);
		expect(matches('7.0.0', '~> 1')).to.equal(true);
		expect(matches('0.9.0', '~> 1')).to.equal(false);
	});

	it('admits a pre-release only for a term that names a pre-release of the same version', () => {
		expect(matches('5.1.0-rc.1', '~> 5.0')).to.equal(false);
		expect(matches('5.1.0-rc.1', '>= 5.0')).to.equal(false);
		expect(matches('5.1.0-rc.1', '= 5.1.0-rc.1')).to.equal(true);
		expect(matches('5.1.0-rc.2', '>= 5.1.0-rc.1')).to.equal(true);
		expect(matches('5.2.0-rc.1', '>= 5.1.0-rc.1')).to.equal(false);
		expect(matches('6.0.0', '>= 5.0.0-beta.1')).to.equal(true);
		expect(matches('5.0.0-beta.1', '~> 5.0.0-beta.1')).to.equal(true);
		expect(matches('5.0.1', '~> 5.0.0-beta.1')).to.equal(false);
	});

	it('resolves the highest version a constraint admits, and the highest release without one', () => {
		const available = ['4.9.0', '5.0.0-beta.1', '5.0.0', '5.0.1', '5.1.0-rc.1', '5.1.0', '6.0.0', 'nightly'];
		expect(resolveVersion(undefined, available)).to.equal('6.0.0');
		expect(resolveVersion('5.0.0', available)).to.equal('5.0.0');
		expect(resolveVersion('~> 5.0', available)).to.equal('5.1.0');
		expect(resolveVersion('~> 5.0.0', available)).to.equal('5.0.1');
		expect(resolveVersion('>= 4.9, < 6.0', available)).to.equal('5.1.0');
		expect(resolveVersion('>= 5.0.0-beta.1', available)).to.equal('6.0.0');
		expect(resolveVersion('= 5.1.0-rc.1', available)).to.equal('5.1.0-rc.1');
		expect(resolveVersion('~> 5.0.0-beta.1', available)).to.equal('5.0.0-beta.1');
		expect(resolveVersion('!= 6.0.0, >= 5.1', available)).to.equal('5.1.0');
		expect(resolveVersion('> 6.0.0', available)).to.equal(undefined);
		expect(resolveVersion('v5.0.1', available)).to.equal('5.0.1');
		expect(resolveVersion(undefined, ['1.0.0-rc.1', '1.0.0-rc.2'])).to.equal(undefined);
		expect(resolveVersion(undefined, [])).to.equal(undefined);
		expect(() => resolveVersion('>= 1.2 < 2.0', available)).to.throw('not an operator');
	});
});
