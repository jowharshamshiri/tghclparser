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
    if (token?.type === 'block') {
      return this.getAttributeCompletions(token.text);
    }

    // After = sign - suggest functions
    if (this.isAfterEquals(line, position.character)) {
      return this.getFunctionCompletions();
    }

    return [];
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
}