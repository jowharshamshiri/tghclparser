import { expect } from 'chai';

import { escapeMarkdownText, markdownCode, markdownFence } from '../src/markdown';

describe('markdown from module text', () => {
	it('shows a description as plain text whatever markdown it contains', () => {
		expect(escapeMarkdownText('![beacon](https://attacker.example/p.gif)')).to.equal('\\!\\[beacon\\]\\(https://attacker\\.example/p\\.gif\\)');
		expect(escapeMarkdownText('# Heading\n- item')).to.equal('\\# Heading\n\\- item');
		expect(escapeMarkdownText('<img src=x onerror=alert(1)>')).to.equal('\\<img src=x onerror=alert\\(1\\)\\>');
		expect(escapeMarkdownText('a‮b​c\u0007d')).to.equal('abcd');
		expect(escapeMarkdownText('x'.repeat(2500))).to.have.length(2001);
	});

	it('wraps a value in a code span it cannot close', () => {
		expect(markdownCode('map(string)')).to.equal('`map(string)`');
		expect(markdownCode('a`b')).to.equal('``a`b``');
		expect(markdownCode('`x`')).to.equal('`` `x` ``');
		expect(markdownCode('')).to.equal('`  `');
		expect(markdownCode('one\ntwo‮')).to.equal('`one two`');
	});

	it('fences a block with more backticks than it contains', () => {
		expect(markdownFence('object({\n  a = string\n})', 'hcl')).to.equal('```hcl\nobject({\n  a = string\n})\n```');
		expect(markdownFence('```\nescape\n```', 'hcl')).to.equal('````hcl\n```\nescape\n```\n````');
	});
});
