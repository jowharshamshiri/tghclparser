import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeStringValue } from './utils';

export const stringFunctionGroup = {
    namespace: 'string',
    functions: {
        replace: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (args.length < 3 ||
                args[0].type !== 'string' ||
                args[1].type !== 'string' ||
                args[2].type !== 'string') {
                throw new Error('string.replace requires three string arguments: string, search, replace');
            }

            const str = String(args[0].value);
            const search = String(args[1].value);
            const replace = String(args[2].value);

            // Support regex if the search string appears to be a regex
            if (search.startsWith('/') && /\/[gimsuy]*$/.test(search)) {
                try {
                    const flags = search.match(/\/([gimsuy]*)$/)?.[1] || '';
                    const pattern = search.replaceAll(/^\/|\/[gimsuy]*$/g, '');
                    const regex = new RegExp(pattern, flags);
                    return makeStringValue(str.replace(regex, replace));
                } catch (error) {
                    console.error('Invalid regex pattern:', error);
                    return makeStringValue(str.replace(search, replace));
                }
            }

            return makeStringValue(str.replace(search, replace));
        },

        format: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('string.format requires a string as first argument');
            }
            let result = args[0].value as string;
            
            // Support both numbered {0} and named {name} placeholders
            const namedPlaceholders = result.match(/\{([^0-9}][^}]*)\}/g);
            const numberedPlaceholders = result.match(/\{(\d+)\}/g);

            if (namedPlaceholders) {
                // Create a map of named arguments
                const argsMap = new Map<string, string>();
                args.slice(1).forEach(arg => {
                    if (arg.type === 'object' && arg.value instanceof Map) {
                        arg.value.forEach((val, key) => {
                            if (typeof val.value === 'string' || typeof val.value === 'number' || typeof val.value === 'boolean') {
                                argsMap.set(key, String(val.value));
                            }
                        });
                    }
                });

                // Replace named placeholders
                namedPlaceholders.forEach(placeholder => {
                    const key = placeholder.slice(1, -1);
                    const value = argsMap.get(key) || '';
                    result = result.replace(placeholder, value);
                });
            } else if (numberedPlaceholders) {
                // Replace numbered placeholders
                args.slice(1).forEach((arg, i) => {
                    if (arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean') {
                        result = result.replaceAll(new RegExp(`\\{${i}\\}`, 'g'), String(arg.value));
                    }
                });
            }

            return makeStringValue(result);
        },

        trim: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('string.trim requires a string argument');
            }
            return makeStringValue((args[0].value as string).trim());
        },

        upper: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('string.upper requires a string argument');
            }
            return makeStringValue((args[0].value as string).toUpperCase());
        },

        lower: async (
            args: RuntimeValue<ValueType>[], 
            _context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('string.lower requires a string argument');
            }
            return makeStringValue((args[0].value as string).toLowerCase());
        }
    }
};