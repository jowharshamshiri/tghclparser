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
			`# ${value} Block`,
			blockTemplate.description || ''
		];

		if (blockTemplate.parameters?.length) {
			contents.push('## Parameters');
			contents.push(...blockTemplate.parameters.map(param =>
				`- **${param.name}** (${param.types.map(t => this.formatValueType(t)).join(' | ')}${param.required ? '' : '?'}): ${param.description || ''}`
			));
		}

		if (blockTemplate.attributes?.length) {
			contents.push('## Attributes');
			contents.push(...blockTemplate.attributes.map(attr => {
				let attrDoc = `- **${attr.name}** (${attr.types.map(t => this.formatValueType(t)).join(' | ')}${attr.required ? '' : '?'})`;
				if (attr.description) attrDoc += `: ${attr.description}`;
				if (attr.validation?.allowedValues?.length) {
					attrDoc += `\n  - Allowed values: ${attr.validation.allowedValues.join(', ')}`;
				}
				if (attr.validation?.pattern) {
					attrDoc += `\n  - Pattern: \`${attr.validation.pattern}\``;
				}
				return attrDoc;
			}));
		}

		if (blockTemplate.blocks?.length) {
			contents.push('## Nested Blocks');
			contents.push(...blockTemplate.blocks.map(block => {
				let blockDoc = `- **${block.type}**`;
				if (block.description) blockDoc += `: ${block.description}`;
				if (block.min !== undefined || block.max !== undefined) {
					blockDoc += `\n  - Occurrences: ${block.min || 0} to ${block.max || '∞'}`;
				}
				return blockDoc;
			}));
		}

		return contents;
	}

	private getFunctionDocumentation(funcDef: FunctionDefinition): string[] {
		const contents: string[] = [
			`# ${funcDef.name}()`,
			funcDef.description
		];

		if (funcDef.parameters.length) {
			contents.push('## Parameters');
			contents.push(...funcDef.parameters.map(param => {
				let paramDoc = `- **${param.name}** (${param.types.map(t => this.formatValueType(t)).join(' | ')}${param.required ? '' : '?'})`;
				if (param.description) paramDoc += `: ${param.description}`;
				if (param.variadic) paramDoc += ' (variadic)';
				return paramDoc;
			}));
		}

		contents.push('## Return Type');
		contents.push(`\`${funcDef.returnType.types.map(t => this.formatValueType(t)).join(' | ')}\`${funcDef.returnType.description ? `: ${funcDef.returnType.description}` : ''}`);

		return contents;
	}

	private getAttributeDocumentation(attr: AttributeDefinition): string[] {
		const contents: string[] = [
			`# ${attr.name}`,
			attr.description
		];

		contents.push('## Details');
		contents.push(`- **Type**: ${attr.types.map(t => this.formatValueType(t)).join(' | ')}`);
		contents.push(`- **Required**: ${attr.required}`);

		if (attr.validation?.pattern) {
			contents.push(`- **Pattern**: \`${attr.validation.pattern}\``);
		}

		if (attr.validation?.allowedValues?.length) {
			contents.push('## Allowed Values');
			contents.push(attr.validation.allowedValues.map(value => `- \`${value}\``).join('\n'));
		}

		// Only show properties if one of the types is 'object'
		if (attr.types.includes('object') && attr.attributes?.length) {
			contents.push('## Properties');
			attr.attributes.forEach(nestedAttr => {
				contents.push(`- **${nestedAttr.name}** (${nestedAttr.types.map(t => this.formatValueType(t)).join(' | ')})`);
				if (nestedAttr.description) contents.push(`  ${nestedAttr.description}`);
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