// @ts-check
import { defineConfig } from 'eslint-config-hyoban'

export default defineConfig(
  {
    formatting: false,
    lessOpinionated: true,
    ignores: [
      'src/renderer/src/hono.ts',
      'src/hono.ts',
      'packages/shared/src/hono.ts',
      'resources/**',
      'src/terragrunt-parser.js',
    ],
    preferESM: false,
  },
  {
    settings: {
      tailwindcss: {
        whitelist: ['center'],
      },
    },
    rules: {
      'unicorn/prefer-math-trunc': 'off',
      'unicorn/prefer-code-point': 'off',
      'unicorn/prefer-string-slice': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'array-callback-return': 'off',
      'no-console': 'off',
      'no-param-reassign': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-use-before-define': 'off',
      'no-undef': 'off',
      'no-empty': 'off',
      'new-cap': 'off',
      'unused-imports/no-unused-vars': ['error', {
		'vars': 'all',
		'varsIgnorePattern': '^_|s[0-9]+|minus|int|frac|exp|expr|offset|range|expected|token|path|value|node|context|uri',
		'args': 'after-used',
		'argsIgnorePattern': '^_|s[0-9]+|minus|int|frac|exp|expr|offset|range|expected|token|path|value|node|context|uri'
		}],
      '@eslint-react/no-clone-element': 'off',
      '@eslint-react/hooks-extra/no-direct-set-state-in-use-effect': 'off',
      'react-compiler/react-compiler': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-restricted-globals': [
        'error',
        {
          name: 'location',
          message:
            "Since you don't use the same router instance in electron and browser, you can't use the global location to get the route info. \n\n" +
            'You can use `useLocaltion` or `getReadonlyRoute` to get the route info.',
        },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      '@stylistic/jsx-self-closing-comp': 'error',
    },
  },
  {
    files: ['locales/**/*.json'],
    rules: {
      'recursive-sort/recursive-sort': 'error',
    },
  },
)