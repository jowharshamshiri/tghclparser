import { CompletionItem, Diagnostic, Position } from 'vscode-languageserver';
import { parse as tg_parse, SyntaxError } from './terragrunt-parser';
import { Token, Location, BlockValue, ASTValue, ASTNode } from './model';
import { Schema } from './Schema';
import { CompletionsProvider } from './CompletionsProvider';
import { HoverProvider } from './HoverProvider';
import { DiagnosticsProvider } from './DiagnosticsProvider';

export interface IParseResult {
  ast: any | null;
  diagnostics: Diagnostic[];
  tokens: Token[];
}

export interface HoverResult {
  content: {
    kind: 'markdown';
    value: string;
  };
}

export class ParsedDocument {
  private ast: any | null = null;
  private diagnostics: Diagnostic[] = [];
  private tokens: Token[] = [];
  private schema: Schema;
  private completionsProvider: CompletionsProvider;
  private hoverProvider: HoverProvider;
  private diagnosticsProvider: DiagnosticsProvider;

  constructor(private uri: string, private content: string) {
    this.schema = Schema.getInstance();
    this.completionsProvider = new CompletionsProvider(this.schema);
    this.hoverProvider = new HoverProvider(this.schema);
    this.diagnosticsProvider = new DiagnosticsProvider(this.schema);
    this.parse(content);
  }

  private convertAstToTokens(ast: any, parent: Token | null = null): Token[] {
    const tokens: Token[] = [];
    
    if (!ast || typeof ast !== 'object') {
      return tokens;
    }

    // Handle root node
    if (ast.type === 'root' && Array.isArray(ast.value)) {
      ast.value.forEach(statement => {
        if (Array.isArray(statement) && statement[1]) {
          const blockTokens = this.processBlock(statement[1], parent);
          tokens.push(...blockTokens);
        }
      });
      return tokens;
    }

    // Handle individual blocks and values
    if ('key' in ast && 'value' in ast) {
      const blockTokens = this.processBlock(ast, parent);
      tokens.push(...blockTokens);
    }

    return tokens;
  }

  private processBlock(block: any, parent: Token | null): Token[] {
    const tokens: Token[] = [];
    const location = block.location;

    // Create block token
    const blockToken = new Token(
      'block',
      block.key,
      location.start.line - 1,
      location.start.column - 1,
      location.end.line - 1,
      location.end.column - 1
    );

    if (parent) {
      blockToken.parent = parent;
      parent.children.push(blockToken);
    }

    // Process block value
    if (block.value) {
      if (typeof block.value === 'object') {
        // Handle nested blocks and attributes
        Object.entries(block.value).forEach(([key, value]: [string, any]) => {
          // Create attribute token
          const attrToken = new Token(
            'identifier',
            key,
            value.location?.start.line - 1 || 0,
            value.location?.start.column - 1 || 0,
            value.location?.end.line - 1 || 0,
            value.location?.end.column - 1 || 0
          );
          attrToken.parent = blockToken;
          blockToken.children.push(attrToken);

          // Handle the value based on its type
          if (value.type) {
            const valueToken = new Token(
              value.type,
              value.value,
              value.location?.start.line - 1 || 0,
              value.location?.start.column - 1 || 0,
              value.location?.end.line - 1 || 0,
              value.location?.end.column - 1 || 0
            );
            valueToken.parent = attrToken;
            attrToken.children.push(valueToken);
          } else if (typeof value === 'object') {
            // Recursively process nested blocks
            const nestedTokens = this.convertAstToTokens(value, attrToken);
            tokens.push(...nestedTokens);
          }
        });
      } else {
        // Handle primitive values
        const valueToken = new Token(
          typeof block.value === 'string' ? 'string_lit' : 
          typeof block.value === 'number' ? 'number_lit' : 
          typeof block.value === 'boolean' ? 'boolean_lit' : 
          'unknown',
          String(block.value),
          location.start.line - 1,
          location.start.column - 1,
          location.end.line - 1,
          location.end.column - 1
        );
        valueToken.parent = blockToken;
        blockToken.children.push(valueToken);
      }
    }

    tokens.push(blockToken);
    return tokens;
  }

  private parse(code: string): IParseResult {
    try {
      this.ast = tg_parse(code, { grammarSource: this.uri });
      this.tokens = this.convertAstToTokens(this.ast);
      this.diagnostics = this.diagnosticsProvider.getDiagnostics(this.tokens);
      
      return {
        ast: this.ast,
        diagnostics: this.diagnostics,
        tokens: this.tokens
      };
    } catch (e) {
      const diagnostic: Diagnostic = {
        severity: 1,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 }
        },
        message: e instanceof Error ? e.message : 'Unknown error',
        source: 'terragrunt'
      };
      
      return {
        ast: null,
        diagnostics: [diagnostic],
        tokens: []
      };
    }
  }

  public getUri(): string {
    return this.uri;
  }

  public getContent(): string {
    return this.content;
  }

  public getAST(): any | null {
    return this.ast;
  }

  public getTokens(): Token[] {
    return this.tokens;
  }

  public getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  public update(newContent: string): IParseResult {
    this.content = newContent;
    return this.parse(newContent);
  }

  public getCompletionsAtPosition(position: Position): CompletionItem[] {
    const lineText = this.getLineAtPosition(position);
    const token = this.findTokenAtPosition(position);
    return this.completionsProvider.getCompletions(lineText, position, token);
  }

  public getHoverInfo(position: Position): HoverResult | null {
    const token = this.findTokenAtPosition(position);
    if (!token) return null;
    return this.hoverProvider.getHoverInfo(token);
  }

  public findTokenAtPosition(position: Position): Token | null {
    const findToken = (tokens: Token[]): Token | null => {
      for (const token of tokens) {
        if (this.isPositionInRange(position, token)) {
          // Check children first for more specific matches
          const childMatch = findToken(token.children);
          if (childMatch) return childMatch;
          return token;
        }
      }
      return null;
    };

    return findToken(this.tokens);
  }

  private getLineAtPosition(position: Position): string {
    const lines = this.content.split('\n');
    return position.line < lines.length ? lines[position.line] : '';
  }

  private isPositionInRange(position: Position, token: Token): boolean {
    if (position.line < token.startPosition.line || 
        position.line > token.endPosition.line) {
      return false;
    }

    if (position.line === token.startPosition.line && 
        position.character < token.startPosition.character) {
      return false;
    }

    if (position.line === token.endPosition.line && 
        position.character > token.endPosition.character) {
      return false;
    }

    return true;
  }
}

export { Token };