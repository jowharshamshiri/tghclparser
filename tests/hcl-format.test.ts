import { expect } from 'chai';

import { formatHcl, formatHclTokens } from '../src/hcl-format';
import { HclSyntaxError } from '../src/hcl-syntax';
import { unifiedDiff } from '../src/unified-diff';

// Every expected text below is the reference's own output for the source beside it, recorded from hclwrite.Format
// (github.com/hashicorp/hcl/v2 v2.25.0), which is all `terragrunt hcl format` does to a file it accepts, and from
// `terragrunt hcl format --stdin --diff` (Terragrunt 1.1.5) for the diffs. None was written by hand or taken from
// this implementation.
const layouts: { name: string; source: string; formatted: string }[] = [
	{
		name: "aligns the equals signs and trailing comments of consecutive lines",
		source: "a=1 # one\nlonger_name   =   2  // two\n\nb = 3\nc    = 4 # four\n",
		formatted: "a           = 1 # one\nlonger_name = 2 // two\n\nb = 3\nc = 4 # four\n"
	},
	{
		name: "indents by two spaces per level whatever the indentation was",
		source: "terraform {\nsource = \"../m\"\n      extra_arguments \"x\" {\n\tcommands = [\"plan\"]\n   }\n}\n",
		formatted: "terraform {\n  source = \"../m\"\n  extra_arguments \"x\" {\n    commands = [\"plan\"]\n  }\n}\n"
	},
	{
		name: "starts a new alignment group after a value that spans lines",
		source: "name = \"a\"\ntags = {\n  env = \"prod\"\n  team_name = \"x\"\n}\nregion = \"r\"\nlong_region_name = \"s\"\n",
		formatted: "name = \"a\"\ntags = {\n  env       = \"prod\"\n  team_name = \"x\"\n}\nregion           = \"r\"\nlong_region_name = \"s\"\n"
	},
	{
		name: "lays out lists and objects written across lines",
		source: "x = [\n1,\n  2,\n      3\n]\ny = { a = 1, b = [1,2,3], c = {} , d = { } }\n",
		formatted: "x = [\n  1,\n  2,\n  3\n]\ny = { a = 1, b = [1, 2, 3], c = {}, d = {} }\n"
	},
	{
		name: "keeps a function name against its parenthesis and spaces arguments",
		source: "a = f (b ,c , d...)\nb = provider :: ns :: fn ( x )\nc = merge(local.a,{ k = 1 })\n",
		formatted: "a = f(b, c, d...)\nb = provider::ns::fn(x)\nc = merge(local.a, { k = 1 })\n"
	},
	{
		name: "tells negation from subtraction",
		source: "a = -1\nb = 1 - 2\nc = 1 -2\nd = !x\ne = x ? -1 : - 2\nf = [ -1, - 2 ]\ng = a - -b\nh = (a) -b\n",
		formatted: "a = -1\nb = 1 - 2\nc = 1 - 2\nd = !x\ne = x ? -1 : -2\nf = [-1, -2]\ng = a - -b\nh = (a) - b\n"
	},
	{
		name: "keeps indexes and attribute access tight",
		source: "a = x [0]\nb = x.y [ \"k\" ] . z\nc = x [*].id\nd = x.*.id\ne = [for v in [a, b] : v]\nf = { for k, v in m : k => v if v != null }\n",
		formatted: "a = x[0]\nb = x.y[\"k\"].z\nc = x[*].id\nd = x.*.id\ne = [for v in [a, b] : v]\nf = { for k, v in m : k => v if v != null }\n"
	},
	{
		name: "changes nothing inside quoted templates except their expressions",
		source: "a = \"x ${ b } y   z\"\nb = \"${ {k=1} }\"\nc = \"${a}${ b }-%{ if x }y%{ else }z%{ endif }\"\nd = \"$${a} %%{b} $ % 100% \\\" \\\\ $$\"\ne = \"${ f( a ,b ) }\"\n",
		formatted: "a = \"x ${b} y   z\"\nb = \"${ { k = 1 } }\"\nc = \"${a}${b}-%{if x}y%{else}z%{endif}\"\nd = \"$${a} %%{b} $ % 100% \\\" \\\\ $$\"\ne = \"${f(a, b)}\"\n"
	},
	{
		name: "keeps heredoc bodies as written and formats the expressions in them",
		source: "a = <<EOT\n   keep   this  \n  ${ x  +  1 } and $${literal}\n\tEOT not the end ${\n  y\n}\nEOT\nb   =   <<-EOT\n    indented\n    EOT\nc = 1\n",
		formatted: "a = <<EOT\n   keep   this  \n  ${x + 1} and $${literal}\n\tEOT not the end ${\ny\n}\nEOT\nb = <<-EOT\n    indented\n    EOT\nc = 1\n"
	},
	{
		name: "leaves comments as written and moves only whole lines",
		source: "# top\n   // indented comment\nblock {\n# inside\n  /* multi\n     line */\n  a = 1 /* inline */ + 2\n}\n",
		formatted: "# top\n// indented comment\nblock {\n  # inside\n  /* multi\n     line */\n  a = 1 /* inline */ + 2\n}\n"
	},
	{
		name: "writes empty braces closed and spaces one-line blocks",
		source: "a { }\nb { c = 1 }\nd \"l\" \"m\" {e=2}\nf = { }\n",
		formatted: "a {}\nb { c = 1 }\nd \"l\" \"m\" { e = 2 }\nf = {}\n"
	},
	{
		name: "keeps carriage returns where they were",
		source: "a   = 1\r\nbb = {\r\nc = 2\r\n}\r\n",
		formatted: "a = 1\r\nbb = {\r\n  c = 2\r\n}\r\n"
	},
	{
		name: "replaces tabs between tokens and keeps space at the end of the source",
		source: "a\t=\t1\nb =\t[1,\t2]\n   ",
		formatted: "a = 1\nb = [1, 2]\n   "
	},
	{
		name: "drops a byte order mark",
		source: "\uFEFFa   = 1\n",
		formatted: "a = 1\n"
	},
	{
		name: "does not drift when brackets do not pair up line by line",
		source: "a = [{\n  b = 1\n}, {\n  c = 2\n}]\nd = f(g(\n  1\n), 2)\ne = [\n]]\nf = 1\n",
		formatted: "a = [{\n  b = 1\n  }, {\n  c = 2\n}]\nd = f(g(\n  1\n), 2)\ne = [\n]]\nf = 1\n"
	},
	{
		name: "measures alignment in characters as displayed, not in bytes",
		source: "é = 1\nab = 2\n\"日本語\" = 3 # c\nx = \"👍🏽\" # d\ny = \"é\" # e\n",
		formatted: "é     = 1\nab    = 2\n\"日本語\" = 3   # c\nx     = \"👍🏽\" # d\ny     = \"é\" # e\n"
	},
	{
		name: "formats source that does not parse rather than failing",
		source: "a = \nb = = 2\n) c = 3\nd = \"unterminated\ne = 1\n",
		formatted: "a   =\nb   = = 2\n) c = 3\nd   = \"unterminated\ne = 1\n"
	},
	{
		name: "spaces the operators",
		source: "a = b==c&&d!=e||f>=g\nb = c<d ? e:f\nc = a+b*c/d%e\nd = x=>y\n",
		formatted: "a = b == c && d != e || f >= g\nb = c < d ? e : f\nc = a + b * c / d % e\nd = x => y\n"
	}
];

const diffs: { name: string; source: string; formatted: string; diff: string }[] = [
	{
		name: "prints one hunk with three lines of context",
		source: "a = 1\nb = 2\nc = 3\nd = 4\ne   = 5\nf = 6\ng = 7\nh = 8\ni = 9\n",
		formatted: "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nh = 8\ni = 9\n",
		diff: "diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -2,7 +2,7 @@\n b = 2\n c = 3\n d = 4\n-e   = 5\n+e = 5\n f = 6\n g = 7\n h = 8\n"
	},
	{
		name: "splits changes that are far apart into hunks",
		source: "a   = 1\n\nb = 2\n\nc = 3\n\nd = 4\n\ne = 5\n\nf = 6\n\ng = 7\n\nh = 8\n\ni = 9\n\nj   = 10\n",
		formatted: "a = 1\n\nb = 2\n\nc = 3\n\nd = 4\n\ne = 5\n\nf = 6\n\ng = 7\n\nh = 8\n\ni = 9\n\nj = 10\n",
		diff: "diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -1,4 +1,4 @@\n-a   = 1\n+a = 1\n \n b = 2\n \n@@ -16,4 +16,4 @@\n \n i = 9\n \n-j   = 10\n+j = 10\n"
	},
	{
		name: "joins changes that are close together",
		source: "a   = 1\n\nb = 2\n\nc = 3\n\nd   = 4\n",
		formatted: "a = 1\n\nb = 2\n\nc = 3\n\nd = 4\n",
		diff: "diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -1,7 +1,7 @@\n-a   = 1\n+a = 1\n \n b = 2\n \n c = 3\n \n-d   = 4\n+d = 4\n"
	},
	{
		name: "does not pair up repeated lines around a change",
		source: "x {\n  a = 1\n}\n\ny {\n  a = 1\n    b = 2\n}\n\nz {\n  a = 1\n}\n\nw {\n  a = 1\n}\n",
		formatted: "x {\n  a = 1\n}\n\ny {\n  a = 1\n  b = 2\n}\n\nz {\n  a = 1\n}\n\nw {\n  a = 1\n}\n",
		diff: "diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -4,7 +4,7 @@\n \n y {\n   a = 1\n-    b = 2\n+  b = 2\n }\n \n z {\n"
	},
	{
		name: "marks a last line that has no line break",
		source: "a = 1\nb   = 2",
		formatted: "a = 1\nb = 2",
		diff: "diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -1,2 +1,2 @@\n a = 1\n-b   = 2\n\\ No newline at end of file\n+b = 2\n\\ No newline at end of file\n"
	},
	{
		name: "counts an added line break in the hunk header",
		source: "block {\na = 1\n  }\nlast   = [1,2]",
		formatted: "block {\n  a = 1\n}\nlast = [1, 2]",
		diff: "diff old/stdin new/stdin\n--- old/stdin\n+++ new/stdin\n@@ -1,4 +1,4 @@\n block {\n-a = 1\n-  }\n-last   = [1,2]\n\\ No newline at end of file\n+  a = 1\n+}\n+last = [1, 2]\n\\ No newline at end of file\n"
	}
];

describe('HCL formatting', () => {
	for (const layout of layouts) {
		it(layout.name, () => {
			expect(formatHclTokens(layout.source)).to.equal(layout.formatted);
		});
	}

	it('leaves formatted source exactly as it is', () => {
		for (const layout of layouts) expect(formatHclTokens(layout.formatted), layout.name).to.equal(layout.formatted);
	});

	it('changes nothing but spaces, tabs and a byte order mark', () => {
		const significant = (text: string) => text.replace(/^\u{FEFF}/u, '').replace(/[ \t]/g, '');
		for (const layout of layouts) expect(significant(formatHclTokens(layout.source)), layout.name).to.equal(significant(layout.source));
	});

	it('refuses source the HCL parser reports an error in, saying where and what in its words', () => {
		expect(() => formatHcl('inputs = {\n  a = \n}\n'))
			.to.throw(HclSyntaxError, 'line 2, column 7: Invalid expression; Expected the start of an expression, but found an invalid expression token.');
		expect(() => formatHcl('a = "unterminated\n')).to.throw(HclSyntaxError, 'line 1, column 18: Invalid multi-line string; Quoted strings may not be split over multiple lines.');
	});

	it('names the source in an error that points back at an earlier part of it', () => {
		expect(() => formatHcl('a = 1\na = 2\n', 'unit/terragrunt.hcl'))
			.to.throw(HclSyntaxError, 'line 2, column 1: Attribute redefined; The argument "a" was already set at unit/terragrunt.hcl:1,1-2. Each argument may be set only once.');
	});

	it('formats what parses the way the token formatter does', () => {
		const source = 'locals {\nname="a"\n  longer_name = [1,2]\n}\n';
		expect(formatHcl(source)).to.equal('locals {\n  name        = "a"\n  longer_name = [1, 2]\n}\n');
		expect(formatHcl(source)).to.equal(formatHclTokens(source));
	});

	// Inline functions and the pipe operator are this project's own syntax, so there is no reference output for
	// them: spacing JavaScript as HCL would break it (=== would become == =), and HCL has no |> token.
	it('keeps an inline function exactly as written and formats around it', () => {
		const declaration = [
			'function state_key(environment: string,   component: string = "app") {',
			'  const tier = environment === "prod" ? "prod" : "nonprod";',
			'\tif (a<b&&c!==d) { return `${tg.local.org}/${tier}`; }',
			'  return `${tg.local.org}/${tier}/${component}`; // }',
			'}'
		].join('\n');
		const source = `locals {\norg="acme"\n}\n\n  # helper: function of two things\n   ${declaration}\n\ninputs = {\nkey = state_key("prod","api")\n}\n`;
		expect(formatHcl(source)).to.equal(`locals {\n  org = "acme"\n}\n\n# helper: function of two things\n${declaration}\n\ninputs = {\n  key = state_key("prod", "api")\n}\n`);
	});

	it('keeps the pipe operator whole', () => {
		expect(formatHcl('inputs = {\n  name   = local.org|>upper()   |>   trimspace()\n}\n'))
			.to.equal('inputs = {\n  name = local.org |> upper() |> trimspace()\n}\n');
	});
});

describe('unified diff', () => {
	for (const example of diffs) {
		it(example.name, () => {
			expect(formatHclTokens(example.source)).to.equal(example.formatted);
			expect(unifiedDiff('old/stdin', example.source, 'new/stdin', example.formatted)).to.equal(example.diff);
		});
	}

	it('is empty for identical texts', () => {
		expect(unifiedDiff('old/a', 'a = 1\n', 'new/a', 'a = 1\n')).to.equal('');
	});
});
