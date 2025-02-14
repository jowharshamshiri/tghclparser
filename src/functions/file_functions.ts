import fs from 'node:fs/promises';

import yaml from 'js-yaml';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeBooleanValue, makeStringValue } from './utils';

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

            const filePath = args[0].value as string;

            try {
                // Read the file content
                const content = await fs.readFile(filePath, 'utf8');
                return makeStringValue(content);
            } catch (error) {
                console.error(`Error reading file ${filePath}:`, error);
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
                console.error('Error parsing YAML:', error);
                throw new Error(`Error parsing YAML: ${error}`);
            }
        },
        read: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('file.read requires a string argument');
            }
            const filePath = args[0].value as string;
            try {
                const content = await fs.readFile(filePath, 'utf8');
                return makeStringValue(content);
            } catch (error) {
                console.error(`Error reading file ${filePath}:`, error);
                throw new Error(`Error reading file ${filePath}: ${error}`);
            }
        },

        exists: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('file.exists requires a string argument');
            }
            const filePath = args[0].value as string;
            try {
                await fs.access(filePath);
                return makeBooleanValue(true);
            } catch {
                return makeBooleanValue(false);
            }
        }
    }
};

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