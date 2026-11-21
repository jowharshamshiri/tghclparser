import type { CtyNumber } from './cty-number';
import { friendlyName } from './cty-types';
import { unwrapSensitive, valueType } from './functions/utils';
import { goQuoted } from './go-quote';
import { graphemeCount } from './grapheme-clusters';
import type { RuntimeValue, ValueType } from './model';

/**
 * HCL's diagnostics as hcl v2.25.0 states and writes them: a position in a file, a range between two, a diagnostic
 * with its summary, detail, subject and context, the text HCL's DiagnosticTextWriter writes for one, and the text of
 * a set of them as a Go error, Diagnostics.Error().
 */

/**
 * A position in a file as HCL counts it: the line and column from 1, the column in grapheme clusters, as HCL's
 * scanner counts it. Where HCL counts bytes, this counts the UTF-16 code units of the file's text, which orders and
 * slices positions as bytes do.
 */
export interface HclPos {
	line: number;
	column: number;
	offset: number;
}

/** A range of a file between two positions, the end exclusive. */
export interface HclRange {
	filename: string;
	start: HclPos;
	end: HclPos;
}

/** One diagnostic: an error, as everything tghclp reports this way is. */
export interface HclDiagnostic {
	summary: string;
	detail: string;
	/** The part of the file the diagnostic is about. */
	subject?: HclRange;
	/** The expression around the subject, which the source shown takes in as well. */
	context?: HclRange;
	/**
	 * The values of the variables the diagnostic's expression reads, each `name as value` as HCL writes them after
	 * the source. HCL's diagnostic carries the expression and its scope and works these out as it writes; here they are
	 * worked out where the diagnostic is made.
	 */
	values?: string[];
	/**
	 * The top-level block the subject is in, as HCL's ContextString names it: its type and its labels in quotes, or
	 * nothing for a subject outside any block.
	 */
	block?: string;
}

/** Whether a range covers nothing. */
const isEmpty = (range: HclRange): boolean => range.start.offset === range.end.offset;

/** Whether a range holds an offset, its end excluded, as HCL's Range.ContainsOffset decides. */
const containsOffset = (range: HclRange, offset: number): boolean => offset >= range.start.offset && offset < range.end.offset;

/** Whether two ranges of one file overlap, as HCL's Range.Overlaps decides: an empty range overlaps nothing. */
function overlaps(a: HclRange, b: HclRange): boolean {
	if (isEmpty(a) || isEmpty(b)) return false;
	return containsOffset(a, b.start.offset) || containsOffset(a, b.end.offset) || containsOffset(b, a.start.offset) || containsOffset(b, a.end.offset);
}

/** The smallest range covering two, as HCL's RangeOver gives it: an empty one gives the other. */
export function rangeOver(a: HclRange, b: HclRange): HclRange {
	if (isEmpty(a)) return b;
	if (isEmpty(b)) return a;
	return {
		filename: a.filename,
		start: a.start.offset < b.start.offset ? a.start : b.start,
		end: a.end.offset > b.end.offset ? a.end : b.end
	};
}

/**
 * The position of an offset in a file's text.
 *
 * @param content the file's text.
 * @param offset the offset, in UTF-16 code units.
 */
export function hclPos(content: string, offset: number): HclPos {
	const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
	let line = 1;
	for (let index = content.indexOf('\n'); index !== -1 && index < lineStart; index = content.indexOf('\n', index + 1)) line++;
	return { line, column: graphemeCount(content.slice(lineStart, offset)) + 1, offset };
}

/** The range between two offsets of a file's text. */
export function hclRange(filename: string, content: string, start: number, end: number): HclRange {
	return { filename, start: hclPos(content, start), end: hclPos(content, end) };
}

/** A range as HCL's Range.String writes it: `file:line,column-column`, or with the end's line when it differs. */
export function rangeString(range: HclRange): string {
	return range.start.line === range.end.line
		? `${range.filename}:${range.start.line},${range.start.column}-${range.end.column}`
		: `${range.filename}:${range.start.line},${range.start.column}-${range.end.line},${range.end.column}`;
}

/** A diagnostic as a Go error, Diagnostic.Error(): `range: summary; detail`. */
export function diagnosticError(diagnostic: HclDiagnostic): string {
	const where = diagnostic.subject ? rangeString(diagnostic.subject) : '<nil>';
	return `${where}: ${diagnostic.summary}; ${diagnostic.detail}`;
}

/** Diagnostics as a Go error, Diagnostics.Error(): the first, and how many others there are. */
export function diagnosticsError(diagnostics: readonly HclDiagnostic[]): string {
	if (diagnostics.length === 0) return 'no diagnostics';
	if (diagnostics.length === 1) return diagnosticError(diagnostics[0]);
	return `${diagnosticError(diagnostics[0])}, and ${diagnostics.length - 1} other diagnostic(s)`;
}

/**
 * A diagnostic as HCL's DiagnosticTextWriter writes it without colour and without wrapping, in the pieces it writes
 * one at a time: `Error: <summary>`, where it is, each line of the source its subject and context cover, the values of
 * the variables its expression reads, and its detail, with a blank line after each part.
 *
 * @param diagnostic the diagnostic.
 * @param content the text of the file its subject is in, or undefined when that is not to hand.
 * @returns the pieces, in order; joined, they are the text, ending in a blank line.
 */
export function diagnosticWrites(diagnostic: HclDiagnostic, content: string | undefined): string[] {
	const writes = [`Error: ${diagnostic.summary}\n\n`];
	const subject = diagnostic.subject;
	if (subject) {
		let snip = diagnostic.context ? rangeOver(subject, diagnostic.context) : subject;
		if (isEmpty(snip)) snip = { ...snip, end: { ...snip.end, offset: snip.end.offset + 1, column: snip.end.column + 1 } };
		if (content === undefined) {
			writes.push(`  on ${subject.filename} line ${subject.start.line}:\n  (source code not available)\n\n`);
		} else {
			writes.push(`  on ${subject.filename} line ${subject.start.line}${diagnostic.block ? `, in ${diagnostic.block}` : ''}:\n`);
			let lineStart = 0;
			for (let line = 1; lineStart < content.length; line++) {
				const newline = content.indexOf('\n', lineStart);
				const next = newline === -1 ? content.length : newline + 1;
				// bufio.ScanLines drops the line's end, a carriage return before it included.
				let lineEnd = newline === -1 ? content.length : newline;
				if (lineEnd > lineStart && content[lineEnd - 1] === '\r') lineEnd--;
				const lineRange: HclRange = {
					filename: subject.filename,
					start: { line, column: 1, offset: lineStart },
					end: { line, column: 1, offset: lineEnd }
				};
				if (overlaps(lineRange, snip)) writes.push(`${String(line).padStart(4)}: ${content.slice(lineStart, lineEnd)}\n`);
				lineStart = next;
			}
			writes.push('\n');
		}
		const values = diagnostic.values ?? [];
		values.forEach((statement, index) => {
			writes.push(index === 0 ? 'with ' : '     ', statement, index === values.length - 1 ? '.\n\n' : ',\n');
		});
	}
	if (diagnostic.detail !== '') writes.push(`${diagnostic.detail}\n\n`);
	return writes;
}

/**
 * A diagnostic as Terragrunt logs it: each piece HCL's text writer writes cut at its line ends, and each part logged
 * as an error-level message, the empty ones left out. So `with`, each value and the punctuation after it are
 * messages of their own.
 *
 * @param diagnostic the diagnostic.
 * @param content the text of the file its subject is in.
 * @returns the messages, in order.
 */
export function diagnosticLogLines(diagnostic: HclDiagnostic, content: string | undefined): string[] {
	return diagnosticWrites(diagnostic, content).flatMap(write => write.split('\n')).filter(line => line !== '');
}

/**
 * A value in a few words, as HCL's text writer states a variable's value: null, a bool, a number to ten significant
 * digits, a string quoted as Go quotes it, a collection or tuple by its type and how many elements it has, an object
 * by how many attributes it has and the name of a lone one, and anything else by its type.
 *
 * @param value the value, not sensitive and known.
 */
export function hclValueText(value: RuntimeValue<ValueType>): string {
	const plain = unwrapSensitive(value);
	switch (plain.type) {
		case 'null':
			return 'null';
		case 'unknown':
			return '(not yet known)';
		case 'boolean':
			return plain.value ? 'true' : 'false';
		case 'number':
			return (plain.value as CtyNumber).text('g', 10);
		case 'string':
			return goQuoted(String(plain.value));
		default:
			break;
	}
	const type = valueType(plain);
	switch (type.kind) {
		case 'list':
		case 'set':
		case 'map':
		case 'tuple': {
			const size = plain.type === 'array' ? (plain.value as unknown[]).length : (plain.value as Map<string, unknown>).size;
			if (size === 0) return `empty ${friendlyName(type)}`;
			return size === 1 ? `${friendlyName(type)} with 1 element` : `${friendlyName(type)} with ${size} elements`;
		}
		case 'object': {
			const names = [...type.attributes.keys()];
			if (names.length === 0) return 'object with no attributes';
			return names.length === 1 ? `object with 1 attribute ${goQuoted(names[0])}` : `object with ${names.length} attributes`;
		}
		default:
			return friendlyName(type);
	}
}
