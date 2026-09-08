import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/parser.js', 'src/parser.d.ts'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    // The documentation site's script runs in a browser, not in Node, so
    // `document`, `window` and `localStorage` are defined where it runs.
    // Without this it was linted against Node's globals and every use of them
    // was an error -- thirty-six of them, which failed `prepublishOnly` and so
    // blocked publishing entirely.
    //
    // Declared rather than ignored: the file is real code that ships with the
    // package's documentation, and an ignored file is one nothing checks.
    files: ['docs/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
)
