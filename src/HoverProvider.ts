import type {
	MarkupContent
} from 'vscode-languageserver';

import type { AttributeDefinition, BlockTemplate, FunctionDefinition, Token } from './model';
import type { ParsedDocument } from './ParsedDocument';
import type { Schema } from './Schema';

export class HoverProvider {
	getHoverInfo(token: Token, parsedDocument: ParsedDocument): { contents: MarkupContent } | null {
		const parentBlock = token.type === 'identifier' ? parsedDocument.findParentBlock(token) : null;
		let contents: MarkupContent | null = null;

		switch (token.type) {
			case 'block': {
				const template = parsedDocument.getSchema().getBlockTemplate(token.text);
				if (template) {
					contents = {
						kind: 'markdown',
						value: this.formatBlockContent(template)
					};
				}
				break;
			}
			case 'function_call': {
				const func = parsedDocument.getSchema().getFunctionDefinition(token.text);
				if (func) {
					contents = {
						kind: 'markdown',
						value: this.formatFunctionContent(func, parsedDocument.getSchema())
					};
				}
				break;
			}
			case 'identifier': {
				if (parentBlock) {
					const template = parsedDocument.getSchema().getBlockTemplate(parentBlock.text);
					if (template) {
						const attr = template.attributes?.find(a => a.name === token.text);
						if (attr) {
							contents = {
								kind: 'markdown',
								value: this.formatAttributeContent(attr)
							};
						}
					}
				}
				break;
			}
			case 'string_lit': {
				if (token.decorators && token.decorators.length > 0) {
					contents = {
						kind: 'markdown',
						value: this.formatDecoratorContent(token)
					};
				}
				break;
			}
		}

		return contents ? { contents } : null;
	}


	private formatBlockContent(template: BlockTemplate): string {
		return [
			`# ${template.type} Block`,
			template.description || '',
			'## Attributes',
			this.formatAttributes(template.attributes || [])
		].join('\n\n');
	}

	private formatFunctionContent(func: FunctionDefinition, schema: Schema): string {
		return [
			`# ${func.name}`,
			func.description || '',
			'## Signature',
			'```typescript',
			schema.getFunctionSignature(func),
			'```',
			'## Parameters',
			this.formatParameters(func.parameters)
		].join('\n\n');
	}

	private formatAttributeContent(attr: AttributeDefinition): string {
		const parts = [
			`# ${attr.name}`,
			attr.description || '',
			`**Type**: ${attr.value.type}`,
			`**Required**: ${attr.required ? 'Yes' : 'No'}`
		];

		if (attr.value.pattern) {
			parts.push(`**Pattern**: \`${attr.value.pattern}\``);
		}
		if (attr.value.enum) {
			parts.push(`**Allowed Values**: ${attr.value.enum.join(', ')}`);
		}

		return parts.filter(Boolean).join('\n\n');
	}

	private formatDecoratorContent(token: Token): string {
		const decoratorTypes: Record<string, string> = {
			git_ssh_url: 'Git SSH URL',
			git_https_url: 'Git HTTPS URL',
			terraform_registry_url: 'Terraform Registry URL',
			s3_url: 'S3 URL',
			https_url: 'HTTPS URL',
			file_path: 'File Path',
			email: 'Email Address',
			ip_address: 'IP Address',
			date: 'Date',
			time: 'Time',
			uuid: 'UUID'
		};

		if (token.decorators && token.decorators.length > 0) {
			const decorator = token.decorators[0];
			return `**${decoratorTypes[decorator.type]}**\n\n\`${token.text}\``;
		}
		return '';
	}

	private formatAttributes(attrs: AttributeDefinition[]): string {
		return attrs.map(attr =>
			`- **${attr.name}** *(${attr.value.type})* ${attr.required ? '(required)' : '(optional)'}\n  ${attr.description || ''}`
		).join('\n\n');
	}

	private formatParameters(params: any[]): string {
		return params.map(param =>
			`- **${param.name}** *(${param.type})* ${param.required ? '(required)' : '(optional)'}\n  ${param.description || ''}`
		).join('\n\n');
	}

}