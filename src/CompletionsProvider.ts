import type {
	CompletionItem,
	Position
} from 'vscode-languageserver';
import { CompletionItemKind } from 'vscode-languageserver';

import { PositionContext } from './model';
import type { ParsedDocument } from './ParsedDocument';

export class CompletionsProvider {
	getCompletionsAtPosition(position: Position, parsedDocument:ParsedDocument): CompletionItem[] {
		const textBeforeCursor = parsedDocument.getTextBeforeCursor(position);

		const containingBlock = parsedDocument.findContainingBlock(position);
		const positionContext = parsedDocument.getContextAtPosition(position);

		if (positionContext === PositionContext.Function) {
			const partialFunction = this.getPartialFunctionName(textBeforeCursor);
			return this.getFunctionCompletions(partialFunction, parsedDocument);
		}

		if (containingBlock) {
			const blockIndent = parsedDocument.getLines()[containingBlock.startPosition.line].search(/\S/);
			const currentIndent = parsedDocument.getLineText(position).search(/\S/);

			if (currentIndent > blockIndent || currentIndent === -1) {
				return this.getAttributeCompletions(containingBlock.text, parsedDocument);
			}
		}

		if (positionContext === PositionContext.Block && !containingBlock) {
			return this.getBlockCompletions(parsedDocument);
		}

		return [];
	}
	
	private getPartialFunctionName(textBeforeCursor: string): string {
		const match = textBeforeCursor.match(/=\s*(\w*)$/);
		return match ? match[1] : '';
	}

	private getFunctionCompletions(partialName = '', parsedDocument:ParsedDocument): CompletionItem[] {
		const functions = parsedDocument.getSchema().getAllFunctions();
		return functions
			.filter(func => func.name.startsWith(partialName))
			.map(func => ({
				label: func.name,
				kind: CompletionItemKind.Function,
				detail: parsedDocument.getSchema().getFunctionSignature(func),
				documentation: {
					kind: 'markdown',
					value: func.description || ''
				},
				insertText: parsedDocument.getSchema().generateFunctionSnippet(func),
				filterText: func.name
			}));
	}

	private getBlockCompletions(parsedDocument: ParsedDocument): CompletionItem[] {
		const blockTemplates = parsedDocument.getSchema().getAllBlockTemplates();
		return blockTemplates.map(template => ({
			label: template.type,
			kind: CompletionItemKind.Class,
			detail: `Block: ${template.type}`,
			documentation: {
				kind: 'markdown',
				value: template.description || ''
			},
			insertText: parsedDocument.getSchema().generateBlockSnippet(template)
		}));
	}

	private getAttributeCompletions(blockType: string, parsedDocument:ParsedDocument): CompletionItem[] {
		const template = parsedDocument.getSchema().getBlockTemplate(blockType);
		if (!template?.attributes) return [];

		return template.attributes.map(attr => ({
			label: attr.name,
			kind: CompletionItemKind.Field,
			detail: `${attr.name}: ${attr.value.type}`,
			documentation: {
				kind: 'markdown',
				value: attr.description || ''
			},
			insertText: parsedDocument.getSchema().generateAttributeSnippet(attr)
		}));
	}
	
}