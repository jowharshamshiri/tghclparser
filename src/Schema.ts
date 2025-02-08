import blocks from './blocks.json';
import functionsJson from './functions.json';
const functions = functionsJson as { functions: FunctionDefinition[] };
import type { AttributeDefinition, BlockDefinition, FunctionDefinition, ValueType } from './model';

export class Schema {
    private static instance: Schema;
    private constructor() { }
    
    static getInstance(): Schema {
        if (!Schema.instance) {
            Schema.instance = new Schema();
        }
        return Schema.instance;
    }

    findNestedBlockTemplate(parentType: string, nestedType: string): BlockDefinition | undefined {
        const parent = this.getBlockTemplate(parentType);
        if (!parent?.blocks) return undefined;

        return this.findBlockInHierarchy(parent.blocks, nestedType);
    }

    private findBlockInHierarchy(blocks: BlockDefinition[], type: string): BlockDefinition | undefined {
        for (const block of blocks) {
            if (block.type === type) return block;

            if (block.blocks) {
                const found = this.findBlockInHierarchy(block.blocks, type);
                if (found) return found;
            }
        }
        return undefined;
    }

    validateBlockType(type: string, parentType?: string): boolean {
        if (parentType) {
            return !!this.findNestedBlockTemplate(parentType, type);
        }
        return !!this.getBlockTemplate(type);
    }

    getBlockTemplate(type: string): BlockDefinition | undefined {
        const result = blocks.blocks.find(b => b.type === type) as BlockDefinition;
        return result ?? undefined;
    }

    getAllBlockTemplates(): BlockDefinition[] {
        return blocks.blocks.map(block =>
            this.getBlockTemplate(block.type)
        ).filter((block): block is BlockDefinition => block !== undefined);
    }

    getAllFunctions(): FunctionDefinition[] {
        return functions.functions;
    }

    getFunctionDefinition(name: string): FunctionDefinition | undefined {
        return functions.functions.find(f => f.name === name);
    }

    getFunctionSignature(func: FunctionDefinition): string {
        const params = func.parameters.map(p =>
            `${p.name}${p.required ? '' : '?'}: ${p.types.join(' | ')}`
        ).join(', ');
        return `${func.name}(${params}): ${func.returnType.types.join(' | ')}`;
    }

    generateFunctionSnippet(func: FunctionDefinition): string {
        const params = func.parameters
            .map((p, i) => `\${${i + 1}:${p.name}}`)
            .join(', ');
        return `${func.name}(${params})`;
    }

    generateBlockSnippet(template: BlockDefinition): string {
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
        const typeMap: Record<ValueType, string> = {
            string: `"\${1:string}"`,
            number: `\${1:0}`,
            boolean: `\${1:true}`,
            null: 'null',
            array: `[\${1:items}]`,
            object: `{\n\t\${1:key} = \${2:value}\n}`,
            function: `\${1:func}()`,
            block: `{\n\t\${1}\n}`,
            ternary: `\${1:condition} ? \${2:true} : \${3:false}`,
            comparison: `\${1:left} \${2:==} \${3:right}`,
            logical: `\${1:left} \${2:&&} \${3:right}`,
            arithmetic: `\${1:left} \${2:+} \${3:right}`,
            null_coalescing: `\${1:left} ?? \${2:right}`,
            unary: `!\${1:expr}`,
            postfix: `\${1:expr}[*]`,
            pipe: `\${1:expr} | \${2:func}`,
            list_comprehension: `[\${1:expr} for \${2:item} in \${3:list}]`,
            map_comprehension: `{\${1:key} = \${2:value} for \${3:item} in \${4:list}}`,
            interpolation: `\${\${1:expr}}`,
            reference: `\${1:ref}`
        };

        // Find the first supported type or fall back to string
        const type = attr.types.find(t => t in typeMap) || 'string';
        return `${attr.name} = ${typeMap[type]}`;
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

        // Check if value type matches any of the allowed types
        const isValidType = attr.types.some(type => {
            switch (type) {
                case 'string':
                    return typeof value === 'string' && 
                           (!attr.validation?.pattern || new RegExp(attr.validation.pattern).test(value));
                case 'number':
                    return typeof value === 'number' &&
                           (!attr.validation?.min || value >= attr.validation.min) &&
                           (!attr.validation?.max || value <= attr.validation.max);
                case 'boolean':
                    return typeof value === 'boolean';
                case 'array':
                    return Array.isArray(value);
                case 'object':
                    return typeof value === 'object' && value !== null && !Array.isArray(value);
                case 'null':
                    return value === null;
                // Add other type validations as needed
                default:
                    return false;
            }
        });

        if (!isValidType) return false;

        // Check allowed values if specified
        if (attr.validation?.allowedValues && !attr.validation.allowedValues.includes(value)) {
            return false;
        }

        // Run custom validator if provided
        if (attr.validation?.customValidator && !attr.validation.customValidator(value)) {
            return false;
        }

        return true;
    }
}