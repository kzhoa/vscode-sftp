import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';
import jsPlugin from '@eslint/js';
import jsonPlugin from '@eslint/json';
import reactPlugin from 'eslint-plugin-react';
import markdown from '@eslint/markdown';
import globals from 'globals';
import prettier from 'prettier';
import prettierPluginRecommended from 'eslint-plugin-prettier/recommended';
import { defineConfig } from 'eslint/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const nextConfig = [...compat.extends('next/core-web-vitals')].map((cfg) => ({
  ...cfg,
  files: ['**/*.{js,jsx,ts,tsx}'],
}));

export default defineConfig([
  ...nextConfig,
  prettierPluginRecommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...jsPlugin.configs.recommended.rules,
    },
  },
  {
    // React 配置
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      react: reactPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser },
    },
    rules: {
      ...reactPlugin.configs.flat['jsx-runtime'].rules,
      ...reactPlugin.configs.flat.recommended.rules,
      semi: ['error', 'always'],
      'react/react-in-jsx-scope': 'off', // no need in react19
      'react/prop-types': 'off',
    },
  },
  // global rules
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  {
    files: ['**/*.json'],
    ignores: ['package-lock.json'],
    plugins: { json: jsonPlugin },
    language: 'json/json',
    languageOptions: {
      parser: jsonPlugin.parser,
      parserOptions: {
        jsonSyntax: 'JSON',
      },
    },
    rules: {
      ...jsonPlugin.configs.recommended.rules,
      'react/*': 'off',
      'prettier/prettier': 'off',
    },
  },
  {
    files: ['**/*.jsonc', '.vscode/*.json'],
    plugins: { json: jsonPlugin },
    language: 'json/jsonc',
    languageOptions: {
      parser: jsonPlugin.parser,
      allowTrailingCommas: true,
      globals: {},
      parserOptions: {
        jsonSyntax: 'JSONC', // VS Code 配置是 JSON with Comments
      },
    },
    extends: ['json/recommended'],
    rules: {
      'json/no-duplicate-keys': 'error',
      'react/*': 'off',
      'prettier/prettier': 'off',
    },
  },
  {
    ignores: [
      '**/*.min.js',
      '**/sandbox/*',
      '**/node_modules/*',
      '**/dist/*',
      '**/build/*',
      '**/.next/*',
      '**/_themes/*',
    ],
  },
  {
    rules: {
      'no-unused-vars': 'off',
      'linebreak-style': ['error', 'unix'], // 强制 LF 换行符
      'object-curly-newline': 'off', // 花括号换行由prettier管理
      'array-element-newline': 'off', // 数组换行由prettier管理
      'prettier/prettier': ['error'],
    },
  },
]);
