// ESLint flat config for the whole workspace.
// Referenced by CI (lint job) and the PR checklist (`npx eslint packages/*/src`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'copilot-bridge/**',
      'openai-bridge/**',
      'packages/gateway/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase predates the lint gate; `any` is used deliberately at
      // several integration boundaries (pg rows, LSP params). Keep it a
      // conscious choice instead of an error.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
