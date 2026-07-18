import fs from 'node:fs/promises';
import path from 'node:path';

import yaml from 'js-yaml';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeStringValue } from './utils';

export const fileFunctionGroup = {
    namespace: 'file',
    functions: {
		file: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('file() requires a string argument');
            }

			const filePath = resolveFilePath(args[0].value as string, context);

            try {
                // Read the file content
                const content = await fs.readFile(filePath, 'utf8');
                return makeStringValue(content);
			} catch (error) {
				throw new Error(`Error reading file ${filePath}: ${error}`);
            }
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
                // Parse YAML content
                const parsed = yaml.load(yamlContent);

                // Convert the parsed YAML to a RuntimeValue
                return convertToRuntimeValue(parsed);
			} catch (error) {
                throw new Error(`Error parsing YAML: ${error}`);
            }
        },
	}
};

function resolveFilePath(filePath: string, context: FunctionContext): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(context.workingDirectory, filePath);
}

function convertToRuntimeValue(value: any): RuntimeValue<ValueType> {
    if (typeof value === 'string') {
        return { type: 'string', value };
    }
    if (typeof value === 'number') {
        return { type: 'number', value };
    }
    if (typeof value === 'boolean') {
        return { type: 'boolean', value };
    }
    if (value === null) {
        return { type: 'null', value: null };
    }
    if (Array.isArray(value)) {
        return {
            type: 'array',
            value: value.map(v => convertToRuntimeValue(v))
        };
    }
    if (typeof value === 'object') {
        const map = new Map<string, RuntimeValue<ValueType>>();
        for (const [k, v] of Object.entries(value)) {
            map.set(k, convertToRuntimeValue(v));
        }
        return { type: 'object', value: map };
    }
    
    // Default case
    return { type: 'null', value: null };
}
