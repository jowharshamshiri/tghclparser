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

  private createToken(node: any): Token | null {
    if (!node || !node.location) return null;

    return new Token(
      node.id,
      node.type as any,
      node.value,
      node.location
    );
  }

  private convertAstToTokens(ast: any): Token[] {
    if (!ast || typeof ast !== 'object') {
      return [];
    }

    const rootToken = this.createToken(ast);
    if (!rootToken) return [];

    // Special handling for root node - process its value array
    if (ast.type === 'root' && Array.isArray(ast.value)) {
      for (const childNode of ast.value) {
        const childToken = this.processNode(childNode);
        if (childToken) {
          childToken.parent = rootToken;
          rootToken.children.push(childToken);
        }
      }
    }

    return this.flattenTokens(rootToken);
  }

  private processNode(node: any): Token | null {
    const token = this.createToken(node);
    if (!token) return null;

    if (Array.isArray(node.children)) {
      for (const childNode of node.children) {
        const childToken = this.processNode(childNode);
        if (childToken) {
          childToken.parent = token;
          token.children.push(childToken);
        }
      }
    }

    return token;
  }

  private flattenTokens(rootToken: Token | null): Token[] {
    if (!rootToken) return [];
    
    const result: Token[] = [];
    const seen = new Set<number>();
    
    const visit = (token: Token) => {
      if (!seen.has(token.id)) {
        seen.add(token.id);
        result.push(token);
        for (const child of token.children) {
          visit(child);
        }
      }
    };
    
    visit(rootToken);
    return result;
  }

  private parse(code: string): IParseResult {
    try {
		
      this.ast = tg_parse(code, { grammarSource: this.uri });
	  console.log(this.ast);
      this.tokens = this.convertAstToTokens(this.ast);
	  console.log(this.removeCircularReferences(this.tokens));
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
  

  private processChildren(node: any, parentToken: Token) {
    if (!node.children || !Array.isArray(node.children)) {
      return;
    }

    for (const child of node.children) {
      const childToken = this.createToken(child);
      if (childToken) {
        childToken.parent = parentToken;
        parentToken.children.push(childToken);
        this.processChildren(child, childToken);
      }
    }
  }


  private removeCircularReferences<T>(data: T[]): string {
	return JSON.stringify(data, (key, value) => (key === "parent" ? null : value), 2);
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
    const startPos = token.startPosition;
    const endPos = token.endPosition;

    if (position.line < startPos.line || position.line > endPos.line) {
      return false;
    }

    if (position.line === startPos.line && position.character < startPos.character) {
      return false;
    }

    if (position.line === endPos.line && position.character > endPos.character) {
      return false;
    }

    return true;
  }
}

export {Token};