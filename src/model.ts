import type { Location, Position } from 'vscode-languageserver';

import type { LocationRange } from './parser';

export class AnError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TGLS Error";
	}
}
export type TokenType =
	// Root elements
	| 'root'
	| 'assignment'

	// Block types
	| 'block'
	| 'dynamic_block'
	| 'locals_block'
	| 'moved_block'
	| 'import_block'
	| 'check_block'
	| 'validation'
	| 'meta_arguments'

	// Identifiers
	| 'identifier'
	| 'block_identifier'
	| 'root_assignment_identifier'
	| 'attribute_identifier'
	| 'reference_identifier'
	| 'function_identifier'

	// Structural elements
	| 'parameter'
	| 'attribute'
	| 'access_chain'
	| 'namespace'

	// Literals
	| 'string_lit'
	| 'number_lit'
	| 'boolean_lit'
	| 'array_lit'
	| 'object'

	// References and interpolation
	| 'reference'
	| 'interpolation'
	| 'legacy_interpolation'
	| 'interpolated_string'
	| 'string_content'

	// Reference types
	| 'dependency_reference'
	| 'local_reference'
	| 'module_reference'
	| 'terraform_reference'
	| 'var_reference'
	| 'data_reference'
	| 'path_reference'

	// Expressions
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

	// Constructors
	| 'type_constructor'
	| 'collection_constructor'

	// Directives
	| 'if_directive'
	| 'for_directive'
	| 'else_directive'
	| 'endif_directive'

	// Comments and whitespace
	| 'block_comment'
	| 'inline_comment'
	| 'directive_comment'
	| 'documentation_comment'
	| 'whitespace'

	// Meta arguments
	| 'meta_count'
	| 'meta_for_each'
	| 'meta_depends_on'
	| 'meta_provider'
	| 'meta_lifecycle'

	// Special tokens
	| 'inheritance'
	| 'splat_expression'
	| 'index_expression'
	| 'member_access'

	// Language server specific
	| 'unknown';
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
	| 'block'
	| 'type_constructor'
	| 'collection_constructor'
	| 'directive'
	| 'meta_argument';

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
	| 'legacy_interpolation'
	| 'reference';

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
	T extends 'directive' ? DirectiveInfo :
	T extends 'meta_argument' ? MetaArgumentInfo :
	never;


export type EvaluatedValue = RuntimeValue<ValueType>;


// export interface DependencyInfo {
// 	sourcePath: string;
// 	targetPath: string;
// 	block: Token;
// }

export interface DirectiveInfo {
	type: 'if' | 'for' | 'else' | 'endif';
	location: Location;
	content?: string;
}

export interface MetaArgumentInfo {
	type: 'count' | 'for_each' | 'depends_on' | 'provider' | 'lifecycle';
	value: RuntimeValue<ValueType>;
	location: Location;
}

export type FunctionImplementation = (args: RuntimeValue<ValueType>[], context: FunctionContext) => Promise<RuntimeValue<ValueType> | undefined>;

export interface FunctionContext {
	workingDirectory: string;
	environmentVariables: Record<string, string>;
	document: {
		uri: string;
		content: string;
	};
	terraformCommand?: string;
	terraformCliArgs?: string[];
	fs?: {
		access: (path: string) => Promise<void>;
	};
	includedFrom?: string;  // URI of the config file that included this one
}

export interface FunctionGroup {
	namespace: string;
	functions: Record<string, FunctionImplementation>;
}

export interface TerragruntConfig {
	// Basic config info
	uri: string;                   // URI of this config file
	content: string;              // Raw content of the file

	// Relationship tracking
	includes: string[];           // URIs of included configs
	dependencies: string[];       // URIs of explicit dependencies
	referencedBy: string[];      // URIs of configs that include/depend on this one

	// Dependency-specific info (from old DependencyInfo)
	sourcePath: string;          // Path of the config file containing the dependency reference
	targetPath: string;          // Resolved path of the dependency target
	block?: Token;              // Token containing the dependency or include block

	// Additional metadata
	dependencyType: 'include' | 'dependency';  // Whether this is an include or dependency relationship
	parameterValue?: string;    // For dependencies, the name parameter value

	outputs?: Map<string, RuntimeValue<ValueType>>;
}

// Helper functions for creating TerragruntConfig objects
export const createDependencyConfig = (
	uri: string,
	content: string,
	sourcePath: string,
	targetPath: string,
	block: Token,
	parameterValue?: string,
	outputs?: Map<string, RuntimeValue<ValueType>>
): TerragruntConfig => ({
	uri,
	content,
	includes: [],
	dependencies: [],
	referencedBy: [],
	sourcePath,
	targetPath,
	block,
	dependencyType: 'dependency',
	parameterValue,
	outputs
});

export const createIncludeConfig = (
	uri: string,
	content: string,
	sourcePath: string,
	targetPath: string,
	block: Token,
	outputs?: Map<string, RuntimeValue<ValueType>>
): TerragruntConfig => ({
	uri,
	content,
	includes: [],
	dependencies: [],
	referencedBy: [],
	sourcePath,
	targetPath,
	block,
	dependencyType: 'include',
	outputs
});

export class TreeNode<T> {
	data: T;
	name: string;
	type: string;
	children: TreeNode<T>[];

	constructor(data: T, name: string, type: string) {
		this.data = data;
		this.children = [];
		this.name = name;
		this.type = type;
	}

	addChild(data: T, name: string, type: string): TreeNode<T> {
		const child = new TreeNode(data, name, type);
		this.children.push(child);
		return child;
	}

	async preOrderTraversal(callback: (node: TreeNode<T>, depth: number, parent: TreeNode<T> | null) => Promise<boolean>): Promise<number> {
		const result = await this._preOrderTraversalHelper(callback, 0, null);
		return result.maxDepth;
	}

	private async _preOrderTraversalHelper(
		callback: (node: TreeNode<T>, depth: number, parent: TreeNode<T> | null) => Promise<boolean>,
		currentDepth: number,
		parent: TreeNode<T> | null
	): Promise<{ maxDepth: number; shouldContinue: boolean; }> {
		const continueTraversal = await callback(this, currentDepth, parent);
		if (!continueTraversal) {
			return { maxDepth: currentDepth, shouldContinue: false };
		}

		let maxDepth = currentDepth;
		let shouldContinue = true;

		for (const child of this.children) {
			const childResult = await child._preOrderTraversalHelper(callback, currentDepth + 1, this);
			maxDepth = Math.max(maxDepth, childResult.maxDepth);

			if (!childResult.shouldContinue) {
				shouldContinue = false;
				break;
			}
		}

		return { maxDepth, shouldContinue };
	}

	async breadthFirstTraversal(callback: (node: TreeNode<T>, depth: number, parent: TreeNode<T> | null) => Promise<boolean>): Promise<void> {
		const queue: Array<{ node: TreeNode<T>, depth: number, parent: TreeNode<T> | null }> = [];
		queue.push({ node: this, depth: 0, parent: null });

		while (queue.length > 0) {
			const current = queue.shift()!;
			const { node, depth, parent } = current;

			const continueTraversal = await callback(node, depth, parent);

			if (!continueTraversal) {
				return;
			}

			node.children.forEach(child => {
				queue.push({ node: child, depth: depth + 1, parent: node });
			});
		}
	}
	

	toString(): string {
		let result = '';
		this._printTreeHelper(this, "", true, (line) => {
			result += `${line  }\n`;
		});
		return result;
	}
	
	private _printTreeHelper(
		node: TreeNode<T>, 
		prefix: string, 
		isLastChild: boolean,
		output: (line: string) => void
	): void {
		// Print the current node
		output(`${prefix}${isLastChild ? "└── " : "├── "}[${node.type}] ${node.name}`);
	
		// Update the prefix for children
		const newPrefix = prefix + (isLastChild ? "    " : "│   ");
	
		// Recursively print each child
		for (let i = 0; i < node.children.length; i++) {
			const isLast = i === node.children.length - 1;
			this._printTreeHelper(node.children[i], newPrefix, isLast, output);
		}
	}
}