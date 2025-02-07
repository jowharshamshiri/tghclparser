export default {
	input: 'terragrunt.peggy',
	output: 'terragrunt-parser.js',
	format: 'es',
	dts: true,
	trace: true,
	cache: false,
	
	returnTypes: {
	  Start: 'RootNode',
	  Statement: 'Statement',
	  RootAssignment: 'AssignmentNode',
	  Block: 'BlockNode',
	  ParameterizedBlock: 'ParameterizedBlockNode',
	  BlockIdentifier: 'BlockIdentifierNode',
	  BlockParameter: 'ParameterNode',
	  RootAssignmentIdentifier: 'IdentifierNode',
	  Pair: 'PairNode',
	  AttributeIdentifier: 'AttributeIdentifierNode',
	  QuotedAttributeIdentifier: 'AttributeIdentifierNode',
	  UnquotedAttributeIdentifier: 'AttributeIdentifierNode',
	  RootObject: 'ObjectNode',
	  Value: 'ValueNode',
	  Reference: 'ReferenceNode',
	  ReferenceIdentifier: 'IdentifierNode',
	  Object: 'ObjectNode',
	  StringLiteral: 'StringLiteralNode',
	  QuotedString: 'StringLiteralNode',
	  SingleQuotedString: 'StringLiteralNode',
	  Heredoc: 'StringLiteralNode',
	  Number: 'NumberLiteralNode',
	  Boolean: 'BooleanLiteralNode',
	  Array: 'ArrayLiteralNode',
	  ArrayItem: 'ValueNode',
	  Expression: 'ValueNode',
	  SimpleExpression: 'InterpolationNode',
	  TernaryExpression: 'TernaryExpressionNode',
	  ComparisonExpression: 'ComparisonExpressionNode',
	  FunctionCall: 'FunctionCallNode',
	  FunctionArgs: 'ValueNode[]',
	  FunctionArg: 'ValueNode',
	  FunctionIdentifier: 'FunctionIdentifierNode',
	  Identifier: 'string'
	},
	
	header: `
	  export interface Location {
		start: { offset: number; line: number; column: number };
		end: { offset: number; line: number; column: number };
	  }
	  
	  export interface BaseNode {
		id: number;
		type: string;
		location: Location;
		children?: Node[];
	  }
	  
	  export interface RootNode extends BaseNode {
		type: 'root';
		children: Statement[];
	  }
	  
	  export interface Statement extends BaseNode {
		type: 'assignment' | 'block';
	  }
	  
	  export interface AssignmentNode extends Statement {
		type: 'assignment';
		value: string;
		children: [IdentifierNode, RootValue];
	  }
	  
	  export interface BlockNode extends Statement {
		type: 'block';
		value: string;
		children: [BlockIdentifierNode, ...ParameterNode[], ...(PairNode | BlockNode)[]];
	  }
	  
	  export interface ParameterizedBlockNode extends BlockNode {
		children: [BlockIdentifierNode, ParameterNode, ...(PairNode | BlockNode)[]];
	  }
	  
	  export interface IdentifierNode extends BaseNode {
		type: 'identifier' | 'block_identifier' | 'root_assignment_identifier' | 'attribute_identifier' | 'reference_identifier' | 'function_identifier';
		value: string;
	  }
	  
	  export interface BlockIdentifierNode extends IdentifierNode {
		type: 'block_identifier';
	  }
	  
	  export interface ParameterNode extends BaseNode {
		type: 'parameter';
		value: string;
		children: [StringLiteralNode];
	  }
	  
	  export interface PairNode extends BaseNode {
		type: 'attribute';
		value: string;
		children: [AttributeIdentifierNode, ValueNode];
	  }
	  
	  export interface AttributeIdentifierNode extends IdentifierNode {
		type: 'attribute_identifier';
		quoted: boolean;
	  }
	  
	  export interface ValueNode extends BaseNode {
		type: 'string_lit' | 'number_lit' | 'boolean_lit' | 'array_lit' | 'object' | 'reference' | 'interpolation' | 'ternary_expression' | 'comparison_expression' | 'function_call';
	  }
	  
	  export interface StringLiteralNode extends ValueNode {
		type: 'string_lit';
		value: string;
	  }
	  
	  export interface NumberLiteralNode extends ValueNode {
		type: 'number_lit';
		value: number;
	  }
	  
	  export interface BooleanLiteralNode extends ValueNode {
		type: 'boolean_lit';
		value: boolean;
	  }
	  
	  export interface ArrayLiteralNode extends ValueNode {
		type: 'array_lit';
		children: ValueNode[];
	  }
	  
	  export interface ObjectNode extends ValueNode {
		type: 'object';
		children: PairNode[];
	  }
	  
	  export interface ReferenceNode extends ValueNode {
		type: 'reference';
		value: string;
	  }
	  
	  export interface InterpolationNode extends ValueNode {
		type: 'interpolation';
		value: string;
	  }
	  
	  export interface TernaryExpressionNode extends ValueNode {
		type: 'ternary_expression';
		children: [ValueNode, ValueNode, ValueNode];
	  }
	  
	  export interface ComparisonExpressionNode extends ValueNode {
		type: 'comparison_expression';
		children: [ValueNode, ValueNode];
	  }
	  
	  export interface FunctionCallNode extends ValueNode {
		type: 'function_call';
		children: [FunctionIdentifierNode, ...ValueNode[]];
	  }
	  
	  export interface FunctionIdentifierNode extends IdentifierNode {
		type: 'function_identifier';
	  }
	  
	  export type Node = 
		| RootNode 
		| Statement
		| IdentifierNode
		| ParameterNode
		| PairNode
		| ValueNode;
	  
	  export type RootValue = 
		| BlockNode
		| ObjectNode
		| ArrayLiteralNode
		| TernaryExpressionNode
		| ComparisonExpressionNode
		| FunctionCallNode
		| InterpolationNode;
  
	  export interface ParserOptions {
		grammarSource?: string;
		trace?: boolean;
		debugEnabled?: boolean;
		[key: string]: any;
	  }
	`,
  }