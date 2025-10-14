import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import { configs } from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactPlugin from 'eslint-plugin-react';

export default defineConfig([
  {
    files: ['src/**/*.{js,mjs,cjs,ts,jsx,tsx}', '*.{js,mjs,cjs,ts}'],
    plugins: { js },
    extends: ['js/recommended'],
  },

  {
    files: ['src/**/*.{js,mjs,cjs,ts,jsx,tsx}', '*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // TypeScript configuration
  {
    files: ['src/**/*.{ts,tsx}', '*.ts'],
    extends: [configs.recommended, configs.stylistic],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
    },
    rules: {
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: false, variables: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE', 'snake_case'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase', 'snake_case'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
    },
  },

  {
    files: ['src/**/*.{jsx,tsx}'],
    plugins: {
      react: reactPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      'react/jsx-max-props-per-line': [2, { maximum: 2, when: 'always' }],
      'react/jsx-first-prop-new-line': [2, 'multiline-multiprop'],
      'react/jsx-closing-bracket-location': [2, 'tag-aligned'],
      'react/jsx-indent-props': [2, 2],
      'react/jsx-closing-tag-location': 2,
      'react/jsx-wrap-multilines': [
        2,
        {
          declaration: 'parens-new-line',
          assignment: 'parens-new-line',
          return: 'parens-new-line',
          arrow: 'parens-new-line',
          condition: 'parens-new-line',
          logical: 'parens-new-line',
          prop: 'parens-new-line',
        },
      ],
    },
  },

  {
    files: ['src/**/*.{js,mjs,cjs,ts,jsx,tsx}', '*.{js,mjs,cjs,ts}'],
    extends: [
      importPlugin.flatConfigs.recommended,
      importPlugin.flatConfigs.typescript,
    ],
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.eslint.json',
          alwaysTryTypes: true,
        },
        node: true,
      },
    },
    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          alphabetize: { order: 'asc' },
          'newlines-between': 'always',
        },
      ],
      'import/newline-after-import': ['error'],
      'import/no-duplicates': ['error'],
    },
  },

  // only lint gaming-fe directory
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Ignore everything outside gaming-fe directory
      '../**',
      '../../**',
      'node-pkg/**',
      'scripts/testMock.js',
    ],
  },

  // Prettier integration (do not move, should be last)
  eslintConfigPrettier,
]);
