/**
 * The house format: Prettier's defaults (double quotes, semicolons) at the estate's width.
 * A repo's own `prettier.config.js` re-exports it:
 *
 *   export { default } from "./vendor/house-style/prettier.config.js";
 */
export default {
  // 120 columns changed the fewest lines across the house repos, and it is a common convention.
  printWidth: 120,
  // A trailing comma turns adding one item into a one-line diff.
  trailingComma: "all",
};
