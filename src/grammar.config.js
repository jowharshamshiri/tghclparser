export default {
  input: 'terragrunt.peggy',
  output: 'terragrunt-parser.js',
  format: 'es',
  dts: true,
  trace: false,
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
    LogicalExpression: 'LogicalExpressionNode',
    ArithmeticExpression: 'ArithmeticExpressionNode',
    NullCoalescingExpression: 'NullCoalescingExpressionNode',
    UnaryExpression: 'UnaryExpressionNode',
    PostfixExpression: 'PostfixExpressionNode',
    PipeExpression: 'PipeExpressionNode',
    ListComprehension: 'ListComprehensionNode',
    MapComprehension: 'MapComprehensionNode',
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
      type: 'string_lit' | 'number_lit' | 'boolean_lit' | 'array_lit' | 'object' | 
            'reference' | 'interpolation' | 'ternary_expression' | 'comparison_expression' |
            'logical_expression' | 'arithmetic_expression' | 'null_coalescing' |
            'unary_expression' | 'postfix_expression' | 'pipe_expression' |
            'list_comprehension' | 'map_comprehension' | 'function_call';
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

	  export interface LogicalExpressionNode extends ValueNode {
      type: 'logical_expression';
      value: string; // The operator
      children: [ValueNode, ValueNode];
    }

	export interface ArithmeticExpressionNode extends ValueNode {
      type: 'arithmetic_expression';
      value: string; // The operator
      children: [ValueNode, ValueNode];
    }

	export interface NullCoalescingExpressionNode extends ValueNode {
      type: 'null_coalescing';
      children: [ValueNode, ValueNode];
    }

	export interface UnaryExpressionNode extends ValueNode {
      type: 'unary_expression';
      value: string; // The operator
      children: [ValueNode];
    }
    
	export interface PostfixExpressionNode extends ValueNode {
      type: 'postfix_expression';
      children: [ValueNode, ValueNode];
    }

	 export interface PipeExpressionNode extends ValueNode {
      type: 'pipe_expression';
      children: [ValueNode, ...FunctionCallNode[]];
    }
    
	export interface ListComprehensionNode extends ValueNode {
      type: 'list_comprehension';
      children: [IdentifierNode, ValueNode, ValueNode]; // [item, collection, expression]
    }

	export interface MapComprehensionNode extends ValueNode {
      type: 'map_comprehension';
      children: [IdentifierNode, ValueNode, ValueNode, ValueNode]; // [item, collection, key, value]
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
		| LogicalExpressionNode
		| ArithmeticExpressionNode
		| NullCoalescingExpressionNode
		| UnaryExpressionNode
		| PostfixExpressionNode
		| PipeExpressionNode
		| ListComprehensionNode
		| MapComprehensionNode
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