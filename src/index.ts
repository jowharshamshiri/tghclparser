import { Schema } from './Schema';
import { HoverProvider } from './HoverProvider';
import { CompletionsProvider } from './CompletionsProvider';
import { DiagnosticsProvider } from './DiagnosticsProvider';
import { parse, SyntaxError } from './terragrunt-parser';
import { Token } from './model';
import type { CompletionItem, Diagnostic, Position } from 'vscode-languageserver';

export interface IParseResult {
  ast: any | null;
  diagnostics: Diagnostic[];
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

  constructor(
    private uri: string,
    private content: string
  ) {
    this.schema = Schema.getInstance();
    this.completionsProvider = new CompletionsProvider(this.schema);
    this.hoverProvider = new HoverProvider(this.schema);
    this.diagnosticsProvider = new DiagnosticsProvider(this.schema);
    this.parse();
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
    return this.parse();
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

  private parse(): IParseResult {
    try {
      this.ast = parse(this.content, {
        grammarSource: this.uri
      });
      
      // Convert AST to tokens
      this.tokens = this.convertAstToTokens(this.ast);
      
      // Generate diagnostics using schema validation
      this.diagnostics = this.diagnosticsProvider.getDiagnostics(this.tokens);
      
      return {
        ast: this.ast,
        diagnostics: this.diagnostics
      };
    } catch (e) {
      this.ast = null;
      this.tokens = [];
      
      if (e instanceof SyntaxError) {
        this.diagnostics = [{
          severity: 1,
          range: {
            start: { line: e.location.start.line - 1, character: e.location.start.column - 1 },
            end: { line: e.location.end.line - 1, character: e.location.end.column - 1 }
          },
          message: e.message,
          source: 'terragrunt'
        }];
      } else {
        this.diagnostics = [{
          severity: 1,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          },
          message: e instanceof Error ? e.message : 'Unknown error',
          source: 'terragrunt'
        }];
      }

      return {
        ast: null,
        diagnostics: this.diagnostics
      };
    }
  }

  private convertAstToTokens(ast: any, parent: Token | null = null): Token[] {
    const tokens: Token[] = [];

    if (!ast) return tokens;

    // Handle objects
    if (typeof ast === 'object') {
      for (const [key, value] of Object.entries(ast)) {
        // Create token for the key
        const keyToken = new Token(
          'identifier',
          key,
          0, // We'll need to determine actual positions
          0,
          key.length
        );

        if (parent) {
          keyToken.parent = parent;
          parent.children.push(keyToken);
        }

        // Process the value
        if (typeof value === 'object' && value !== null) {
          // Recursively process nested objects/arrays
          this.convertAstToTokens(value, keyToken);
        } else {
          // Create token for primitive values
          const valueToken = new Token(
            typeof value === 'string' ? 'string_lit' :
            typeof value === 'number' ? 'float_lit' :
            typeof value === 'boolean' ? 'boolean_lit' :
            'null_lit',
            String(value),
            0,
            0,
            String(value).length
          );
          keyToken.children.push(valueToken);
          valueToken.parent = keyToken;
        }

        tokens.push(keyToken);
      }
    }

    return tokens;
  }

  private getLineAtPosition(position: Position): string {
    const lines = this.content.split('\n');
    return position.line < lines.length ? lines[position.line] : '';
  }

  private isPositionInRange(position: Position, token: Token): boolean {
    const tokenStartLine = token.startPosition.line;
    const tokenEndLine = token.endPosition.line;
    const tokenStartChar = token.startPosition.character;
    const tokenEndChar = token.endPosition.character;

    if (position.line < tokenStartLine || position.line > tokenEndLine) {
      return false;
    }

    if (position.line === tokenStartLine && position.character < tokenStartChar) {
      return false;
    }

    if (position.line === tokenEndLine && position.character > tokenEndChar) {
      return false;
    }

    return true;
  }
}