// FunctionRegistry.ts
import type { FunctionContext, FunctionGroup, FunctionImplementation, RuntimeValue, ValueType } from "./model";
import { FunctionOperation, invokeFunctionOperation } from './function-ops';

export class FunctionRegistry {
    private functions: Map<string, FunctionImplementation>;
    private operations: Map<string, FunctionOperation>;
    private functionGroups: Map<string, FunctionGroup>;
    private static instance: FunctionRegistry;

    private constructor() {
        this.functions = new Map();
        this.operations = new Map();
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
        this.operations.set(name, new FunctionOperation(name, implementation));
    }

    registerOperation(name: string, operation: FunctionOperation): void {
        if (this.functions.has(name) || this.operations.has(name)) {
            throw new Error(`Function "${name}" is registered more than once`);
        }
        if (operation.functionName !== name) {
            throw new Error(`Function operation name mismatch: expected ${name}, got ${operation.functionName}`);
        }
        this.operations.set(name, operation);
        this.functions.set(name, async (args, context) => invokeFunctionOperation(operation, args, context));
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
        const operation = this.operations.get(name);
        if (!operation) {
            throw new Error(`Terragrunt function "${name}" is known by the language schema but has no local evaluator`);
        }
        const value = await invokeFunctionOperation(operation, args, context);
        if (!value) throw new Error(`Terragrunt function "${name}" returned no value`);
        return value;
    }

    getFunctionNames(): string[] {
        return Array.from(this.functions.keys());
    }

    hasFunction(name: string): boolean {
        return this.functions.has(name);
    }

    getFunctionOperation(name: string): FunctionOperation | undefined {
        return this.operations.get(name);
    }

    getFunctionOperations(): ReadonlyMap<string, FunctionOperation> {
        return this.operations;
    }
}
