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

export const coreFunctionGroup = {
    namespace: 'core',
    functions: {
        get_terragrunt_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const {fsPath} = URI.parse(context.document.uri);
            const dirPath = path.dirname(fsPath);
            return makeStringValue(dirPath);
        },

        get_parent_terragrunt_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const configPath = context.document.uri;
            const currentDir = path.dirname(URI.parse(configPath).fsPath);
            const parentDir = path.dirname(currentDir);
            return makeStringValue(parentDir);
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
            return makeStringValue(context.terraformCommand || '');
        },

        get_terraform_cli_args: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const cliArgs = context.terraformCliArgs || [];
            return makeArrayValue(cliArgs.map(arg => makeStringValue(arg)));
        },

        get_platform: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeStringValue(os.platform());
        },

        get_working_dir: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            return makeStringValue(context.workingDirectory);
        },

        path_relative_to_include: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            // Logic to get relative path between included terragrunt config and current config
            return makeStringValue('.');
        },

        path_relative_from_include: async (
            _args: RuntimeValue<ValueType>[],
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            // Logic to get relative path from current config to included config
            return makeStringValue('.');
        },

        find_in_parent_folders: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const fileToFind = args[0]?.type === 'string' ? String(args[0].value) : 'terragrunt.hcl';
            const fallback = args[1]?.type === 'string' ? String(args[1].value) : undefined;
            
            try {
                let currentDir = path.dirname(URI.parse(context.document.uri).fsPath);
                const maxDepth = 100; // Prevent infinite loops
                let depth = 0;

                while (depth < maxDepth) {
                    const filePath = path.join(currentDir, fileToFind);
                    try {
                        // Using the context to check file existence
                        await context.fs?.access(filePath);
                        return makeStringValue(filePath);
                    } catch {
                        const parentDir = path.dirname(currentDir);
                        if (parentDir === currentDir) {
                            // Reached root directory
                            if (fallback !== undefined) {
                                return makeStringValue(fallback);
                            }
                            throw new Error(`Could not find ${fileToFind} in parent folders`);
                        }
                        currentDir = parentDir;
                    }
                    depth++;
                }

                throw new Error(`Exceeded maximum depth searching for ${fileToFind}`);
            } catch (error) {
                if (fallback !== undefined) {
                    return makeStringValue(fallback);
                }
                throw error;
            }
        },

        get_env: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (args.length === 0 || args[0].type !== 'string') {
                throw new Error('get_env requires at least one string argument');
            }

            const envName = String(args[0].value);
            const defaultValue = args[1]?.type === 'string' ? String(args[1].value) : '';

            const envValue = context.environmentVariables[envName];
            return makeStringValue(envValue ?? defaultValue);
        }
    }
};