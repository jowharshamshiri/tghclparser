import type { MarkupContent } from 'vscode-languageserver-types';
import { MarkupKind } from 'vscode-languageserver-types';

import type { AttributeDefinition, BlockDefinition, FunctionDefinition, TokenType, ValueType } from '../model';
import { Token } from '../model';
import type { ParsedDocument } from '../ParsedDocument';
import type { Schema } from '../Schema';


export class HoverProvider {
	constructor(private schema: Schema) { }
	private createTrustedMarkdownContent(content: string): MarkupContent {
		// Create markdown content in the format VSCode expects
		return {
			kind: MarkupKind.Markdown,
			value: content
		};
	}
	private getFunctionDocumentation(funcDef: FunctionDefinition): string[] {
		const contents: string[] = [
			`## ${funcDef.name}()`,
			''
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

		if (funcDef.parameters.length > 0) {
			contents.push('### Parameters', '');
			funcDef.parameters.forEach(param => {
				const typeStr = param.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
				contents.push(
					`**${param.name}** ${param.required ? '(required)' : '(optional)'}`,
					`- *Type:* ${typeStr}${param.variadic ? ' (variadic)' : ''}`
				);
				if (param.description) {
					contents.push(`- *Description:* ${param.description}`);
				}
				if (param.validation?.pattern) {
					contents.push(`- *Pattern:* \`${param.validation.pattern}\``);
				}
				if (param.validation?.allowedValues?.length) {
					contents.push(`- *Allowed values:* ${param.validation.allowedValues.map(v => `\`${v}\``).join(', ')}`);
				}
				contents.push('');
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

	private async getLocalReferenceHoverInfo(token: Token, doc: ParsedDocument): Promise<string[]> {
		const accessChain = token.children.find(c => c.type === 'access_chain');
		const refId = accessChain?.children.find(c => c.type === 'reference_identifier');

		if (!refId?.value) return [];

		// Get the locals block and find our target attribute
		const ast = doc.getAST();
		const localsBlock = this.findBlock(ast, 'locals');
		if (!localsBlock) return [];

		const targetAttr = localsBlock.children.find(child =>
			child.type === 'attribute' &&
			child.value === refId.value
		);

		if (!targetAttr) return [];

		// Get the URI from the token's location
		const sourceUri = targetAttr.location.source;
		// Get the line number (1-based in HCL AST)
		const { line } = targetAttr.location.start;

		// Get the raw text content
		const rawContent = doc.getContent().split('\n')[line - 1].trim();

		return [
			`## Local Value: ${refId.value}`,
			'',
			`[Go to definition](${sourceUri}#${line})`,
			'```hcl',
			`${rawContent}`,
			'```'
		];
	}

	private getExpressionHoverInfo(token: Token): string[] {
		const contents: string[] = [];

		switch (token.type) {
			case 'ternary_expression': {
				contents.push(
					'## Ternary Expression',
					'',
					'Conditionally selects one of two values based on a condition.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```',
					'',
					'Format: `condition ? true_value : false_value`'
				);
				break;
			}
			case 'comparison_expression': {
				const operator = token.children[1]?.value;
				contents.push(
					'## Comparison Expression',
					'',
					'Compares two values.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```',
					'',
					`Operator: \`${operator}\``,
					'',
					'Returns: `boolean`'
				);
				break;
			}
			case 'logical_expression': {
				const operator = token.children[1]?.value;
				contents.push(
					'## Logical Expression',
					'',
					'Performs a logical operation.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```',
					'',
					`Operator: \`${operator}\``,
					'',
					'Returns: `boolean`'
				);
				break;
			}
			case 'arithmetic_expression': {
				const operator = token.children[1]?.value;
				contents.push(
					'## Arithmetic Expression',
					'',
					'Performs an arithmetic operation.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```',
					'',
					`Operator: \`${operator}\``,
					'',
					'Returns: `number`'
				);
				break;
			}
			// Add more expression types...
		}

		return contents;
	}

	private getTypeConstructorHoverInfo(token: Token): string[] {
		const typeName = token.children[0]?.value;
		return [
			`## Type Constructor: ${typeName}`,
			'',
			'Constructs a value of a specific type.',
			'',
			'```hcl',
			`${token.getDisplayText()}`,
			'```',
			'',
			`Creates a value of type: \`${typeName}\``
		];
	}

	private getCollectionConstructorHoverInfo(token: Token): string[] {
		const isMap = token.children.some(c => c.type === 'object');
		return [
			`## Collection Constructor: ${isMap ? 'Map' : 'List'}`,
			'',
			`Constructs a ${isMap ? 'map' : 'list'} from the given expressions.`,
			'',
			'```hcl',
			`${token.getDisplayText()}`,
			'```'
		];
	}

	private getDirectiveHoverInfo(token: Token): string[] {
		const contents: string[] = [];

		switch (token.type) {
			case 'if_directive': {
				contents.push(
					'## If Directive',
					'',
					'Conditionally includes or excludes configuration blocks.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```'
				);
				break;
			}
			case 'for_directive': {
				contents.push(
					'## For Directive',
					'',
					'Generates multiple blocks or values from an iteration.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```'
				);
				break;
			}
			// Add other directives...
		}

		return contents;
	}

	private getMetaArgumentHoverInfo(token: Token): string[] {
		const contents: string[] = [];

		switch (token.type) {
			case 'meta_count': {
				contents.push(
					'## Count Meta-Argument',
					'',
					'Specifies the number of instances to create.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```'
				);
				break;
			}
			case 'meta_for_each': {
				contents.push(
					'## For Each Meta-Argument',
					'',
					'Creates an instance for each item in a map or set.',
					'',
					'```hcl',
					`${token.getDisplayText()}`,
					'```'
				);
				break;
			}
			// Add other meta-arguments...
		}

		return contents;
	}

	private getAllLocalsInfo(doc: ParsedDocument): string[] {
		const localsBlock = this.findBlock(doc.getAST(), 'locals');
		const names = localsBlock?.children
			.filter((child: any) => child.type === 'attribute' && typeof child.value === 'string')
			.map((child: any) => String(child.value)) ?? [];
		if (names.length === 0) return [];
		return ['## Local Variables', '', ...names.map((name: string) => `- \`${name}\``)];
	}

	async getHoverInfo(token: Token, doc: ParsedDocument): Promise<MarkupContent | null> {
		let contents: string[] = [];
		const value = token.getDisplayText();

		// Check for expressions first
		if (token.type.endsWith('_expression')) {
			contents = this.getExpressionHoverInfo(token);
		}

		// Special handling for namespace tokens that are part of local references
		if (token.type === 'namespace' && token.value === 'local') {
			// Find the parent local_reference if it exists
			const parentRef = token.parent;
			if (parentRef && parentRef.type === 'local_reference') {
				contents = await this.getLocalReferenceHoverInfo(parentRef, doc);
				if (contents.length > 0) {
					return this.createTrustedMarkdownContent(contents.join('\n'));
				}
			} else {
				// If we're just on the 'local' keyword, show all locals
				contents = await this.getAllLocalsInfo(doc);
				if (contents.length > 0) {
					return this.createTrustedMarkdownContent(contents.join('\n'));
				}
			}
		}

		switch (token.type as TokenType) {
			case 'type_constructor': {
				contents = this.getTypeConstructorHoverInfo(token);
				break;
			}
			case 'collection_constructor': {
				contents = this.getCollectionConstructorHoverInfo(token);
				break;
			}
			case 'if_directive':
			case 'for_directive': {
				contents = this.getDirectiveHoverInfo(token);
				break;
			}
			case 'meta_count':
			case 'meta_for_each':
			case 'meta_depends_on':
			case 'meta_provider':
			case 'meta_lifecycle': {
				contents = this.getMetaArgumentHoverInfo(token);
				break;
			}
			case 'local_reference': {
				contents = await this.getLocalReferenceHoverInfo(token, doc);
				if (contents.length > 0) {
					return this.createTrustedMarkdownContent(contents.join('\n'));
				}
				break;
			}
			case 'string_lit': {
				if (token.parent?.type === 'attribute' && // Handle single dependency path
					token.parent.value === 'config_path' &&
					token.parent.parent?.type === 'block' &&
					token.parent.parent.value === 'dependency') {

					contents = [
						`## Terragrunt Dependency`,
						'',
						`Path: \`${value}\``
					];
					break;
				}
				break;
				// Fall through to other cases if not a dependency
			}
			case 'block_identifier': {
				const blockDefinition = token.parent?.parent?.type === 'root'
					? this.schema.getRootBlockDefinitions(doc.getUri()).find(block => block.type === value)
					: this.schema.getBlockDefinition(value);
				if (blockDefinition) {
					contents = this.getBlockDocumentation(blockDefinition, value);
				}
				break;
			}
			case 'root_assignment_identifier': {
				const attribute = this.schema.getRootAttributeDefinition(doc.getUri(), value);
				if (attribute) contents = this.getAttributeDocumentation(attribute);
				break;
			}

			case 'function_identifier': {
				const funcDef = this.schema.getFunctionDefinition(value);
				if (funcDef) {
					contents = this.getFunctionDocumentation(funcDef);
					return this.createTrustedMarkdownContent(contents.join('\n'));
				}
				break;
			}

			case 'attribute_identifier': {
				if (token.parent?.parent?.type === 'block') {
					const parentBlock = token.parent.parent;
					const parentBlockDefinition = parentBlock.parent?.type === 'root'
						? this.schema.getRootBlockDefinitions(doc.getUri()).find(block => block.type === parentBlock.getDisplayText())
						: this.schema.getBlockDefinition(parentBlock.getDisplayText());
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

			case 'array_lit': {
				// Handle paths array in dependencies block
				if (token.parent?.type === 'attribute' &&
					token.parent?.value === 'paths' &&
					token.parent.parent?.type === 'block' &&
					token.parent.parent.value === 'dependencies') {

					const paths = token.children
						.filter(child => child.type === 'string_lit')
						.map(child => `- \`${child.value}\``);
					contents = ['## Terragrunt Dependencies', '', ...paths];
				}
				break;
			}
		}

		return contents.length > 0 ? this.createTrustedMarkdownContent(contents.join('\n')) : null;
	}


	private buildReferencePath(token: Token): string[] {
		const parts: string[] = [];
		let current: Token | null = token;

		while (current) {
			if (current.type === 'identifier') {
				parts.unshift(current.getDisplayText());
			}
			current = current.parent;
		}

		return parts;
	}


	private findBlock(ast: any, type: string): any {
		if (ast.type === 'block' && ast.value === type) {
			return ast;
		}
		if (!ast.children) {
			return null;
		}
		for (const child of ast.children) {
			const found = this.findBlock(child, type);
			if (found) return found;
		}
		return null;
	}
	private formatValueType(type: ValueType): string {
		switch (type) {
			case 'array': {
				return 'Array';
			}
			case 'object': {
				return 'Object';
			}
			case 'function': {
				return 'Function';
			}
			case 'block': {
				return 'Block';
			}
			case 'ternary': {
				return 'Ternary Expression';
			}
			case 'comparison': {
				return 'Comparison';
			}
			case 'logical': {
				return 'Logical Expression';
			}
			case 'arithmetic': {
				return 'Arithmetic Expression';
			}
			case 'null_coalescing': {
				return 'Null Coalescing';
			}
			case 'unary': {
				return 'Unary Expression';
			}
			case 'postfix': {
				return 'Postfix Expression';
			}
			case 'pipe': {
				return 'Pipe Expression';
			}
			case 'list_comprehension': {
				return 'List Comprehension';
			}
			case 'map_comprehension': {
				return 'Map Comprehension';
			}
			case 'interpolation': {
				return 'String Interpolation';
			}
			case 'reference': {
				return 'Reference';
			}
			default: {
				return type.charAt(0).toUpperCase() + type.slice(1);
			}
		}
	}

	private getBlockDocumentation(blockTemplate: BlockDefinition, value: string): string[] {
		const contents: string[] = [
			`## ${value} Block`,
			'',  // Empty line for better readability
		];

		// Add description with proper formatting
		if (blockTemplate.description) {
			contents.push(blockTemplate.description, '', '---', '');  // Add horizontal rule for section separation
		}

		// Parameters section with better structure
		if (blockTemplate.parameters?.length) {
			contents.push('### Parameters', '');
			blockTemplate.parameters.forEach(param => {
				const typeStr = param.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
				contents.push(`**${param.name}** ${param.required ? '(required)' : '(optional)'}`, `- *Type:* ${typeStr}`);
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
		contents.push(`- *Type:* ${typeStr}`, `- *Required:* ${attr.required ? 'Yes' : 'No'}`);

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
				contents.push(`**${nestedAttr.name}** ${nestedAttr.required ? '(required)' : '(optional)'}`, `- *Type:* ${nestedTypeStr}`);
				if (nestedAttr.description) {
					contents.push(`- *Description:* ${nestedAttr.description}`);
				}
				contents.push('');  // Add space between nested attributes
			});
		}

		return contents;
	}
}
