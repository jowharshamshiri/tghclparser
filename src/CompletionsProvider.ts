import { Schema } from './Schema';
import { Token } from './model';
import { CompletionItem, CompletionItemKind, Position } from 'vscode-languageserver';

export class CompletionsProvider {
  constructor(private schema: Schema) {}

  getCompletions(line: string, position: Position, token: Token | null): CompletionItem[] {
    // Start of line - suggest blocks
    if (this.isStartOfLine(line, position.character)) {
      return this.getBlockCompletions();
    }

    // Inside a block - suggest attributes
    if (token && (token.type === 'block' || this.findParentBlock(token))) {
      const blockToken = token.type === 'block' ? token : this.findParentBlock(token);
      if (blockToken) {
        return this.getAttributeCompletions(blockToken.getDisplayText());
      }
    }

    // After = sign - suggest functions
    if (this.isAfterEquals(line, position.character)) {
      return this.getFunctionCompletions();
    }

    return [];
  }

  private findParentBlock(token: Token): Token | null {
    let current = token.parent;
    while (current) {
      if (current.type === 'block') {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private isStartOfLine(line: string, character: number): boolean {
    return line.slice(0, character).trim().length === 0;
  }

  private isAfterEquals(line: string, character: number): boolean {
    const beforeCursor = line.slice(0, character).trim();
    return beforeCursor.endsWith('=');
  }

  private getBlockCompletions(): CompletionItem[] {
    return this.schema.getAllBlockTemplates().map(template => ({
      label: template.type,
      kind: CompletionItemKind.Class,
      detail: template.description,
      insertText: this.schema.generateBlockSnippet(template),
      insertTextFormat: 2 // Snippet
    }));
  }

  private getAttributeCompletions(blockType: string): CompletionItem[] {
    const template = this.schema.getBlockTemplate(blockType);
    if (!template?.attributes) return [];

    return template.attributes.map(attr => ({
      label: attr.name,
      kind: CompletionItemKind.Field,
      detail: attr.description,
      insertText: this.schema.generateAttributeSnippet(attr),
      insertTextFormat: 2 // Snippet
    }));
  }

  private getFunctionCompletions(): CompletionItem[] {
    return this.schema.getAllFunctions().map(func => ({
      label: func.name,
      kind: CompletionItemKind.Function,
      detail: func.description,
      insertText: this.schema.generateFunctionSnippet(func),
      insertTextFormat: 2 // Snippet
    }));
  }

  // Helper method to determine if a token is within a block's attribute context
  private isAttributeContext(token: Token): boolean {
    if (!token) return false;
    
    // If we're in an attribute or identifier
    if (token.type === 'attribute' || token.type === 'identifier') {
      return true;
    }

    // Check if we're in a block's body
    let current = token;
    while (current.parent) {
      if (current.parent.type === 'block') {
        return true;
      }
      current = current.parent;
    }

    return false;
  }
}