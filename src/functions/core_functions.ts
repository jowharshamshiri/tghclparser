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
    const maxDepth = 100;
    let depth = 0;

    if (!context.fs?.access) {
        console.warn('No fs.access provided in context');
        return null;
    }

    if (!includeStart) {
        currentDir = path.dirname(currentDir);
    }

    while (depth < maxDepth) {
        try {
            const filePath = path.join(currentDir, filename);
            // console.log(`Checking directory for ${filename}:`, currentDir);
            
            // Check if file exists
            await context.fs.access(filePath);
            
            // Check if this is a project root
            const isProjectRoot = await isRoot(currentDir, context.fs);
            
            // If this is the project root or we're at filesystem root, return immediately
            if (isProjectRoot || currentDir === path.dirname(currentDir)) {
                // console.log('Found file at root:', filePath);
                return filePath;
            }
            
            // Store this as candidate but keep going up
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                // console.log('Found file at filesystem root:', filePath);
                return filePath;
            }
            currentDir = parentDir;
        } catch {
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) {
                return null;
            }
            currentDir = parentDir;
        }
        depth++;
    }
    
    return null;
}
// Helper function to detect if a directory is the root of our project
async function isRoot(dir: string, fs: { access: (path: string) => Promise<void> }): Promise<boolean> {
    try {
        // Try to access a combination of files that would indicate this is our project root
        await fs.access(path.join(dir, '.git'));
        return true;
    } catch {
        try {
            // Check for terragrunt.hcl and no parent terragrunt.hcl
            const hasTerragrunt = await fs.access(path.join(dir, 'terragrunt.hcl'));
            const parentDir = path.dirname(dir);
            if (parentDir === dir) {
                return hasTerragrunt !== undefined;
            }
            try {
                await fs.access(path.join(parentDir, 'terragrunt.hcl'));
                return false;
            } catch {
                return hasTerragrunt !== undefined;
            }
        } catch {
            return false;
        }
    }
}
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
            
            const parentTerragruntDir = await findParentWithFile(currentDir, 'terragrunt.hcl', context, false);
            if (!parentTerragruntDir) {
                throw new Error('No parent terragrunt.hcl file found');
            }
            
            return makeStringValue(parentTerragruntDir);
        },

        path_relative_to_include: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!context.includedFrom) {
                throw new Error('path_relative_to_include can only be called from an included config');
            }
            
            const currentPath = path.dirname(URI.parse(context.document.uri).fsPath);
            const includedFromPath = path.dirname(URI.parse(context.includedFrom).fsPath);
            
            // Get the relative path from the included config to the current config
            const relativePath = path.relative(includedFromPath, currentPath);
            return makeStringValue(relativePath || '.');
        },

        path_relative_from_include: async (
            _args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!context.includedFrom) {
                throw new Error('path_relative_from_include can only be called from an included config');
            }
            
            const currentPath = path.dirname(URI.parse(context.document.uri).fsPath);
            const includedFromPath = path.dirname(URI.parse(context.includedFrom).fsPath);
            
            // Get the relative path from the current config to the included config
            const relativePath = path.relative(currentPath, includedFromPath);
            return makeStringValue(relativePath || '.');
        },

        find_in_parent_folders: async (
            args: RuntimeValue<ValueType>[],
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            // console.log(`find_in_parent_folders called with args:`, args);
            // console.log(`context:`, {
            //     workingDirectory: context.workingDirectory,
            //     uri: context.document.uri
            // });

            const fileToFind = args[0]?.type === 'string' ? String(args[0].value) : 'terragrunt.hcl';
            const fallback = args[1]?.type === 'string' ? String(args[1].value) : undefined;
            
            try {
                const currentDir = path.dirname(URI.parse(context.document.uri).fsPath);
                const foundDir = await findParentWithFile(currentDir, fileToFind, context, true);
                
                if (!foundDir) {
                    // console.log(`No parent directory found containing:`, fileToFind);
                    if (fallback !== undefined) {
                        return makeStringValue(fallback);
                    }
                    throw new Error(`Could not find ${fileToFind} in parent folders`);
                }
                
                // const result = path.join(foundDir, fileToFind);
                // console.log(`Found file at:`, foundDir);
                return makeStringValue(foundDir);
            } catch (error) {
                // console.error(`Error in find_in_parent_folders:`, error);
                if (fallback !== undefined) {
                    return makeStringValue(fallback);
                }
                throw error;
            }
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