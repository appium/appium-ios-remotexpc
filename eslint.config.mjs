import appiumConfig from '@appium/eslint-config-appium-ts';

export default [
  ...appiumConfig,
  {
    files: [
      'src/lib/plist/length-based-splitter.ts',
      'src/lib/plist/plist-decoder.ts',
      'src/lib/plist/plist-encoder.ts',
      'src/lib/usbmux/usbmux-decoder.ts',
      'src/lib/usbmux/usbmux-encoder.ts',
      'src/services/ios/afc/stream-utils.ts',
    ],
    rules: {
      // These files implement Node stream APIs that require callback signatures.
      'promise/prefer-await-to-callbacks': 'off',
    },
  },
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
