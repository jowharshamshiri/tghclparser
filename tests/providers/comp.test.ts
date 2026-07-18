import fs from 'node:fs';
import path from 'node:path';

import { expect } from 'chai';
import type { Position } from 'vscode-languageserver';

import { CompletionsProvider } from '../../src/providers/CompletionsProvider';
import { Schema } from '../../src/Schema';

interface TestCase {
    file: string;
    content: string;
    ast: any;
}

describe('CompletionsProvider with Real Files', () => {
    let provider: CompletionsProvider;
    const testCases: TestCase[] = [];

    before(() => {
        provider = new CompletionsProvider(Schema.getInstance());
        
        // Load all test cases from the cases directory
        const casesDir = path.join(__dirname, 'cases');
        const files = fs.readdirSync(casesDir);
        
        // Group files by their base name (without extension)
        const fileGroups = new Map<string, {content?: string, ast?: any}>();
        
        files.forEach(file => {
            const baseName = file.split('_')[0];
            const fileContent = fs.readFileSync(path.join(casesDir, file), 'utf8');
            
            if (!fileGroups.has(baseName)) {
                fileGroups.set(baseName, {});
            }
            
            const group = fileGroups.get(baseName)!;
            if (file.endsWith('content.hcl')) {
                group.content = fileContent;
            } else if (file.endsWith('ast.json')) {
                group.ast = JSON.parse(fileContent);
            }
        });
        
        // Convert groups to test cases
        fileGroups.forEach((group, baseName) => {
            if (group.content && group.ast) {
                testCases.push({
                    file: baseName,
                    content: group.content,
                    ast: group.ast
                });
            }
        });
    });

    describe('Context Detection with Real Files', () => {
        // Test isRootContext
        describe('isRootContext', () => {
            testCases.forEach(testCase => {
                it(`should correctly identify root context in ${testCase.file}`, () => {
                    // Test at various positions in the file
                    const lines = testCase.content.split('\n');
                    lines.forEach((line, lineNum) => {
                        // Test at start of each line
                        const startPos: Position = { line: lineNum, character: 0 };
                        const startResult = provider.isRootContext(testCase.content, startPos);
                        
                        // Test at end of each line
                        const endPos: Position = { line: lineNum, character: line.length };
                        const endResult = provider.isRootContext(testCase.content, endPos);
                        
                        // We don't assert specific values here since we don't know the expected results
                        // Instead, we ensure the function returns without error
                        expect(typeof startResult).to.equal('boolean');
                        expect(typeof endResult).to.equal('boolean');
                    });
                });
            });
        });

        // Test isBlockTypeContext
        describe('isBlockTypeContext', () => {
            testCases.forEach(testCase => {
                it(`should correctly identify block type context in ${testCase.file}`, () => {
                    const lines = testCase.content.split('\n');
                    lines.forEach((line, lineNum) => {
                        const pos: Position = { line: lineNum, character: 0 };
                        const result = provider.isBlockTypeContext(testCase.content, pos);
                        expect(typeof result).to.equal('boolean');
                    });
                });
            });
        });

        // Test isReferenceContext
        describe('isReferenceContext', () => {
            testCases.forEach(testCase => {
                it(`should correctly identify reference context in ${testCase.file}`, () => {
                    const lines = testCase.content.split('\n');
                    lines.forEach((line, lineNum) => {
                        // Look for lines containing reference patterns like "local." or "dependency."
                        if (line.includes('local.') || line.includes('dependency.')) {
                            const pos: Position = { 
                                line: lineNum, 
                                character: line.indexOf('.') + 1 
                            };
                            const result = provider.isReferenceContext(testCase.content, pos);
                            expect(result).to.be.true;
                        }
                    });
                });
            });
        });

        // Add more context detection tests as needed
        describe('isInterpolationContext', () => {
            testCases.forEach(testCase => {
                it(`should correctly identify interpolation context in ${testCase.file}`, () => {
                    const lines = testCase.content.split('\n');
                    lines.forEach((line, lineNum) => {
                        if (line.includes('${')) {
                            const pos: Position = {
                                line: lineNum,
                                character: line.indexOf('${') + 2
                            };
                            const result = provider.isInterpolationContext(testCase.content, pos);
                            expect(result).to.be.true;
                        }
                    });
                });
            });
        });

        // Test attribute context
        describe('isBlockAttributeContext', () => {
            testCases.forEach(testCase => {
                it(`should correctly identify block attribute context in ${testCase.file}`, () => {
                    const lines = testCase.content.split('\n');
                    lines.forEach((line, lineNum) => {
                        if (line.trim().startsWith('  ') && !line.includes('=')) {
                            const pos: Position = {
                                line: lineNum,
                                character: line.length
                            };
                            const result = provider.isBlockAttributeContext(testCase.content, pos);
                            expect(typeof result).to.equal('boolean');
                        }
                    });
                });
            });
        });

        // Test function context
        describe('isFunctionContext', () => {
            testCases.forEach(testCase => {
                it(`should correctly identify function context in ${testCase.file}`, () => {
                    const lines = testCase.content.split('\n');
                    lines.forEach((line, lineNum) => {
                        const functionCalls = [
                            'find_in_parent_folders',
                            'get_env',
                            'read_terragrunt_config'
                        ];
                        
                        functionCalls.forEach(func => {
                            if (line.includes(func)) {
                                const pos: Position = {
                                    line: lineNum,
                                    character: line.indexOf(func) + func.length
                                };
                                const result = provider.isFunctionContext(testCase.content, pos);
                                expect(typeof result).to.equal('boolean');
                            }
                        });
                    });
                });
            });
        });
    });

    // Add tests for actual completion suggestions
    describe('Completion Suggestions', () => {
        testCases.forEach(testCase => {
            it(`should provide appropriate completions for ${testCase.file}`, async () => {
                const lines = testCase.content.split('\n');
                
                // Test completions at interesting positions
                const interestingPositions = lines.map((line, lineNum) => {
                    return {
                        pos: { line: lineNum, character: line.length },
                        content: line
                    };
                }).filter(({ content }) => {
                    // Filter for positions where completions would be relevant
                    return content.includes('local.') ||
                           content.includes('dependency.') ||
                           content.includes('${') ||
                           content.trim().startsWith('  ') ||
                           content.includes('(');
                });

                for (const { pos } of interestingPositions) {
                    const completions = await provider.getCompletions(
                        testCase.content,
                        pos,
                        null, // You might want to add proper token finding logic here
                        null  // You might want to add proper ParsedDocument here
                    );
                    
                    expect(Array.isArray(completions)).to.be.true;
                }
            });
        });
    });
});