import { expect } from 'chai';

import { TextChange } from '../src/text-change';

describe('text changes', () => {
	it('maps offsets before and after an insertion, and none inside it', () => {
		const change = new TextChange('a = local.x\nb = 1', 'a = local.x.\nb = 1');

		expect(change.toAfter(4, 'start')).to.equal(4);
		expect(change.toAfter(11, 'end')).to.equal(11);
		expect(change.toAfter(11, 'start')).to.equal(12);
		expect(change.toAfter(16, 'start')).to.equal(17);
		expect(change.toBefore(11, 'end')).to.equal(11);
		expect(change.toBefore(12, 'start')).to.equal(11);
	});

	it('has no counterpart for an offset inside a replaced stretch', () => {
		const change = new TextChange('x = "abc"', 'x = "aXYc"');

		expect(change.toAfter(6, 'start')).to.equal(undefined);
		expect(change.toBefore(7, 'start')).to.equal(undefined);
		expect(change.toAfter(8, 'start')).to.equal(9);
	});

	it('maps positions and ranges across lines', () => {
		const change = new TextChange('a = 1\nb = local.x\nc = 2', 'a = 1\nb = local.x.\n\nc = 2');

		expect(change.positionToBefore({ line: 3, character: 4 })).to.deep.equal({ line: 2, character: 4 });
		expect(change.positionToBefore({ line: 1, character: 4 })).to.deep.equal({ line: 1, character: 4 });
		expect(change.rangeToAfter({ start: { line: 2, character: 0 }, end: { line: 2, character: 5 } })).to.deep.equal({ start: { line: 3, character: 0 }, end: { line: 3, character: 5 } });
		expect(change.rangeToAfter({ start: { line: 1, character: 4 }, end: { line: 1, character: 11 } })).to.deep.equal({ start: { line: 1, character: 4 }, end: { line: 1, character: 11 } });
	});

	it('maps nothing away when the texts are equal', () => {
		const change = new TextChange('same', 'same');

		expect(change.toAfter(2, 'start')).to.equal(2);
		expect(change.toBefore(4, 'end')).to.equal(4);
	});
});
