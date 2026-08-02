import os from 'node:os';
import path from 'node:path';

import { URI } from 'vscode-uri';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeArrayValue, makeStringValue } from './utils';

// Constants from original terragrunt
const TerraformCommandsNeedVars = [
    'apply', 'console', 'destroy', 'import', 'plan', 'push', 'refresh',
];

const TerraformCommandsNeedLocking = [
    'apply', 'destroy', 'import', 'plan', 'refresh', 'taint', 'untaint',
];

const TerraformCommandsNeedInput = [
    'apply', 'import', 'init', 'plan', 'refresh',
];

const TerraformCommandsNeedParallelism = [
    'apply', 'plan', 'destroy',
];
async function findParentWithFile(
    startDir: string, 
    filename: string, 
    context: FunctionContext,
    includeStart = true
): Promise<string | null> {
    let currentDir = path.resolve(startDir);
    if (!context.fs?.access) {
		throw new Error('Filesystem access is required to resolve parent files');
    }

    if (!includeStart) {
        currentDir = path.dirname(currentDir);
    }
	const workspaceRoot = context.workspaceRoot ? path.resolve(context.workspaceRoot) : undefined;

    while (true) {
		if (workspaceRoot && currentDir !== workspaceRoot && !currentDir.startsWith(`${workspaceRoot}${path.sep}`)) {
			return null;
		}
        try {
            const filePath = path.join(currentDir, filename);
            await context.fs.access(filePath);
            return filePath;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                return null;
            }
            currentDir = parentDir;
        }
    }
}

async function requireRepositoryRoot(context: FunctionContext): Promise<string> {
	const currentDir = path.dirname(URI.parse(context.document.uri).fsPath);
	const marker = await findParentWithFile(currentDir, '.git', context, true);
	if (!marker) throw new Error(`No Git repository contains ${currentDir}`);
	return path.dirname(marker);
}
export const coreFunctionGroup = {
    namespace: 'core',
    functions: {
		get_terragrunt_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (context.terragruntDir) return makeStringValue(context.terragruntDir);
            const {fsPath} = URI.parse(context.document.uri);
            return makeStringValue(path.dirname(fsPath));
        },
        get_original_terragrunt_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (context.originalTerragruntDir) return makeStringValue(context.originalTerragruntDir);
            if (context.terragruntDir) return makeStringValue(context.terragruntDir);
            const {fsPath} = URI.parse(context.document.uri);
            return makeStringValue(path.dirname(fsPath));
        },
        get_parent_terragrunt_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!context.includeDir) throw new Error('get_parent_terragrunt_dir requires an included config');
            return makeStringValue(context.includeDir);
        },
        path_relative_to_include: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!context.includeDir || !context.terragruntDir) {
                throw new Error('path_relative_to_include requires an included config');
            }
            return makeStringValue(path.relative(context.includeDir, context.terragruntDir) || '.');
        },
        path_relative_from_include: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!context.includeDir || !context.terragruntDir) {
                throw new Error('path_relative_from_include requires an included config');
            }
            return makeStringValue(path.relative(context.terragruntDir, context.includeDir) || '.');
        },
        get_terragrunt_source_cli_flag: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const cliArgs = context.terraformCliArgs ?? [];
            const index = cliArgs.findIndex(argument => argument === '--terragrunt-source');
            if (index !== -1 && index + 1 < cliArgs.length) {
                return makeStringValue(cliArgs[index + 1]);
            }
            return makeStringValue('');
        },
        run_cmd: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const raw = args.map((_, index) => {
                const argument = args[index];
                if (!argument || argument.type !== 'string') {
                    throw new Error(`run_cmd argument ${index + 1} must be a string`);
                }
                return String(argument.value);
            });
            if (raw.length === 0) throw new Error('run_cmd requires a program');
            let programIndex = 0;
            while (programIndex < raw.length && raw[programIndex].startsWith('--terragrunt-')) programIndex++;
            if (programIndex >= raw.length) throw new Error('run_cmd requires a program');
            const program = raw[programIndex];
            const programArgs = raw.slice(programIndex + 1);
            if (!context.runCommand) throw new Error('run_cmd requires a command runner');
            return makeStringValue(await context.runCommand(program, programArgs));
        },

        find_in_parent_folders: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
			if (args.length > 0 && (args[0]?.type !== 'string' || !args[0].value)) {
				throw new Error('find_in_parent_folders requires an explicit filename');
			}
			const fileToFind = args.length > 0 ? String(args[0].value) : 'terragrunt.hcl';
            const fallback = args[1]?.type === 'string' ? String(args[1].value) : undefined;
            
			const currentDir = context.terragruntDir ?? path.dirname(URI.parse(context.document.uri).fsPath);
			const foundDir = await findParentWithFile(currentDir, fileToFind, context, true);
                
			if (!foundDir) {
				if (fallback !== undefined) {
					return makeStringValue(fallback);
				}
				throw new Error(`Could not find ${fileToFind} in parent folders`);
			}
			return makeStringValue(foundDir);
        },
        get_terraform_commands_that_need_vars: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeArrayValue(TerraformCommandsNeedVars.map(cmd => makeStringValue(cmd)));
        },

        get_terraform_commands_that_need_locking: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeArrayValue(TerraformCommandsNeedLocking.map(cmd => makeStringValue(cmd)));
        },

        get_terraform_commands_that_need_input: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeArrayValue(TerraformCommandsNeedInput.map(cmd => makeStringValue(cmd)));
        },

        get_terraform_commands_that_need_parallelism: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeArrayValue(TerraformCommandsNeedParallelism.map(cmd => makeStringValue(cmd)));
        },

        get_terraform_command: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
			if (context.terraformCommand === undefined) throw new Error('Terraform command context is unavailable');
			return makeStringValue(context.terraformCommand);
        },

        get_terraform_cli_args: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
			if (context.terraformCliArgs === undefined) throw new Error('Terraform CLI argument context is unavailable');
			const cliArgs = context.terraformCliArgs;
            return makeArrayValue(cliArgs.map(arg => makeStringValue(arg)));
        },

        get_platform: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeStringValue(os.platform());
        },
		get_repo_root: async (
			_args: RuntimeValue<ValueType>[],
			context: FunctionContext
		): Promise<RuntimeValue<ValueType>> => makeStringValue(context.repoRoot ?? await requireRepositoryRoot(context)),
		get_path_from_repo_root: async (
			_args: RuntimeValue<ValueType>[],
			context: FunctionContext
		): Promise<RuntimeValue<ValueType>> => {
			const currentDir = context.terragruntDir ?? path.dirname(URI.parse(context.document.uri).fsPath);
			const repoRoot = context.repoRoot ?? await requireRepositoryRoot(context);
			return makeStringValue(path.relative(repoRoot, currentDir) || '.');
		},
		get_path_to_repo_root: async (
			_args: RuntimeValue<ValueType>[],
			context: FunctionContext
		): Promise<RuntimeValue<ValueType>> => {
			const currentDir = context.terragruntDir ?? path.dirname(URI.parse(context.document.uri).fsPath);
			const repoRoot = context.repoRoot ?? await requireRepositoryRoot(context);
			return makeStringValue(path.relative(currentDir, repoRoot) || '.');
		},

        get_working_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeStringValue(context.workingDirectory);
        },
        get_env: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (args.length === 0 || args[0].type !== 'string') {
                throw new Error('get_env requires at least one string argument');
            }

            const envName = String(args[0].value);
			const defaultValue = args[1]?.type === 'string' ? String(args[1].value) : undefined;

			const envValue = context.environmentVariables[envName];
			if (envValue !== undefined) return makeStringValue(envValue);
			if (defaultValue !== undefined) return makeStringValue(defaultValue);
			throw new Error(`Required environment variable ${envName} is not set`);
        }
    }
};
