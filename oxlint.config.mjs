import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxlint';

export default defineConfig({
  extends: [appiumConfig],
  ignorePatterns: [...ignorePatterns],
  rules: {
    'unicorn/filename-case': ['error', {case: 'kebabCase'}],
    'typescript/consistent-type-imports': [
      'error',
      {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      },
    ],
  },
  overrides: [
    {
      files: [
        'src/lib/plist/length-based-splitter.ts',
        'src/lib/plist/plist-decoder.ts',
        'src/lib/plist/plist-encoder.ts',
        'src/lib/usbmux/usbmux-decoder.ts',
        'src/lib/usbmux/usbmux-encoder.ts',
        'src/services/ios/afc/stream-utils.ts',
        'src/services/ios/zipconduit/stream-zip.ts',
      ],
      rules: {
        // These files implement Node stream APIs that require callback signatures.
        'promise/prefer-await-to-callbacks': 'off',
      },
    },
  ],
});
