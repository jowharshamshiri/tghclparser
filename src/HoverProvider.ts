import { Schema } from './Schema';
import { AttributeDefinition, BlockDefinition, FunctionDefinition, Token, TokenType, ValueType } from './model';
import type { HoverResult } from '.';

export class HoverProvider {
	constructor(private schema: Schema) { }

	private formatValueType(type: ValueType): string {
		switch (type) {
			case 'array':
				return 'Array';
			case 'object':
				return 'Object';
			case 'function':
				return 'Function';
			case 'block':
				return 'Block';
			case 'ternary':
				return 'Ternary Expression';
			case 'comparison':
				return 'Comparison';
			case 'logical':
				return 'Logical Expression';
			case 'arithmetic':
				return 'Arithmetic Expression';
			case 'null_coalescing':
				return 'Null Coalescing';
			case 'unary':
				return 'Unary Expression';
			case 'postfix':
				return 'Postfix Expression';
			case 'pipe':
				return 'Pipe Expression';
			case 'list_comprehension':
				return 'List Comprehension';
			case 'map_comprehension':
				return 'Map Comprehension';
			case 'interpolation':
				return 'String Interpolation';
			case 'reference':
				return 'Reference';
			default:
				return type.charAt(0).toUpperCase() + type.slice(1);
		}
	}

	private getBlockDocumentation(blockTemplate: BlockDefinition, value: string): string[] {
		const contents: string[] = [
		  `## ${value} Block`,
		  '',  // Empty line for better readability
		];
	
		// Add description with proper formatting
		if (blockTemplate.description) {
		  contents.push(blockTemplate.description, '');
		  contents.push('---', '');  // Add horizontal rule for section separation
		}
	
		// Parameters section with better structure
		if (blockTemplate.parameters?.length) {
		  contents.push('### Parameters', '');
		  blockTemplate.parameters.forEach(param => {
			const typeStr = param.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
			contents.push(`**${param.name}** ${param.required ? '(required)' : '(optional)'}`);
			contents.push(`- *Type:* ${typeStr}`);
			if (param.description) {
			  contents.push(`- *Description:* ${param.description}`);
			}
			if (param.validation?.pattern) {
			  contents.push(`- *Pattern:* \`${param.validation.pattern}\``);
			}
			if (param.validation?.allowedValues?.length) {
			  contents.push(`- *Allowed values:* ${param.validation.allowedValues.map(v => `\`${v}\``).join(', ')}`);
			}
			contents.push('');  // Add space between parameters
		  });
		  contents.push('---', '');
		}
	
		// Attributes section with enhanced formatting
		if (blockTemplate.attributes?.length) {
		  contents.push('### Attributes', '');
		  blockTemplate.attributes.forEach(attr => {
			const typeStr = attr.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
			contents.push(`**${attr.name}** ${attr.required ? '(required)' : '(optional)'}`);
			if (attr.deprecated) {
			  contents.push('> ⚠️ *Deprecated*');
			  if (attr.deprecationMessage) {
				contents.push(`> ${attr.deprecationMessage}`);
			  }
			  contents.push('');
			}
			contents.push(`- *Type:* ${typeStr}`);
			if (attr.description) {
			  contents.push(`- *Description:* ${attr.description}`);
			}
			if (attr.validation?.pattern) {
			  contents.push(`- *Pattern:* \`${attr.validation.pattern}\``);
			}
			if (attr.validation?.allowedValues?.length) {
			  contents.push(`- *Allowed values:* ${attr.validation.allowedValues.map(v => `\`${v}\``).join(', ')}`);
			}
			contents.push('');  // Add space between attributes
		  });
		  contents.push('---', '');
		}
	
		// Nested blocks section with improved structure
		if (blockTemplate.blocks?.length) {
		  contents.push('### Nested Blocks', '');
		  blockTemplate.blocks.forEach(block => {
			contents.push(`**${block.type}**`);
			if (block.description) {
			  contents.push(`- *Description:* ${block.description}`);
			}
			if (block.min !== undefined || block.max !== undefined) {
			  const min = block.min ?? 0;
			  const max = block.max ?? '∞';
			  contents.push(`- *Occurrences:* ${min} to ${max}`);
			}
			contents.push('');  // Add space between blocks
		  });
		}
	
		return contents;
	  }
	
	  private getFunctionDocumentation(funcDef: FunctionDefinition): string[] {
		const contents: string[] = [
		  `## ${funcDef.name}()`,
		  ''  // Empty line for better readability
		];
	
		if (funcDef.deprecated) {
		  contents.push('> ⚠️ *This function is deprecated*');
		  if (funcDef.deprecationMessage) {
			contents.push(`> ${funcDef.deprecationMessage}`);
		  }
		  contents.push('');
		}
	
		if (funcDef.description) {
		  contents.push(funcDef.description, '', '---', '');
		}
	
		if (funcDef.parameters.length) {
		  contents.push('### Parameters', '');
		  funcDef.parameters.forEach(param => {
			const typeStr = param.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
			contents.push(`**${param.name}** ${param.required ? '(required)' : '(optional)'}`);
			contents.push(`- *Type:* ${typeStr}${param.variadic ? ' (variadic)' : ''}`);
			if (param.description) {
			  contents.push(`- *Description:* ${param.description}`);
			}
			if (param.validation?.pattern) {
			  contents.push(`- *Pattern:* \`${param.validation.pattern}\``);
			}
			if (param.validation?.allowedValues?.length) {
			  contents.push(`- *Allowed values:* ${param.validation.allowedValues.map(v => `\`${v}\``).join(', ')}`);
			}
			contents.push('');  // Add space between parameters
		  });
		  contents.push('---', '');
		}
	
		contents.push('### Return Type', '');
		const returnTypeStr = funcDef.returnType.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
		contents.push(`*Type:* ${returnTypeStr}`);
		if (funcDef.returnType.description) {
		  contents.push(`*Description:* ${funcDef.returnType.description}`);
		}
	
		if (funcDef.examples?.length) {
		  contents.push('', '### Examples', '');
		  funcDef.examples.forEach(example => {
			contents.push('```hcl', example, '```', '');
		  });
		}
	
		return contents;
	  }
	
	  private getAttributeDocumentation(attr: AttributeDefinition): string[] {
		const contents: string[] = [
		  `## ${attr.name} Attribute`,
		  ''  // Empty line for better readability
		];
	
		if (attr.deprecated) {
		  contents.push('> ⚠️ *This attribute is deprecated*');
		  if (attr.deprecationMessage) {
			contents.push(`> ${attr.deprecationMessage}`);
		  }
		  contents.push('');
		}
	
		if (attr.description) {
		  contents.push(attr.description, '', '---', '');
		}
	
		contents.push('### Details', '');
		const typeStr = attr.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
		contents.push(`- *Type:* ${typeStr}`);
		contents.push(`- *Required:* ${attr.required ? 'Yes' : 'No'}`);
	
		if (attr.validation) {
		  contents.push('', '### Validation', '');
		  if (attr.validation.pattern) {
			contents.push(`- *Pattern:* \`${attr.validation.pattern}\``);
		  }
		  if (attr.validation.allowedValues?.length) {
			contents.push('- *Allowed values:*');
			attr.validation.allowedValues.forEach(value => {
			  contents.push(`  - \`${value}\``);
			});
		  }
		  if (attr.validation.min !== undefined) {
			contents.push(`- *Minimum:* ${attr.validation.min}`);
		  }
		  if (attr.validation.max !== undefined) {
			contents.push(`- *Maximum:* ${attr.validation.max}`);
		  }
		}
	
		if (attr.types.includes('object') && attr.attributes?.length) {
		  contents.push('', '### Properties', '');
		  attr.attributes.forEach(nestedAttr => {
			const nestedTypeStr = nestedAttr.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
			contents.push(`**${nestedAttr.name}** ${nestedAttr.required ? '(required)' : '(optional)'}`);
			contents.push(`- *Type:* ${nestedTypeStr}`);
			if (nestedAttr.description) {
			  contents.push(`- *Description:* ${nestedAttr.description}`);
			}
			contents.push('');  // Add space between nested attributes
		  });
		}
	
		return contents;
	  }

	getHoverInfo(token: Token): HoverResult | null {
		let contents: string[] = [];
		const value = token.getDisplayText();

		switch (token.type as TokenType) {
			case 'block_identifier':
			case 'root_assignment_identifier':
				{
					const blockDefinition = this.schema.getBlockDefinition(value);
					if (blockDefinition) {
						contents = this.getBlockDocumentation(blockDefinition, value);
					}
					break;
				}

			case 'function_identifier': {
				const funcDef = this.schema.getFunctionDefinition(value);
				if (funcDef) {
					contents = this.getFunctionDocumentation(funcDef);
				}
				break;
			}

			case 'attribute_identifier': {
				if (token.parent?.parent?.type === 'block') {
					let parentBlock = token.parent.parent;
					const parentBlockDefinition = this.schema.getBlockDefinition(parentBlock.getDisplayText());
					const attr = parentBlockDefinition?.attributes?.find(a => a.name === value);
					if (attr) {
						contents = this.getAttributeDocumentation(attr);
					}
				}
				break;
			}

			case 'parameter': {
				if (token.parent?.type === 'block') {
					const blockTemplate = this.schema.getBlockDefinition(token.parent.getDisplayText());
					const param = blockTemplate?.parameters?.find(p =>
						p.validation?.pattern && new RegExp(p.validation.pattern).test(value)
					);
					if (param) {
						contents = [
							`# Block Parameter: ${param.name}`,
							param.description || '',
							'## Details',
							`- **Type**: ${param.types.map(t => this.formatValueType(t)).join(' | ')}`,
							`- **Required**: ${param.required}`,
							param.validation?.pattern ? `- **Pattern**: \`${param.validation.pattern}\`` : ''
						].filter(Boolean);
					}
				}
				break;
			}
		}

		return contents.length > 0 ? {
			content: {
				kind: 'markdown',
				value: contents.join('\n\n')
			}
		} : null;
	}
}