import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      globals: { console: 'readonly', Buffer: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
];
