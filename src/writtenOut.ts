import type { RuntimeValue, ValueType } from './model';

interface SourceNode {
	type: string;
	value?: string | number | boolean | null;
	children?: SourceNode[];
	location?: {
		start: { offset: number };
		end: { offset: number };
	};
}

const HCL_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const HEREDOC_OPENER = /^<<-?[A-Za-z_][A-Za-z0-9_-]*\r?\n/;
const NON_VALUE_NODES = new Set(['block_comment', 'inline_comment', 'directive_comment', 'documentation_comment', 'whitespace']);

/**
 * Whether `value` is exactly what the source of `node` already spells out, so that showing it would tell a reader
 * nothing the text does not.
 *
 * A literal is written out when its source is how that value is written: `"api"`, `3`, `1.50`, `-1`, `true`,
 * `null`, a quoted string whose only escapes are the ones its value needs, a heredoc whose body is its value. An
 * array or object literal is written out when every element, key and value in it is. Anything the evaluator had
 * to work out -- a reference, a call, an operator, an interpolation, a heredoc indent it stripped -- is not, and
 * neither is a value whose type or shape differs from the literal's.
 */
export function isWrittenOut(node: SourceNode, value: RuntimeValue<ValueType>, content: string): boolean {
	if (!node.location) return false;
	const text = content.slice(node.location.start.offset, node.location.end.offset).trim();
	switch (node.type) {
		case 'array_lit': {
			if (value.type !== 'array') return false;
			const elements = valueChildren(node);
			const items = value.value as RuntimeValue<ValueType>[];
			return elements !== undefined
				&& elements.length === items.length
				&& elements.every((element, index) => isWrittenOut(element, items[index], content));
		}
		case 'object': {
			if (value.type !== 'object') return false;
			const attributes = valueChildren(node);
			const entries = value.value as Map<string, RuntimeValue<ValueType>>;
			return attributes !== undefined
				&& attributes.length === entries.size
				&& attributes.every(attribute => isWrittenOutEntry(attribute, entries, content));
		}
	}
	switch (value.type) {
		case 'string': {
			const written = value.value as string;
			if (text.startsWith('<<')) return node.type === 'string_lit' && heredocBody(text) === escapeTemplate(written);
			return text === quoted(written);
		}
		case 'number':
			return HCL_NUMBER.test(text) && Number(text) === value.value;
		case 'boolean':
			return text === String(value.value);
		case 'null':
			return text === 'null';
		default:
			return false;
	}
}

/** The children of a collection literal that hold its values, or undefined if any is not a plain value. */
function valueChildren(node: SourceNode): SourceNode[] | undefined {
	const children = (node.children ?? []).filter(child => !NON_VALUE_NODES.has(child.type));
	if (node.type === 'object' && children.some(child => child.type !== 'attribute')) return undefined;
	return children;
}

function isWrittenOutEntry(attribute: SourceNode, entries: Map<string, RuntimeValue<ValueType>>, content: string): boolean {
	const key = attribute.children?.find(child => child.type === 'attribute_identifier');
	const bound = attribute.children?.find(child => child.type !== 'attribute_identifier');
	if (!key?.location || !bound || typeof key.value !== 'string') return false;
	const keyText = content.slice(key.location.start.offset, key.location.end.offset);
	if (keyText !== key.value && keyText !== quoted(key.value)) return false;
	const entry = entries.get(key.value);
	return entry !== undefined && isWrittenOut(bound, entry, content);
}

/** The text between a heredoc's opening line and its closing marker line. */
function heredocBody(text: string): string | undefined {
	const opener = HEREDOC_OPENER.exec(text);
	if (!opener) return undefined;
	const closing = text.lastIndexOf('\n');
	if (closing < opener[0].length) return '';
	const end = text[closing - 1] === '\r' ? closing - 1 : closing;
	return text.slice(opener[0].length, end);
}

/** A template's literal text written so that it reads back as itself: `${` and `%{` doubled. */
function escapeTemplate(value: string): string {
	return value.replace(/\$\{/g, '$${').replace(/%\{/g, '%%{');
}

/** A string as a quoted HCL literal, escaping only what must be escaped. */
function quoted(value: string): string {
	const escaped = escapeTemplate(value).replace(/[\\"\n\r\t\u0000-\u001f]/g, character => {
		switch (character) {
			case '\\': return '\\\\';
			case '"': return '\\"';
			case '\n': return '\\n';
			case '\r': return '\\r';
			case '\t': return '\\t';
			default: return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
		}
	});
	return `"${escaped}"`;
}
