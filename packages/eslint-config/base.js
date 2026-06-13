/**
 * Shared ESLint flat config — stub.
 *
 * This intentionally ships as a no-op until the team wires up @eslint/js,
 * typescript-eslint, and any framework plugins. Keeping it small now keeps
 * `pnpm install` instant and avoids dragging in a 200MB toolchain before
 * we're ready to enforce rules.
 *
 * When you're ready:
 *   pnpm add -Dw eslint @eslint/js typescript-eslint
 * Then expand this file with the actual recommended configs.
 */
export default [
  {
    ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/node_modules/**'],
  },
];
