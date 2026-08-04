import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.{js,mjs,cjs,ts,tsx}'];
const reactFiles = ['front-end/**/*.{ts,tsx}', 'hub/hub-frontend/**/*.{ts,tsx}'];

export default defineConfig([
  globalIgnores([
    '**/build/**',
    '**/coverage/**',
    '**/dist/**',
    '**/node-pkg/**',
    '**/node_modules/**',
    '**/public/index.js',
    '**/serve/**',
    'deploy_hub/**',
    'deploy_player_app/**',
    'front-end/src/lib/pkg/**',
  ]),
  {
    files: sourceFiles,
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.jest,
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: reactFiles,
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    files: [
      'desktop/**',
      'front-end/scripts/**',
      'hub/hub-service/**',
      'static-server.js',
      'tools/**',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['front-end/src/**/*.{ts,tsx}', 'hub/hub-frontend/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  // Keep last so lint rules never conflict with the root Prettier config.
  eslintConfigPrettier,
]);
