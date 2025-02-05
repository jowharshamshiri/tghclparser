import { Schema } from './Schema';
import { Token } from './model';
import type { HoverResult } from '.';

export class HoverProvider {
  constructor(private schema: Schema) {}

  getHoverInfo(token: Token): HoverResult | null {
    let contents: string[] = [];

    switch (token.type) {
      case 'block':
        const blockTemplate = this.schema.getBlockTemplate(token.text);
        if (blockTemplate) {
          contents = [
            `# ${token.text} Block`,
            blockTemplate.description || '',
            '## Attributes',
            ...(blockTemplate.attributes || []).map(attr => 
              `- **${attr.name}**: ${attr.description}`
            )
          ];
        }
        break;

      case 'function_call':
        const funcDef = this.schema.getFunctionDefinition(token.text);
        if (funcDef) {
          contents = [
            `# ${token.text}()`,
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
        if (token.parent?.type === 'block') {
          const parentBlock = this.schema.getBlockTemplate(token.parent.text);
          const attr = parentBlock?.attributes?.find(a => a.name === token.text);
          if (attr) {
            contents = [
              `# ${token.text}`,
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