import appiumConfig from '@appium/eslint-config-appium-ts';

export default [
  ...appiumConfig,
  {
    files: ['**/*.ts'],
    settings: {
      // Ensure import resolution checks TS sources in this repo's src tree.
      'import-x/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
        node: {
          extensions: ['.js', '.ts', '.d.ts'],
          moduleDirectory: ['node_modules', 'src'],
        },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
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
          case: 'kebabCase',
        },
      ],
    },
  },
];
