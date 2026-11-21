import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import yaml from 'js-yaml';

import { ArgumentError } from '../function-signature';
import { goQuoted } from '../go-quote';
import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { renderTemplate } from './template';
import {
	convertToRuntimeValue,
	expectParams,
	makeBooleanValue,
	makeSensitiveValue,
	makeStringValue,
	markEncrypted,
	unwrapSensitive
} from './utils';

export const fileFunctionGroup = {
    namespace: 'file',
    functions: {
		file: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'file');
            const path = markedPath(args[0]);
            const content = utf8Text(await readArgumentFile(path, context));
            if (content === undefined) {
                throw new Error(
                    `contents of ${path.redacted(path.text)} are not valid UTF-8; use the filebase64 function to obtain the Base64 `
                    + 'encoded contents or the other file functions (e.g. filemd5, filesha256) to obtain file hashing results instead'
                );
            }
            return path.mark(makeStringValue(content));
        },
		fileexists: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'fileexists');
            const path = markedPath(args[0]);
            const filePath = resolveFilePath(path.text, context);
            await assertPathAllowed(context, filePath);
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.mark(makeBooleanValue(false));
                throw new Error(`failed to stat ${path.redacted(filePath)}`);
            }
            if (stat.isFile()) return path.mark(makeBooleanValue(true));
            // Terragrunt reports what sits there at position 1, which fileexists has no parameter for.
            throw new ArgumentError(1, `${path.redacted(filePath)} ${irregularFile(stat)}`);
        },
		filebase64: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'filebase64');
            const path = markedPath(args[0]);
            const content = await readArgumentFile(path, context);
            return path.mark(makeStringValue(content.toString('base64')));
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
			const filePath = resolveFilePath(source, context);
			await assertPathAllowed(context, filePath);
			if (!context.decryptSopsFile) throw new Error('sops_decrypt_file requires a sops runner');
			const read = await context.decryptSopsFile(filePath);
			return read.encrypted ? { ...makeStringValue(read.content), encrypted: true } : makeStringValue(read.content);
		},
		templatefile: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            assertTrusted(context, 'templatefile');
            // Terragrunt reads the template before it looks at the variables, and fails the call, not the argument,
            // when it cannot.
            const path = markedPath(args[0]);
            const content = await readFileBytes(path, context);
            const source = utf8Text(content);
            if (source === undefined) throw new Error(`contents of ${path.redacted(path.text)} are not valid UTF-8`);
            return path.mark(await renderTemplate(source, args[1], context, path.text));
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

/** A path argument, which the file functions take sensitive, and what its sensitivity does to what they give. */
interface MarkedPath {
	text: string;
	/** The value marked sensitive when the path was. */
	mark(value: RuntimeValue<ValueType>): RuntimeValue<ValueType>;
	/** A path as Terragrunt's redact gives it in a message: quoted, or "(sensitive value)" when the argument was. */
	redacted(path: string): string;
}

function markedPath(argument: RuntimeValue<ValueType>): MarkedPath {
	const sensitive = (argument.type as string) === 'sensitive';
	return {
		text: String(unwrapSensitive(argument).value),
		mark: value => (sensitive ? makeSensitiveValue(value) : value),
		redacted: path => (sensitive ? '(sensitive value)' : goQuoted(path))
	};
}

/** Text that is valid UTF-8, as Go's utf8.Valid decides, or undefined. */
function utf8Text(content: Buffer): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
	} catch {
		return undefined;
	}
}

/** A file Terragrunt's readFileBytes could not read, in its words. */
class UnreadableFileError extends Error {}

/**
 * The contents of the file at a path, as Terragrunt's readFileBytes reads them: a missing file and a file it cannot
 * read refused in its words.
 *
 * @throws UnreadableFileError naming the path for a missing file, and the file as Go's os package names it for one
 *   it cannot read.
 */
async function readFileBytes(path: MarkedPath, context: FunctionContext): Promise<Buffer> {
	const filePath = resolveFilePath(path.text, context);
	await assertPathAllowed(context, filePath);
	try {
		return await fs.readFile(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			throw new UnreadableFileError(
				`no file exists at ${path.redacted(path.text)}; this function works only with files that are distributed as part of `
				+ 'the configuration source code, so if this file will be created by a resource in this configuration you must instead '
				+ 'obtain this result from an attribute of that resource'
			);
		}
		// Go's os package names the failed operation and the file; Node names the same failures by these codes.
		if (code === 'EISDIR') throw new UnreadableFileError(`failed to read file: read ${filePath}: is a directory`);
		if (code === 'EACCES') throw new UnreadableFileError(`failed to read file: open ${filePath}: permission denied`);
		throw error;
	}
}

/** The contents of the file a file function's path argument names, a failure to read it an argument error. */
async function readArgumentFile(path: MarkedPath, context: FunctionContext): Promise<Buffer> {
	try {
		return await readFileBytes(path, context);
	} catch (error) {
		if (error instanceof UnreadableFileError) throw new ArgumentError(0, error.message);
		throw error;
	}
}

/** What Terragrunt's irregularFileError says sits at a path that is not a regular file. */
function irregularFile(stat: Stats): string {
	if (stat.isDirectory()) return 'is a directory, not a file';
	if (stat.isCharacterDevice() || stat.isBlockDevice()) return 'is a device node, not a regular file';
	if (stat.isFIFO()) return 'is a named pipe, not a regular file';
	if (stat.isSocket()) return 'is a unix domain socket, not a regular file';
	return 'is not a regular file';
}

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
    assertTrusted(context, name);
	const filePath = resolveFilePath(stringArgument(args, 0, name), context);
	await assertPathAllowed(context, filePath);
	const content = await fs.readFile(filePath);
	return makeStringValue(createHash(name).update(content).digest('hex'));
}

async function fileBase64Digest(
	name: 'sha256' | 'sha512',
	args: RuntimeValue<ValueType>[],
	context: FunctionContext
): Promise<RuntimeValue<ValueType>> {
    assertTrusted(context, name);
	const filePath = resolveFilePath(stringArgument(args, 0, name), context);
	await assertPathAllowed(context, filePath);
	const content = await fs.readFile(filePath);
	return makeStringValue(createHash(name).update(content).digest('base64'));
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
