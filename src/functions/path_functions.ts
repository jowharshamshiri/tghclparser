import path from 'node:path';

import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeStringValue } from './utils';

export const pathFunctionGroup = {
    namespace: 'path',
    functions: {
        join: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            const paths = args
                .filter(arg => arg.type === 'string')
                .map(arg => arg.value as string);
            if (paths.length === 0) {
                throw new Error('path.join requires at least one string argument');
            }
            return makeStringValue(path.join(...paths));
        },
        
        dirname: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('path.dirname requires a string argument');
            }
            return makeStringValue(path.dirname(args[0].value as string));
        },
        
        basename: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('path.basename requires a string argument');
            }
            const filePath = args[0].value as string;
            const ext = args[1]?.type === 'string' ? args[1].value as string : undefined;
            return makeStringValue(path.basename(filePath, ext));
        },
        
        extname: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('path.extname requires a string argument');
            }
            return makeStringValue(path.extname(args[0].value as string));
        }
    }
};