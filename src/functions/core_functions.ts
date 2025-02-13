import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FunctionContext, FunctionDefinition, RuntimeValue, ValueType } from '../model';

// Helper to create a string runtime value
const makeStringValue = (value: string): RuntimeValue<'string'> => ({
  type: 'string',
  value
});

// Function definitions that match the Go implementations
export const functionDefinitions: FunctionDefinition[] = [
  {
    name: 'find_in_parent_folders',
    description: 'Find a file in parent folders working up from the current Terragrunt configuration file',
    parameters: [
      {
        name: 'fileToFind',
        types: ['string'],
        required: false,
        description: 'The name of the file to find. If empty, will look for terragrunt.hcl'
      },
      {
        name: 'fallback',
        types: ['string'],
        required: false,
        description: 'The fallback value to return if the file is not found'
      }
    ],
    returnType: {
      types: ['string'],
      description: 'The path to the found file or the fallback value'
    }
  },
  {
    name: 'path_relative_to_include',
    description: 'Returns the relative path between the included config file and current config file',
    parameters: [
      {
        name: 'includeName',
        types: ['string'],
        required: false,
        description: 'The name of the include block to use when multiple includes exist'
      }
    ],
    returnType: {
      types: ['string'],
      description: 'The relative path'
    }
  },
  {
    name: 'get_env',
    description: 'Get an environment variable value',
    parameters: [
      {
        name: 'envName',
        types: ['string'],
        required: true,
        description: 'The name of the environment variable'
      },
      {
        name: 'defaultValue',
        types: ['string'],
        required: false,
        description: 'The default value if env var is not set'
      }
    ],
    returnType: {
      types: ['string'],
      description: 'The environment variable value or default'
    }
  },
  {
    name: 'get_platform',
    description: 'Get the current operating system platform',
    parameters: [],
    returnType: {
      types: ['string'],
      description: 'The OS platform (e.g., linux, darwin, windows)'
    }
  },
  {
    name: 'get_terragrunt_dir',
    description: 'Get the directory where the Terragrunt configuration file lives',
    parameters: [],
    returnType: {
      types: ['string'],
      description: 'The absolute path to the Terragrunt config directory'
    }
  }
];

// Function implementations
export const functions = {
  
  // find_in_parent_folders implementation
  async find_in_parent_folders(
    args: RuntimeValue<ValueType>[],
    context: FunctionContext
  ): Promise<RuntimeValue<ValueType>> {
    const configPath = context.document.uri;
    const fileToFind = args[0]?.type === 'string' ? String(args[0].value) : 'terragrunt.hcl';
    const fallback = args[1]?.type === 'string' ? String(args[1].value) : undefined;

    let currentDir = path.dirname(configPath);
    const maxDepth = 100; // Prevent infinite loops
    let depth = 0;

    while (depth < maxDepth) {
      const filePath = path.join(currentDir, fileToFind);
      try {
        await fs.access(filePath);
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
  },

  // get_env implementation
  async get_env(
    args: RuntimeValue<ValueType>[],
    context: FunctionContext
  ): Promise<RuntimeValue<ValueType>> {
    if (args.length === 0 || args[0].type !== 'string') {
      throw new Error('get_env requires at least one string argument');
    }

    const envName = String(args[0].value);
    const defaultValue = args[1]?.type === 'string' ? String(args[1].value) : '';

    const envValue = context.environmentVariables[envName];
    return makeStringValue(envValue ?? defaultValue);
  },

  // get_platform implementation 
  async get_platform(
    _args: RuntimeValue<ValueType>[],
    _context: FunctionContext
  ): Promise<RuntimeValue<ValueType>> {
    return makeStringValue(os.platform());
  },

  // get_terragrunt_dir implementation
  async get_terragrunt_dir(
    _args: RuntimeValue<ValueType>[],
    context: FunctionContext
  ): Promise<RuntimeValue<ValueType>> {
    return makeStringValue(path.dirname(context.document.uri));
  },

  // path_relative_to_include implementation
  async path_relative_to_include(
    _args: RuntimeValue<ValueType>[],
    _context: FunctionContext
  ): Promise<RuntimeValue<ValueType>> {
    // This requires access to the include context, which should be passed in context
    // For now returning current directory as placeholder
    return makeStringValue('.');
  }
};

// Check if path exists
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}