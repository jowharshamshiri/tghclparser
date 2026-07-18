// FunctionRegistry.ts
import type { FunctionContext, FunctionGroup, FunctionImplementation, RuntimeValue, ValueType } from "./model";

export class FunctionRegistry {
    private functions: Map<string, FunctionImplementation>;
    private functionGroups: Map<string, FunctionGroup>;
    private static instance: FunctionRegistry;

    private constructor() {
        this.functions = new Map();
        this.functionGroups = new Map();
    }

    static getInstance(): FunctionRegistry {
        if (!FunctionRegistry.instance) {
            FunctionRegistry.instance = new FunctionRegistry();
        }
        return FunctionRegistry.instance;
    }

    registerFunction(name: string, implementation: FunctionImplementation) {
        if (this.functions.has(name)) {
            return;
        }
        
        this.functions.set(name, implementation);
    }

    registerFunctionGroup(group: FunctionGroup) {
        if (this.functionGroups.has(group.namespace)) {
            console.log(`Function group ${group.namespace} already registered`);
            return;
        }

        this.functionGroups.set(group.namespace, group);
        
        // Register each function with its namespace
        Object.entries(group.functions).forEach(([name, impl]) => {
            this.registerFunction(name, impl);
        });
    }

    async evaluateFunction(
        name: string,
        args: RuntimeValue<ValueType>[],
        context: FunctionContext
    ): Promise<RuntimeValue<ValueType> | undefined> {
		// console.log(`Evaluating function "${name}" with args:`, args,context);
        const implementation = this.functions.get(name);
        if (!implementation) {
            console.warn(`Function "${name}" not implemented`);
            return undefined;
        }

        try {
            return await implementation(args, context);
        } catch (error) {
            console.error(`Error evaluating function "${name}":`, error);
            throw error;
        }
    }

    getFunctionNames(): string[] {
        return Array.from(this.functions.keys());
    }

    hasFunction(name: string): boolean {
        return this.functions.has(name);
    }
}