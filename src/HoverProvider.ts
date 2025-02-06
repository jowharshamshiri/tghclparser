import { Schema } from './Schema';
import { Token } from './model';
import type { HoverResult } from '.';

export class HoverProvider {
  constructor(private schema: Schema) {}

  getHoverInfo(token: Token): HoverResult | null {
    let contents: string[] = [];
    const value = token.getDisplayText();

    switch (token.type) {
      case 'block':
        const blockTemplate = this.schema.getBlockTemplate(value);
        if (blockTemplate) {
          contents = [
            `# ${value} Block`,
            blockTemplate.description || '',
            '## Attributes',
            ...(blockTemplate.attributes || []).map(attr => 
              `- **${attr.name}**: ${attr.description}`
            )
          ];
        }
        break;

      case 'function_call':
        // For function calls, we need to get the actual function name from the child identifier
        const functionName = token.children.find(child => 
          child.type === 'attribute_identifier')?.getDisplayText() || value;
        const funcDef = this.schema.getFunctionDefinition(functionName);
        if (funcDef) {
          contents = [
            `# ${functionName}()`,
            funcDef.description,
            '## Parameters',
            ...funcDef.parameters.map(param =>
              `- **${param.name}** (${param.type}${param.required ? '' : '?'}): ${param.description || ''}`
            ),
            '## Return Type',
            `\`${funcDef.returnType.type}\`: ${funcDef.returnType.description || ''}`
          ];
        }
        break;

      case 'identifier':
      case 'attribute_identifier':
        if (token.parent?.type === 'block') {
          const parentBlockValue = token.parent.getDisplayText();
          const parentBlock = this.schema.getBlockTemplate(parentBlockValue);
          const attr = parentBlock?.attributes?.find(a => a.name === value);
          if (attr) {
            contents = [
              `# ${value}`,
              attr.description,
              `**Required**: ${attr.required}`,
              `**Type**: ${attr.value.type}`
            ];
          }
        }
        break;

      case 'attribute':
        // For attributes, look at the identifier child
        const attrName = token.children.find(child => 
          child.type === 'attribute_identifier')?.getDisplayText();
        if (token.parent?.type === 'block' && attrName) {
          const parentBlockValue = token.parent.getDisplayText();
          const parentBlock = this.schema.getBlockTemplate(parentBlockValue);
          const attr = parentBlock?.attributes?.find(a => a.name === attrName);
          if (attr) {
            contents = [
              `# ${attrName}`,
              attr.description,
              `**Required**: ${attr.required}`,
              `**Type**: ${attr.value.type}`
            ];
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