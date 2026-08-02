import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { expandTerragruntGlob } from './terragrunt_glob';
import {
	convertToRuntimeValue,
	makeNullValue,
	makeSensitiveValue,
	runtimeToPlain,
	unwrapSensitive
} from './utils';

function requireArgument(args: RuntimeValue<ValueType>[], index: number, name: string): RuntimeValue<ValueType> {
	const argument = args[index];
	if (!argument) throw new Error(`${name} requires argument ${index + 1}`);
	return argument;
}

function stringArgument(args: RuntimeValue<ValueType>[], index: number, name: string): string {
	const argument = requireArgument(args, index, name);
	if (argument.type !== 'string') throw new Error(`${name} argument ${index + 1} must be a string`);
	return String(argument.value);
}

function numberArgument(args: RuntimeValue<ValueType>[], index: number, name: string): number {
	const argument = requireArgument(args, index, name);
	if (argument.type !== 'number') throw new Error(`${name} argument ${index + 1} must be a number`);
	return Number(argument.value);
}

function arrayArgument(args: RuntimeValue<ValueType>[], index: number, name: string): RuntimeValue<ValueType>[] {
	const argument = requireArgument(args, index, name);
	if (argument.type !== 'array' || !Array.isArray(argument.value)) throw new Error(`${name} argument ${index + 1} must be a list`);
	return argument.value;
}

function objectArgument(args: RuntimeValue<ValueType>[], index: number, name: string): Map<string, RuntimeValue<ValueType>> {
	const argument = requireArgument(args, index, name);
	if (argument.type !== 'object' || !(argument.value instanceof Map)) throw new Error(`${name} argument ${index + 1} must be an object`);
	return argument.value;
}

const stringValue = (value: string): RuntimeValue<'string'> => ({ type: 'string', value });
const numberValue = (value: number): RuntimeValue<'number'> => ({ type: 'number', value });
const booleanValue = (value: boolean): RuntimeValue<'boolean'> => ({ type: 'boolean', value });
const arrayValue = (value: RuntimeValue<ValueType>[]): RuntimeValue<'array'> => ({ type: 'array', value });
const objectValue = (value: Map<string, RuntimeValue<ValueType>>): RuntimeValue<'object'> => ({ type: 'object', value });

function hash(name: 'md5' | 'sha1' | 'sha256' | 'sha512', value: string): RuntimeValue<'string'> {
	return stringValue(createHash(name).update(value, 'utf8').digest('hex'));
}

function valueEquals(left: RuntimeValue<ValueType>, right: RuntimeValue<ValueType>): boolean {
	const plainLeft = runtimeToPlain(unwrapSensitive(left));
	const plainRight = runtimeToPlain(unwrapSensitive(right));
	if (plainLeft === plainRight) return true;
	if (typeof plainLeft === 'object' && typeof plainRight === 'object') {
		return JSON.stringify(plainLeft) === JSON.stringify(plainRight);
	}
	return false;
}

function sortRuntimeList(items: RuntimeValue<ValueType>[]): RuntimeValue<ValueType>[] {
	const allNumbers = items.every(item => item.type === 'number');
	const sorted = [...items];
	if (allNumbers) {
		sorted.sort((left, right) => Number(left.value) - Number(right.value));
	} else {
		sorted.sort((left, right) => String(left.value).localeCompare(String(right.value)));
	}
	return sorted;
}

// Go-compatible formatting for a single format string.
function goFormat(format: string, args: RuntimeValue<ValueType>[]): string {
	let output = '';
	let argumentIndex = 0;
	for (let index = 0; index < format.length;) {
		if (format[index] !== '%') {
			output += format[index];
			index++;
			continue;
		}
		index++;
		if (format[index] === '%') {
			output += '%';
			index++;
			continue;
		}
		let width = 0;
		let zeroPad = false;
		let precision = -1;
		while (format[index] === '0' || format[index] === '-' || format[index] === '+') {
			if (format[index] === '0') zeroPad = true;
			index++;
		}
		const widthStart = index;
		while (index < format.length && /[0-9]/u.test(format[index])) index++;
		if (index > widthStart) width = parseInt(format.slice(widthStart, index), 10);
		if (format[index] === '.') {
			index++;
			const precisionStart = index;
			while (index < format.length && /[0-9]/u.test(format[index])) index++;
			if (index > precisionStart) precision = parseInt(format.slice(precisionStart, index), 10);
		}
		const verb = format[index];
		index++;
		const argument = args[argumentIndex];
		argumentIndex++;
		let rendered: string;
		switch (verb) {
			case 's':
				rendered = argument === undefined ? '' : String(argument.value);
				break;
			case 'd':
				rendered = String(Math.trunc(Number(argument.value)));
				if (zeroPad) rendered = rendered.padStart(width, '0');
				break;
			case 'f':
				rendered = precision >= 0 ? Number(argument.value).toFixed(precision) : String(Number(argument.value));
				break;
			case 'v':
				rendered = JSON.stringify(runtimeToPlain(argument));
				break;
			default:
				rendered = argument === undefined ? '' : String(argument.value);
		}
		if (!zeroPad && width > 0 && rendered.length < width) rendered = rendered.padStart(width, ' ');
		output += rendered;
	}
	return output;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidv5(namespace: string, name: string): string {
	const namespaces: Record<string, string> = {
		dns: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
		url: '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
		oid: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
		x500: '6ba7b814-9dad-11d1-80b4-00c04fd430c8'
	};
	const namespaceBytes = (namespaces[namespace] ?? namespace).replace(/-/g, '');
	const source = Buffer.from(namespaceBytes, 'hex');
	const digest = createHash('sha1').update(source).update(name, 'utf8').digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ipToInteger(ip: string): number {
	const octets = ip.split('.').map(octet => Number.parseInt(octet, 10));
	if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet) || octet < 0 || octet > 255)) {
		throw new Error(`Invalid IPv4 address: ${ip}`);
	}
	return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipFromInteger(value: number): string {
	const unsigned = value >>> 0;
	return `${(unsigned >>> 24) & 0xff}.${(unsigned >>> 16) & 0xff}.${(unsigned >>> 8) & 0xff}.${unsigned & 0xff}`;
}

function parseCidr(cidr: string): { network: number; prefix: number } {
	const [ip, prefixText] = cidr.split('/');
	const prefix = Number.parseInt(prefixText, 10);
	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid CIDR prefix: ${cidr}`);
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return { network: ipToInteger(ip) & mask, prefix };
}

function convertPatternGroups(pattern: string): string {
	return pattern.replace(/\(\?P<([a-zA-Z0-9_]+)>/g, '(?<$1>');
}

function groupNames(pattern: string): string[] {
	const names: string[] = [];
	const converted = convertPatternGroups(pattern);
	const source = converted.replace(/\\\(/g, '');
	const regex = /\(\?<([a-zA-Z0-9_]+)>/gu;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(source)) !== null) names.push(match[1]);
	return names;
}

function regexMatch(pattern: string, value: string): RuntimeValue<ValueType> {
	const converted = convertPatternGroups(pattern);
	const expression = new RegExp(converted);
	const match = expression.exec(value);
	if (!match) throw new Error(`Regex ${pattern} did not match ${JSON.stringify(value)}`);
	const names = groupNames(converted);
	if (names.length > 0) {
		const map = new Map<string, RuntimeValue<ValueType>>();
		for (const name of names) map.set(name, stringValue(match.groups?.[name] ?? ''));
		return objectValue(map);
	}
	const groupCount = expression.source.includes('(') ? match.length - 1 : 0;
	if (groupCount > 0) return arrayValue([...match.slice(1)].map(g => stringValue(g ?? '')));
	return stringValue(match[0]);
}

function regexAll(pattern: string, value: string): RuntimeValue<'array'> {
	const converted = convertPatternGroups(pattern);
	const expression = new RegExp(converted, 'g');
	const names = groupNames(converted);
	const results: RuntimeValue<ValueType>[] = [];
	let match: RegExpExecArray | null;
	while ((match = expression.exec(value)) !== null) {
		if (match[0] === '') expression.lastIndex++;
		if (names.length > 0) {
			const map = new Map<string, RuntimeValue<ValueType>>();
			for (const name of names) map.set(name, stringValue(match.groups?.[name] ?? ''));
			results.push(objectValue(map));
		} else if (match.length > 1) {
			results.push(arrayValue([...match.slice(1)].map(g => stringValue(g ?? ''))));
		} else {
			results.push(stringValue(match[0]));
		}
	}
	return arrayValue(results);
}

function csvDecode(content: string): RuntimeValue<'array'> {
	const rows = content.replace(/\r\n/g, '\n').split('\n');
	const header: string[] = [];
	const body: string[] = [];
	let parsingHeader = true;
	for (const rawRow of rows) {
		if (parsingHeader) {
			const cells = parseCsvRow(rawRow);
			if (cells.length === 0 || cells.every(cell => cell === '')) continue;
			header.push(...cells);
			parsingHeader = false;
			continue;
		}
		body.push(rawRow);
	}
	if (header.length === 0) return arrayValue([]);
	const records: RuntimeValue<ValueType>[] = [];
	for (const rawRow of body) {
		if (rawRow.trim() === '') continue;
		const cells = parseCsvRow(rawRow);
		const map = new Map<string, RuntimeValue<ValueType>>();
		header.forEach((key, index) => {
			map.set(key, stringValue(cells[index] ?? ''));
		});
		records.push(objectValue(map));
	}
	return arrayValue(records);
}

function parseCsvRow(row: string): string[] {
	const cells: string[] = [];
	let current = '';
	let quoted = false;
	for (let index = 0; index < row.length; index++) {
		const char = row[index];
		if (quoted) {
			if (char === '"') {
				if (row[index + 1] === '"') {
					current += '"';
					index++;
				} else {
					quoted = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			cells.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	cells.push(current);
	return cells;
}

export const builtinFunctionGroup = {
	namespace: 'opentofu',
	functions: {
		abspath: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => stringValue(path.resolve(context.workingDirectory, stringArgument(args, 0, 'abspath'))),
		abs: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.abs(numberArgument(args, 0, 'abs'))),
		basename: async (args: RuntimeValue<ValueType>[]) => stringValue(path.basename(stringArgument(args, 0, 'basename'))),
		base64decode: async (args: RuntimeValue<ValueType>[]) => stringValue(Buffer.from(stringArgument(args, 0, 'base64decode'), 'base64').toString('utf8')),
		base64encode: async (args: RuntimeValue<ValueType>[]) => stringValue(Buffer.from(stringArgument(args, 0, 'base64encode'), 'utf8').toString('base64')),
		base64sha256: async (args: RuntimeValue<ValueType>[]) => stringValue(createHash('sha256').update(stringArgument(args, 0, 'base64sha256'), 'utf8').digest('base64')),
		base64sha512: async (args: RuntimeValue<ValueType>[]) => stringValue(createHash('sha512').update(stringArgument(args, 0, 'base64sha512'), 'utf8').digest('base64')),
		ceil: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.ceil(numberArgument(args, 0, 'ceil'))),
		chomp: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'chomp');
			return stringValue(value.replace(/(?:\r?\n)+$/u, ''));
		},
		chunklist: async (args: RuntimeValue<ValueType>[]) => {
			const items = arrayArgument(args, 0, 'chunklist');
			const size = numberArgument(args, 1, 'chunklist');
			if (size <= 0) throw new Error('chunklist size must be positive');
			const chunks: RuntimeValue<ValueType>[] = [];
			for (let index = 0; index < items.length; index += size) chunks.push(arrayValue(items.slice(index, index + size)));
			return arrayValue(chunks);
		},
		cidrhost: async (args: RuntimeValue<ValueType>[]) => {
			const { network, prefix } = parseCidr(stringArgument(args, 0, 'cidrhost'));
			let host = numberArgument(args, 1, 'cidrhost');
			const hostBits = 32 - prefix;
			const maxHost = (1 << hostBits) - 2;
			if (host === -1) host = (1 << hostBits) - 1;
			if (host < 0 || host > maxHost) throw new Error(`cidrhost host ${host} exceeds network capacity`);
			return stringValue(ipFromInteger((network | host) >>> 0));
		},
		cidrnetmask: async (args: RuntimeValue<ValueType>[]) => {
			const { prefix } = parseCidr(stringArgument(args, 0, 'cidrnetmask'));
			const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
			return stringValue(ipFromInteger(mask));
		},
		cidrsubnet: async (args: RuntimeValue<ValueType>[]) => {
			const { network, prefix } = parseCidr(stringArgument(args, 0, 'cidrsubnet'));
			const newBits = numberArgument(args, 1, 'cidrsubnet');
			const netNumber = numberArgument(args, 2, 'cidrsubnet');
			if (newBits < 0 || newBits > 32) throw new Error('cidrsubnet newbits out of range');
			const resultPrefix = prefix + newBits;
			if (resultPrefix > 32) throw new Error('cidrsubnet prefix exceeds 32 bits');
			const maxNet = (1 << newBits) - 1;
			if (netNumber < 0 || netNumber > maxNet) throw new Error(`cidrsubnet netnum ${netNumber} exceeds subnet capacity`);
			const subnetwork = (network | (netNumber << (32 - resultPrefix))) >>> 0;
			return stringValue(`${ipFromInteger(subnetwork)}/${resultPrefix}`);
		},
		cidrsubnets: async (args: RuntimeValue<ValueType>[]) => {
			const { network, prefix } = parseCidr(stringArgument(args, 0, 'cidrsubnets'));
			const newBitsList = args.slice(1).map((_, index) => numberArgument(args, index + 1, 'cidrsubnets'));
			const results: RuntimeValue<ValueType>[] = [];
			let current = network;
			for (const newBits of newBitsList) {
				if (newBits < 0 || prefix + newBits > 32) throw new Error('cidrsubnets prefix exceeds 32 bits');
				const resultPrefix = prefix + newBits;
				results.push(stringValue(`${ipFromInteger(current >>> 0)}/${resultPrefix}`));
				current = (current + (1 << (32 - resultPrefix))) >>> 0;
			}
			return arrayValue(results);
		},
		coalesce: async (args: RuntimeValue<ValueType>[]) => {
			for (const argument of args) {
				const value = unwrapSensitive(argument);
				if (value.type !== 'null' && !(value.type === 'string' && String(value.value) === '')) return value;
			}
			throw new Error('coalesce requires at least one non-null, non-empty argument');
		},
		coalescelist: async (args: RuntimeValue<ValueType>[]) => {
			for (let index = 0; index < args.length; index++) {
				const value = arrayArgument(args, index, 'coalescelist');
				if (value.length > 0) return arrayValue(value);
			}
			throw new Error('coalescelist requires at least one non-empty list');
		},
		compact: async (args: RuntimeValue<ValueType>[]) => arrayValue(arrayArgument(args, 0, 'compact').filter(item => {
			const value = unwrapSensitive(item);
			return value.type !== 'null' && !(value.type === 'string' && String(value.value) === '');
		})),
		concat: async (args: RuntimeValue<ValueType>[]) => arrayValue(args.flatMap((_, index) => arrayArgument(args, index, 'concat'))),
		contains: async (args: RuntimeValue<ValueType>[]) => booleanValue(arrayArgument(args, 0, 'contains').some(item => valueEquals(item, requireArgument(args, 1, 'contains')))),
		csvdecode: async (args: RuntimeValue<ValueType>[]) => csvDecode(stringArgument(args, 0, 'csvdecode')),
		dirname: async (args: RuntimeValue<ValueType>[]) => stringValue(path.dirname(stringArgument(args, 0, 'dirname'))),
		distinct: async (args: RuntimeValue<ValueType>[]) => {
			const items = arrayArgument(args, 0, 'distinct');
			const distinct: RuntimeValue<ValueType>[] = [];
			for (const item of items) {
				if (!distinct.some(existing => valueEquals(existing, item))) distinct.push(item);
			}
			return arrayValue(distinct);
		},
		element: async (args: RuntimeValue<ValueType>[]) => {
			const items = arrayArgument(args, 0, 'element');
			const index = numberArgument(args, 1, 'element');
			if (items.length === 0) throw new Error('element cannot be used on an empty list');
			const wrapped = ((index % items.length) + items.length) % items.length;
			return items[wrapped];
		},
		endswith: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'endswith').endsWith(stringArgument(args, 1, 'endswith'))),
		flatten: async (args: RuntimeValue<ValueType>[]) => {
			const flattenItems = (items: RuntimeValue<ValueType>[], output: RuntimeValue<ValueType>[]): void => {
				for (const item of items) {
					if (item.type === 'array') flattenItems(item.value as RuntimeValue<ValueType>[], output);
					else output.push(item);
				}
			};
			const output: RuntimeValue<ValueType>[] = [];
			flattenItems(arrayArgument(args, 0, 'flatten'), output);
			return arrayValue(output);
		},
		floor: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.floor(numberArgument(args, 0, 'floor'))),
		format: async (args: RuntimeValue<ValueType>[]) => stringValue(goFormat(stringArgument(args, 0, 'format'), args.slice(1))),
		formatlist: async (args: RuntimeValue<ValueType>[]) => {
			const format = stringArgument(args, 0, 'formatlist');
			const lists = args.slice(1).map((_, index) => arrayArgument(args, index + 1, 'formatlist'));
			const maxLength = Math.max(0, ...lists.map(list => list.length));
			const results: RuntimeValue<ValueType>[] = [];
			for (let index = 0; index < maxLength; index++) {
				const rowArgs = lists.map(list => list[list.length === 1 ? 0 : index]);
				results.push(stringValue(goFormat(format, rowArgs)));
			}
			return arrayValue(results);
		},
		index: async (args: RuntimeValue<ValueType>[]) => {
			const items = arrayArgument(args, 0, 'index');
			const target = requireArgument(args, 1, 'index');
			const position = items.findIndex(item => valueEquals(item, target));
			if (position === -1) throw new Error('index target not found in list');
			return numberValue(position);
		},
		indent: async (args: RuntimeValue<ValueType>[]) => {
			const spaces = ' '.repeat(numberArgument(args, 0, 'indent'));
			const lines = stringArgument(args, 1, 'indent').split('\n');
			return stringValue(lines.map((line, index) => (index === 0 ? line : spaces + line)).join('\n'));
		},
		join: async (args: RuntimeValue<ValueType>[]) => stringValue(arrayArgument(args, 1, 'join').map((value, index) => {
			if (value.type !== 'string') throw new Error(`join list element ${index + 1} must be a string`);
			return String(value.value);
		}).join(stringArgument(args, 0, 'join'))),
		jsondecode: async (args: RuntimeValue<ValueType>[]) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(stringArgument(args, 0, 'jsondecode'));
			} catch (error) {
				throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : error}`);
			}
			return convertToRuntimeValue(parsed);
		},
		jsonencode: async (args: RuntimeValue<ValueType>[]) => stringValue(JSON.stringify(runtimeToPlain(requireArgument(args, 0, 'jsonencode')))),
		keys: async (args: RuntimeValue<ValueType>[]) => arrayValue([...objectArgument(args, 0, 'keys').keys()].sort().map(stringValue)),
		length: async (args: RuntimeValue<ValueType>[]) => {
			const value = requireArgument(args, 0, 'length');
			if (value.type === 'string') return numberValue([...String(value.value)].length);
			if (value.type === 'array' && Array.isArray(value.value)) return numberValue(value.value.length);
			if (value.type === 'object' && value.value instanceof Map) return numberValue(value.value.size);
			throw new Error('length requires a string, list, or object');
		},
		log: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.log(numberArgument(args, 0, 'log')) / Math.log(numberArgument(args, 1, 'log'))),
		lookup: async (args: RuntimeValue<ValueType>[]) => {
			const map = objectArgument(args, 0, 'lookup');
			const key = stringArgument(args, 1, 'lookup');
			const value = map.get(key);
			if (value !== undefined) return value;
			if (args.length >= 3) return requireArgument(args, 2, 'lookup');
			throw new Error(`lookup key ${JSON.stringify(key)} not found in object`);
		},
		lower: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'lower').toLocaleLowerCase()),
		mark_as_read: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'mark_as_read');
			return stringValue(value);
		},
		mark_glob_as_read: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => arrayValue((await expandTerragruntGlob(
			args.map((_, index) => stringArgument(args, index, 'mark_glob_as_read')),
			context.workingDirectory
		)).map(stringValue)),
		matchkeys: async (args: RuntimeValue<ValueType>[]) => {
			const values = arrayArgument(args, 0, 'matchkeys');
			const keys = arrayArgument(args, 1, 'matchkeys');
			const search = arrayArgument(args, 2, 'matchkeys');
			if (values.length !== keys.length) throw new Error('matchkeys values and keys must be the same length');
			const results: RuntimeValue<ValueType>[] = [];
			for (let index = 0; index < keys.length; index++) {
				if (search.some(candidate => valueEquals(candidate, keys[index]))) results.push(values[index]);
			}
			return arrayValue(results);
		},
		max: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.max(...args.map((_, index) => numberArgument(args, index, 'max')))),
		md5: async (args: RuntimeValue<ValueType>[]) => hash('md5', stringArgument(args, 0, 'md5')),
		merge: async (args: RuntimeValue<ValueType>[]) => {
			const merged = new Map<string, RuntimeValue<ValueType>>();
			for (let index = 0; index < args.length; index++) {
				for (const [key, value] of objectArgument(args, index, 'merge')) merged.set(key, value);
			}
			return objectValue(merged);
		},
		min: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.min(...args.map((_, index) => numberArgument(args, index, 'min')))),
		nonsensitive: async (args: RuntimeValue<ValueType>[]) => unwrapSensitive(requireArgument(args, 0, 'nonsensitive')),
		one: async (args: RuntimeValue<ValueType>[]) => {
			const items = arrayArgument(args, 0, 'one');
			if (items.length === 0) return makeNullValue();
			if (items.length > 1) throw new Error('one requires a list with exactly zero or one element');
			return items[0];
		},
		parseint: async (args: RuntimeValue<ValueType>[]) => numberValue(parseInt(stringArgument(args, 0, 'parseint'), numberArgument(args, 1, 'parseint'))),
		pathexpand: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'pathexpand');
			if (value === '~') {
				const home = process.env.HOME;
				if (!home) throw new Error('pathexpand requires HOME for the ~ path');
				return stringValue(home);
			}
			if (value.startsWith('~/')) {
				const home = process.env.HOME;
				if (!home) throw new Error('pathexpand requires HOME for a path beginning with ~/');
				return stringValue(path.join(home, value.slice(2)));
			}
			return stringValue(value);
		},
		pow: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.pow(numberArgument(args, 0, 'pow'), numberArgument(args, 1, 'pow'))),
		range: async (args: RuntimeValue<ValueType>[]) => {
			const start = numberArgument(args, 0, 'range');
			const limit = args.length >= 2 ? numberArgument(args, 1, 'range') : start;
			const actualStart = args.length >= 2 ? start : 0;
			const step = args.length >= 3 ? numberArgument(args, 2, 'range') : 1;
			if (step === 0) throw new Error('range step cannot be zero');
			const values: RuntimeValue<ValueType>[] = [];
			if (step > 0) {
				for (let value = actualStart; value < limit; value += step) values.push(numberValue(value));
			} else {
				for (let value = actualStart; value > limit; value += step) values.push(numberValue(value));
			}
			return arrayValue(values);
		},
		regex: async (args: RuntimeValue<ValueType>[]) => regexMatch(stringArgument(args, 0, 'regex'), stringArgument(args, 1, 'regex')),
		regexall: async (args: RuntimeValue<ValueType>[]) => regexAll(stringArgument(args, 0, 'regexall'), stringArgument(args, 1, 'regexall')),
		replace: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'replace').split(stringArgument(args, 1, 'replace')).join(stringArgument(args, 2, 'replace'))),
		reverse: async (args: RuntimeValue<ValueType>[]) => arrayValue([...arrayArgument(args, 0, 'reverse')].reverse()),
		sensitive: async (args: RuntimeValue<ValueType>[]) => makeSensitiveValue(requireArgument(args, 0, 'sensitive')),
		setintersection: async (args: RuntimeValue<ValueType>[]) => {
			const sets = args.map((_, index) => arrayArgument(args, index, 'setintersection'));
			if (sets.length === 0) return arrayValue([]);
			const intersection = sets[0].filter(item => sets.slice(1).every(set => set.some(candidate => valueEquals(candidate, item))));
			return arrayValue(sortRuntimeList(intersection));
		},
		setproduct: async (args: RuntimeValue<ValueType>[]) => {
			const sets = args.map((_, index) => arrayArgument(args, index, 'setproduct'));
			if (sets.length === 0) return arrayValue([]);
			const combinations: RuntimeValue<ValueType>[][] = [[]];
			for (const set of sets) {
				const next: RuntimeValue<ValueType>[][] = [];
				for (const combination of combinations) {
					for (const item of set) next.push([...combination, item]);
				}
				combinations.splice(0, combinations.length, ...next);
			}
			return arrayValue(combinations.map(arrayValue));
		},
		setsubtract: async (args: RuntimeValue<ValueType>[]) => {
			const left = arrayArgument(args, 0, 'setsubtract');
			const right = arrayArgument(args, 1, 'setsubtract');
			return arrayValue(sortRuntimeList(left.filter(item => !right.some(candidate => valueEquals(candidate, item)))));
		},
		setunion: async (args: RuntimeValue<ValueType>[]) => {
			const union: RuntimeValue<ValueType>[] = [];
			for (let index = 0; index < args.length; index++) {
				for (const item of arrayArgument(args, index, 'setunion')) {
					if (!union.some(existing => valueEquals(existing, item))) union.push(item);
				}
			}
			return arrayValue(sortRuntimeList(union));
		},
		sha1: async (args: RuntimeValue<ValueType>[]) => hash('sha1', stringArgument(args, 0, 'sha1')),
		sha256: async (args: RuntimeValue<ValueType>[]) => hash('sha256', stringArgument(args, 0, 'sha256')),
		sha512: async (args: RuntimeValue<ValueType>[]) => hash('sha512', stringArgument(args, 0, 'sha512')),
		signum: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.sign(numberArgument(args, 0, 'signum'))),
		slice: async (args: RuntimeValue<ValueType>[]) => {
			const items = arrayArgument(args, 0, 'slice');
			const start = numberArgument(args, 1, 'slice');
			const end = numberArgument(args, 2, 'slice');
			return arrayValue(items.slice(start, end));
		},
		sort: async (args: RuntimeValue<ValueType>[]) => arrayValue(sortRuntimeList(arrayArgument(args, 0, 'sort'))),
		split: async (args: RuntimeValue<ValueType>[]) => arrayValue(stringArgument(args, 1, 'split').split(stringArgument(args, 0, 'split')).map(stringValue)),
		startswith: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'startswith').startsWith(stringArgument(args, 1, 'startswith'))),
		strcontains: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'strcontains').includes(stringArgument(args, 1, 'strcontains'))),
		strrev: async (args: RuntimeValue<ValueType>[]) => stringValue([...stringArgument(args, 0, 'strrev')].reverse().join('')),
		substr: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'substr');
			let offset = numberArgument(args, 1, 'substr');
			const length = numberArgument(args, 2, 'substr');
			if (offset < 0) offset = value.length + offset;
			if (offset < 0 || offset > value.length) throw new Error('substr offset out of range');
			return stringValue(value.slice(offset, offset + length));
		},
		sum: async (args: RuntimeValue<ValueType>[]) => numberValue(arrayArgument(args, 0, 'sum').reduce((total, value, index) => {
			if (value.type !== 'number') throw new Error(`sum list element ${index + 1} must be a number`);
			return total + Number(value.value);
		}, 0)),
		textdecodebase64: async (args: RuntimeValue<ValueType>[]) => {
			const content = stringArgument(args, 0, 'textdecodebase64');
			const charset = stringArgument(args, 1, 'textdecodebase64');
			const buffer = Buffer.from(content, 'base64');
			switch (charset.toUpperCase()) {
				case 'UTF-8':
					return stringValue(buffer.toString('utf8'));
				case 'UTF-16':
					return stringValue(buffer.toString('utf16le'));
				default:
					throw new Error(`textdecodebase64 does not support charset ${charset}`);
			}
		},
		textencodebase64: async (args: RuntimeValue<ValueType>[]) => {
			const content = stringArgument(args, 0, 'textencodebase64');
			const charset = stringArgument(args, 1, 'textencodebase64');
			switch (charset.toUpperCase()) {
				case 'UTF-8':
					return stringValue(Buffer.from(content, 'utf8').toString('base64'));
				case 'UTF-16':
					return stringValue(Buffer.from(content, 'utf16le').toString('base64'));
				default:
					throw new Error(`textencodebase64 does not support charset ${charset}`);
			}
		},
		title: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'title').replace(/\p{L}[\p{L}\p{N}]*/gu, word => word[0].toLocaleUpperCase() + word.slice(1))),
		tobool: async (args: RuntimeValue<ValueType>[]) => {
			const argument = requireArgument(args, 0, 'tobool');
			if (argument.type === 'boolean') return argument;
			if (argument.type !== 'string') throw new Error('tobool requires a string or boolean');
			const value = String(argument.value);
			if (value === 'true') return booleanValue(true);
			if (value === 'false') return booleanValue(false);
			throw new Error(`cannot convert ${JSON.stringify(value)} to bool`);
		},
		tolist: async (args: RuntimeValue<ValueType>[]) => {
			const argument = requireArgument(args, 0, 'tolist');
			if (argument.type === 'array') return argument;
			if (argument.type === 'object') throw new Error('cannot convert an object to a list');
			throw new Error('tolist requires a list');
		},
		tomap: async (args: RuntimeValue<ValueType>[]) => {
			const argument = requireArgument(args, 0, 'tomap');
			if (argument.type === 'object') return argument;
			if (argument.type === 'array') throw new Error('cannot convert a list to an object');
			throw new Error('tomap requires an object');
		},
		tonumber: async (args: RuntimeValue<ValueType>[]) => {
			const argument = requireArgument(args, 0, 'tonumber');
			if (argument.type === 'number') return argument;
			if (argument.type !== 'string') throw new Error('tonumber requires a string or number');
			const value = Number(String(argument.value));
			if (Number.isNaN(value)) throw new Error(`cannot convert ${JSON.stringify(String(argument.value))} to number`);
			return numberValue(value);
		},
		tostring: async (args: RuntimeValue<ValueType>[]) => {
			const argument = requireArgument(args, 0, 'tostring');
			if (argument.type === 'string') return argument;
			if (argument.type === 'number' || argument.type === 'boolean') return stringValue(String(argument.value));
			if (argument.type === 'null') return stringValue('');
			throw new Error('tostring requires a string, number, boolean, or null');
		},
		transpose: async (args: RuntimeValue<ValueType>[]) => {
			const source = objectArgument(args, 0, 'transpose');
			const result = new Map<string, RuntimeValue<ValueType>>();
			for (const [key, value] of source) {
				if (value.type !== 'array') throw new Error('transpose object values must be lists');
				for (const item of value.value as RuntimeValue<ValueType>[]) {
					if (item.type !== 'string') throw new Error('transpose list elements must be strings');
					const keyValue = String(item.value);
					const existing = result.get(keyValue);
					if (existing?.type === 'array') (existing.value as RuntimeValue<ValueType>[]).push(stringValue(key));
					else result.set(keyValue, arrayValue([stringValue(key)]));
				}
			}
			return objectValue(result);
		},
		trim: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trim');
			const cutset = stringArgument(args, 1, 'trim');
			if (cutset === '') return stringValue(value);
			const pattern = new RegExp(`^[${escapeRegExp(cutset)}]+|[${escapeRegExp(cutset)}]+$`, 'gu');
			return stringValue(value.replace(pattern, ''));
		},
		trimprefix: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trimprefix');
			const prefix = stringArgument(args, 1, 'trimprefix');
			return stringValue(value.startsWith(prefix) ? value.slice(prefix.length) : value);
		},
		trimspace: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'trimspace').trim()),
		trimsuffix: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trimsuffix');
			const suffix = stringArgument(args, 1, 'trimsuffix');
			return stringValue(suffix && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value);
		},
		upper: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'upper').toLocaleUpperCase()),
		urlencode: async (args: RuntimeValue<ValueType>[]) => stringValue(encodeURIComponent(stringArgument(args, 0, 'urlencode')).replace(/%20/g, '+')),
		uuid: async () => stringValue(cryptoRandomUuid()),
		uuidv5: async (args: RuntimeValue<ValueType>[]) => stringValue(uuidv5(stringArgument(args, 0, 'uuidv5'), stringArgument(args, 1, 'uuidv5'))),
		values: async (args: RuntimeValue<ValueType>[]) => {
			const map = objectArgument(args, 0, 'values');
			return arrayValue([...map.keys()].sort().map(key => map.get(key)!));
		},
		formatdate: async (args: RuntimeValue<ValueType>[]) => stringValue(formatDate(stringArgument(args, 0, 'formatdate'), stringArgument(args, 1, 'formatdate'))),
		timeadd: async (args: RuntimeValue<ValueType>[]) => {
			const time = stringArgument(args, 0, 'timeadd');
			const duration = stringArgument(args, 1, 'timeadd');
			const timestamp = Date.parse(time);
			if (Number.isNaN(timestamp)) throw new Error(`Invalid time ${JSON.stringify(time)} for timeadd`);
			return stringValue(formatUtcTimestamp(new Date(timestamp + goDurationMilliseconds(duration))));
		},
		timecmp: async (args: RuntimeValue<ValueType>[]) => {
			const first = Date.parse(stringArgument(args, 0, 'timecmp'));
			const second = Date.parse(stringArgument(args, 1, 'timecmp'));
			if (Number.isNaN(first) || Number.isNaN(second)) throw new Error('timecmp requires RFC3339 timestamps');
			return numberValue(first < second ? -1 : first > second ? 1 : 0);
		},
		zipmap: async (args: RuntimeValue<ValueType>[]) => {
			const keys = arrayArgument(args, 0, 'zipmap');
			const values = arrayArgument(args, 1, 'zipmap');
			if (keys.length !== values.length) throw new Error('zipmap keys and values must be the same length');
			const map = new Map<string, RuntimeValue<ValueType>>();
			keys.forEach((key, index) => {
				if (key.type !== 'string') throw new Error('zipmap keys must be strings');
				map.set(String(key.value), values[index]);
			});
			return objectValue(map);
		}
	}
};

function formatUtcTimestamp(date: Date): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
	return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function goDurationMilliseconds(duration: string): number {
	const pattern = /^[+-]?((?:\d+(?:\.\d+)?)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
	if (!pattern.test(duration)) throw new Error(`Invalid duration for timeadd: ${JSON.stringify(duration)}`);
	const sign = duration.startsWith('-') ? -1 : 1;
	const body = duration.replace(/^[+-]/u, '');
	const units: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
	const parts = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gu;
	let total = 0;
	let match: RegExpExecArray | null;
	while ((match = parts.exec(body)) !== null) total += Number(match[1]) * units[match[2]]!;
	return sign * total;
}

function formatDate(layout: string, timeText: string): string {
	const date = new Date(timeText);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid time ${JSON.stringify(timeText)} for formatdate`);
	const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
	const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
	const renderers: Record<string, () => string> = {
		YYYY: () => pad(date.getUTCFullYear(), 4),
		YY: () => String(date.getUTCFullYear()).slice(-2),
		MMMM: () => monthNames[date.getUTCMonth()],
		MMM: () => monthNames[date.getUTCMonth()].slice(0, 3),
		MM: () => pad(date.getUTCMonth() + 1),
		M: () => String(date.getUTCMonth() + 1),
		DD: () => pad(date.getUTCDate()),
		D: () => String(date.getUTCDate()),
		EEEE: () => weekdayNames[date.getUTCDay()],
		EEE: () => weekdayNames[date.getUTCDay()].slice(0, 3),
		HH: () => pad(date.getUTCHours()),
		H: () => String(date.getUTCHours()),
		hh: () => pad(date.getUTCHours() % 12 || 12),
		h: () => String(date.getUTCHours() % 12 || 12),
		AA: () => (date.getUTCHours() < 12 ? 'AM' : 'PM'),
		aa: () => (date.getUTCHours() < 12 ? 'am' : 'pm'),
		mm: () => pad(date.getUTCMinutes()),
		m: () => String(date.getUTCMinutes()),
		ss: () => pad(date.getUTCSeconds()),
		s: () => String(date.getUTCSeconds()),
		ZZZZZ: () => 'Z',
		ZZZZ: () => '+00:00',
		ZZZ: () => '+0000',
		ZZ: () => 'Z',
		Z: () => 'Z'
	};
	const names = Object.keys(renderers).sort((left, right) => right.length - left.length);
	let output = '';
	let index = 0;
	while (index < layout.length) {
		const match = names.find(name => layout.startsWith(name, index));
		if (match) {
			output += renderers[match]();
			index += match.length;
		} else {
			output += layout[index];
			index++;
		}
	}
	return output;
}

function cryptoRandomUuid(): string {
	return randomUUID();
}

void uuidRegex;
