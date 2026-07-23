import { createHash } from 'node:crypto';
import path from 'node:path';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { expandTerragruntGlob } from './terragrunt_glob';

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

function hash(name: 'md5' | 'sha1' | 'sha256' | 'sha512', value: string): RuntimeValue<'string'> {
	return stringValue(createHash(name).update(value, 'utf8').digest('hex'));
}

export const builtinFunctionGroup = {
	namespace: 'opentofu',
	functions: {
		abspath: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => stringValue(path.resolve(context.workingDirectory, stringArgument(args, 0, 'abspath'))),
		basename: async (args: RuntimeValue<ValueType>[]) => stringValue(path.basename(stringArgument(args, 0, 'basename'))),
		coalescelist: async (args: RuntimeValue<ValueType>[]) => {
			for (let index = 0; index < args.length; index++) {
				const value = arrayArgument(args, index, 'coalescelist');
				if (value.length > 0) return arrayValue(value);
			}
			throw new Error('coalescelist requires at least one non-empty list');
		},
		dirname: async (args: RuntimeValue<ValueType>[]) => stringValue(path.dirname(stringArgument(args, 0, 'dirname'))),
		join: async (args: RuntimeValue<ValueType>[]) => stringValue(arrayArgument(args, 1, 'join').map((value, index) => {
			if (value.type !== 'string') throw new Error(`join list element ${index + 1} must be a string`);
			return String(value.value);
		}).join(stringArgument(args, 0, 'join'))),
		keys: async (args: RuntimeValue<ValueType>[]) => arrayValue([...objectArgument(args, 0, 'keys').keys()].sort().map(stringValue)),
		length: async (args: RuntimeValue<ValueType>[]) => {
			const value = requireArgument(args, 0, 'length');
			if (value.type === 'string') return numberValue([...String(value.value)].length);
			if (value.type === 'array' && Array.isArray(value.value)) return numberValue(value.value.length);
			if (value.type === 'object' && value.value instanceof Map) return numberValue(value.value.size);
			throw new Error('length requires a string, list, or object');
		},
		lower: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'lower').toLocaleLowerCase()),
		md5: async (args: RuntimeValue<ValueType>[]) => hash('md5', stringArgument(args, 0, 'md5')),
		mark_as_read: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'mark_as_read');
			if (!path.isAbsolute(value)) throw new Error('mark_as_read requires an absolute path');
			return stringValue(value);
		},
		mark_glob_as_read: async (args: RuntimeValue<ValueType>[], context: FunctionContext) => arrayValue((await expandTerragruntGlob(
			args.map((_, index) => stringArgument(args, index, 'mark_glob_as_read')),
			context.workingDirectory
		)).map(stringValue)),
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
		replace: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'replace').split(stringArgument(args, 1, 'replace')).join(stringArgument(args, 2, 'replace'))),
		sha1: async (args: RuntimeValue<ValueType>[]) => hash('sha1', stringArgument(args, 0, 'sha1')),
		sha256: async (args: RuntimeValue<ValueType>[]) => hash('sha256', stringArgument(args, 0, 'sha256')),
		sha512: async (args: RuntimeValue<ValueType>[]) => hash('sha512', stringArgument(args, 0, 'sha512')),
		signum: async (args: RuntimeValue<ValueType>[]) => numberValue(Math.sign(numberArgument(args, 0, 'signum'))),
		sum: async (args: RuntimeValue<ValueType>[]) => numberValue(arrayArgument(args, 0, 'sum').reduce((total, value, index) => {
			if (value.type !== 'number') throw new Error(`sum list element ${index + 1} must be a number`);
			return total + Number(value.value);
		}, 0)),
		title: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'title').replace(/\p{L}[\p{L}\p{N}]*/gu, word => word[0].toLocaleUpperCase() + word.slice(1))),
		trimspace: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'trimspace').trim()),
		trimprefix: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trimprefix');
			const prefix = stringArgument(args, 1, 'trimprefix');
			return stringValue(value.startsWith(prefix) ? value.slice(prefix.length) : value);
		},
		trimsuffix: async (args: RuntimeValue<ValueType>[]) => {
			const value = stringArgument(args, 0, 'trimsuffix');
			const suffix = stringArgument(args, 1, 'trimsuffix');
			return stringValue(suffix && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value);
		},
		startswith: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'startswith').startsWith(stringArgument(args, 1, 'startswith'))),
		endswith: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'endswith').endsWith(stringArgument(args, 1, 'endswith'))),
		strcontains: async (args: RuntimeValue<ValueType>[]) => booleanValue(stringArgument(args, 0, 'strcontains').includes(stringArgument(args, 1, 'strcontains'))),
		split: async (args: RuntimeValue<ValueType>[]) => arrayValue(stringArgument(args, 1, 'split').split(stringArgument(args, 0, 'split')).map(stringValue)),
		upper: async (args: RuntimeValue<ValueType>[]) => stringValue(stringArgument(args, 0, 'upper').toLocaleUpperCase())
	}
};
