import type { Position } from 'vscode-languageserver';

export class AnError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TGLS Error";
	}
}
export type TokenType =
	| 'conditional'
	| 'bare_token'
	| 'block'
	| 'identifier'
	| 'string_lit'
	| 'block_comment'
	| 'block_parameter'
	| 'inline_comment'
	| 'heredoc'
	| 'heredoc_content'
	| 'interpolation'
	| 'function_call'
	| 'block_assign'
	| 'block_with_param'
	| 'integer_lit'
	| 'float_lit'
	| 'float_lit_with_f'
	| 'null_lit'
	| 'boolean_lit'
	| 'whitespace'
	| 'property_access'
	| 'array_lit'
	| 'object_lit'
	| 'unknown'
	| 'number_lit'
	| 'assignment'
	| 'attribute'
	| 'root'
	| 'attribute_identifier';

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
	location: Location;
	children: Token[];
	parent: Token | null;
	decorators?: TokenDecorator[];

	constructor(
		id: number,
		type: TokenType,
		value: string | number | boolean | null,
		location: Location
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

	// Helper method to get displayable text for the token
	getDisplayText(): string {
		if (this.value === null) return '';
		return String(this.value);
	}
}
export enum PositionContext {
	Block,
	Function
}

export type PrimitiveValueType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'null';

export type ComplexValueType =
	| 'array'
	| 'object'
	| 'function_call'
	| 'property_access'
	| 'interpolation'
	| 'heredoc';

export interface BlockDelimiter {
	char: string;
	line: number;
	column: number;
	type: 'brace' | 'bracket' | 'parenthesis';
}

export type ValueType = PrimitiveValueType | ComplexValueType;

export interface TokenTypePatterns {
	BLOCK: RegExp;
	BLOCK_WITH_PARAM: RegExp;
	BLOCK_ASSIGN: RegExp;
	IDENTIFIER: RegExp;
	FUNCTION_CALL: RegExp;
	STRING: RegExp;
	INTEGER: RegExp;
	FLOAT: RegExp;
	FLOAT_WITH_F: RegExp;
	NULL: RegExp;
	BOOLEAN: RegExp;
	WHITESPACE: RegExp;
	BLOCK_COMMENT: RegExp;
	INLINE_COMMENT: RegExp;
	HEREDOC: RegExp;
	HEREDOC_CONTENT: RegExp;
	HEREDOC_START: RegExp;
	ARRAY: RegExp;
	OBJECT: RegExp;
}

export const TOKEN_PATTERNS: TokenTypePatterns = {
	BLOCK: /^\s*(\w+)\s*(?=\{)/,
	BLOCK_WITH_PARAM: /^\s*(\w+)\s+"([^"]+)"\s*(?=\{)/,
	BLOCK_ASSIGN: /^\s*(\w+)\s*=\s*\{/,
	IDENTIFIER: /^\s*(\w+)\s*(?==)/,
	FUNCTION_CALL: /^\s*(\w+)\s*(?=\()/,
	STRING: /"([^"]*)"/,
	INTEGER: /^-?\d+(?![.\d])/,
	FLOAT: /^-?\d+\.\d+(?!f)/,
	FLOAT_WITH_F: /^-?\d+\.\d+f\b/,
	NULL: /^null\b/,
	BOOLEAN: /^(?:true|false)\b/,
	WHITESPACE: /^\s+/,
	BLOCK_COMMENT: /^\/\*[\s\S]*?\*\//,
	INLINE_COMMENT: /^(?:\/\/|#).*/,
	HEREDOC: /^<<[-~]?(\w+)$/,
	HEREDOC_CONTENT: /^.*$/,
	HEREDOC_START: /^\s*<<[-~]?(\w+)\s*$/,
	ARRAY: /^\[/,
	OBJECT: /^\{/,
};

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
	value: ValueDefinition;
	allowedValues?: string[];
	isArray?: boolean;
	attributes?: AttributeDefinition[];
}

export interface ParameterDefinition {
	name: string;
	type: PrimitiveValueType;
	pattern?: string;
	required: boolean;
	description?: string;
}

export interface BlockTemplate {
	type: string;
	parameters?: ParameterDefinition[];
	attributes?: AttributeDefinition[];
	blocks?: BlockTemplate[];
	min?: number;
	max?: number;
	description?: string;
	arbitraryAttributes?: boolean;
}

export interface FunctionParameter {
	name: string;
	type: string;
	required: boolean;
	description?: string;
	variadic?: boolean;
}

export interface FunctionReturnType {
	type: string;
	description?: string;
}

export interface FunctionDefinition {
	name: string;
	description: string;
	parameters: FunctionParameter[];
	returnType: FunctionReturnType;
}


export interface ValueDefinition {
	type: ValueType;
	elementType?: ValueType;  // For arrays, specifies the type of elements
	properties?: Record<string, ValueDefinition>;  // For objects, defines nested property types
	pattern?: string;  // For strings, regex pattern for validation
	enum?: Array<string | number | boolean>;  // Allowed values for primitives
	minItems?: number;  // For arrays
	maxItems?: number;  // For arrays
	required?: boolean;
	description?: string;
}

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

export interface ASTValue {
	key?: string;
	value: any;
	location?: Location;
}

export interface BlockValue {
	identifier: string;
	blockType?: string;
	pairs: ASTValue[];
	location: Location;
}

export interface ASTNode {
	type: string;
	value: string | number | boolean | BlockValue | Record<string, ASTValue>;
	location: Location;
}