import { parse } from './parser';
import type { ParserTracer } from './parser';

/**
 * Parses HCL source into its syntax tree, refusing what the HCL parser Terragrunt uses refuses: text the grammar
 * does not accept, and an argument set twice in one body, which the grammar alone lets through.
 *
 * @param content the source text.
 * @param grammarSource how locations name the source, such as its URI or path.
 * @param tracer receives the grammar's trace events; none are kept when omitted.
 * @returns the root node of the syntax tree.
 * @throws the grammar's `SyntaxError`, with its location, for text it does not accept; an `Error` naming the
 *   argument for one that is set twice.
 */
export function parseHclSyntax(content: string, grammarSource: string, tracer: ParserTracer = { trace() {} }): any {
	const ast = parse(content, { grammarSource, tracer });
	validateUniqueArguments(ast);
	return ast;
}

/**
 * Checks that no body sets the same argument twice, in the root, in blocks and in `locals`.
 *
 * @param node a syntax node.
 * @throws when an argument is set twice in one body.
 */
function validateUniqueArguments(node: any): void {
	if (node?.type !== 'root' && node?.type !== 'block' && node?.type !== 'locals_block') return;
	const names = new Set<string>();
	for (const child of node?.children ?? []) {
		if (child.type !== 'attribute' && child.type !== 'assignment') continue;
		if (child.value == null) continue;
		const name = String(child.value);
		if (names.has(name)) throw new Error(`Attribute redefined: ${name}`);
		names.add(name);
	}
	for (const child of node?.children ?? []) validateUniqueArguments(child);
}
