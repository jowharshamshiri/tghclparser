import { Schema } from './Schema';
import { AttributeDefinition, BlockTemplate, FunctionDefinition, Token, TokenType, ValueType } from './model';
import type { HoverResult } from '.';

export class HoverProvider {
  constructor(private schema: Schema) {}

  private formatValueType(value: ValueType): string {
    switch (value) {
      case 'array':
        return 'Array';
      case 'object':
        return 'Object';
      case 'function_call':
        return 'Function Call';
      case 'property_access':
        return 'Property Access';
      case 'interpolation':
        return 'String Interpolation';
      case 'heredoc':
        return 'Heredoc';
      default:
        return value.charAt(0).toUpperCase() + value.slice(1);
    }
  }

  private getBlockDocumentation(blockTemplate: BlockTemplate, value: string): string[] {
    const contents: string[] = [
      `# ${value} Block`,
      blockTemplate.description || ''
    ];

    if (blockTemplate.parameters?.length) {
      contents.push('## Parameters');
      contents.push(...blockTemplate.parameters.map(param => 
        `- **${param.name}** (${param.type}${param.required ? '' : '?'}): ${param.description || ''}`
      ));
    }

    if (blockTemplate.attributes?.length) {
      contents.push('## Attributes');
      contents.push(...blockTemplate.attributes.map(attr => {
        let attrDoc = `- **${attr.name}** (${this.formatValueType(attr.value.type)}${attr.required ? '' : '?'})`;
        if (attr.description) attrDoc += `: ${attr.description}`;
        if (attr.allowedValues?.length) {
          attrDoc += `\n  - Allowed values: ${attr.allowedValues.join(', ')}`;
        }
        if (attr.value.pattern) {
          attrDoc += `\n  - Pattern: \`${attr.value.pattern}\``;
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
        let paramDoc = `- **${param.name}** (${param.type}${param.required ? '' : '?'})`;
        if (param.description) paramDoc += `: ${param.description}`;
        if (param.variadic) paramDoc += ' (variadic)';
        return paramDoc;
      }));
    }

    contents.push('## Return Type');
    contents.push(`\`${funcDef.returnType.type}\`${funcDef.returnType.description ? `: ${funcDef.returnType.description}` : ''}`);

    return contents;
  }

  private getAttributeDocumentation(attr: AttributeDefinition): string[] {
    const contents: string[] = [
      `# ${attr.name}`,
      attr.description
    ];

    contents.push('## Details');
    contents.push(`- **Type**: ${this.formatValueType(attr.value.type)}`);
    contents.push(`- **Required**: ${attr.required}`);

    if (attr.value.pattern) {
      contents.push(`- **Pattern**: \`${attr.value.pattern}\``);
    }

    if (attr.allowedValues?.length) {
      contents.push('## Allowed Values');
      contents.push(attr.allowedValues.map(value => `- \`${value}\``).join('\n'));
    }

    if (attr.value.type === 'object' && attr.value.properties) {
      contents.push('## Properties');
      Object.entries(attr.value.properties).forEach(([key, prop]) => {
        contents.push(`- **${key}** (${this.formatValueType(prop.type)})`);
        if (prop.description) contents.push(`  ${prop.description}`);
      });
    }

    return contents;
  }

  getHoverInfo(token: Token): HoverResult | null {
    let contents: string[] = [];
    const value = token.getDisplayText();

    switch (token.type) {
      case 'block':
      case 'block_with_param':
        const blockTemplate = this.schema.getBlockTemplate(value);
        if (blockTemplate) {
          contents = this.getBlockDocumentation(blockTemplate, value);
        }
        break;

      case 'function_call':
        const functionName = token.children.find(child => 
          child.type === 'identifier')?.getDisplayText() || value;
        const funcDef = this.schema.getFunctionDefinition(functionName);
        if (funcDef) {
          contents = this.getFunctionDocumentation(funcDef);
        }
        break;

      case 'identifier':
        if (token.parent?.type === 'block' || token.parent?.type === 'block_with_param') {
          const parentBlockValue = token.parent.getDisplayText();
          const parentBlock = this.schema.getBlockTemplate(parentBlockValue);
          const attr = parentBlock?.attributes?.find(a => a.name === value);
          if (attr) {
            contents = this.getAttributeDocumentation(attr);
          }
        }
        break;

      case 'attribute':
        const attrName = token.children.find(child => 
          child.type === 'identifier')?.getDisplayText();
        if ((token.parent?.type === 'block' || token.parent?.type === 'block_with_param') && attrName) {
          const parentBlockValue = token.parent.getDisplayText();
          const parentBlock = this.schema.getBlockTemplate(parentBlockValue);
          const attr = parentBlock?.attributes?.find(a => a.name === attrName);
          if (attr) {
            contents = this.getAttributeDocumentation(attr);
          }
        }
        break;

      case 'block_parameter':
        if (token.parent?.type === 'block_with_param') {
          const blockTemplate = this.schema.getBlockTemplate(token.parent.getDisplayText());
          const param = blockTemplate?.parameters?.find(p => p.pattern && new RegExp(p.pattern).test(value));
          if (param) {
            contents = [
              `# Block Parameter: ${param.name}`,
              param.description || '',
              '## Details',
              `- **Type**: ${param.type}`,
              `- **Required**: ${param.required}`,
              param.pattern ? `- **Pattern**: \`${param.pattern}\`` : ''
            ].filter(Boolean);
          }
        }
        break;
    }

    return contents.length > 0 ? {
      content: {
        kind: 'markdown',
        value: contents.join('\n\n')
      }
    } : null;
  }
}