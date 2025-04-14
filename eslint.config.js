import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
        rules: {
            'quotes': ['error', 'single'],
            'semi': ['error', 'always'],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', {
                'argsIgnorePattern': '^_',
                'varsIgnorePattern': '^_'
            }],
        },
        ignores: ['**/build/**', '**/node_modules/**'],
    }
);