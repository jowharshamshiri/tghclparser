export default {
	input: 'terragrunt.peggy',
	output: 'terragrunt-parser.js',
	format: 'es',
	dts: true,
	trace: false,
	cache: false,
	// Define output types for each grammar rule
	returnTypes: {
	  Start: 'TerragruntConfig',
	  Block: 'BlockDefinition',
	  Pair: 'KeyValuePair',
	  Value: 'ConfigValue',
	  StringLiteral: 'string',
	  Number: 'number',
	  Boolean: 'boolean',
	  Array: 'ConfigValue[]',
	  Expression: 'string',
	  FunctionCall: 'string',
	  Identifier: 'string',
	},
	// This creates a wrapper module that exports both the parser and types
	header: `
		// Generated TypeScript interfaces
		export interface TerragruntConfig {
		  [key: string]: any;
		}
	
		export interface BlockDefinition {
		  key: string;
		  value: Record<string, ConfigValue>;
		}
	
		export interface KeyValuePair {
		  key: string;
		  value: ConfigValue;
		}
	
		export type ConfigValue = 
		  | string 
		  | number 
		  | boolean 
		  | ConfigValue[] 
		  | Record<string, ConfigValue>;
	
		export interface ParserOptions {
		  grammarSource?: string;
		  trace?: boolean;
		  [key: string]: any;
		}
	  `,
  }
  