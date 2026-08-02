import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { coerceToBool, coerceToString, makeBooleanValue, makeNullValue, makeNumberValue, makeStringValue } from './utils';

// Template rendering reproduces the template tokenizer and strip-marker
// semantics of the upstream template language:
//   - "%{~" / "${~" openers trim trailing whitespace from the previous literal
//   - "~}" closers trim leading whitespace from the next literal
// Literals, interpolations, and %{ if } / %{ for } directives are the only
// constructs; expressions inside ${...} and %{ ... } are parsed by a
// self-contained evaluator because bare identifiers are not part of the HCL
// expression grammar.
export async function renderTemplate(
	template: string,
	vars: RuntimeValue<ValueType>,
	context: FunctionContext
): Promise<string> {
	if (vars.type !== 'object' && vars.type !== 'block') throw new Error('Template variables must be an object');
	const tokens = tokenizeTemplate(template);
	const tree = buildTemplateTree(tokens);
	const scope = new Map<string, RuntimeValue<ValueType>>();
	for (const [key, value] of (vars.value as Map<string, RuntimeValue<ValueType>>).entries()) {
		scope.set(key, value);
	}
	return renderTemplateNodes(tree, scope, context);
}

type TemplateToken =
	| { kind: 'lit'; text: string }
	| { kind: 'interp'; expr: string }
	| { kind: 'dir'; text: string };

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

	while (index < length) {
		if (template.startsWith('%{', index)) {
			const openerTilde = template[index + 2] === '~';
			if (openerTilde && canTrimPrev) trimLastLiteral();
			const end = findClosingMarker(template, index + 2, '}');
			const inner = template.slice(index + 2, end);
			const closerTilde = inner.endsWith('~');
			tokens.push({ kind: 'dir', text: (closerTilde ? inner.slice(0, -1) : inner).trim() });
			index = end + 1;
			ltrimNext = closerTilde;
			canTrimPrev = false;
		} else if (template.startsWith('${', index)) {
			const openerTilde = template[index + 2] === '~';
			if (openerTilde && canTrimPrev) trimLastLiteral();
			const end = findClosingMarker(template, index + 2, '}');
			const inner = template.slice(index + 2, end);
			const closerTilde = inner.endsWith('~');
			tokens.push({ kind: 'interp', expr: (closerTilde ? inner.slice(0, -1) : inner).trim() });
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
	| { kind: 'interp'; expr: string }
	| { kind: 'if'; cond: string; then: TemplateNode[]; else: TemplateNode[] | null }
	| { kind: 'for'; key: string | null; val: string; coll: string; body: TemplateNode[] };

type TemplateFrame =
	| { kind: 'if'; nodes: TemplateNode[]; inElse: boolean; cond: string }
	| { kind: 'for'; nodes: TemplateNode[]; inElse: boolean; key: string | null; val: string; coll: string };

function buildTemplateTree(tokens: TemplateToken[]): TemplateNode[] {
	const root: TemplateNode[] = [];
	const stack: TemplateFrame[] = [];
	const current = (): TemplateNode[] => (stack.length > 0 ? stack[stack.length - 1].nodes : root);

	for (const token of tokens) {
		if (token.kind === 'lit') {
			current().push({ kind: 'lit', text: token.text });
		} else if (token.kind === 'interp') {
			current().push({ kind: 'interp', expr: token.expr });
		} else {
			const directive = token.text;
			if (directive.startsWith('if ')) {
				stack.push({ kind: 'if', nodes: [], inElse: false, cond: directive.slice(3).trim() });
			} else if (directive.startsWith('for ')) {
				const parsed = parseForDirective(directive.slice(4).trim());
				stack.push({ kind: 'for', nodes: [], inElse: false, key: parsed.key, val: parsed.val, coll: parsed.coll });
			} else if (directive === 'else' || directive.startsWith('else ')) {
				const frame = stack[stack.length - 1];
				if (!frame || frame.kind !== 'if') throw new Error('Template "else" without a matching "if"');
				frame.inElse = true;
			} else if (directive === 'endif') {
				const frame = stack.pop();
				if (!frame || frame.kind !== 'if') throw new Error('Template "endif" without a matching "if"');
				const node: TemplateNode = {
					kind: 'if',
					cond: frame.cond,
					then: frame.nodes,
					else: null
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

function parseForDirective(text: string): { key: string | null; val: string; coll: string } {
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
		return { key, val, coll: text.slice(index).trim() };
	}
	const inMatch = /^[\s]*in\s*/u.exec(text.slice(index));
	if (!inMatch) throw new Error(`Invalid template "for" directive: ${text}`);
	index += inMatch[0].length;
	return { key: null, val: key, coll: text.slice(index).trim() };
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
				const value = await evaluateTemplateExpression(node.expr, scope, context);
				output += coerceToString(value);
				break;
			}
			case 'if': {
				const condition = await evaluateTemplateExpression(node.cond, scope, context);
				const branch = coerceToBool(condition) ? node.then : (node.else ?? []);
				output += await renderTemplateNodes(branch, scope, context);
				break;
			}
			case 'for': {
				const collection = await evaluateTemplateExpression(node.coll, scope, context);
				for (const [key, item] of templateIterate(collection)) {
					const childScope = new Map(scope);
					if (node.key !== null) childScope.set(node.key, makeStringValue(key));
					childScope.set(node.val, item);
					output += await renderTemplateNodes(node.body, childScope, context);
				}
				break;
			}
		}
	}
	return output;
}

function templateIterate(value: RuntimeValue<ValueType>): Array<[string, RuntimeValue<ValueType>]> {
	const items: Array<[string, RuntimeValue<ValueType>]> = [];
	if (value.type === 'array') {
		(value.value as RuntimeValue<ValueType>[]).forEach((item, index) => items.push([String(index), item]));
	} else if (value.type === 'object' || value.type === 'block') {
		for (const [key, item] of (value.value as Map<string, RuntimeValue<ValueType>>).entries()) items.push([key, item]);
	} else {
		throw new Error(`Template "for" collection must be a list or object, got ${value.type}`);
	}
	return items;
}

// --- Template expression evaluator -----------------------------------------

function evaluateTemplateExpression(
	source: string,
	scope: Map<string, RuntimeValue<ValueType>>,
	context: FunctionContext
): Promise<RuntimeValue<ValueType>> {
	const parser = new TemplateExpressionParser(source);
	const expression = parser.parseExpression();
	return evaluateTemplateAst(expression, scope, context);
}

interface TExpr {
	kind: string;
	value?: unknown;
	left?: TExpr;
	right?: TExpr;
	name?: string;
	args?: TExpr[];
}

class TemplateExpressionParser {
	private index = 0;

	constructor(private readonly source: string) {}

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
		return { kind: 'ident', name };
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

	private matchNumber(): number | null {
		const match = /^[+-]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][+-]?\d+)?/u.exec(this.source.slice(this.index));
		if (!match) return null;
		this.index += match[0].length;
		return Number(match[0]);
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
			return makeNumberValue(node.value as number);
		case 'string':
			return makeStringValue(node.value as string);
		case 'bool':
			return makeBooleanValue(node.value as boolean);
		case 'null':
			return makeNullValue();
		case 'ident': {
			const value = scope.get(node.name!);
			if (value) return value;
			throw new Error(`Template reference to undefined value ${node.name}`);
		}
		case 'member': {
			const base = await evaluateTemplateAst(node.left!, scope, context);
			const name = node.value as string;
			if (base.type !== 'object' && base.type !== 'block') throw new Error(`Template member access on ${base.type}`);
			const member = (base.value as Map<string, RuntimeValue<ValueType>>).get(name);
			if (member === undefined) throw new Error(`Template member access for missing key ${name}`);
			return member;
		}
		case 'index': {
			const base = await evaluateTemplateAst(node.left!, scope, context);
			const indexValue = await evaluateTemplateAst(node.right!, scope, context);
			return templateIndex(base, indexValue);
		}
		case 'call': {
			const args = await Promise.all((node.args ?? []).map(arg => evaluateTemplateAst(arg, scope, context)));
			return context.evaluateFunction ? context.evaluateFunction(node.name!, args) : templateUnknownFunction(node.name!);
		}
		case 'unary': {
			const operand = await evaluateTemplateAst(node.left!, scope, context);
			if (node.value === '!') return makeBooleanValue(!coerceToBool(operand));
			if (node.value === '-') {
				if (operand.type !== 'number') throw new Error('Template unary minus requires a number');
				return makeNumberValue(-Number(operand.value));
			}
			throw new Error(`Unknown template unary operator ${String(node.value)}`);
		}
		case 'binary': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			const right = await evaluateTemplateAst(node.right!, scope, context);
			if (left.type !== 'number' || right.type !== 'number') throw new Error('Template arithmetic requires numbers');
			const a = Number(left.value);
			const b = Number(right.value);
			switch (node.value) {
				case '+': return makeNumberValue(a + b);
				case '-': return makeNumberValue(a - b);
				case '*': return makeNumberValue(a * b);
				case '/': return makeNumberValue(a / b);
				case '%': return makeNumberValue(a % b);
				default: throw new Error(`Unknown template binary operator ${String(node.value)}`);
			}
		}
		case 'compare': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			const right = await evaluateTemplateAst(node.right!, scope, context);
			return templateCompare(left, right, node.value as string);
		}
		case 'and': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			if (!coerceToBool(left)) return makeBooleanValue(false);
			const right = await evaluateTemplateAst(node.right!, scope, context);
			return makeBooleanValue(coerceToBool(right));
		}
		case 'or': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			if (coerceToBool(left)) return makeBooleanValue(true);
			const right = await evaluateTemplateAst(node.right!, scope, context);
			return makeBooleanValue(coerceToBool(right));
		}
		case 'coalesce': {
			const left = await evaluateTemplateAst(node.left!, scope, context);
			if (left.type !== 'null') return left;
			return evaluateTemplateAst(node.right!, scope, context);
		}
		case 'ternary': {
			const condition = await evaluateTemplateAst(node.left!, scope, context);
			return coerceToBool(condition)
				? evaluateTemplateAst(node.right!, scope, context)
				: evaluateTemplateAst(node.args![0], scope, context);
		}
		default:
			throw new Error(`Unknown template expression kind ${node.kind}`);
	}
}

function templateIndex(base: RuntimeValue<ValueType>, index: RuntimeValue<ValueType>): RuntimeValue<ValueType> {
	if (base.type === 'object' || base.type === 'block') {
		if (index.type !== 'string') throw new Error('Template object index must be a string');
		const member = (base.value as Map<string, RuntimeValue<ValueType>>).get(String(index.value));
		if (member === undefined) throw new Error(`Template object index for missing key ${String(index.value)}`);
		return member;
	}
	if (base.type === 'array') {
		if (index.type !== 'number') throw new Error('Template list index must be a number');
		const items = base.value as RuntimeValue<ValueType>[];
		const position = Number(index.value);
		if (position < 0 || position >= items.length) throw new Error('Template list index out of range');
		return items[position];
	}
	throw new Error(`Template cannot index ${base.type}`);
}

function templateCompare(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>, operator: string): RuntimeValue<'boolean'> {
	const a = templateComparisonValue(left);
	const b = templateComparisonValue(right);
	let result = false;
	switch (operator) {
		case '==': result = a === b; break;
		case '!=': result = a !== b; break;
		case '<': result = a < b; break;
		case '<=': result = a <= b; break;
		case '>': result = a > b; break;
		case '>=': result = a >= b; break;
	}
	return makeBooleanValue(result);
}

function templateComparisonValue(value: RuntimeValue<ValueType>): string | number {
	switch (value.type) {
		case 'string':
		case 'number':
		case 'boolean':
			return value.value as string | number;
		case 'null':
			return '';
		default:
			return JSON.stringify(value.value);
	}
}

function templateUnknownFunction(name: string): never {
	throw new Error(`Template function ${name} requires an evaluator context`);
}
