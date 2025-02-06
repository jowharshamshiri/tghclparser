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
        case 'identifier':
          this.validateIdentifier(token, diagnostics);
          break;
        case 'attribute':
          this.validateAttribute(token, diagnostics);
          break;
      }

      // Recursively validate children
      token.children.forEach(validateToken);
    };

    tokens.forEach(validateToken);
    return diagnostics;
  }

  private validateBlock(token: Token, seenBlocks: Set<string>, diagnostics: Diagnostic[]) {
    const blockValue = token.getDisplayText();
    const template = this.schema.getBlockTemplate(blockValue);

    if (!template) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Unknown block type: ${blockValue}`,
        DiagnosticSeverity.Error
      ));
      return;
    }

    // Check for duplicate blocks
    if (seenBlocks.has(blockValue) && !template.arbitraryAttributes) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Duplicate block: ${blockValue}`,
        DiagnosticSeverity.Error
      ));
    }
    seenBlocks.add(blockValue);

    // Validate required attributes
    if (template.attributes) {
      const requiredAttrs = template.attributes.filter(attr => attr.required);
      const presentAttrs = new Set(
        token.children
          .filter(child => child.type === 'attribute')
          .map(child => child.children.find(c => c.type === 'identifier')?.getDisplayText())
          .filter(Boolean)
      );

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
    // Get function name from child identifier
    const funcIdentifier = token.children.find(child => 
      child.type === 'identifier');
    const funcName = funcIdentifier?.getDisplayText();
    
    if (!funcName) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Invalid function call structure`,
        DiagnosticSeverity.Error
      ));
      return;
    }

    const funcDef = this.schema.getFunctionDefinition(funcName);
    
    if (!funcDef) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Unknown function: ${funcName}`,
        DiagnosticSeverity.Error
      ));
      return;
    }

    // Validate required parameters
    const requiredParams = funcDef.parameters.filter(param => param.required);
    // Remove the function identifier from children count when checking parameters
    const paramCount = token.children.length - 1;
    if (paramCount < requiredParams.length) {
      diagnostics.push(this.createDiagnostic(
        token,
        `Function ${funcName} requires at least ${requiredParams.length} parameters`,
        DiagnosticSeverity.Error
      ));
    }
  }

  private validateIdentifier(token: Token, diagnostics: Diagnostic[]) {
    if (token.parent?.type === 'block') {
      const blockValue = token.parent.getDisplayText();
      const identifierValue = token.getDisplayText();
      const blockTemplate = this.schema.getBlockTemplate(blockValue);
      
      if (!blockTemplate?.attributes?.some(attr => attr.name === identifierValue) &&
          !blockTemplate?.arbitraryAttributes) {
        diagnostics.push(this.createDiagnostic(
          token,
          `Unknown attribute: ${identifierValue} in ${blockValue} block`,
          DiagnosticSeverity.Warning
        ));
      }
    }
  }

  private validateAttribute(token: Token, diagnostics: Diagnostic[]) {
    const attributeIdentifier = token.children.find(child => 
      child.type === 'identifier');
    if (!attributeIdentifier) return;

    const attributeName = attributeIdentifier.getDisplayText();
    const blockToken = this.findParentBlock(token);
    
    if (blockToken) {
      const blockTemplate = this.schema.getBlockTemplate(blockToken.getDisplayText());
      const attribute = blockTemplate?.attributes?.find(attr => attr.name === attributeName);

      if (attribute) {
        // Validate attribute value if present
        const valueToken = token.children.find(child => 
          child.type !== 'identifier');
        if (valueToken) {
          this.validateAttributeValue(valueToken, attribute, diagnostics);
        }
      }
    }
  }

  private validateAttributeValue(token: Token, attribute: any, diagnostics: Diagnostic[]) {
    // Add specific value validation based on attribute definition
    // This is a placeholder for attribute-specific validation
    if (attribute.type === 'string' && token.type !== 'string_lit') {
      diagnostics.push(this.createDiagnostic(
        token,
        `Expected string value for attribute ${attribute.name}`,
        DiagnosticSeverity.Error
      ));
    }
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