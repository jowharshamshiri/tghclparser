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
            throw new Error(`Function "${name}" is registered more than once`);
        }
        
        this.functions.set(name, implementation);
    }

    registerFunctionGroup(group: FunctionGroup) {
        if (this.functionGroups.has(group.namespace)) {
            throw new Error(`Function group "${group.namespace}" is registered more than once`);
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
    ): Promise<RuntimeValue<ValueType>> {
        const implementation = this.functions.get(name);
        if (!implementation) {
            throw new Error(`Terragrunt function "${name}" is known by the language schema but has no local evaluator`);
        }
        const value = await implementation(args, context);
        if (!value) throw new Error(`Terragrunt function "${name}" returned no value`);
        return value;
    }

    getFunctionNames(): string[] {
        return Array.from(this.functions.keys());
    }

    hasFunction(name: string): boolean {
        return this.functions.has(name);
    }
}
