import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import blocks from './blocks.json';
import { FunctionRegistry } from './Functions';
import functionsJson from './functions.json';
import { functions as coreFunctions } from './functions/core_functions';
import type { AttributeDefinition, BlockDefinition, FunctionDefinition, FunctionGroup, FunctionImplementation, FunctionParameter, RuntimeValue, ValueType } from './model';

const functions = functionsJson as { functions: FunctionDefinition[] };

export class Schema {
	private static instance: Schema;
	private functionRegistry: FunctionRegistry;

	private constructor() {
		console.log('\nInitializing Schema and discovering functions...\n');
		this.functionRegistry = FunctionRegistry.getInstance();
		this.initializeFunctionRegistry();
		this.discoverCustomFunctions().then(() => {
			// Get functions that have actual implementations
			const registry = this.getFunctionRegistry();
			const executableFunctions = new Set<string>();

			// Add built-in functions from FunctionRegistry
			const builtInGroups = new Map<string, string[]>();
			builtInGroups.set('file', ['read', 'exists']);
			builtInGroups.set('path', ['join', 'dirname']);
			builtInGroups.set('env', ['get', 'has']);
			builtInGroups.set('string', ['replace', 'format']);

			// Add core terragrunt functions that have implementations
			const coreFunctions = [
				'find_in_parent_folders',
				'path_relative_to_include',
				'path_relative_from_include',
				'get_env',
				'run_cmd',
				'get_platform',
				'get_repo_root',
				'get_path_from_repo_root',
				'get_path_to_repo_root',
				'get_terragrunt_dir',
				'get_parent_terragrunt_dir',
				'get_original_terragrunt_dir'
			];

			// Add implementated functions to the set
			coreFunctions.forEach(f => executableFunctions.add(f));
			builtInGroups.forEach((funcs, namespace) => {
				funcs.forEach(f => executableFunctions.add(`${namespace}.${f}`));
			});

			console.log('Actually Implemented Functions');
			console.log('============================\n');

			// First list root-level functions
			const rootFunctions = Array.from(executableFunctions)
				.filter(name => !name.includes('.'))
				.sort();

			if (rootFunctions.length > 0) {
				console.log('Root Functions:');
				console.log('--------------\n');
				rootFunctions.forEach(name => {
					const funcDef = this.getFunctionDefinition(name);
					if (funcDef) {
						console.log(`  ${name}`);
						console.log(`    ${funcDef.description}\n`);
					} else {
						console.log(`  ${name}`);
						console.log(`    [Has implementation but needs documentation]\n`);
					}
				});
			}

			// Then list namespaced functions
			const groups = Array.from(builtInGroups.keys()).sort();

			if (groups.length > 0) {
				console.log('\nNamespaced Functions:');
				console.log('-------------------\n');
				groups.forEach(namespace => {
					console.log(`${namespace}:`);
					const namespacedFuncs = Array.from(executableFunctions)
						.filter(name => name.startsWith(`${namespace}.`))
						.map(name => name.split('.')[1])
						.sort();

					namespacedFuncs.forEach(shortName => {
						const fullName = `${namespace}.${shortName}`;
						const funcDef = this.getFunctionDefinition(fullName);
						if (funcDef) {
							console.log(`  ${shortName}`);
							console.log(`    ${funcDef.description}\n`);
						} else {
							console.log(`  ${shortName}`);
							console.log(`    [Has implementation but needs documentation]\n`);
						}
					});
					console.log('');
				});
			}

			const totalFuncs = executableFunctions.size;
			console.log('============================');
			console.log(`Total implemented functions: ${totalFuncs}`);
			console.log('============================\n');
		});
	}
	static getInstance(): Schema {
		if (!Schema.instance) {
			Schema.instance = new Schema();
		}
		return Schema.instance;
	}

	findNestedBlockTemplate(parentType: string, nestedType: string): BlockDefinition | undefined {
		const parent = this.getBlockDefinition(parentType);
		if (!parent?.blocks) return undefined;

		return this.findBlockInHierarchy(parent.blocks, nestedType);
	}

	private findBlockInHierarchy(blocks: BlockDefinition[], type: string): BlockDefinition | undefined {
		for (const block of blocks) {
			if (block.type === type) return block;

			if (block.blocks) {
				const found = this.findBlockInHierarchy(block.blocks, type);
				if (found) return found;
			}
		}
		return undefined;
	}

	validateBlockType(type: string, parentType?: string): boolean {
		if (parentType) {
			return !!this.findNestedBlockTemplate(parentType, type);
		}
		return !!this.getBlockDefinition(type);
	}

	getBlockDefinition(type: string): BlockDefinition | undefined {
		const result = blocks.blocks.find(b => b.type === type) as BlockDefinition;
		return result ?? undefined;
	}

	getAllBlockTemplates(): BlockDefinition[] {
		return blocks.blocks.map(block =>
			this.getBlockDefinition(block.type)
		).filter((block): block is BlockDefinition => block !== undefined);
	}

	getAllFunctions(): FunctionDefinition[] {
		return functions.functions;
	}

	getFunctionDefinition(name: string): FunctionDefinition | undefined {
		return functions.functions.find(f => f.name === name);
	}

	getFunctionSignature(func: FunctionDefinition): string {
		const params = func.parameters.map(p =>
			`${p.name}${p.required ? '' : '?'}: ${p.types.join(' | ')}`
		).join(', ');
		return `${func.name}(${params}): ${func.returnType.types.join(' | ')}`;
	}

	generateFunctionSnippet(func: FunctionDefinition): string {
		const params = func.parameters
			.map((p, i) => `\${${i + 1}:${p.name}}`)
			.join(', ');
		return `${func.name}(${params})`;
	}

	generateBlockSnippet(template: BlockDefinition): string {
		let snippet = `${template.type} {\n`;
		if (template.attributes) {
			template.attributes
				.filter(attr => attr.required)
				.forEach((attr, i) => {
					snippet += `\t${attr.name} = \${${i + 1}}\n`;
				});
		}
		snippet += '}';
		return snippet;
	}

	generateAttributeSnippet(attr: AttributeDefinition): string {
		const typeMap: Record<ValueType, string> = {
			string: `"\${1:string}"`,
			number: `\${1:0}`,
			boolean: `\${1:true}`,
			null: 'null',
			array: `[\${1:items}]`,
			object: `{\n\t\${1:key} = \${2:value}\n}`,
			function: `\${1:func}()`,
			block: `{\n\t\${1}\n}`,
			ternary: `\${1:condition} ? \${2:true} : \${3:false}`,
			comparison: `\${1:left} \${2:==} \${3:right}`,
			logical: `\${1:left} \${2:&&} \${3:right}`,
			arithmetic: `\${1:left} \${2:+} \${3:right}`,
			null_coalescing: `\${1:left} ?? \${2:right}`,
			unary: `!\${1:expr}`,
			postfix: `\${1:expr}[*]`,
			pipe: `\${1:expr} | \${2:func}`,
			list_comprehension: `[\${1:expr} for \${2:item} in \${3:list}]`,
			map_comprehension: `{\${1:key} = \${2:value} for \${3:item} in \${4:list}}`,
			interpolation: `\${\${1:expr}}`,
			reference: `\${1:ref}`,
			type_constructor: `type(\${1:args})`,
			collection_constructor: `collection(\${1:args})`,
			directive: `@directive(\${1:args})`,
			meta_argument: `meta(\${1:args})`,
			legacy_interpolation: `{{\${1:expr}}}`
		};

		// Find the first supported type or fall back to string
		const type = attr.types.find(t => t in typeMap) || 'string';
		return `${attr.name} = ${typeMap[type]}`;
	}

	validateBlockAttributes(blockType: string, attributes: Record<string, any>): boolean {
		const template = this.getBlockDefinition(blockType);
		if (!template) return false;

		// If the block allows arbitrary attributes, all attribute combinations are valid
		if (template.arbitraryAttributes) return true;

		// Check that all required attributes are present
		const requiredAttrs = template.attributes?.filter(attr => attr.required) || [];
		for (const attr of requiredAttrs) {
			if (!(attr.name in attributes)) {
				return false;
			}
		}

		// Check that all present attributes are defined in the schema
		for (const attrName of Object.keys(attributes)) {
			if (!template.attributes?.some(attr => attr.name === attrName)) {
				return false;
			}
		}

		return true;
	}

	validateFunctionCall(funcName: string, args: any[]): boolean {
		const funcDef = this.getFunctionDefinition(funcName);
		if (!funcDef) return false;

		// Check required parameters
		const requiredParams = funcDef.parameters.filter(param => param.required);
		if (args.length < requiredParams.length) {
			return false;
		}

		// Check if too many arguments (unless the last parameter is variadic)
		const lastParam = funcDef.parameters.at(-1);
		if (!lastParam?.variadic && args.length > funcDef.parameters.length) {
			return false;
		}

		return true;
	}

	validateAttributeValue(blockType: string, attrName: string, value: any): boolean {
		const template = this.getBlockDefinition(blockType);
		if (!template) return false;

		const attr = template.attributes?.find(a => a.name === attrName);
		if (!attr) return template.arbitraryAttributes || false;

		// Check if value type matches any of the allowed types
		const isValidType = attr.types.some(type => {
			switch (type) {
				case 'string': {
					return typeof value === 'string' &&
						(!attr.validation?.pattern || new RegExp(attr.validation.pattern).test(value));
				}
				case 'number': {
					return typeof value === 'number' &&
						(!attr.validation?.min || value >= attr.validation.min) &&
						(!attr.validation?.max || value <= attr.validation.max);
				}
				case 'boolean': {
					return typeof value === 'boolean';
				}
				case 'array': {
					return Array.isArray(value);
				}
				case 'object': {
					return typeof value === 'object' && value !== null && !Array.isArray(value);
				}
				case 'null': {
					return value === null;
				}
				// Add other type validations as needed
				default: {
					return false;
				}
			}
		});

		if (!isValidType) return false;

		// Check allowed values if specified
		if (attr.validation?.allowedValues && !attr.validation.allowedValues.includes(value)) {
			return false;
		}

		// Run custom validator if provided
		if (attr.validation?.customValidator && !attr.validation.customValidator(value)) {
			return false;
		}

		return true;
	}

	getFunctionRegistry(): FunctionRegistry {
		return this.functionRegistry;
	}

	/**
	 * Initializes function registry with schema functions.
	 * Should be called after Schema instance is created.
	 */
	initializeFunctionRegistry(): void {
        // First register core functions directly
        Object.entries(coreFunctions).forEach(([name, implementation]) => {
            console.log(`Registering core function: ${name}`);
            this.functionRegistry.registerFunction(name, implementation);
        });

        // Register any additional functions from the schema
        functions.functions.forEach(funcDef => {
            console.log(`Registering schema function: ${funcDef.name}`);
            // Only register if not already registered as a core function
            if (!this.functionRegistry.hasFunction(funcDef.name)) {
                this.registerSchemaFunction(funcDef);
            }
        });

        // Log registered functions
        console.log('Registered functions:', this.functionRegistry.getFunctionNames());
    }

	private registerSchemaFunction(funcDef: FunctionDefinition): void {
		// Create an implementation that validates args against the schema
		const implementation: FunctionImplementation = async (args, context) => {
			// Validate required parameters
			const requiredParams = funcDef.parameters.filter(p => p.required);
			if (args.length < requiredParams.length) {
				console.error(`Function ${funcDef.name} requires at least ${requiredParams.length} parameters`);
				return;
			}

			// Validate parameter types
			for (let i = 0; i < funcDef.parameters.length; i++) {
				const param = funcDef.parameters[i];
				const arg = args[i];

				if (arg && !param.types.includes(arg.type)) {
					console.error(`Parameter ${param.name} of function ${funcDef.name} expects types ${param.types.join('|')}, got ${arg.type}`);
					return;
				}

				if (param.validation) {
					const valid = this.validateFunctionParameter(arg, param.validation);
					if (!valid) {
						console.error(`Parameter ${param.name} of function ${funcDef.name} failed validation`);
						return;
					}
				}
			}

			// If no custom implementation exists, return a default value based on return type
			const defaultValue = this.createDefaultValue(funcDef.returnType.types[0]);
			return defaultValue;
		};

		this.functionRegistry.registerFunction(funcDef.name, implementation);
	}

	private validateFunctionParameter(value: RuntimeValue<ValueType>, validation: any): boolean {
		if (!value) return false;

		if (validation.pattern && value.type === 'string') {
			const pattern = new RegExp(validation.pattern);
			return pattern.test(value.value as string);
		}

		if (validation.min !== undefined && value.type === 'number' && (value.value as number) < validation.min) return false;

		if (validation.max !== undefined && value.type === 'number' && (value.value as number) > validation.max) return false;

		if (validation.allowedValues && validation.allowedValues.length > 0) {
			return validation.allowedValues.includes(value.value);
		}

		return true;
	}

	private createDefaultValue(type: ValueType): RuntimeValue<ValueType> {
		switch (type) {
			case 'string': {
				return { type: 'string', value: '' };
			}
			case 'number': {
				return { type: 'number', value: 0 };
			}
			case 'boolean': {
				return { type: 'boolean', value: false };
			}
			case 'array': {
				return { type: 'array', value: [] };
			}
			case 'object': {
				return { type: 'object', value: new Map() };
			}
			default: {
				return { type: 'null', value: null };
			}
		}
	}
	private async discoverCustomFunctions(): Promise<void> {
		try {
			// Get the directory path in a way that works in both ESM and CommonJS
			let functionsDir: string;
			
			if (typeof __dirname !== 'undefined') {
				// CommonJS environment
				functionsDir = path.join(__dirname, 'functions');
			} else if (import.meta.url !== undefined) {
				// ESM environment
				const __filename = fileURLToPath(import.meta.url);
				const __dirname = path.dirname(__filename);
				functionsDir = path.join(__dirname, 'functions');
			} else {
				// If neither is available, use a reasonable default
				console.log('Unable to determine functions directory path, skipping custom functions');
				return;
			}
	
			// Check if the functions directory exists
			if (!fs.existsSync(functionsDir)) {
				console.log('No custom functions directory found at:', functionsDir);
				return;
			}
	
			// Read all files in the functions directory
			const files = fs.readdirSync(functionsDir);
	
			// Filter for TypeScript files
			const tsFiles = files.filter(file =>
				file.endsWith('.ts') && !file.startsWith('.')
			);
	
			// Import and register each TypeScript function file
			for (const file of tsFiles) {
				try {
					const filePath = path.join(functionsDir, file);
					console.log('Loading functions from:', filePath);
	
					// Convert the file path to a URL for import
					const fileUrl = `file://${filePath}`;
	
					// Import the module using dynamic import
					const importedModule = await import(fileUrl);
	
					// Check for function definitions
					const functionDefinitions = importedModule.functionDefinitions || [];
	
					// Check for implementations
					const functionImplementations = importedModule.functions || {};
	
					if (functionDefinitions.length > 0 || Object.keys(functionImplementations).length > 0) {
						const namespace = path.basename(file, '.ts');
						console.log('Registering functions from namespace:', namespace);
	
						const functionGroup: FunctionGroup = {
							namespace,
							functions: {}
						};
	
						// Register functions from definitions
						functionDefinitions.forEach(funcDef => {
							const implementation: FunctionImplementation = async (args, context) => {
								// Validate args against function definition
								this.validateFunctionArgs(funcDef, args);
	
								// If a matching implementation exists, use it
								const explicitImpl = functionImplementations[funcDef.name];
								if (explicitImpl) {
									return explicitImpl(args, context);
								}
	
								// Otherwise, return a default value based on return type
								return this.createDefaultReturnValue(funcDef.returnType.types[0]);
							};
	
							functionGroup.functions[funcDef.name] = implementation;
						});
	
						// Register additional implementations
						Object.entries(functionImplementations).forEach(([name, impl]) => {
							if (!functionGroup.functions[name]) {
								functionGroup.functions[name] = impl as FunctionImplementation;
							}
						});
	
						console.log('Registering function group:', functionGroup);
						this.functionRegistry.registerFunctionGroup(functionGroup);
					}
				} catch (importError) {
					console.error(`Error importing custom functions from ${file}:`, importError);
					console.error('Import error details:', importError);
				}
			}
		} catch (error) {
			console.error('Error discovering custom functions:', error);
		}
	}

	// Helper method to validate function arguments
	private validateFunctionArgs(
		funcDef: FunctionDefinition,
		args: RuntimeValue<ValueType>[]
	): void {
		// Check required parameters
		const requiredParams = funcDef.parameters.filter(p => p.required);
		if (args.length < requiredParams.length) {
			throw new Error(`Function ${funcDef.name} requires at least ${requiredParams.length} parameters`);
		}

		// Validate parameter types
		funcDef.parameters.forEach((param, index) => {
			const arg = args[index];
			if (arg) {
				// Check if argument type matches any of the allowed types
				if (!param.types.includes(arg.type)) {
					throw new Error(`Parameter ${param.name} expects types ${param.types.join('|')}, got ${arg.type}`);
				}

				// Additional validation if needed (pattern, min/max, allowed values)
				this.validateParameterValue(param, arg);
			}
		});
	}

	// Helper method to validate individual parameter values
	private validateParameterValue(
		param: FunctionParameter,
		value: RuntimeValue<ValueType>
	): void {
		const { validation } = param;
		if (!validation) return;

		// Pattern validation for string types
		if (validation.pattern && value.type === 'string') {
			const pattern = new RegExp(validation.pattern);
			if (!pattern.test(value.value as string)) {
				throw new Error(`Parameter ${param.name} does not match required pattern`);
			}
		}

		// Min/max validation for number types
		if (value.type === 'number') {
			const numValue = value.value as number;
			if (validation.min !== undefined && numValue < validation.min) {
				throw new Error(`Parameter ${param.name} must be at least ${validation.min}`);
			}
			if (validation.max !== undefined && numValue > validation.max) {
				throw new Error(`Parameter ${param.name} must be at most ${validation.max}`);
			}
		}

		// Allowed values validation
		if (validation.allowedValues &&
			!validation.allowedValues.includes(value.value)) {
			throw new Error(`Parameter ${param.name} must be one of: ${validation.allowedValues.join(', ')}`);
		}
	}

	// Helper method to create a default return value
	private createDefaultReturnValue(type: ValueType): RuntimeValue<ValueType> {
		switch (type) {
			case 'string': {
				return { type: 'string', value: '' };
			}
			case 'number': {
				return { type: 'number', value: 0 };
			}
			case 'boolean': {
				return { type: 'boolean', value: false };
			}
			case 'array': {
				return { type: 'array', value: [] };
			}
			case 'object': {
				return { type: 'object', value: new Map() };
			}
			default: {
				return { type: 'null', value: null };
			}
		}
	}
}