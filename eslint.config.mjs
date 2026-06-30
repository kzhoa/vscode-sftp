export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: (await import('@typescript-eslint/parser')).default,
      ecmaVersion: 2018,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': (await import('@typescript-eslint/eslint-plugin')).default,
    },
    rules: {
      'curly': ['error', 'multi-line'],
      'eqeqeq': ['error', 'always'],
      'linebreak-style': ['error', 'unix'],
      'no-bitwise': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-shadow': 'off',
      'no-unused-vars': 'off',
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts'],
    languageOptions: {
      globals: {
        afterEach: 'readonly',
        beforeEach: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        jest: 'readonly',
        test: 'readonly',
      },
    },
  },
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
    ],
  },
];
