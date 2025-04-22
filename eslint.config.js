import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      unicorn: unicorn,
    },
    rules: {
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/member-ordering': [
        'error',
        {
          default: [
            // ─── PUBLIC METHODS ─────────────────────────────────────────────────────
            'public-static-method',
            'public-instance-method',

            // ─── PROTECTED METHODS ──────────────────────────────────────────────────
            'protected-static-method',
            'protected-instance-method',

            // ─── PRIVATE METHODS ────────────────────────────────────────────────────
            'private-static-method',
            'private-instance-method',
          ],
        },
      ],
      'unicorn/filename-case': [
        'error',
        {
          'case': 'kebabCase'
        }
      ],
    },
    ignores: ['**/build/**', '**/node_modules/**'],
  }
);
