import path from 'node:path';

import { URI } from 'vscode-uri';

import type { AttributeDefinition, BlockDefinition, DependencyInfo, FunctionDefinition, RuntimeValue, TokenType, ValueType } from './model';
import { Token } from './model';
import type { ParsedDocument } from './ParsedDocument';
import type { Schema } from './Schema';

export interface HoverResult {
	content: {
		kind: 'markdown';
		value: string;
	};
}


export class HoverProvider {
	constructor(private schema: Schema) { }

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

		// Get the value token (second child after the identifier)
		const valueToken = targetAttr.children[1];
		if (!valueToken) return [];

		// Evaluate the value
		const value = await doc.evaluateValue(valueToken);
		if (!value) return [];

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
			'```',
			'',
			'Current value:',
			'```hcl',
			this.formatRuntimeValue(value),
			'```'
		];
	}

	private async getAllLocalsInfo(doc: ParsedDocument): Promise<string[]> {
		// Use ParsedDocument's getAllLocals
		const locals = await doc.getAllLocals();
		if (locals.size === 0) return [];

		const contents: string[] = ['## Local Variables', ''];

		for (const [name, value] of locals.entries()) {
			contents.push(`### ${name}`, '```hcl', this.formatRuntimeValue(value), '```', '');
		}

		return contents;
	}
	// Helper to better debug value tokens
	private async getValueHoverInfo(token: Token, doc: ParsedDocument): Promise<string[]> {
		console.log('getValueHoverInfo for token:', {
			type: token.type,
			value: token.value,
			children: token.children?.map(c => ({
				type: c.type,
				value: c.value
			}))
		});

		const value = await doc.evaluateValue(token);
		console.log('Evaluated value:', value);
		if (!value) return [];

		const contents: string[] = [];
		const formatted = this.formatRuntimeValue(value);
		console.log('Formatted value:', formatted);
		contents.push('## Evaluated Value', '', '```hcl', formatted, '```');

		return contents;
	}

	async getHoverInfo(token: Token, doc: ParsedDocument): Promise<HoverResult | null> {
		console.log('getHoverInfo called with token:', {
			type: token.type,
			value: token.value,
			displayText: token.getDisplayText(),
			parent: token.parent ? {
				type: token.parent.type,
				value: token.parent.value
			} : null
		});

		let contents: string[] = [];
		const value = token.getDisplayText();

		// Special handling for namespace tokens that are part of local references
		if (token.type === 'namespace' && token.value === 'local') {
			// Find the parent local_reference if it exists
			const parentRef = token.parent;
			if (parentRef && parentRef.type === 'local_reference') {
				console.log('Found parent local reference:', {
					type: parentRef.type,
					children: parentRef.children.map(c => ({
						type: c.type,
						value: c.value
					}))
				});
				contents = await this.getLocalReferenceHoverInfo(parentRef, doc);
				if (contents.length > 0) {
					return {
						content: {
							kind: 'markdown',
							value: contents.join('\n')
						}
					};
				}
			} else {
				// If we're just on the 'local' keyword, show all locals
				console.log('Getting all locals info');
				contents = await this.getAllLocalsInfo(doc);
				if (contents.length > 0) {
					return {
						content: {
							kind: 'markdown',
							value: contents.join('\n')
						}
					};
				}
			}
		}

		switch (token.type as TokenType) {
			case 'local_reference': {
				console.log('Processing direct local reference');
				contents = await this.getLocalReferenceHoverInfo(token, doc);
				if (contents.length > 0) {
					return {
						content: {
							kind: 'markdown',
							value: contents.join('\n')
						}
					};
				}
				break;
			}
			case 'string_lit': {
				if (token.parent?.type === 'attribute') {
					// Handle single dependency path
					if (token.parent.value === 'config_path' &&
						token.parent.parent?.type === 'block' &&
						token.parent.parent.value === 'dependency') {

						contents = [
							`## Terragrunt Dependency`,
							'',
							`Path: \`${value}\``,
							'',
							this.getPathLinkMarkdown(value as string, String(token.location.source) || '')
						];
						break;
					}

					// Handle paths array in dependencies block
					if (token.parent.value === 'paths' &&
						token.parent.parent?.type === 'block' &&
						token.parent.parent.value === 'dependencies') {

						contents = [
							`## Terragrunt Dependencies Path`,
							'',
							`Path: \`${value}\``,
							'',
							this.getPathLinkMarkdown(value as string, String(token.location.source) || '')
						];
						break;
					}
				}
				// Fall through to other cases if not a dependency
			}
			case 'block_identifier':
			case 'root_assignment_identifier': {
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
					const parentBlock = token.parent.parent;
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
				value: contents.join('\n')
			}
		} : null;
	}


	private formatRuntimeValue(value: RuntimeValue<ValueType>): string {
		console.log('formatRuntimeValue called with:', value);
		let result: string;

		switch (value.type) {
			case 'string': {
				result = `"${value.value}"`;
				break;
			}
			case 'number':
			case 'boolean': {
				result = String(value.value);
				break;
			}
			case 'array': {
				if (Array.isArray(value.value)) {
					result = `[${value.value.map(v => this.formatRuntimeValue(v)).join(', ')}]`;
				} else {
					result = '[]';
				}
				break;
			}
			case 'object':
			case 'block': {
				if (value.value instanceof Map) {
					const entries: string[] = [];
					value.value.forEach((v, k) => {
						entries.push(`${k} = ${this.formatRuntimeValue(v)}`);
					});
					result = `{${entries.join(', ')}}`;
				} else {
					result = '{}';
				}
				break;
			}
			default: {
				result = value.type;
			}
		}

		console.log('formatRuntimeValue result:', result);
		return result;
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


	private async getOutputs(doc: ParsedDocument): Promise<Map<string, RuntimeValue<ValueType>>> {
		const outputs = new Map<string, RuntimeValue<ValueType>>();
		const ast = doc.getAST();
		if (!ast) return outputs;

		const outputsBlock = this.findBlock(ast, 'outputs');
		if (!outputsBlock) return outputs;

		for (const attr of outputsBlock.children) {
			if (attr.type === 'attribute') {
				const name = attr.children.find(c => c.type === 'identifier')?.value;
				const valueToken = attr.children.find(c => c.type !== 'identifier');
				if (typeof name === 'string' && valueToken && valueToken instanceof Token) {
					const value = await doc.evaluateValue(valueToken);
					if (value) {
						outputs.set(name, value);
					}
				}
			}
		}

		return outputs;
	}
	private findBlock(ast: any, type: string): any {
		console.log('findBlock called for type:', type);
		if (ast.type === 'block' && ast.value === type) {
			console.log('Found matching block:', type);
			return ast;
		}
		if (!ast.children) {
			console.log('No children in current node');
			return null;
		}
		for (const child of ast.children) {
			const found = this.findBlock(child, type);
			if (found) return found;
		}
		console.log('No matching block found');
		return null;
	}

	private getDependencyName(dep: DependencyInfo): string {
		// For dependency blocks, name is in the parameter
		if (dep.block.value === 'dependency') {
			const param = dep.block.children.find(c => c.type === 'parameter');
			return param?.value?.toString() || '';
		}
		// For dependencies block, use the path as name
		return path.basename(dep.targetPath);
	}


	private async getLocalHoverInfo(token: Token, doc: ParsedDocument): Promise<string[]> {
		const parts = this.buildReferencePath(token);
		if (parts.length < 2 || parts[0] !== 'local') return [];

		const locals = await doc.getAllLocals();
		const localName = parts[1];
		const value = locals.get(localName);
		if (!value) return [];

		const contents: string[] = [];
		contents.push(`## Local Variable: ${localName}`, '', '```hcl', this.formatRuntimeValue(value), '```');

		return contents;
	}

	private async getDependencyHoverInfo(token: Token, doc: ParsedDocument): Promise<string[]> {
		const parts = this.buildReferencePath(token);
		if (parts.length < 3 || parts[1] !== 'outputs') return [];

		const depName = parts[0];
		const dependencies = await doc.getWorkspace().getDependencies(doc.getUri());
		const dep = dependencies.find(d => d.block.value === depName);
		if (!dep) return [];

		const depDoc = await doc.getWorkspace().getDocument(dep.targetPath);
		if (!depDoc) return [];

		const outputs = await this.getOutputs(depDoc);
		const outputName = parts[2];
		const value = outputs.get(outputName);
		if (!value) return [];

		const contents: string[] = [];
		contents.push(`## Dependency Output: ${depName}.outputs.${outputName}`, '', `From: \`${dep.targetPath}\``, '', '```hcl', this.formatRuntimeValue(value), '```');

		return contents;
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

		if (funcDef.parameters.length > 0) {
			contents.push('### Parameters', '');
			funcDef.parameters.forEach(param => {
				const typeStr = param.types.map(t => `\`${this.formatValueType(t)}\``).join(' | ');
				contents.push(`**${param.name}** ${param.required ? '(required)' : '(optional)'}`, `- *Type:* ${typeStr}${param.variadic ? ' (variadic)' : ''}`);
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
	private getPathLinkMarkdown(value: string, sourceLocation: string): string {
		const sourceUri = URI.parse(sourceLocation);
		const sourceDir = path.dirname(sourceUri.fsPath);
		const depPath = path.resolve(sourceDir, value);
		const targetUri = URI.file(path.join(depPath, 'terragrunt.hcl')).toString();

		return `[Open terragrunt.hcl](${targetUri})`;
	}

}