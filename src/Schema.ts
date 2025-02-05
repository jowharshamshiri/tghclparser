import blocks from './blocks.json';
import functions from './functions.json';
import type { AttributeDefinition, BlockTemplate, FunctionDefinition } from './model';

export class Schema {
	private static instance: Schema;
	private constructor() {
	}
	static getInstance(): Schema {
		if (!Schema.instance) {
			Schema.instance = new Schema();
		}
		return Schema.instance;
	}

	findNestedBlockTemplate(parentType: string, nestedType: string): BlockTemplate | undefined {
		const parent = this.getBlockTemplate(parentType);
		if (!parent?.blocks) return undefined;

		return this.findBlockInHierarchy(parent.blocks, nestedType);
	}

	private findBlockInHierarchy(blocks: BlockTemplate[], type: string): BlockTemplate | undefined {
		for (const block of blocks) {
			if (block.type === type) return block;

			if (block.blocks) {
				const found = this.findBlockInHierarchy(block.blocks, type);
				if (found) return found;
			}
		}
		return undefined;
	}

	// Update block validation to handle nested structure
	validateBlockType(type: string, parentType?: string): boolean {
		if (parentType) {
			return !!this.findNestedBlockTemplate(parentType, type);
		}
		return !!this.getBlockTemplate(type);
	}

	getBlockTemplate(type: string): BlockTemplate | undefined {
		const result = blocks.blocks.find(b => b.type === type) as BlockTemplate;
		return result ?? undefined;
	}

	getAllBlockTemplates(): BlockTemplate[] {
		return blocks.blocks.map(block =>
			this.getBlockTemplate(block.type)
		).filter((block): block is BlockTemplate => block !== undefined);
	}

	getAllFunctions(): FunctionDefinition[] {
		return functions.functions;
	}

	getFunctionDefinition(name: string): FunctionDefinition | undefined {
		return functions.functions.find(f => f.name === name);
	}

	getFunctionSignature(func: FunctionDefinition): string {
		const params = func.parameters.map(p =>
			`${p.name}${p.required ? '' : '?'}: ${p.type}`
		).join(', ');
		return `${func.name}(${params}): ${func.returnType.type}`;
	}

	generateFunctionSnippet(func: FunctionDefinition): string {
		const params = func.parameters
			.map((p, i) => `\${${i + 1}:${p.name}}`)
			.join(', ');
		return `${func.name}(${params})`;
	}

	generateBlockSnippet(template: BlockTemplate): string {
		let snippet = `${template.type} {\n`;
		if (template.attributes) {
			template.attributes
				.filter(attr => attr.required)
				.forEach((attr, i) => {
					snippet += `\t${attr.name} = \${${i + 1}}\n`;
				});
		}
		snippet += '}';
		return snippet;
	}

	generateAttributeSnippet(attr: AttributeDefinition): string {
		const typeMap: Record<string, string> = {
			string: `"\${1:string}"`,
			number: `\${1:0}`,
			bool: `\${1:true}`,
			object: `{\n\t\${1:key} = \${2:value}\n}`,
			default: `\${1:value}`
		};
		return `${attr.name} = ${typeMap[attr.value.type] || typeMap.default}`;
	}

	validateBlockAttributes(blockType: string, attributes: Record<string, any>): boolean {
		const template = this.getBlockTemplate(blockType);
		if (!template) return false;

		// If the block allows arbitrary attributes, all attribute combinations are valid
		if (template.arbitraryAttributes) return true;

		// Check that all required attributes are present
		const requiredAttrs = template.attributes?.filter(attr => attr.required) || [];
		for (const attr of requiredAttrs) {
			if (!(attr.name in attributes)) {
				return false;
			}
		}

		// Check that all present attributes are defined in the schema
		for (const attrName of Object.keys(attributes)) {
			if (!template.attributes?.some(attr => attr.name === attrName)) {
				return false;
			}
		}

		return true;
	}

	validateFunctionCall(funcName: string, args: any[]): boolean {
		const funcDef = this.getFunctionDefinition(funcName);
		if (!funcDef) return false;

		// Check required parameters
		const requiredParams = funcDef.parameters.filter(param => param.required);
		if (args.length < requiredParams.length) {
			return false;
		}

		// Check if too many arguments (unless the last parameter is variadic)
		const lastParam = funcDef.parameters[funcDef.parameters.length - 1];
		if (!lastParam?.variadic && args.length > funcDef.parameters.length) {
			return false;
		}

		return true;
	}

	validateAttributeValue(blockType: string, attrName: string, value: any): boolean {
		const template = this.getBlockTemplate(blockType);
		if (!template) return false;

		const attr = template.attributes?.find(a => a.name === attrName);
		if (!attr) return template.arbitraryAttributes || false;

		// Check value type
		switch (attr.value.type) {
			case 'string':
				if (typeof value !== 'string') return false;
				if (attr.value.pattern && !new RegExp(attr.value.pattern).test(value)) {
					return false;
				}
				break;

			case 'number':
				if (typeof value !== 'number') return false;
				break;

			case 'boolean':
				if (typeof value !== 'boolean') return false;
				break;

			case 'array':
				if (!Array.isArray(value)) return false;
				if (attr.value.minItems && value.length < attr.value.minItems) return false;
				if (attr.value.maxItems && value.length > attr.value.maxItems) return false;
				break;

			case 'object':
				if (typeof value !== 'object' || value === null || Array.isArray(value)) {
					return false;
				}
				break;
		}

		// Check enum values if specified
		if (attr.value.enum && !attr.value.enum.includes(value)) {
			return false;
		}

		return true;
	}

}