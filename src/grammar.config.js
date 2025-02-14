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
    Identifier: 'string',
	DynamicBlock: 'DynamicBlockNode',
	ImportBlock: 'ImportBlockNode',
	LocalsBlock: 'LocalsBlockNode',
	MovedBlock: 'MovedBlockNode',
	CheckBlock: 'CheckBlockNode',
	Validation: 'ValidationNode',
	TypeConstructor: 'TypeConstructorNode',
	CollectionConstructor: 'CollectionConstructorNode',
	DirectiveComment: 'DirectiveCommentNode',
	DocumentationComment: 'DocumentationCommentNode',
	TypeParameters: 'TypeParametersNode',
	TypeConstraint: 'TypeConstraintNode',
	VariadicArguments: 'VariadicArgumentsNode',
	MetaArguments: 'MetaArgumentsNode',
	InterpolatedString: 'InterpolatedStringNode',
    StringContent: 'StringContentNode',
    LegacyInterpolation: 'LegacyInterpolationNode',
    IfDirective: 'IfDirectiveNode',
    ForDirective: 'ForDirectiveNode',
    ElseDirective: 'ElseDirectiveNode',
    EndifDirective: 'EndifDirectiveNode'
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
				'reference' | 'interpolation' | 'legacy_interpolation' | 'interpolated_string' | 
				'string_content' | 'ternary_expression' | 'comparison_expression' |
				'logical_expression' | 'arithmetic_expression' | 'null_coalescing' |
				'unary_expression' | 'postfix_expression' | 'pipe_expression' |
				'list_comprehension' | 'map_comprehension' | 'function_call' |
				'member_access' | 'index_expression' | 'splat_expression' |
				'type_constructor' | 'collection_constructor';
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
		| ValueNode
		| DynamicBlockNode
		| ImportBlockNode
		| LocalsBlockNode
		| MovedBlockNode
		| CheckBlockNode
		| ValidationNode
		| MetaArgumentNode
		| ReferenceNode
		| AssertionNode
		| AccessChainNode
		| NamespaceNode
		| ConditionNode
		| ErrorMessageNode
		| CommentContentNode
		| LocalAssignmentNode
		| IfDirectiveNode
		| ForDirectiveNode
		| ElseDirectiveNode
		| EndifDirectiveNode
		| InterpolatedStringNode
		| StringContentNode
		| LegacyInterpolationNode;
			
	  
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

	export interface DynamicBlockNode extends BaseNode {
	type: 'dynamic_block';
	value: string;
	children: [ValueNode, BlockNode];
	}

	export interface ImportBlockNode extends BaseNode {
	type: 'import_block';
	children: [StringLiteralNode, ReferenceNode];
	}

	export interface LocalsBlockNode extends BaseNode {
	type: 'locals_block';
	children: LocalAssignmentNode[];
	}

	export interface MovedBlockNode extends BaseNode {
	type: 'moved_block';
	children: [ReferenceNode, ReferenceNode];
	}

	export interface CheckBlockNode extends BaseNode {
	type: 'check_block';
	children: AssertionNode[];
	}

	export interface ValidationNode extends BaseNode {
	type: 'validation';
	children: [ConditionNode, ErrorMessageNode];
	}

	export interface TypeConstructorNode extends ValueNode {
	type: 'type_constructor';
	value: string;
	children: [ValueNode];
	}

	export interface CollectionConstructorNode extends ValueNode {
	type: 'collection_constructor';
	value: string;
	children: [ValueNode];
	}

	export interface DirectiveCommentNode extends BaseNode {
	type: 'directive_comment';
	value: string;
	children: [CommentContentNode];
	}

	export interface DocumentationCommentNode extends BaseNode {
	type: 'documentation_comment';
	value: string;
	}

	export interface TypeParametersNode extends BaseNode {
	type: 'type_parameters';
	children: TypeConstraintNode[];
	}

	export interface TypeConstraintNode extends BaseNode {
	type: 'type_constraint';
	value: string;
	}

	export interface VariadicArgumentsNode extends BaseNode {
	type: 'variadic_arguments';
	children: [ValueNode];
	}

	export type MetaArgumentNode = 
		| CountMetaNode
		| ForEachMetaNode
		| DependsOnMetaNode
		| ProviderMetaNode
		| LifecycleMetaNode;

	export interface CountMetaNode extends BaseNode {
	type: 'meta_count';
	children: [ValueNode];
	}

	export interface ForEachMetaNode extends BaseNode {
	type: 'meta_for_each';
	children: [ValueNode];
	}

	export interface DependsOnMetaNode extends BaseNode {
	type: 'meta_depends_on';
	children: [ArrayLiteralNode];
	}

	export interface ProviderMetaNode extends BaseNode {
	type: 'meta_provider';
	children: [ValueNode];
	}

	export interface LifecycleMetaNode extends BaseNode {
	type: 'meta_lifecycle';
	children: LifecycleRuleNode[];
	}

	export interface ConditionNode extends BaseNode {
	type: 'condition';
	children: [ValueNode];
	}

	export interface ErrorMessageNode extends BaseNode {
	type: 'error_message';
	children: [StringLiteralNode];
	}

	export interface CommentContentNode extends BaseNode {
	type: 'comment_content';
	value: string;
	}

	export interface LocalAssignmentNode extends BaseNode {
	type: 'local_assignment';
	value: string;
	children: [IdentifierNode, ValueNode];
	}

	export interface DependencyReferenceNode extends ReferenceNode {
	type: 'dependency_reference';
	children: [DependencyNameNode, AccessChainNode];
	}

	export interface LocalReferenceNode extends ReferenceNode {
	type: 'local_reference';
	children: [NamespaceNode, AccessChainNode];
	}

	export interface ModuleReferenceNode extends ReferenceNode {
	type: 'module_reference';
	children: [NamespaceNode, ModuleNameNode, AccessChainNode];
	}

	export interface TerraformReferenceNode extends ReferenceNode {
	type: 'terraform_reference';
	children: [NamespaceNode, TerraformAttributeNode];
	}

	export interface VarReferenceNode extends ReferenceNode {
	type: 'var_reference';
	children: [NamespaceNode, AccessChainNode];
	}

	export interface DataReferenceNode extends ReferenceNode {
	type: 'data_reference';
	children: [NamespaceNode, ProviderNode, AccessChainNode];
	}

	export interface PathReferenceNode extends ReferenceNode {
	type: 'path_reference';
	children: [NamespaceNode, PathAttributeNode];
	}

	export interface AccessChainNode extends BaseNode {
	type: 'access_chain';
	children: ReferenceIdentifierNode[];
	}

	export interface NamespaceNode extends BaseNode {
	type: 'namespace';
	value: string;
	}

	export interface DependencyNameNode extends BaseNode {
	type: 'dependency_name';
	value: string;
	children: [ReferenceIdentifierNode];
	}

	export interface ModuleNameNode extends BaseNode {
	type: 'module_name';
	value: string;
	children: [ReferenceIdentifierNode];
	}

	export interface TerraformAttributeNode extends BaseNode {
	type: 'terraform_attribute';
	value: string;
	children: [ReferenceIdentifierNode];
	}

	export interface PathAttributeNode extends BaseNode {
	type: 'path_attribute';
	value: string;
	}

	export interface ProviderNode extends BaseNode {
	type: 'provider';
	value: string;
	children: [ReferenceIdentifierNode];
	}

	export interface LifecycleRuleNode extends BaseNode {
	type: 'lifecycle_rule';
	children: [];
	}

	export interface AssertionNode extends BaseNode {
	type: 'assertion';
	children: [ConditionNode, ErrorMessageNode];
	}

	export interface InterpolatedStringNode extends ValueNode {
		type: 'interpolated_string';
		children: (StringLiteralNode | InterpolationNode)[];
	}

	export interface StringContentNode extends ValueNode {
		type: 'string_content';
		children: (StringLiteralNode | InterpolationNode)[];
	}

	export interface LegacyInterpolationNode extends ValueNode {
		type: 'legacy_interpolation';
		children: [ValueNode];
	}

	export interface IfDirectiveNode extends BaseNode {
		type: 'if_directive';
		children: [ValueNode, StringContentNode];
	}

	export interface ForDirectiveNode extends BaseNode {
		type: 'for_directive';
		children: [IdentifierNode, ValueNode, StringContentNode];
	}

	export interface ElseDirectiveNode extends BaseNode {
		type: 'else_directive';
		children: [StringContentNode];
	}

	export interface EndifDirectiveNode extends BaseNode {
		type: 'endif_directive';
		children: [];
	}

	export interface MetaArgumentsNode extends BaseNode {
		type: 'meta_arguments';
		children: MetaArgumentNode[];
	}
	`,
  }