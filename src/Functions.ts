import path from 'node:path';

import type { FunctionContext, FunctionGroup, FunctionImplementation, RuntimeValue, ValueType } from './model';


export class FunctionRegistry {
	private static instance: FunctionRegistry;
	private functions: Map<string, FunctionImplementation>;
	private functionGroups: Map<string, FunctionGroup>;

	private constructor() {
		this.functions = new Map();
		this.functionGroups = new Map();
		this.registerBuiltinFunctions();
	}

	static getInstance(): FunctionRegistry {
		if (!FunctionRegistry.instance) {
			FunctionRegistry.instance = new FunctionRegistry();
		}
		return FunctionRegistry.instance;
	}

	registerFunction(name: string, implementation: FunctionImplementation) {
		this.functions.set(name, implementation);
	}

	registerFunctionGroup(group: FunctionGroup) {
		this.functionGroups.set(group.namespace, group);
		Object.entries(group.functions).forEach(([name, impl]) => {
			this.registerFunction(`${group.namespace}.${name}`, impl);
		});
	}

	unregisterFunction(name: string) {
		this.functions.delete(name);
	}

	unregisterFunctionGroup(namespace: string) {
		const group = this.functionGroups.get(namespace);
		if (group) {
			Object.keys(group.functions).forEach(name => {
				this.unregisterFunction(`${namespace}.${name}`);
			});
			this.functionGroups.delete(namespace);
		}
	}

	async evaluateFunction(
		name: string,
		args: RuntimeValue<ValueType>[],
		context: FunctionContext
	): Promise<RuntimeValue<ValueType> | undefined> {
		const implementation = this.functions.get(name);
		if (!implementation) {
			console.warn(`Function "${name}" not implemented`);
			return undefined;
		}

		try {
			return await implementation(args, context);
		} catch (error) {
			console.error(`Error evaluating function "${name}":`, error);
			return undefined;
		}
	}

	hasFunction(name: string): boolean {
		return this.functions.has(name);
	}

	getFunctionNames(): string[] {
		return Array.from(this.functions.keys());
	}

	getNamespaces(): string[] {
		return Array.from(this.functionGroups.keys());
	}

	private registerBuiltinFunctions() {
		// File operations group
		this.registerFunctionGroup({
			namespace: 'file',
			functions: {
				read: async (args, context) => {
					if (!args[0] || args[0].type !== 'string') return;
					const filePath = args[0].value as string;
					try {
						return {
							type: 'string',
							value: `Mock content for ${filePath}`
						};
					} catch (error) {
						console.error(`Error reading file ${filePath}:`, error);
						return;
					}
				},
				exists: async (args, context) => {
					if (!args[0] || args[0].type !== 'string') return;
					return {
						type: 'boolean',
						value: true // Mock implementation
					};
				}
			}
		});

		// Path operations group
		this.registerFunctionGroup({
			namespace: 'path',
			functions: {
				join: async (args) => {
					const paths = args
						.filter(arg => arg.type === 'string')
						.map(arg => arg.value as string);
					return {
						type: 'string',
						value: path.join(...paths)
					};
				},
				dirname: async (args) => {
					if (!args[0] || args[0].type !== 'string') return;
					return {
						type: 'string',
						value: path.dirname(args[0].value as string)
					};
				}
			}
		});

		// Environment and configuration functions
		this.registerFunctionGroup({
			namespace: 'env',
			functions: {
				get: async (args, context) => {
					if (!args[0] || args[0].type !== 'string') return;
					const varName = args[0].value as string;
					const defaultValue = args[1]?.type === 'string' ? args[1].value : undefined;

					return {
						type: 'string',
						value: context.environmentVariables[varName] ?? defaultValue ?? ''
					};
				},
				has: async (args, context) => {
					if (!args[0] || args[0].type !== 'string') return;
					const varName = args[0].value as string;
					return {
						type: 'boolean',
						value: varName in context.environmentVariables
					};
				}
			}
		});

		// String manipulation functions
		this.registerFunctionGroup({
			namespace: 'string',
			functions: {
				replace: async (args) => {
					if (args.length < 3 ||
						args[0].type !== 'string' ||
						args[1].type !== 'string' ||
						args[2].type !== 'string') {
						return;
					}

					return {
						type: 'string',
						value: String(args[0].value).replace(
							String(args[1].value),
							String(args[2].value)
						)
					};
				},
				format: async (args) => {
					if (!args[0] || args[0].type !== 'string') return;
					let result = args[0].value as string;
					args.slice(1).forEach((arg, i) => {
						if (arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean') {
							result = result.replace(`{${i}}`, String(arg.value));
						}
					});
					return {
						type: 'string',
						value: result
					};
				}
			}
		});
	}
}