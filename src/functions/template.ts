import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { CtyNumber } from '../cty-number';
import { arithmetic, attributeValue, comparison, type ConditionalBranch, conditionalResult, conditionValue, forElements, indexValue, negation, operandBool, templatePart } from '../cty-operations';
import { ctyDynamic } from '../cty-types';
import { ArgumentError } from '../function-signature';
import { graphemeClusters } from '../grapheme-clusters';
import { isDefect } from '../unresolved';
import type { LogicalOperand } from './utils';
import { logicalOperation, makeBooleanValue, makeNullValue, makeNumberValue, makeStringValue, NULL_OPERAND, unwrapSensitive } from './utils';

/** An HCL identifier, as the scanner reads one: the names a template's variables may have. */
const templateVariableName = /^[\p{ID_Start}_][\p{ID_Continue}-]*$/u;

// Template rendering reproduces the template tokenizer and strip-marker
// semantics of the upstream template language:
//   - "%{~" / "${~" openers trim trailing whitespace from the previous literal
//   - "~}" closers trim leading whitespace from the next literal
// Literals, interpolations, and %{ if } / %{ for } directives are the only
// constructs; expressions inside ${...} and %{ ... } are parsed by a
// self-contained evaluator because bare identifiers are not part of the HCL
// expression grammar.
//
// A template that is one interpolation and nothing else gives that interpolation's value as it is, not as a string,
// as HCL wraps such a template: "${x}" with a number x renders the number.
//
// As OpenTofu's RenderTemplate: the template is parsed first, then the variables refused, as an argument error on
// `vars`, when they are not a map or object, when one's name is not an identifier, or when the template refers to
// one they lack, wherever it does, branches not taken included.
/**
 * @param template the template's source.
 * @param vars the variables, as templatefile and templatestring are given them.
 * @param context what the functions the template calls read.
 * @param filename the template file's path as templatefile was given it, which a missing variable's message names
 *   with where the template refers to it; left out for templatestring, whose message gives the name alone.
 */
export async function renderTemplate(
	template: string,
	vars: RuntimeValue<ValueType>,
	context: FunctionContext,
	filename?: string
): Promise<RuntimeValue<ValueType>> {
	const tree = buildTemplateTree(tokenizeTemplate(template));
	const given = unwrapSensitive(vars);
	if (given.type !== 'object' && given.type !== 'block') throw new ArgumentError(1, 'invalid vars value: must be a map');
	const scope = new Map<string, RuntimeValue<ValueType>>();
	for (const [key, value] of (given.value as Map<string, RuntimeValue<ValueType>>).entries()) {
		if (!templateVariableName.test(key)) {
			throw new ArgumentError(1, `invalid template variable name ${JSON.stringify(key)}: must start with a letter, followed by zero or more letters, digits, and underscores`);
		}
		scope.set(key, value);
	}
	const missing = templateReferences(tree, new Set()).find(reference => !scope.has(reference.name));
	if (missing) {
		const at = filename === undefined ? '' : `, referenced at ${filename}:${sourceRange(template, missing.offset, missing.name)}`;
		throw new ArgumentError(1, `vars map does not contain key ${JSON.stringify(missing.name)}${at}`);
	}
	const [only] = tree;
	if (tree.length === 1 && only.kind === 'interp') return evaluateTemplateAst(only.expr, scope, context);
	return makeStringValue(await renderTemplateNodes(tree, scope, context));
}

/** A variable a template refers to: its name, and where the reference starts in the template's source. */
interface TemplateReference {
	name: string;
	offset: number;
}

/**
 * The variables a template's nodes refer to, in the order of their source, as HCL's Variables finds them: a for
 * directive's key and value are no reference within its body.
 */
function templateReferences(nodes: TemplateNode[], bound: ReadonlySet<string>): TemplateReference[] {
	const free = (expression: TExpr): TemplateReference[] => expressionReferences(expression).filter(reference => !bound.has(reference.name));
	return nodes.flatMap(node => {
		switch (node.kind) {
			case 'lit': return [];
			case 'interp': return free(node.expr);
			case 'if': return [...free(node.cond), ...templateReferences(node.then, bound), ...templateReferences(node.else ?? [], bound)];
			case 'for': {
				const inner = new Set([...bound, node.val, ...(node.key === null ? [] : [node.key])]);
				return [...free(node.coll), ...templateReferences(node.body, inner)];
			}
		}
	});
}

/** The variables an expression refers to, in the order of their source. */
function expressionReferences(expression: TExpr): TemplateReference[] {
	if (expression.kind === 'ident') return [{ name: expression.name!, offset: expression.offset! }];
	const children = expression.kind === 'ternary'
		? [expression.left!, expression.right!, ...expression.args!]
		: [expression.left, expression.right, ...(expression.args ?? [])].filter((child): child is TExpr => child !== undefined);
	return children.flatMap(expressionReferences);
}

/**
 * Where a name starts in a template's source, as HCL's Range writes it on one line: the line, and the columns it
 * starts and ends at, each counted from 1 in characters.
 */
function sourceRange(template: string, offset: number, name: string): string {
	const before = template.slice(0, offset).split('\n');
	const column = graphemeClusters(before.at(-1)!).length + 1;
	return `${before.length},${column}-${column + graphemeClusters(name).length}`;
}

type TemplateToken =
	| { kind: 'lit'; text: string }
	| { kind: 'interp'; expr: string; offset: number }
	| { kind: 'dir'; text: string; offset: number };

function tokenizeTemplate(template: string): TemplateToken[] {
	const tokens: TemplateToken[] = [];
	const trimLastLiteral = (): void => {
		const previous = tokens[tokens.length - 1];
		if (previous?.kind === 'lit') previous.text = previous.text.replace(/\s+$/u, '');
	};

	let index = 0;
	let ltrimNext = false;
	let canTrimPrev = false;
	const length = template.length;
	// What a marker opened at `start` and closed at `end` holds, without its strip markers and the space around it.
	const content = (start: number, end: number): { text: string; offset: number; closerTilde: boolean } => {
		let from = template[start] === '~' ? start + 1 : start;
		const closerTilde = end > from && template[end - 1] === '~';
		let to = closerTilde ? end - 1 : end;
		while (from < to && /\s/u.test(template[from])) from++;
		while (to > from && /\s/u.test(template[to - 1])) to--;
		return { text: template.slice(from, to), offset: from, closerTilde };
	};

	while (index < length) {
		if (template.startsWith('%{', index)) {
			const openerTilde = template[index + 2] === '~';
			if (openerTilde && canTrimPrev) trimLastLiteral();
			const end = findClosingMarker(template, index + 2, '}');
			const { text, offset, closerTilde } = content(index + 2, end);
			tokens.push({ kind: 'dir', text, offset });
			index = end + 1;
			ltrimNext = closerTilde;
			canTrimPrev = false;
		} else if (template.startsWith('${', index)) {
			const openerTilde = template[index + 2] === '~';
			if (openerTilde && canTrimPrev) trimLastLiteral();
			const end = findClosingMarker(template, index + 2, '}');
			const { text, offset, closerTilde } = content(index + 2, end);
			tokens.push({ kind: 'interp', expr: text, offset });
			index = end + 1;
			ltrimNext = closerTilde;
			canTrimPrev = false;
		} else {
			let end = index;
			while (end < length && !template.startsWith('%{', end) && !template.startsWith('${', end)) end++;
			let text = template.slice(index, end);
			if (ltrimNext) text = text.replace(/^\s+/u, '');
			ltrimNext = false;
			tokens.push({ kind: 'lit', text });
			canTrimPrev = true;
			index = end;
		}
	}

	return tokens;
}

function findClosingMarker(template: string, from: number, closing: string): number {
	let index = from;
	while (index < template.length) {
		if (template[index] === '"') {
			index++;
			while (index < template.length && template[index] !== '"') {
				if (template[index] === '\\') index++;
				index++;
			}
		}
		if (template.startsWith(closing, index)) return index;
		index++;
	}
	throw new Error(`Unclosed template marker: ${closing}`);
}

type TemplateNode =
	| { kind: 'lit'; text: string }
	| { kind: 'interp'; expr: TExpr }
	| { kind: 'if'; cond: TExpr; then: TemplateNode[]; else: TemplateNode[] | null }
	| { kind: 'for'; key: string | null; val: string; coll: TExpr; body: TemplateNode[] };

type TemplateFrame =
	| { kind: 'if'; nodes: TemplateNode[]; elseNodes: TemplateNode[] | null; cond: TExpr }
	| { kind: 'for'; nodes: TemplateNode[]; key: string | null; val: string; coll: TExpr };

/** An expression of a template, parsed from its source at `offset` in the template. */
function parseTemplateExpression(source: string, offset: number): TExpr {
	return new TemplateExpressionParser(source, offset).parseExpression();
}

/** The part of a directive's text from `start` on, without the space before it, and where it starts in the template. */
function directivePart(token: { text: string; offset: number }, start: number): { source: string; offset: number } {
	const rest = token.text.slice(start);
	const source = rest.trimStart();
	return { source, offset: token.offset + start + rest.length - source.length };
}

function buildTemplateTree(tokens: TemplateToken[]): TemplateNode[] {
	const root: TemplateNode[] = [];
	const stack: TemplateFrame[] = [];
	const current = (): TemplateNode[] => {
		const frame = stack.at(-1);
		if (!frame) return root;
		return frame.kind === 'if' && frame.elseNodes !== null ? frame.elseNodes : frame.nodes;
	};

	for (const token of tokens) {
		if (token.kind === 'lit') {
			current().push({ kind: 'lit', text: token.text });
		} else if (token.kind === 'interp') {
			current().push({ kind: 'interp', expr: parseTemplateExpression(token.expr, token.offset) });
		} else {
			const directive = token.text;
			if (directive.startsWith('if ')) {
				const { source, offset } = directivePart(token, 3);
				stack.push({ kind: 'if', nodes: [], elseNodes: null, cond: parseTemplateExpression(source, offset) });
			} else if (directive.startsWith('for ')) {
				const { source, offset } = directivePart(token, 4);
				const parsed = parseForDirective(source);
				stack.push({ kind: 'for', nodes: [], key: parsed.key, val: parsed.val, coll: parseTemplateExpression(parsed.coll, offset + parsed.collOffset) });
			} else if (directive === 'else' || directive.startsWith('else ')) {
				const frame = stack[stack.length - 1];
				if (!frame || frame.kind !== 'if') throw new Error('Template "else" without a matching "if"');
				if (frame.elseNodes !== null) throw new Error('Unexpected else directive; Already in the else clause for the if');
				frame.elseNodes = [];
			} else if (directive === 'endif') {
				const frame = stack.pop();
				if (!frame || frame.kind !== 'if') throw new Error('Template "endif" without a matching "if"');
				const node: TemplateNode = {
					kind: 'if',
					cond: frame.cond,
					then: frame.nodes,
					else: frame.elseNodes
				};
				current().push(node);
			} else if (directive === 'endfor') {
				const frame = stack.pop();
				if (!frame || frame.kind !== 'for') throw new Error('Template "endfor" without a matching "for"');
				const node: TemplateNode = {
					kind: 'for',
					key: frame.key,
					val: frame.val,
					coll: frame.coll,
					body: frame.nodes
				};
				current().push(node);
			} else {
				throw new Error(`Unknown template directive: ${directive}`);
			}
		}
	}

	if (stack.length > 0) throw new Error('Unclosed template directive');
	return root;
}

/** A for directive's key and value names, and its collection's source with where it starts in the directive. */
function parseForDirective(text: string): { key: string | null; val: string; coll: string; collOffset: number } {
	let index = 0;
	const readIdentifier = (): string => {
		const match = /^[a-zA-Z_][a-zA-Z0-9_-]*/u.exec(text.slice(index));
		if (!match) throw new Error(`Invalid template "for" directive: ${text}`);
		index += match[0].length;
		return match[0];
	};
	const key = readIdentifier();
	if (text[index] === ',') {
		index++;
		const val = readIdentifier();
		const inMatch = /^[\s]*in\s*/u.exec(text.slice(index));
		if (!inMatch) throw new Error(`Invalid template "for" directive: ${text}`);
		index += inMatch[0].length;
		return { key, val, coll: text.slice(index).trim(), collOffset: index };
	}
	const inMatch = /^[\s]*in\s*/u.exec(text.slice(index));
	if (!inMatch) throw new Error(`Invalid template "for" directive: ${text}`);
	index += inMatch[0].length;
	return { key: null, val: key, coll: text.slice(index).trim(), collOffset: index };
}

async function renderTemplateNodes(
	nodes: TemplateNode[],
	scope: Map<string, RuntimeValue<ValueType>>,
	context: FunctionContext
): Promise<string> {
	let output = '';
	for (const node of nodes) {
		switch (node.kind) {
			case 'lit': {
				output += node.text;
				break;
			}
			case 'interp': {
				const value = await evaluateTemplateAst(node.expr, scope, context);
				output += templatePart(value).text;
				break;
			}
			case 'if': {
				const condition = await evaluateTemplateAst(node.cond, scope, context);
				const branch = conditionValue(condition) ? node.then : (node.else ?? []);
				output += await renderTemplateNodes(branch, scope, context);
				break;
			}
			case 'for': {
				const collection = await evaluateTemplateAst(node.coll, scope, context);
				for (const [key, item] of forElements(unwrapSensitive(collection))) {
					const childScope = new Map(scope);
					if (node.key !== null) childScope.set(node.key, key);
					childScope.set(node.val, item);
					output += await renderTemplateNodes(node.body, childScope, context);
				}
				break;
			}
		}
	}
	return output;
}

// --- Template expression evaluator -----------------------------------------

interface TExpr {
	kind: string;
	value?: unknown;
	left?: TExpr;
	right?: TExpr;
	name?: string;
	args?: TExpr[];
	/** Where an identifier starts in the template's source. */
	offset?: number;
}

class TemplateExpressionParser {
	private index = 0;

	/**
	 * @param source the expression's source.
	 * @param base where the expression starts in the template's source.
	 */
	constructor(private readonly source: string, private readonly base: number) {}

	parseExpression(): TExpr {
		const expression = this.parseTernary();
		this.skipWhitespace();
		if (this.index < this.source.length) throw new Error(`Trailing template expression characters: ${this.source.slice(this.index)}`);
		return expression;
	}

	private parseTernary(): TExpr {
		const condition = this.parseCoalesce();
		this.skipWhitespace();
		if (this.source[this.index] === '?') {
			this.index++;
			const whenTrue = this.parseTernary();
			this.skipWhitespace();
			if (this.source[this.index] !== ':') throw new Error('Template ternary missing ":"');
			this.index++;
			const whenFalse = this.parseTernary();
			return { kind: 'ternary', left: condition, right: whenTrue, args: [whenFalse] };
		}
		return condition;
	}

	private parseCoalesce(): TExpr {
		let left = this.parseOr();
		for (;;) {
			this.skipWhitespace();
			if (this.source.startsWith('??', this.index)) {
				this.index += 2;
				const right = this.parseOr();
				left = { kind: 'coalesce', left, right };
			} else {
				return left;
			}
		}
	}

	private parseOr(): TExpr {
		let left = this.parseAnd();
		for (;;) {
			this.skipWhitespace();
			if (this.source.startsWith('||', this.index)) {
				this.index += 2;
				const right = this.parseAnd();
				left = { kind: 'or', left, right };
			} else {
				return left;
			}
		}
	}

	private parseAnd(): TExpr {
		let left = this.parseComparison();
		for (;;) {
			this.skipWhitespace();
			if (this.source.startsWith('&&', this.index)) {
				this.index += 2;
				const right = this.parseComparison();
				left = { kind: 'and', left, right };
			} else {
				return left;
			}
		}
	}

	private parseComparison(): TExpr {
		let left = this.parseAdditive();
		for (;;) {
			this.skipWhitespace();
			const operator = this.matchComparisonOperator();
			if (!operator) return left;
			const right = this.parseAdditive();
			left = { kind: 'compare', value: operator, left, right };
		}
	}

	private matchComparisonOperator(): string | null {
		for (const operator of ['==', '!=', '<=', '>=', '<', '>']) {
			if (this.source.startsWith(operator, this.index)) {
				this.index += operator.length;
				return operator;
			}
		}
		return null;
	}

	private parseAdditive(): TExpr {
		let left = this.parseMultiplicative();
		for (;;) {
			this.skipWhitespace();
			const operator = this.source[this.index];
			if (operator === '+' || operator === '-') {
				this.index++;
				const right = this.parseMultiplicative();
				left = { kind: 'binary', value: operator, left, right };
			} else {
				return left;
			}
		}
	}

	private parseMultiplicative(): TExpr {
		let left = this.parseUnary();
		for (;;) {
			this.skipWhitespace();
			const operator = this.source[this.index];
			if (operator === '*' || operator === '/' || operator === '%') {
				this.index++;
				const right = this.parseUnary();
				left = { kind: 'binary', value: operator, left, right };
			} else {
				return left;
			}
		}
	}

	private parseUnary(): TExpr {
		this.skipWhitespace();
		const operator = this.source[this.index];
		if (operator === '!' || operator === '-') {
			this.index++;
			const operand = this.parseUnary();
			return { kind: 'unary', value: operator, left: operand };
		}
		return this.parsePostfix();
	}

	private parsePostfix(): TExpr {
		let expression = this.parsePrimary();
		for (;;) {
			this.skipWhitespace();
			if (this.source[this.index] === '[') {
				this.index++;
				const indexExpression = this.parseTernary();
				this.skipWhitespace();
				if (this.source[this.index] !== ']') throw new Error('Template index missing "]"');
				this.index++;
				expression = { kind: 'index', left: expression, right: indexExpression };
			} else if (this.source[this.index] === '.') {
				this.index++;
				const name = this.matchIdentifier();
				if (!name) throw new Error('Template member access missing name');
				expression = { kind: 'member', left: expression, value: name };
			} else {
				return expression;
			}
		}
	}

	private parsePrimary(): TExpr {
		this.skipWhitespace();
		if (this.source[this.index] === '(') {
			this.index++;
			const expression = this.parseTernary();
			this.skipWhitespace();
			if (this.source[this.index] !== ')') throw new Error('Template expression missing ")"');
			this.index++;
			return expression;
		}
		const number = this.matchNumber();
		if (number !== null) return { kind: 'number', value: number };
		if (this.source.startsWith('"', this.index)) return { kind: 'string', value: this.parseQuotedString() };
		if (this.source.startsWith('true', this.index)) {
			this.index += 4;
			return { kind: 'bool', value: true };
		}
		if (this.source.startsWith('false', this.index)) {
			this.index += 5;
			return { kind: 'bool', value: false };
		}
		if (this.source.startsWith('null', this.index)) {
			this.index += 4;
			return { kind: 'null' };
		}
		const start = this.index;
		const name = this.matchIdentifier();
		if (!name) throw new Error(`Unexpected template expression character: ${this.source[this.index]}`);
		this.skipWhitespace();
		if (this.source[this.index] === '(') {
			this.index++;
			const args: TExpr[] = [];
			this.skipWhitespace();
			if (this.source[this.index] === ')') {
				this.index++;
			} else {
				for (;;) {
					args.push(this.parseTernary());
					this.skipWhitespace();
					if (this.source[this.index] === ',') {
						this.index++;
					} else if (this.source[this.index] === ')') {
						this.index++;
						break;
					} else {
						throw new Error(`Template function call missing ")" for ${name}`);
					}
				}
			}
			return { kind: 'call', name, args };
		}
		return { kind: 'ident', name, offset: this.base + start };
	}

	private parseQuotedString(): string {
		this.index++; // opening quote
		let result = '';
		while (this.index < this.source.length && this.source[this.index] !== '"') {
			if (this.source[this.index] === '\\') {
				this.index++;
				const escaped = this.source[this.index];
				switch (escaped) {
					case 'n': result += '\n'; break;
					case 't': result += '\t'; break;
					case 'r': result += '\r'; break;
					default: result += escaped;
				}
				this.index++;
			} else {
				result += this.source[this.index];
				this.index++;
			}
		}
		this.index++; // closing quote
		return result;
	}

	private matchNumber(): string | null {
		const match = /^[+-]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][+-]?\d+)?/u.exec(this.source.slice(this.index));
		if (!match) return null;
		this.index += match[0].length;
		return match[0];
	}

	private matchIdentifier(): string | null {
		const match = /^[a-zA-Z_][a-zA-Z0-9_-]*/u.exec(this.source.slice(this.index));
		if (!match) return null;
		this.index += match[0].length;
		return match[0];
	}

	private skipWhitespace(): void {
		while (this.index < this.source.length && /\s/u.test(this.source[this.index])) this.index++;
	}
}

async function evaluateTemplateAst(
	node: TExpr,
	scope: Map<string, RuntimeValue<ValueType>>,
	context: FunctionContext
): Promise<RuntimeValue<ValueType>> {
	switch (node.kind) {
		case 'number':
			return makeNumberValue(CtyNumber.parse(node.value as string));
		case 'string':
			return makeStringValue(node.value as string);
		case 'bool':
			return makeBooleanValue(node.value as boolean);
		case 'null':
			return makeNullValue(ctyDynamic);
		case 'ident': {
			const value = scope.get(node.name!);
			if (value) return value;
			throw new Error(`Template reference to undefined value ${node.name}`);
		}
		case 'member': {
			const base = await evaluateTemplateAst(node.left!, scope, context);
			return attributeValue(base, node.value as string);
		}
		case 'index': {
			const base = await evaluateTemplateAst(node.left!, scope, context);
			const key = await evaluateTemplateAst(node.right!, scope, context);
			return indexValue(base, key);
		}
		case 'call': {
			const args = await Promise.all((node.args ?? []).map(arg => evaluateTemplateAst(arg, scope, context)));
			return context.evaluateFunction ? context.evaluateFunction(node.name!, args) : templateUnknownFunction(node.name!);
		}
		case 'unary': {
			const operand = await evaluateTemplateAst(node.left!, scope, context);
			if (node.value === '!') {
				const truth = operandBool(operand, 'unary');
				if (truth === null) throw new Error(NULL_OPERAND);
				return makeBooleanValue(!truth);
			}
			if (node.value === '-') return negation(operand);
			throw new Error(`Unknown template unary operator ${String(node.value)}`);
		}
		case 'binary': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			const right = await evaluateTemplateAst(node.right!, scope, context);
			return arithmetic(String(node.value), left, right);
		}
		case 'compare': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			const right = await evaluateTemplateAst(node.right!, scope, context);
			return comparison(node.value as string, left, right);
		}
		case 'and':
		case 'or': {
			// As HCL does: both operands are evaluated and must convert to a bool, and one that decides the result
			// drops what evaluating the other threw.
			const operands: LogicalOperand[] = [];
			for (const [operand, side] of [[node.left!, 'left'], [node.right!, 'right']] as const) {
				let value: RuntimeValue<ValueType>;
				try {
					value = await evaluateTemplateAst(operand, scope, context);
				} catch (error) {
					if (error instanceof Error && isDefect(error)) throw error;
					operands.push({ error });
					continue;
				}
				operands.push(operandBool(value, side));
			}
			return makeBooleanValue(logicalOperation(node.kind === 'and' ? '&&' : '||', operands[0], operands[1]));
		}
		case 'coalesce': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			if (left.type !== 'null') return left;
			return evaluateTemplateAst(node.right!, scope, context);
		}
		case 'ternary': {
			// As HCL does: both branches first, their types unified, then the condition picks one.
			const settle = async (expression: TExpr): Promise<ConditionalBranch> => {
				try {
					return { value: await evaluateTemplateAst(expression, scope, context) };
				} catch (error) {
					if (error instanceof Error && isDefect(error)) throw error;
					return { error };
				}
			};
			const whenTrue = await settle(node.right!);
			const whenFalse = await settle(node.args![0]);
			const condition = await settle(node.left!);
			return conditionalResult(whenTrue, whenFalse, () => {
				if ('error' in condition) throw condition.error;
				return { truth: conditionValue(condition.value), value: condition.value };
			});
		}
		default:
			throw new Error(`Unknown template expression kind ${node.kind}`);
	}
}

function templateUnknownFunction(name: string): never {
	throw new Error(`Template function ${name} requires an evaluator context`);
}
