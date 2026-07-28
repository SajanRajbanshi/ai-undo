import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'test/fixtures/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
