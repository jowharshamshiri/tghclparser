import fs from 'node:fs/promises';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeBooleanValue, makeStringValue } from './utils';

export const fileFunctionGroup = {
    namespace: 'file',
    functions: {
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