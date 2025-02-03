import blocks from './blocks.json';
import functions from './functions.json';
import type { AttributeDefinition, BlockTemplate, FunctionDefinition } from './model';

export class Schema {
	private static instance: Schema;
	private constructor() { }
	static getInstance(): Schema {
		if (!Schema.instance) {
			Schema.instance = new Schema();
		}
		return Schema.instance;
	}

	// New method to find nested blocks
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

	validateFunctionCall(name: string): boolean {
		return !!this.getFunctionDefinition(name);
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
}