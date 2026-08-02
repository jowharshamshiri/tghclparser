import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import yaml from 'js-yaml';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { renderTemplate } from './template';
import {
	convertToRuntimeValue,
	makeBooleanValue,
	makeStringValue
} from './utils';

export const fileFunctionGroup = {
    namespace: 'file',
    functions: {
		file: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const filePath = resolveFilePath(stringArgument(args, 0, 'file'), context);
            try {
                const content = await fs.readFile(filePath, 'utf8');
                return makeStringValue(content);
			} catch (error) {
				throw new Error(`Error reading file ${filePath}: ${error instanceof Error ? error.message : error}`);
            }
        },
		fileexists: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const filePath = resolveFilePath(stringArgument(args, 0, 'fileexists'), context);
            try {
                await fs.access(filePath);
                return makeBooleanValue(true);
            } catch {
                return makeBooleanValue(false);
            }
        },
		filebase64: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const filePath = resolveFilePath(stringArgument(args, 0, 'filebase64'), context);
            try {
                const content = await fs.readFile(filePath);
                return makeStringValue(content.toString('base64'));
			} catch (error) {
				throw new Error(`Error reading file ${filePath}: ${error instanceof Error ? error.message : error}`);
            }
        },
		filemd5: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => fileHexDigest('md5', args, context),
		filesha1: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => fileHexDigest('sha1', args, context),
		filesha256: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => fileHexDigest('sha256', args, context),
		filesha512: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => fileHexDigest('sha512', args, context),
		filebase64sha256: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => fileBase64Digest('sha256', args, context),
		filebase64sha512: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => fileBase64Digest('sha512', args, context),
		read_terragrunt_config: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const configPath = stringArgument(args, 0, 'read_terragrunt_config');
            if (!context.readTerragruntConfig) {
                throw new Error('read_terragrunt_config requires a config reader');
            }
            const value = await context.readTerragruntConfig(configPath);
            if (value !== undefined) return value;
            if (args.length >= 2) return args[1];
            throw new Error(`Could not read Terragrunt config ${configPath}`);
        },
		read_tfvars_file: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const tfvarsPath = stringArgument(args, 0, 'read_tfvars_file');
            if (!context.readTFVarsFile) {
                throw new Error('read_tfvars_file requires a tfvars reader');
            }
            const value = await context.readTFVarsFile(tfvarsPath);
            if (value === undefined) throw new Error(`Could not read tfvars file ${tfvarsPath}`);
            return value;
        },
		templatefile: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const templatePath = stringArgument(args, 0, 'templatefile');
            const vars = args[1];
            if (!vars || vars.type !== 'object') {
                throw new Error('templatefile requires an object of template variables');
            }
            const filePath = resolveFilePath(templatePath, context);
            const content = await fs.readFile(filePath, 'utf8');
            return makeStringValue(await renderTemplate(content, vars, context));
        },
        yamldecode: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('yamldecode() requires a string argument');
            }

            const yamlContent = args[0].value as string;

            try {
                const parsed = yaml.load(yamlContent);
                return convertToRuntimeValue(parsed);
			} catch (error) {
                throw new Error(`Error parsing YAML: ${error instanceof Error ? error.message : error}`);
            }
        },
	}
};

function stringArgument(args: RuntimeValue<ValueType>[], index: number, name: string): string {
	const argument = args[index];
	if (!argument || argument.type !== 'string') {
		throw new Error(`${name} requires a string argument ${index + 1}`);
	}
	return String(argument.value);
}

async function fileHexDigest(
	name: 'md5' | 'sha1' | 'sha256' | 'sha512',
	args: RuntimeValue<ValueType>[],
	context: FunctionContext
): Promise<RuntimeValue<ValueType>> {
	const filePath = resolveFilePath(stringArgument(args, 0, name), context);
	const content = await fs.readFile(filePath);
	return makeStringValue(createHash(name).update(content).digest('hex'));
}

async function fileBase64Digest(
	name: 'sha256' | 'sha512',
	args: RuntimeValue<ValueType>[],
	context: FunctionContext
): Promise<RuntimeValue<ValueType>> {
	const filePath = resolveFilePath(stringArgument(args, 0, name), context);
	const content = await fs.readFile(filePath);
	return makeStringValue(createHash(name).update(content).digest('base64'));
}

function resolveFilePath(filePath: string, context: FunctionContext): string {
	const base = context.workingDirectory;
	return path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
}
