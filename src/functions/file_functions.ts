import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import yaml from 'js-yaml';

import { goQuoted } from '../go-quote';
import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { renderTemplate } from './template';
import {
	convertToRuntimeValue,
	expectParams,
	makeBooleanValue,
	makeStringValue,
	markEncrypted,
	unitWorkingDirectory
} from './utils';

export const fileFunctionGroup = {
    namespace: 'file',
    functions: {
		file: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'file');
            const filePath = resolveFilePath(stringArgument(args, 0, 'file'), context);
            await assertPathAllowed(context, filePath);
            let content: string;
            try {
                content = await fs.readFile(filePath, 'utf8');
			} catch (error) {
				throw new Error(`Error reading file ${filePath}: ${error instanceof Error ? error.message : error}`);
            }
            context.onRead?.(filePath);
            return makeStringValue(content);
        },
		// Only a regular file exists, and is read; a directory or another kind of file is refused, as Terragrunt does.
		fileexists: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'fileexists');
            const filePath = resolveFilePath(stringArgument(args, 0, 'fileexists'), context);
            await assertPathAllowed(context, filePath);
            let stats: Stats;
            try {
                stats = await fs.stat(filePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return makeBooleanValue(false);
                throw new Error(`failed to stat ${goQuoted(filePath)}`);
            }
            if (!stats.isFile()) throw new Error(`${goQuoted(filePath)} ${irregularFileKind(stats)}`);
            context.onRead?.(filePath);
            return makeBooleanValue(true);
        },
		filebase64: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'filebase64');
            const filePath = resolveFilePath(stringArgument(args, 0, 'filebase64'), context);
            await assertPathAllowed(context, filePath);
            let content: Buffer;
            try {
                content = await fs.readFile(filePath);
			} catch (error) {
				throw new Error(`Error reading file ${filePath}: ${error instanceof Error ? error.message : error}`);
            }
            context.onRead?.(filePath);
            return makeStringValue(content.toString('base64'));
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
            expectParams(args, [1, 2], 'read_terragrunt_config');
            assertTrusted(context, 'read_terragrunt_config');
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
            expectParams(args, [1], 'read_tfvars_file');
            assertTrusted(context, 'read_tfvars_file');
            const tfvarsPath = stringArgument(args, 0, 'read_tfvars_file');
            if (!context.readTFVarsFile) {
                throw new Error('read_tfvars_file requires a tfvars reader');
            }
            const value = await context.readTFVarsFile(tfvarsPath);
            if (value === undefined) throw new Error(`Could not read tfvars file ${tfvarsPath}`);
			return value;
		},
		sops_decrypt_file: async (
			args: RuntimeValue<ValueType>[],
			context: FunctionContext
		): Promise<RuntimeValue<ValueType>> => {
			expectParams(args, [1], 'sops_decrypt_file');
			assertTrusted(context, 'sops_decrypt_file');
			const source = stringArgument(args, 0, 'sops_decrypt_file');
			// Terragrunt's own function: a relative path is the unit's, and the file is read before it is decrypted.
			const filePath = path.resolve(unitWorkingDirectory(context), source);
			await assertPathAllowed(context, filePath);
			if (!context.decryptSopsFile) throw new Error('sops_decrypt_file requires a sops runner');
			context.onRead?.(filePath);
			const read = await context.decryptSopsFile(filePath);
			return read.encrypted ? { ...makeStringValue(read.content), encrypted: true } : makeStringValue(read.content);
		},
		templatefile: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'templatefile');
            const templatePath = stringArgument(args, 0, 'templatefile');
            const vars = args[1];
            if (!vars || vars.type !== 'object') {
                throw new Error('templatefile requires an object of template variables');
            }
            const filePath = resolveFilePath(templatePath, context);
            await assertPathAllowed(context, filePath);
            const content = await fs.readFile(filePath, 'utf8');
            context.onRead?.(filePath);
            // The files the template reads in turn are read through the same context, from the same directory.
            return renderTemplate(content, vars, context);
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
                const decoded = convertToRuntimeValue(parsed);
                return args[0].encrypted ? markEncrypted(decoded) : decoded;
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
	return makeStringValue(createHash(name).update(await hashedContent(`file${name}`, args, context)).digest('hex'));
}

async function fileBase64Digest(
	name: 'sha256' | 'sha512',
	args: RuntimeValue<ValueType>[],
	context: FunctionContext
): Promise<RuntimeValue<ValueType>> {
	return makeStringValue(createHash(name).update(await hashedContent(`filebase64${name}`, args, context)).digest('base64'));
}

/**
 * The content of the file a hashing function hashes. As in Terragrunt, the file counts as read once it is opened, so
 * a directory, which opens but cannot be read, is read and then refused.
 */
async function hashedContent(name: string, args: RuntimeValue<ValueType>[], context: FunctionContext): Promise<Buffer> {
    assertTrusted(context, name);
	const filePath = resolveFilePath(stringArgument(args, 0, name), context);
	await assertPathAllowed(context, filePath);
	const handle = await fs.open(filePath, 'r');
	try {
		context.onRead?.(filePath);
		try {
			return await handle.readFile();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EISDIR') throw new Error(`read ${filePath}: is a directory`);
			throw error;
		}
	} finally {
		await handle.close();
	}
}

/** What Terragrunt's fileexists says of a path that is not a regular file. */
function irregularFileKind(stats: Stats): string {
	if (stats.isDirectory()) return 'is a directory, not a file';
	if (stats.isBlockDevice() || stats.isCharacterDevice()) return 'is a device node, not a regular file';
	if (stats.isFIFO()) return 'is a named pipe, not a regular file';
	if (stats.isSocket()) return 'is a unix domain socket, not a regular file';
	return 'is not a regular file';
}

function assertTrusted(context: FunctionContext, operation: string): void {
	if (context.assertTrusted) {
		context.assertTrusted(`${operation}() file access`);
		return;
	}
	if (context.workspaceTrusted !== true) {
		throw new Error(`${operation}() file access is disabled until the workspace is trusted`);
	}
}

async function assertPathAllowed(context: FunctionContext, target: string): Promise<void> {
	if (context.assertPathAllowed) {
		await context.assertPathAllowed(target);
	}
}

function resolveFilePath(filePath: string, context: FunctionContext): string {
	const base = context.workingDirectory;
	return path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
}
