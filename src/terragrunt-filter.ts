/*
 * A TypeScript port of Terragrunt's filter query language (internal/filter in github.com/gruntwork-io/terragrunt,
 * MIT licence), as far as it applies to plain files: the whole grammar is parsed, so that a query is accepted or
 * refused as Terragrunt accepts or refuses it, and the path filters are evaluated.
 *
 * `terragrunt hcl format` selects the files it formats with these queries. Queries that need Terragrunt to
 * discover units first -- by name, type, dependency graph or Git history -- cannot select plain files, and
 * Terragrunt refuses them there; so does this.
 */

import { compileGlob } from './glob';
import type { Glob } from './glob';

/** A parsed filter query. */
export type FilterExpression =
	| { kind: 'path'; value: string; glob: Glob }
	| { kind: 'attribute'; key: string; value: string }
	| { kind: 'negation'; right: FilterExpression }
	| { kind: 'intersection'; left: FilterExpression; right: FilterExpression }
	| { kind: 'graph'; target: FilterExpression; dependents: GraphBound; dependencies: GraphBound; excludeTarget: boolean }
	| { kind: 'git'; from: string; to: string };

/** How far a graph query reaches in one direction. */
interface GraphBound {
	include: boolean;
	boundary: string;
	depth: number;
}

/** A filter query, with the text it was parsed from. */
export interface Filter {
	expression: FilterExpression;
	query: string;
}

/** A query that is not a valid filter. The message says what is wrong with it. */
export class FilterSyntaxError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param query the query.
	 * @param title the kind of problem.
	 * @param detail what is wrong.
	 * @param position the byte offset in the query the problem is at.
	 */
	constructor(readonly query: string, readonly title: string, readonly detail: string, readonly position: number) {
		super(`Filter "${query}" is not valid: ${title}: ${detail}`);
		this.name = 'FilterSyntaxError';
	}
}

/** A filter that cannot select plain files, because it needs Terragrunt units to have been discovered. */
export class FilterRequiresDiscoveryError extends Error {
	/**
	 * Creates the error.
	 *
	 * @param query the part of the query that needs discovery.
	 */
	constructor(readonly query: string) {
		super(`Filter query '${query}' requires discovery of Terragrunt configurations, which is not supported when evaluating filters on generic files`);
		this.name = 'FilterRequiresDiscoveryError';
	}
}

type TokenType = 'ILLEGAL' | 'EOF' | 'IDENT' | 'PATH' | '!' | '|' | '=' | '{' | '}' | '[' | ']' | '(' | ')' | '...' | '^';

interface Token {
	type: TokenType;
	/** The token's text, as UTF-8 bytes held one to a character. */
	literal: string;
	position: number;
}

const MAX_TRAVERSAL_DEPTH = 1_000_000;
const specialCharacters = '!|={}[]()^';
/** The bytes Go's `unicode.IsSpace` accepts when a byte is read as a character. */
const spaceBytes = '\t\n\v\f\r \u0085 ';
/** What Go's `strings.TrimSpace` removes from text that is valid UTF-8, here as bytes. */
const trimmable = /^(?:[\t\n\v\f\r ]|\xC2[\x85\xA0]|\xE1\x9A\x80|\xE2\x80[\x80-\x8A\xA8\xA9\xAF]|\xE2\x81\x9F|\xE3\x80\x80)+|(?:[\t\n\v\f\r ]|\xC2[\x85\xA0]|\xE1\x9A\x80|\xE2\x80[\x80-\x8A\xA8\xA9\xAF]|\xE2\x81\x9F|\xE3\x80\x80)+$/g;

/**
 * Cuts a query into tokens. Like the original, it reads the query as bytes.
 */
class Lexer {
	private position = 0;
	private afterEqual = false;

	/**
	 * Creates a lexer.
	 *
	 * @param input the query, as UTF-8 bytes held one to a character.
	 */
	constructor(private readonly input: string) {}

	/**
	 * Reads the byte at an offset.
	 *
	 * @param at the offset.
	 * @returns the byte as a character, or the empty string past the end, which a NUL in the query also reads as.
	 */
	private at(at: number): string {
		const character = this.input[at];
		return character === undefined || character === '\0' ? '' : character;
	}

	next(): Token {
		while (this.at(this.position) !== '' && spaceBytes.includes(this.at(this.position))) this.position++;
		const start = this.position;
		const character = this.at(start);
		// Most tokens end what follows an equals sign being read as an attribute's value. The original leaves that
		// in force after a few of them, and so does this, token for token.
		switch (character) {
			case '!': case '|': case '{': case '}': case '[': case ']': case '(': case ')': case '^':
				this.position++;
				this.afterEqual = false;
				return { type: character, literal: character, position: start };
			case '=':
				this.position++;
				this.afterEqual = true;
				return { type: '=', literal: '=', position: start };
			case '':
				this.afterEqual = false;
				return { type: 'EOF', literal: '', position: start };
			case '.': {
				const following = this.at(start + 1);
				if (following === '.') {
					if (this.input[start + 2] === '.') {
						this.position += 3;
						return { type: '...', literal: '...', position: start };
					}
					if (this.input[start + 2] === '/') return this.readRun('PATH', false, start);
				}
				if (following === '/') {
					this.afterEqual = false;
					return this.readRun('PATH', false, start);
				}
				if (following === '' || spaceBytes.includes(following) || specialCharacters.includes(following)) {
					// A dot on its own is the working directory.
					this.position++;
					this.afterEqual = false;
					return { type: 'PATH', literal: '.', position: start };
				}
				return this.readRun('IDENT', true, start);
			}
			case '/':
				this.afterEqual = false;
				return this.readRun('PATH', false, start);
			default:
				if (this.afterEqual) {
					// An attribute's value may hold slashes.
					this.afterEqual = false;
					return this.readRun('IDENT', false, start);
				}
				// A name with a slash in it, before anything that ends it, is a path.
				if (this.slashBeforeSpecial()) return this.readRun('PATH', false, start);
				return this.readRun('IDENT', true, start);
		}
	}

	/**
	 * Reads a run of characters up to a special character or an ellipsis, and trims the space around it.
	 *
	 * @param type the token's type.
	 * @param stopAtSlash true for a name, which a slash ends.
	 * @param start the offset the token starts at.
	 * @returns the token.
	 */
	private readRun(type: 'IDENT' | 'PATH', stopAtSlash: boolean, start: number): Token {
		for (;;) {
			const character = this.at(this.position);
			if (character === '' || specialCharacters.includes(character) || (stopAtSlash && character === '/')) break;
			if (character === '.' && this.at(this.position + 1) === '.' && this.input[this.position + 2] === '.') break;
			this.position++;
		}
		return { type, literal: this.input.slice(start, this.position).replace(trimmable, ''), position: start };
	}

	private slashBeforeSpecial(): boolean {
		for (let at = this.position; at < this.input.length; at++) {
			const character = this.at(at);
			if (character === '/') return true;
			if (character === '' || specialCharacters.includes(character)) return false;
		}
		return false;
	}
}

/** The parser found a problem; carries the position and words until the query is known. */
class ParseProblem extends Error {
	constructor(readonly title: string, readonly detail: string, readonly position: number) {
		super(detail);
	}
}

/**
 * Parses a query into an expression, as Terragrunt's recursive-descent parser does.
 */
class Parser {
	private current: Token;
	private peek: Token;
	private readonly lexer: Lexer;

	constructor(input: string) {
		this.lexer = new Lexer(input);
		this.current = this.lexer.next();
		this.peek = this.lexer.next();
	}

	private advance(): void {
		this.current = this.peek;
		this.peek = this.lexer.next();
	}

	/** The type of the current token, read afresh each time since advancing changes it. */
	private type(): TokenType {
		return this.current.type;
	}

	/** The type of the token after the current one. */
	private peekType(): TokenType {
		return this.peek.type;
	}

	private fail(title: string, detail: string, position = this.current.position): never {
		throw new ParseProblem(title, detail, position);
	}

	parse(): FilterExpression {
		const expression = this.parseExpression(false);
		if (this.type() !== 'EOF') this.fail('Unexpected token', `Unexpected '${fromBytes(this.current.literal)}' after expression`);
		return expression;
	}

	/**
	 * Parses one operand with its graph operators and, unless it is the operand of `!`, the intersections after it.
	 *
	 * @param prefixOperand true for the operand of `!`, which binds tighter than `|`.
	 * @returns the expression.
	 */
	private parseExpression(prefixOperand: boolean): FilterExpression {
		const dependents = this.parseDependentPrefix();
		let excludeTarget = false;
		if (this.type() === '^') {
			excludeTarget = true;
			this.advance();
		}

		let left: FilterExpression;
		switch (this.type()) {
			case '!':
				left = this.parseNegation();
				break;
			case 'PATH':
				left = this.pathFilter(this.current.literal);
				this.advance();
				break;
			case '{':
				left = this.parseBracedPath();
				break;
			case '[':
				left = this.parseGitFilter();
				break;
			case 'IDENT':
				if (this.peekType() === '=') {
					left = this.parseAttributeFilter();
					break;
				}
				left = this.attributeFilter('name', this.current.literal, 'name filter');
				this.advance();
				break;
			case 'ILLEGAL':
				this.fail('Illegal token', `Unrecognized character '${fromBytes(this.current.literal)}'`);
			// eslint-disable-next-line no-fallthrough -- fail() never returns
			case 'EOF':
				this.fail('Unexpected end of input', 'Expression is incomplete');
			// eslint-disable-next-line no-fallthrough -- fail() never returns
			case '|':
				this.fail('Unexpected token', 'Missing left-hand side of \'|\' operator');
			// eslint-disable-next-line no-fallthrough -- fail() never returns
			default:
				this.fail('Unexpected token', `Unexpected '${fromBytes(this.current.literal)}'`);
		}

		const dependencies = this.parseDependencySuffix();
		if (dependents.include || dependencies.include || excludeTarget) {
			left = { kind: 'graph', target: left, dependents, dependencies, excludeTarget };
		}

		while (!prefixOperand && this.type() === '|') {
			this.advance();
			let right: FilterExpression;
			try {
				// The right-hand side is one operand: intersections associate to the left.
				right = this.parseExpression(true);
			} catch (error) {
				if (!(error instanceof ParseProblem)) throw error;
				this.fail('Unexpected end of input', 'Missing right-hand side of \'|\' operator');
			}
			left = { kind: 'intersection', left, right };
		}
		return left;
	}

	/** Parses what may come before the ellipsis of a dependents query: a boundary, a depth, or nothing. */
	private parseDependentPrefix(): GraphBound {
		if (this.type() === '(') {
			const boundary = this.parseBoundary();
			if (this.type() !== '...') this.fail('Invalid boundary operand', 'A graph boundary \'(dir)\' must be followed by \'...\'');
			this.advance();
			return { include: true, boundary, depth: 0 };
		}
		if (isNumeric(this.current.literal) && this.peekType() === '...') {
			const depth = parseDepth(this.current.literal);
			this.advance();
			this.advance();
			return { include: true, boundary: '', depth };
		}
		if (this.type() === '...') {
			this.advance();
			return { include: true, boundary: '', depth: 0 };
		}
		return { include: false, boundary: '', depth: 0 };
	}

	/** Parses the ellipsis of a dependencies query and what may follow it: a boundary, a depth, or nothing. */
	private parseDependencySuffix(): GraphBound {
		if (this.type() !== '...') return { include: false, boundary: '', depth: 0 };
		this.advance();
		if (this.type() === '(') return { include: true, boundary: this.parseBoundary(), depth: 0 };
		if (isNumeric(this.current.literal)) {
			const depth = parseDepth(this.current.literal);
			this.advance();
			return { include: true, boundary: '', depth };
		}
		return { include: true, boundary: '', depth: 0 };
	}

	/** Parses a `(dir)` boundary, from its opening parenthesis to after its closing one. */
	private parseBoundary(): string {
		const open = this.current.position;
		this.advance();
		if (this.type() === ')') this.fail('Empty boundary', 'A graph boundary \'()\' cannot be empty');
		let directory = '';
		while (this.type() !== ')' && this.type() !== 'EOF') {
			directory += this.current.literal;
			this.advance();
		}
		if (this.type() !== ')') this.fail('Unclosed boundary', 'This graph boundary is missing a closing \')\'', open);
		this.advance();
		return fromBytes(directory);
	}

	/** Parses a run of `!` and its operand. An even number of them cancel out. */
	private parseNegation(): FilterExpression {
		let negations = 0;
		while (this.type() === '!') {
			negations++;
			this.advance();
		}
		let inner: FilterExpression;
		try {
			inner = this.parseExpression(true);
		} catch (error) {
			if (!(error instanceof ParseProblem)) throw error;
			this.fail('Unexpected end of input', 'Missing target expression for \'!\' operator');
		}
		return negations % 2 === 0 ? inner : { kind: 'negation', right: inner };
	}

	/** Parses `{path}`, where the path is everything up to the closing brace. */
	private parseBracedPath(): FilterExpression {
		const open = this.current.position;
		this.advance();
		if (this.type() === '}') this.fail('Empty path expression', 'Braced path expression cannot be empty');
		let value = '';
		while (this.type() !== '}' && this.type() !== 'EOF') {
			value += this.current.literal;
			this.advance();
		}
		if (this.type() !== '}') this.fail('Unclosed path expression', 'This braced path expression is missing a closing \'}\'', open);
		this.advance();
		return this.pathFilter(value);
	}

	/** Parses `key=value`. */
	private parseAttributeFilter(): FilterExpression {
		const key = fromBytes(this.current.literal);
		this.advance();
		this.advance();
		if (this.type() !== 'IDENT' && this.type() !== 'PATH') {
			this.fail('Attribute expression missing value', 'Attribute expressions require a value after \'=\'');
		}
		const value = this.current.literal;
		this.advance();
		return this.attributeFilter(key, value, `${key} filter`);
	}

	/** Parses `[ref]` or `[from...to]`. */
	private parseGitFilter(): FilterExpression {
		const open = this.current.position;
		this.advance();
		if (this.type() === ']') this.fail('Empty Git filter', 'Git filter expression cannot be empty');
		let from = '';
		let any = false;
		while (this.type() !== ']' && this.type() !== '...' && this.type() !== 'EOF') {
			from += this.current.literal;
			any = true;
			this.advance();
		}
		if (!any) this.fail('Missing Git reference', 'Expected Git reference in filter');
		if (this.type() === '...') {
			this.advance();
			let to = '';
			let anyTo = false;
			while (this.type() !== ']' && this.type() !== 'EOF') {
				to += this.current.literal;
				anyTo = true;
				this.advance();
			}
			if (!anyTo) this.fail('Missing Git reference', 'Expected second Git reference after \'...\'');
			if (this.type() !== ']') this.fail('Unclosed Git filter expression', 'This Git-based expression is missing a closing \']\'', open);
			this.advance();
			return { kind: 'git', from: fromBytes(from), to: fromBytes(to) };
		}
		if (this.type() !== ']') this.fail('Unclosed Git filter expression', 'This Git-based expression is missing a closing \']\'', open);
		this.advance();
		return { kind: 'git', from: fromBytes(from), to: 'HEAD' };
	}

	/**
	 * Builds a path filter, compiling its pattern.
	 *
	 * @param literal the path as written, in bytes.
	 * @returns the filter.
	 */
	private pathFilter(literal: string): FilterExpression {
		const value = fromBytes(literal);
		try {
			return { kind: 'path', value, glob: compileGlob(cleanPath(value)) };
		} catch (error) {
			this.fail('Invalid glob pattern', `Invalid glob pattern '${value}': ${(error as Error).message}`);
		}
	}

	/**
	 * Builds an attribute filter, compiling the pattern of the attributes that take one.
	 *
	 * @param key the attribute.
	 * @param literal its value, in bytes.
	 * @param described how a message names the filter.
	 * @returns the filter.
	 */
	private attributeFilter(key: string, literal: string, described: string): FilterExpression {
		const value = fromBytes(literal);
		if (key === 'name' || key === 'reading' || key === 'source') {
			try {
				compileGlob(key === 'reading' ? cleanPath(value) : value);
			} catch (error) {
				this.fail('Invalid glob pattern', `Invalid glob pattern in ${described}: ${(error as Error).message}`);
			}
		}
		return { kind: 'attribute', key, value };
	}
}

/**
 * Decodes UTF-8 bytes held one to a character.
 *
 * @param bytes the bytes.
 * @returns the text.
 */
function fromBytes(bytes: string): string {
	return Buffer.from(bytes, 'latin1').toString('utf8');
}

/**
 * Tells whether text is one or more ASCII digits, which next to an ellipsis is a depth rather than a name.
 *
 * @param literal the text.
 * @returns true when it is.
 */
function isNumeric(literal: string): boolean {
	return /^[0-9]+$/.test(literal);
}

/**
 * Reads a traversal depth.
 *
 * @param literal digits.
 * @returns the depth, capped at the most levels Terragrunt traverses, or 0 when the number does not fit.
 */
function parseDepth(literal: string): number {
	const depth = BigInt(literal);
	if (depth > 2n ** 63n - 1n) return 0;
	return depth > BigInt(MAX_TRAVERSAL_DEPTH) ? MAX_TRAVERSAL_DEPTH : Number(depth);
}

/**
 * Shortens a `/`-separated path without looking at the filesystem, as Go's `path.Clean` does: repeated slashes
 * and `.` elements are dropped, `..` removes the element before it, and a trailing slash goes.
 *
 * @param path the path.
 * @returns the cleaned path, `.` for an empty one.
 */
export function cleanPath(path: string): string {
	if (path === '') return '.';
	const rooted = path.startsWith('/');
	const out: string[] = [];
	for (const element of path.split('/')) {
		if (element === '' || element === '.') continue;
		if (element === '..') {
			if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
			else if (!rooted) out.push('..');
			continue;
		}
		out.push(element);
	}
	const joined = out.join('/');
	if (rooted) return `/${joined}`;
	return joined === '' ? '.' : joined;
}

/**
 * Parses a filter query.
 *
 * @param query the query, such as `./apps/** | !./apps/legacy/**`.
 * @returns the filter.
 * @throws {FilterSyntaxError} when the query is not a valid filter.
 */
export function parseFilter(query: string): Filter {
	try {
		return { expression: new Parser(Buffer.from(query, 'utf8').toString('latin1')).parse(), query };
	} catch (error) {
		if (!(error instanceof ParseProblem)) throw error;
		throw new FilterSyntaxError(query, error.title, error.detail, error.position);
	}
}

/**
 * Writes an expression the way Terragrunt names it in a message.
 *
 * @param expression the expression.
 * @returns its text.
 */
function describe(expression: FilterExpression): string {
	switch (expression.kind) {
		case 'path':
			return expression.value;
		case 'attribute':
			return `${expression.key}=${expression.value}`;
		case 'negation':
			return `!${describe(expression.right)}`;
		case 'intersection':
			return `${describe(expression.left)} | ${describe(expression.right)}`;
		case 'git':
			return `[${expression.from}...${expression.to}]`;
		case 'graph': {
			/**
			 * Writes the operand of one direction: a boundary, a depth, or nothing.
			 *
			 * @param bound the direction's bound.
			 * @returns the operand's text.
			 */
			const operand = (bound: GraphBound) => bound.boundary !== '' ? `(${bound.boundary})` : bound.depth > 0 ? String(bound.depth) : '';
			return `${expression.dependents.include ? `${operand(expression.dependents)}...` : ''}${expression.excludeTarget ? '^' : ''}${describe(expression.target)}`
				+ `${expression.dependencies.include ? `...${operand(expression.dependencies)}` : ''}`;
		}
	}
}

/**
 * Finds the part of an expression that cannot be decided from a file's path alone.
 *
 * @param expression the expression.
 * @returns that part, or undefined when the whole expression is about paths.
 */
function needsDiscovery(expression: FilterExpression): FilterExpression | undefined {
	switch (expression.kind) {
		case 'path':
			return undefined;
		case 'negation':
			return needsDiscovery(expression.right);
		case 'intersection':
			return needsDiscovery(expression.left) || needsDiscovery(expression.right) ? expression : undefined;
		default:
			return expression;
	}
}

/**
 * Tells whether a filter only takes files away: `!a`, or `!a | !b`. A filter such as `!a | b` selects, since `|`
 * narrows from left to right and what is left still has to match `b`.
 *
 * @param expression the expression.
 * @returns true when every operand is negated.
 */
function isPureNegation(expression: FilterExpression): boolean {
	if (expression.kind === 'negation') return true;
	return expression.kind === 'intersection' && isPureNegation(expression.left) && isPureNegation(expression.right);
}

/**
 * Applies filters to files, as `terragrunt hcl format` does. The filters that select are joined, so a file any of
 * them selects is kept; with none, every file is. Then each filter that only takes away removes what it rejects.
 *
 * @param filters the filters.
 * @param files absolute paths, in the platform's own form.
 * @param workingDir the absolute directory relative patterns are matched from.
 * @param separator the platform's path separator.
 * @returns the files the filters leave, in the order given.
 * @throws {FilterRequiresDiscoveryError} when a filter is about anything but paths.
 */
export function filterFiles(filters: Filter[], files: string[], workingDir: string, separator: string): string[] {
	for (const filter of filters) {
		const blocking = needsDiscovery(filter.expression);
		if (blocking) throw new FilterRequiresDiscoveryError(describe(blocking));
	}
	if (filters.length === 0) return files;

	/**
	 * Puts a path in the form patterns are written in.
	 *
	 * @param path a path in the platform's form.
	 * @returns the path with forward slashes.
	 */
	const slashed = (path: string) => separator === '/' ? path : path.split(separator).join('/');
	const base = slashed(workingDir).replace(/\/+$/, '');
	/**
	 * Evaluates an expression over files.
	 *
	 * @param expression the expression, which is about paths only.
	 * @param candidates the files to choose from.
	 * @returns the files it keeps.
	 */
	const evaluate = (expression: FilterExpression, candidates: string[]): string[] => {
		switch (expression.kind) {
			case 'path': {
				const absolute = expression.value.startsWith('/') || (separator !== '/' && /^[A-Za-z]:[\\/]/.test(expression.value));
				return candidates.filter(file => {
					const path = slashed(file);
					return expression.glob.match(absolute ? path : relativeTo(base, path));
				});
			}
			case 'negation': {
				const excluded = new Set(evaluate(expression.right, candidates));
				return candidates.filter(file => !excluded.has(file));
			}
			case 'intersection':
				return evaluate(expression.right, evaluate(expression.left, candidates));
			default:
				throw new FilterRequiresDiscoveryError(describe(expression));
		}
	};

	const selecting = filters.filter(filter => !isPureNegation(filter.expression));
	let combined = files;
	if (selecting.length > 0) {
		const selected = new Set<string>();
		for (const filter of selecting) for (const file of evaluate(filter.expression, files)) selected.add(file);
		combined = files.filter(file => selected.has(file));
	}
	const rejected = new Set<string>();
	for (const filter of filters) {
		if (!isPureNegation(filter.expression)) continue;
		const kept = new Set(evaluate(filter.expression, combined));
		for (const file of combined) if (!kept.has(file)) rejected.add(file);
	}
	return combined.filter(file => !rejected.has(file));
}

/**
 * Writes a path relative to a directory, as Go's `filepath.Rel` does for two absolute paths.
 *
 * @param base the directory, with forward slashes and no trailing one.
 * @param target the path, with forward slashes.
 * @returns the relative path, `.` when they are the same.
 */
function relativeTo(base: string, target: string): string {
	const from = base.split('/').filter(Boolean);
	const to = cleanPath(target).split('/').filter(Boolean);
	let common = 0;
	while (common < from.length && common < to.length && from[common] === to[common]) common++;
	const parts = [...from.slice(common).map(() => '..'), ...to.slice(common)];
	return parts.length === 0 ? '.' : parts.join('/');
}
