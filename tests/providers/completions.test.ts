import { expect } from 'chai';
import type { Position } from 'vscode-languageserver';

import { CompletionsProvider } from '../../src/providers/CompletionsProvider';
import { Schema } from '../../src/Schema';

describe('CompletionsProvider', () => {
	let provider: CompletionsProvider;

	before(() => {
		provider = new CompletionsProvider(Schema.getInstance());
	});

	describe('isRootContext', () => {
		interface TestCase {
			name: string;
			text: string;
			position: Position;
			expected: boolean;
		}

		const tests: TestCase[] = [
			{
				name: "empty document",
				text: "",
				position: { line: 0, character: 0 },
				expected: true
			},
			{
				name: "root level complete block",
				text: "terraform {\n  source = \"foo\"\n}\n",
				position: { line: 3, character: 0 },
				expected: true
			},
			{
				name: "inside unclosed block",
				text: "terraform {\n  source = \"foo\"\n",
				position: { line: 2, character: 0 },
				expected: false
			},
			{
				name: "after block identifier before {",
				text: "terraform",
				position: { line: 0, character: 9 },
				expected: true  // Still at root until { is typed
			},
			{
				name: "inside string literal",
				text: 'source = "hello',
				position: { line: 0, character: 13 },
				expected: false
			},
			{
				name: "inside interpolation",
				text: 'source = "$\\{path',
				position: { line: 0, character: 13 },
				expected: false
			},
			{
				name: "after attribute name before value",
				text: "source =",
				position: { line: 0, character: 8 },
				expected: false
			},
			{
				name: "nested interpolation",
				text: 'source = "${foo("${bar"',  // Removed backslashes
				position: { line: 0, character: 20 },
				expected: false
			},
			{
				name: "at root after complete attribute",
				text: 'source = "foo"\n',
				position: { line: 1, character: 0 },
				expected: true
			},
			// Attribute value tests
			{
				name: "attribute array value incomplete",
				text: 'source = ["foo", "bar"',
				position: { line: 0, character: 20 },
				expected: false
			},
			{
				name: "attribute array value complete",
				text: 'source = ["foo", "bar"]\n',
				position: { line: 1, character: 0 },
				expected: true
			},
			{
				name: "attribute object value incomplete",
				text: 'config = { foo = "bar"',
				position: { line: 0, character: 20 },
				expected: false
			},
			{
				name: "attribute object value complete",
				text: 'config = { foo = "bar" }\n',
				position: { line: 1, character: 0 },
				expected: true
			},
			{
				name: "attribute with nested interpolation complete",
				text: 'source = "$\\{path.module}/foo"\n',
				position: { line: 1, character: 0 },
				expected: true
			}
		];

		tests.forEach(({ name, text, position, expected }) => {
			it(name, () => {
				const result = provider.isRootContext(text, position);
				expect(result).to.equal(expected);
			});
		});
	});

	describe('isBlockTypeContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "empty line",
                text: "",
                position: { line: 0, character: 0 },
                expected: true
            },
            {
                name: "start of partial block type",
                text: "ter",
                position: { line: 0, character: 3 },
                expected: true
            },
            {
                name: "whitespace before partial block type",
                text: "  remote",
                position: { line: 0, character: 8 },
                expected: true
            },
            {
                name: "after complete block",
                text: "terraform {\n  source = \"foo\"\n}\nrem",
                position: { line: 3, character: 3 },
                expected: true
            },
            {
                name: "inside block",
                text: "terraform {\n  rem",
                position: { line: 1, character: 5 },
                expected: false
            },
            {
                name: "complete block type before {",
                text: "terraform ",
                position: { line: 0, character: 10 },
                expected: true
            },
            {
                name: "complete block type with {",
                text: "terraform {",
                position: { line: 0, character: 10 },
                expected: false
            },
            {
                name: "after block type but before {",
                text: "terraform  ",
                position: { line: 0, character: 11 },
                expected: true
            },
            {
                name: "after identifier with invalid characters",
                text: "terraform$",
                position: { line: 0, character: 10 },
                expected: false
            },
            {
                name: "inside string literal",
                text: 'source = "ter',
                position: { line: 0, character: 11 },
                expected: false
            },
            {
                name: "after attribute name",
                text: "source",
                position: { line: 0, character: 6 },
                expected: false
            },
            {
                name: "after multiple closing blocks",
                text: "terraform {\n  nested {\n    foo = \"bar\"\n  }\n}\nter",
                position: { line: 5, character: 3 },
                expected: true
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isBlockTypeContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

	describe('isReferenceContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "empty document",
                text: "",
                position: { line: 0, character: 0 },
                expected: false
            },
            {
                name: "local reference start",
                text: "value = local.",
                position: { line: 0, character: 13 },
                expected: true
            },
            {
                name: "dependency reference path",
                text: "site_name = dependency.xc_site.outputs.",
                position: { line: 0, character: 37 },
                expected: true
            },
            {
                name: "inside string literal",
                text: 'path = "local.',
                position: { line: 0, character: 13 },
                expected: false
            },
            {
                name: "inside interpolation reference",
                text: 'source = "${local.my_var}',
                position: { line: 0, character: 20 },
                expected: true
            },
            {
                name: "after complete reference",
                text: "value = local.my_var ",
                position: { line: 0, character: 20 },
                expected: false
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isReferenceContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isInterpolationContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "start of interpolation",
                text: 'source = "${',
                position: { line: 0, character: 11 },
                expected: true
            },
            {
                name: "middle of interpolation",
                text: 'bucket = "${local.my_bucket_name}',
                position: { line: 0, character: 25 },
                expected: true
            },
            {
                name: "complete interpolation",
                text: 'path = "${path_relative_to_include()}"',
                position: { line: 0, character: 37 },
                expected: false
            },
            {
                name: "nested interpolation",
                text: 'source = "${get_env("${local.',
                position: { line: 0, character: 27 },
                expected: true
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isInterpolationContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isBlockAttributeContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "inside terraform block",
                text: "terraform {\n  sou",
                position: { line: 1, character: 5 },
                expected: true
            },
            {
                name: "inside generate block",
                text: 'generate "provider" {\n  pa',
                position: { line: 1, character: 4 },
                expected: true
            },
            {
                name: "after attribute equals",
                text: "terraform {\n  source =",
                position: { line: 1, character: 10 },
                expected: false
            },
            {
                name: "inside string value",
                text: 'terraform {\n  source = "foo',
                position: { line: 1, character: 15 },
                expected: false
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isBlockAttributeContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isFunctionContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "root level function start",
                text: "path = find_",
                position: { line: 0, character: 11 },
                expected: true
            },
            {
                name: "function in interpolation",
                text: 'source = "${get_',
                position: { line: 0, character: 15 },
                expected: true
            },
            {
                name: "inside function parameters",
                text: 'get_env("MY_',
                position: { line: 0, character: 11 },
                expected: false
            },
            {
                name: "nested function call",
                text: "read_terragrunt_config(find_in_",
                position: { line: 0, character: 29 },
                expected: true
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isFunctionContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isExpressionContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "after equals",
                text: "count = ",
                position: { line: 0, character: 8 },
                expected: true
            },
            {
                name: "after arithmetic operator",
                text: "max_attempts = 3 + ",
                position: { line: 0, character: 19 },
                expected: true
            },
            {
                name: "in conditional expression",
                text: "protected = condition ? ",
                position: { line: 0, character: 23 },
                expected: true
            },
            {
                name: "inside interpolation expression",
                text: 'name = "${count + ',
                position: { line: 0, character: 17 },
                expected: true
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isExpressionContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isBlockParameterContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "after dependency",
                text: 'dependency "',
                position: { line: 0, character: 12 },
                expected: true
            },
            {
                name: "inside parameter string",
                text: 'dependency "infrastructure',
                position: { line: 0, character: 25 },
                expected: true
            },
            {
                name: "after generate",
                text: 'generate "',
                position: { line: 0, character: 10 },
                expected: true
            },
            {
                name: "in block body",
                text: 'dependency "infra" {\n  ',
                position: { line: 1, character: 2 },
                expected: false
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isBlockParameterContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isNestedBlockContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "inside terraform block",
                text: "terraform {\n  ",
                position: { line: 1, character: 2 },
                expected: true
            },
            {
                name: "inside remote_state block",
                text: "remote_state {\n  ",
                position: { line: 1, character: 2 },
                expected: true
            },
            {
                name: "after nested block identifier",
                text: "terraform {\n  before_hook ",
                position: { line: 1, character: 13 },
                expected: true
            },
            {
                name: "inside attribute assignment",
                text: "terraform {\n  source = ",
                position: { line: 1, character: 11 },
                expected: false
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isNestedBlockContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

	describe('isBlockAttributeValueContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "after attribute equals",
                text: "terraform {\n  source = ",
                position: { line: 1, character: 11 },
                expected: true
            },
            {
                name: "in dependency block attribute value",
                text: 'dependency "infra" {\n  config_path = ',
                position: { line: 1, character: 16 },
                expected: true
            },
            {
                name: "inside started string value",
                text: 'terraform {\n  source = "git',
                position: { line: 1, character: 18 },
                expected: true
            },
            {
                name: "after attribute with no equals",
                text: "terraform {\n  source",
                position: { line: 1, character: 9 },
                expected: false
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isBlockAttributeValueContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isReferenceContext - additional namespaces', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "module reference",
                text: "value = module.",
                position: { line: 0, character: 14 },
                expected: true
            },
            {
                name: "var reference",
                text: 'source = "${var.environment}',
                position: { line: 0, character: 24 },
                expected: true
            },
            {
                name: "data reference",
                text: "value = data.aws_vpc.",
                position: { line: 0, character: 20 },
                expected: true
            },
            {
                name: "terraform reference",
                text: "workspace = terraform.",
                position: { line: 0, character: 21 },
                expected: true
            },
            {
                name: "path reference with parts",
                text: "key = path.module.",
                position: { line: 0, character: 17 },
                expected: true
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isReferenceContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isFunctionContext - parameter index', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "first parameter",
                text: 'get_env(',
                position: { line: 0, character: 8 },
                expected: true
            },
            {
                name: "second parameter after comma",
                text: 'get_env("MY_VAR", ',
                position: { line: 0, character: 17 },
                expected: true
            },
            {
                name: "in attribute value function",
                text: 'source = get_env(',
                position: { line: 0, character: 16 },
                expected: true
            },
            {
                name: "nested function parameter",
                text: 'merge(local.vars, read_terragrunt_config(',
                position: { line: 0, character: 39 },
                expected: true
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isFunctionContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

    describe('isStringLiteralContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: {
                isString: boolean;
                interpolated: boolean;
            }
        }

        const tests: TestCase[] = [
            {
                name: "simple string literal",
                text: 'source = "github',
                position: { line: 0, character: 15 },
                expected: {
                    isString: true,
                    interpolated: false
                }
            },
            {
                name: "string with interpolation",
                text: 'path = "${local.path}/module"',
                position: { line: 0, character: 28 },
                expected: {
                    isString: true,
                    interpolated: true
                }
            },
            {
                name: "string with multiple interpolations",
                text: 'name = "${var.prefix}-${var.env}-app"',
                position: { line: 0, character: 35 },
                expected: {
                    isString: true,
                    interpolated: true
                }
            },
            {
                name: "not in string",
                text: "source = local.path",
                position: { line: 0, character: 15 },
                expected: {
                    isString: false,
                    interpolated: false
                }
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isStringLiteralContext(text, position);
                expect(result).to.deep.equal(expected);
            });
        });
    });

    describe('isCommentContext', () => {
        interface TestCase {
            name: string;
            text: string;
            position: Position;
            expected: boolean;
        }

        const tests: TestCase[] = [
            {
                name: "single line comment",
                text: "# This is a comment",
                position: { line: 0, character: 10 },
                expected: true
            },
            {
                name: "multi-line comment",
                text: "/* This is a\n   comment */",
                position: { line: 1, character: 5 },
                expected: true
            },
            {
                name: "after single line comment",
                text: "# Comment\nterraform {",
                position: { line: 1, character: 0 },
                expected: false
            },
            {
                name: "after multi-line comment",
                text: "/* Comment */\nterraform {",
                position: { line: 1, character: 0 },
                expected: false
            },
            {
                name: "in string with hash",
                text: 'source = "#not-comment"',
                position: { line: 0, character: 12 },
                expected: false
            }
        ];

        tests.forEach(({ name, text, position, expected }) => {
            it(name, () => {
                const result = provider.isCommentContext(text, position);
                expect(result).to.equal(expected);
            });
        });
    });

	describe('isFunctionCallContext', () => {
		interface TestCase {
			name: string;
			text: string;
			position: Position;
			expected: {
				isFunction: boolean;
				identifierPart?: string;
				argIndex?: number;
				inArgString?: boolean;
			}
		}
	
		const tests: TestCase[] = [
			{
				name: "at function identifier start",
				text: "path = find",
				position: { line: 0, character: 8 },
				expected: { isFunction: true, identifierPart: "find" }
			},
			{
				name: "inside function identifier",
				text: "path = find_in_parent",
				position: { line: 0, character: 15 },
				expected: { isFunction: true, identifierPart: "find_in_parent" }
			},
			{
				name: "at first argument position",
				text: "find_in_parent_folders(",
				position: { line: 0, character: 21 },
				expected: { isFunction: true, argIndex: 0 }
			},
			{
				name: "inside first string argument",
				text: 'find_in_parent_folders("env.tfv',
				position: { line: 0, character: 27 },
				expected: { isFunction: true, argIndex: 0, inArgString: true }
			},
			{
				name: "between arguments",
				text: 'find_in_parent_folders("env.tfvars", ',
				position: { line: 0, character: 35 },
				expected: { isFunction: true, argIndex: 1 }
			},
			{
				name: "nested function calls",
				text: 'read_terragrunt_config(find_in_parent_folders("',
				position: { line: 0, character: 45 },
				expected: { isFunction: true, argIndex: 0, inArgString: true }
			}
		];
	
		tests.forEach(({ name, text, position, expected }) => {
			it(name, () => {
				const result = provider.getFunctionContext(text, position);
				expect(result).to.deep.equal(expected);
			});
		});
	});

	describe('isArrayContext', () => {
		interface TestCase {
			name: string;
			text: string;
			position: Position;
			expected: {
				inArray: boolean;
				elementIndex?: number;
				inElementString?: boolean;
			}
		}
	
		const tests: TestCase[] = [
			{
				name: "empty array",
				text: "paths = [",
				position: { line: 0, character: 8 },
				expected: { inArray: true, elementIndex: 0 }
			},
			{
				name: "inside array string element",
				text: 'paths = ["../mod',
				position: { line: 0, character: 15 },
				expected: { inArray: true, elementIndex: 0, inElementString: true }
			},
			{
				name: "between array elements",
				text: 'paths = ["../common", ',
				position: { line: 0, character: 22 },
				expected: { inArray: true, elementIndex: 1 }
			},
			{
				name: "nested arrays",
				text: 'configs = [["value',
				position: { line: 0, character: 16 },
				expected: { inArray: true, elementIndex: 0, inElementString: true }
			}
		];
	
		tests.forEach(({ name, text, position, expected }) => {
			it(name, () => {
				const result = provider.getArrayContext(text, position);
				expect(result).to.deep.equal(expected);
			});
		});
	});

	describe('isBlockContext', () => {
		interface TestCase {
			name: string;
			text: string;
			position: Position;
			expected: {
				inBlock: boolean;
				blockIdentifierPart?: string;
				afterBlockIdentifier?: boolean;
				inBlockParameter?: boolean;
				blockDepth?: number;
			}
		}
	
		const tests: TestCase[] = [
			{
				name: "at block identifier start",
				text: "ter",
				position: { line: 0, character: 3 },
				expected: { inBlock: true, blockIdentifierPart: "ter" }
			},
			{
				name: "after block identifier before {",
				text: "terraform ",
				position: { line: 0, character: 10 },
				expected: { inBlock: true, afterBlockIdentifier: true }
			},
			{
				name: "with block parameter",
				text: 'generate "prov',
				position: { line: 0, character: 13 },
				expected: { inBlock: true, inBlockParameter: true }
			},
			{
				name: "nested blocks",
				text: "terraform {\n  source {\n    ",
				position: { line: 2, character: 4 },
				expected: { inBlock: true, blockDepth: 2 }
			}
		];
	
		tests.forEach(({ name, text, position, expected }) => {
			it(name, () => {
				const result = provider.getBlockContext(text, position);
				expect(result).to.deep.equal(expected);
			});
		});
	});

	describe('isAttributeContext', () => {
		interface TestCase {
			name: string;
			text: string;
			position: Position;
			expected: {
				inAttribute: boolean;
				attributeNamePart?: string;
				afterEquals?: boolean;
				inAttributeValue?: boolean;
				inInterpolation?: boolean;
			}
		}
	
		const tests: TestCase[] = [
			{
				name: "at attribute name start",
				text: "  sou",
				position: { line: 0, character: 5 },
				expected: { inAttribute: true, attributeNamePart: "sou" }
			},
			{
				name: "after equals",
				text: "source = ",
				position: { line: 0, character: 9 },
				expected: { inAttribute: true, afterEquals: true }
			},
			{
				name: "in attribute string value",
				text: 'source = "git@',
				position: { line: 0, character: 13 },
				expected: { inAttribute: true, inAttributeValue: true }
			},
			{
				name: "in interpolation",
				text: 'source = "${local.',
				position: { line: 0, character: 16 },
				expected: { 
					inAttribute: true, 
					inAttributeValue: true,
					inInterpolation: true 
				}
			}
		];
	
		tests.forEach(({ name, text, position, expected }) => {
			it(name, () => {
				const result = provider.getAttributeContext(text, position);
				expect(result).to.deep.equal(expected);
			});
		});
	});
});