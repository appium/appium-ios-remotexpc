import appiumConfig from '@appium/eslint-config-appium-ts';

export default [
  ...appiumConfig,
  {
    files: ['**/*.ts'],
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
