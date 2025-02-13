import type { FunctionContext, RuntimeValue, ValueType } from '../model';
import { makeBooleanValue, makeStringValue } from './utils';

export const envFunctionGroup = {
    namespace: 'env',
    functions: {
        get: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('env.get requires a string argument');
            }
            const varName = args[0].value as string;
            const defaultValue = args[1]?.type === 'string' ? args[1].value as string : undefined;

            // First check context.environmentVariables (for testing/overrides)
            if (context.environmentVariables && varName in context.environmentVariables) {
                return makeStringValue(context.environmentVariables[varName] ?? defaultValue ?? '');
            }

            // Then check actual process.env
            return makeStringValue(process.env[varName] ?? defaultValue ?? '');
        },

        has: async (
            args: RuntimeValue<ValueType>[], 
            context: FunctionContext
        ): Promise<RuntimeValue<ValueType>> => {
            if (!args[0] || args[0].type !== 'string') {
                throw new Error('env.has requires a string argument');
            }
            const varName = args[0].value as string;
            
            // Check both context.environmentVariables and process.env
            const exists = (context.environmentVariables && varName in context.environmentVariables) || 
                          varName in process.env;
            
            return makeBooleanValue(exists);
        }
    }
};