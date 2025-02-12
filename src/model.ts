import type { Position } from 'vscode-languageserver';

import type { LocationRange } from './terragrunt-parser';

export class AnError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TGLS Error";
	}
}

export type TokenType =
	| 'root'
	| 'block'
	| 'identifier'
	| 'block_identifier'
	| 'root_assignment_identifier'
	| 'attribute_identifier'
	| 'reference_identifier'
	| 'function_identifier'
	| 'parameter'
	| 'attribute'
	| 'string_lit'
	| 'number_lit'
	| 'boolean_lit'
	| 'array_lit'
	| 'object'
	| 'reference'
	| 'interpolation'
	| 'ternary_expression'
	| 'comparison_expression'
	| 'logical_expression'
	| 'arithmetic_expression'
	| 'null_coalescing'
	| 'unary_expression'
	| 'postfix_expression'
	| 'pipe_expression'
	| 'list_comprehension'
	| 'map_comprehension'
	| 'function_call'
	| 'block_comment'
	| 'inline_comment'
	| 'heredoc'
	| 'whitespace'
	| 'unknown'
| 'local_reference'
| 'namespace'
| 'access_chain'
|'dependency'
|'block_identifier'
| 'interpolated_string'
|'legacy_interpolation';

export type ValueType =
	| PrimitiveValueType
	| ComplexValueType
	| ExpressionValueType;

export type PrimitiveValueType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'null';

export type ComplexValueType =
	| 'array'
	| 'object'
	| 'function'
	| 'block';

export type ExpressionValueType =
	| 'ternary'
	| 'comparison'
	| 'logical'
	| 'arithmetic'
	| 'null_coalescing'
	| 'unary'
	| 'postfix'
	| 'pipe'
	| 'list_comprehension'
	| 'map_comprehension'
	| 'interpolation'
	| 'reference';

export interface Location {
	start: {
		offset: number;
		line: number;
		column: number;
	};
	end: {
		offset: number;
		line: number;
		column: number;
	};
	source?: string;
}

export class Token {
	readonly id: number;
	type: TokenType;
	value: string | number | boolean | null;
	location: LocationRange;
	children: Token[];
	parent: Token | null;
	decorators?: TokenDecorator[];

	constructor(
		id: number,
		type: TokenType,
		value: string | number | boolean | null,
		location: LocationRange
	) {
		this.id = id;
		this.type = type;
		this.value = value;
		this.location = location;
		this.children = [];
		this.parent = null;
		this.decorators = [];
	}

	get startPosition(): Position {
		return {
			line: this.location.start.line - 1,
			character: this.location.start.column - 1
		};
	}

	get endPosition(): Position {
		return {
			line: this.location.end.line - 1,
			character: this.location.end.column - 1
		};
	}

	getDisplayText(): string {
		if (this.value === null) return '';
		return String(this.value);
	}
}

export enum PositionContext {
	Block,
	Function,
	Attribute,
	Parameter,
	Root,
	RootAssignment,
	Reference,
	Unknown
}

export interface DecoratorTypePatterns {
	GIT_SSH_URL: RegExp;
	GIT_HTTPS_URL: RegExp;
	TERRAFORM_REGISTRY_URL: RegExp;
	S3_URL: RegExp;
	HTTPS_URL: RegExp;
	FILE_PATH: RegExp;
	EMAIL: RegExp;
	IP_ADDRESS: RegExp;
	DATE: RegExp;
	TIME: RegExp;
	UUID: RegExp;
}

export interface TokenDecorator {
	type: 'git_ssh_url' | 'git_https_url' | 'terraform_registry_url' | 's3_url' | 'https_url' |
	'file_path' | 'email' | 'ip_address' | 'date' | 'time' | 'uuid';
	startIndex: number;
	endIndex: number;
}

export const DECORATOR_PATTERNS: DecoratorTypePatterns = {
	GIT_SSH_URL: /git@[\w\-.]+:[\w\-./]+\.git(?:\/\/[\w\-./]+)?(?:\?ref=[\w\-.]+)?/,
	GIT_HTTPS_URL: /https:\/\/[\w\-.]+\/[\w\-./]+\.git(?:\/\/[\w\-./]+)?(?:\?ref=[\w\-.]+)?/,
	TERRAFORM_REGISTRY_URL: /(?:registry\.terraform\.io|app\.terraform\.io)\/[\w\-./]+/,
	S3_URL: /s3:\/\/[\w\-./]+/,
	HTTPS_URL: /https?:\/\/(?!registry\.terraform\.io|app\.terraform\.io)[\w\-.@:/]+(?:\?[\w=&.-]+)?/,
	FILE_PATH: /(?:\/|[A-Z]:\\|\\\\|\.{1,2}\/|\.{1,2}\\|\.[A-Z])[\w\-./\\]*/i,
	EMAIL: /\b[\w.%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
	IP_ADDRESS: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
	DATE: /\b\d{4}-\d{2}-\d{2}\b/,
	TIME: /\b\d{2}:\d{2}:\d{2}\b/,
	UUID: /\b[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89aAbB][a-f0-9]{3}-[a-f0-9]{12}\b/
};

export interface AttributeDefinition {
	name: string;
	description: string;
	required: boolean;
	types: ValueType[];
	validation?: {
		pattern?: string;
		min?: number;
		max?: number;
		allowedValues?: any[];
		customValidator?: (value: any) => boolean;
	};
	attributes?: AttributeDefinition[];
	deprecated?: boolean;
	deprecationMessage?: string;
}

export interface ParameterDefinition {
	name: string;
	types: ValueType[];
	required: boolean;
	description?: string;
	validation?: {
		pattern?: string;
		min?: number;
		max?: number;
		allowedValues?: any[];
	};
}

export interface BlockDefinition {
	type: string;
	parameters?: ParameterDefinition[];
	attributes?: AttributeDefinition[];
	blocks?: BlockDefinition[];
	min?: number;
	max?: number;
	description?: string;
	arbitraryAttributes?: boolean;
	validation?: {
		requiredAttributes?: string[];
		mutuallyExclusive?: string[][];
		requiredChoice?: string[][];
	};
}

export interface FunctionParameter {
	name: string;
	types: ValueType[];
	required: boolean;
	description?: string;
	variadic?: boolean;
	defaultValue?: any;
	validation?: {
		pattern?: string;
		min?: number;
		max?: number;
		allowedValues?: any[];
	};
}

export interface FunctionReturnType {
	types: ValueType[];
	description?: string;
	validation?: {
		pattern?: string;
		min?: number;
		max?: number;
		allowedValues?: any[];
	};
}

export interface FunctionDefinition {
	name: string;
	description: string;
	parameters: FunctionParameter[];
	returnType: FunctionReturnType;
	examples?: string[];
	deprecated?: boolean;
	deprecationMessage?: string;
}


export interface ResolvedReference {
    value: RuntimeValue<ValueType>;
    source: string;
    found: boolean;
}

export interface RuntimeValue<T extends ValueType> {
	type: T;
	value: RuntimeValueType<T>;
}

export type RuntimeValueType<T extends ValueType> =
	T extends 'string' ? string :
	T extends 'number' ? number :
	T extends 'boolean' ? boolean :
	T extends 'null' ? null :
	T extends 'array' ? RuntimeValue<ValueType>[] :
	T extends 'object' | 'block' ? Map<string, RuntimeValue<ValueType>> :
	T extends 'function' ? (args: RuntimeValue<ValueType>[]) => RuntimeValue<ValueType> :
	T extends ExpressionValueType ? RuntimeValue<ValueType> :
	never;


export type EvaluatedValue = RuntimeValue<ValueType>;


export interface DependencyInfo {
	sourcePath: string;
	targetPath: string;
	block: Token;
}
