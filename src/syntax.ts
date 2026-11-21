import { assertHclSyntax, assertTerragruntParse } from './hcl-syntax';
import { parse } from './parser';
import type { ParserTracer } from './parser';

/**
 * Parses HCL source into its syntax tree. What is valid is decided by {@link assertHclSyntax}, which applies the
 * rules of the HCL parser, so that a file is refused here exactly when that parser refuses it. The grammar then
 * builds the tree.
 *
 * @param content the source text.
 * @param grammarSource how the grammar's locations name the source, such as its URI or path.
 * @param filename the name of the source in messages that point back at an earlier part of it.
 * @param tracer receives the grammar's trace events; none are kept when omitted.
 * @returns the root node of the syntax tree.
 * @throws {HclSyntaxError} for source that is not valid HCL, with every problem the parser reports; the grammar's
 *   `SyntaxError` for valid source the grammar cannot build a tree for, which is a gap in the grammar.
 */
export function parseHclSyntax(content: string, grammarSource: string, filename: string, tracer: ParserTracer = { trace() {} }): any {
	assertHclSyntax(content, filename);
	return parse(content, { grammarSource, tracer });
}

/**
 * Parses a Terragrunt configuration file into its syntax tree. What is valid is decided by
 * {@link assertTerragruntParse}: the HCL parser's rules and the checks Terragrunt adds to them, so that a file is
 * refused here exactly when Terragrunt refuses to parse it. The grammar then builds the tree.
 *
 * @param content the source text.
 * @param grammarSource how the grammar's locations name the source, such as its URI or path.
 * @param filename the name of the source in messages that point back at an earlier part of it.
 * @param tracer receives the grammar's trace events; none are kept when omitted.
 * @returns the root node of the syntax tree.
 * @throws {HclSyntaxError} for source Terragrunt refuses to parse, with every problem it reports; the grammar's
 *   `SyntaxError` for source Terragrunt parses that the grammar cannot build a tree for, which is a gap in the grammar.
 */
export function parseTerragruntSyntax(content: string, grammarSource: string, filename: string, tracer: ParserTracer = { trace() {} }): any {
	assertTerragruntParse(content, filename);
	return parse(content, { grammarSource, tracer });
}
