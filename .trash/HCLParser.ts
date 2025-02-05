import { ExpressionParser } from './ExpressionParser';
import { Token } from './model';
import { TokenParser } from './TokenParser';

export class HCLParser {
	private depth = 0;
	private stack: Token[] = [];
	private leadingWhitespace: number[] = [];
	private lines: string[] = [];
	private tokenParser: TokenParser = new TokenParser();
	private expressionParser: ExpressionParser = new ExpressionParser();

	private addToken(token: Token, tokens: Token[]): void {
		if (token.type === 'block' && token.text === 'locals') {
			this.stack.push(token);
			tokens.push(token);
		} else if (this.stack.length > 0) {
			const parent = this.stack.at(-1);
			// Add null check for parent
			if (parent) {
				if (parent.type === 'block' && parent.text === 'locals') {
					parent.children.push(token);
				} else {
					parent.children.push(token);
				}
			}
		} else {
			tokens.push(token);
		}

		if (token.type === 'block' ||
			(token.type === 'identifier' && token.children.some(child => child.type === 'block'))) {
			this.stack.push(token);
		}
	}


	public parse(code: string): Token[] {
		const tokens: Token[] = [];
		this.lines = code.split('\n');
		this.depth = 0;
		this.stack = [];
		this.leadingWhitespace = [];

		// Calculate leading whitespace for each line
		for (let i = 0; i < this.lines.length; i++) {
			const line = this.lines[i];
			const leadingWhitespace = line.match(/^\s*/)?.[0].length || 0;
			this.leadingWhitespace[i] = leadingWhitespace;
		}

		let currentRow = 0;
		while (currentRow < this.lines.length) {
			const line = this.lines[currentRow];
			let currentCol = this.leadingWhitespace[currentRow];

			// Handle block comments
			if (line.trimStart().startsWith('/*')) {
				const [commentToken, newRow, newCol] = this.tokenParser.parseBlockComment(this.lines, currentRow, currentCol);
				this.addToken(commentToken, tokens);
				currentRow = newRow;
				currentCol = newCol;
				continue;
			}

			// Handle inline comments at start of line
			const trimmedLine = line.trimStart();
			if (trimmedLine.startsWith('//') || trimmedLine.startsWith('#')) {
				this.addToken(
					new Token('inline_comment', trimmedLine, currentRow, currentCol, currentRow, currentCol + trimmedLine.length),
					tokens
				);
				currentRow++;
				continue;
			}

			// Handle heredoc
			if (trimmedLine.includes('<<')) {
				const result = this.tokenParser.parseHeredocLine(
					trimmedLine,
					this.lines,
					currentRow,
					currentCol,
					this.expressionParser
				);
				if (result) {
					const [token, newRow] = result;
					this.addToken(token, tokens);
					currentRow = newRow;
					continue;
				}
			}

			// Process remaining line content
			while (currentCol < line.length) {
				const slice = line.slice(currentCol);
				let matched = false;

				[matched, currentRow, currentCol] = this.tokenParser.parseLineContent(
					slice,
					this.lines,
					currentRow,
					currentCol,
					this.depth,
					this.stack,
					tokens,
					this.addToken.bind(this),
					this.expressionParser
				);

				if (!matched) currentCol++;
				if (currentRow !== currentRow) break;
			}
			currentRow++;
		}

		return tokens;
	}
}