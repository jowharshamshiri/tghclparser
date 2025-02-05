import { Schema } from './Schema';
import { Token } from './model';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';

export class DiagnosticsProvider {
  constructor(private schema: Schema) {}

  getDiagnostics(tokens: Token[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const seenBlocks = new Set<string>();

    const validateToken = (token: Token) => {
      switch (token.type) {
        case 'block':
          this.validateBlock(token, seenBlocks, diagnostics);
          break;
        case 'function_call':
          this.validateFunction(token, diagnostics);
          break;
        case 'identifier':
          this.validateIdentifier(token, diagnostics);
          break;
      }

      // Recursively validate children
      token.children.forEach(validateToken);
    };

    tokens.forEach(validateToken);
    return diagnostics;
  }

  private validateBlock(token: Token, seenBlocks: Set<string>, diagnostics: Diagnostic[]) {
    const template = this.schema.getBlockTemplate(token.text);

    if (!template) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Unknown block type: ${token.text}`,
        DiagnosticSeverity.Error
      ));
      return;
    }

    // Check for duplicate blocks
    if (seenBlocks.has(token.text) && !template.arbitraryAttributes) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Duplicate block: ${token.text}`,
        DiagnosticSeverity.Error
      ));
    }
    seenBlocks.add(token.text);

    // Validate required attributes
    if (template.attributes) {
      const requiredAttrs = template.attributes.filter(attr => attr.required);
      const presentAttrs = new Set(token.children
        .filter(child => child.type === 'identifier')
        .map(child => child.text));

      for (const attr of requiredAttrs) {
        if (!presentAttrs.has(attr.name)) {
          diagnostics.push(this.createDiagnostic(
            token,
            `Missing required attribute: ${attr.name}`,
            DiagnosticSeverity.Error
          ));
        }
      }
    }
  }

  private validateFunction(token: Token, diagnostics: Diagnostic[]) {
    const funcDef = this.schema.getFunctionDefinition(token.text);
    
    if (!funcDef) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Unknown function: ${token.text}`,
        DiagnosticSeverity.Error
      ));
      return;
    }

    // Validate required parameters
    const requiredParams = funcDef.parameters.filter(param => param.required);
    if (token.children.length < requiredParams.length) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Function ${token.text} requires at least ${requiredParams.length} parameters`,
        DiagnosticSeverity.Error
      ));
    }
  }

  private validateIdentifier(token: Token, diagnostics: Diagnostic[]) {
    if (token.parent?.type === 'block') {
      const blockTemplate = this.schema.getBlockTemplate(token.parent.text);
      if (!blockTemplate?.attributes?.some(attr => attr.name === token.text) &&
          !blockTemplate?.arbitraryAttributes) {
        diagnostics.push(this.createDiagnostic(
          token,
          `Unknown attribute: ${token.text} in ${token.parent.text} block`,
          DiagnosticSeverity.Warning
        ));
      }
    }
  }

  private createDiagnostic(
    token: Token,
    message: string,
    severity: DiagnosticSeverity
  ): Diagnostic {
    return {
      range: {
        start: {
          line: token.startPosition.line,
          character: token.startPosition.character
        },
        end: {
          line: token.endPosition.line,
          character: token.endPosition.character
        }
      },
      message,
      severity,
      source: 'terragrunt'
    };
  }
}