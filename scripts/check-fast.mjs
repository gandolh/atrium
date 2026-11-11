// The second half of `npm run check:fast`: ESLint on the files changed against HEAD and the untracked
// ones, after the typecheck. Nothing else, so it stays quick enough for the Stop hook.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const files = [
  ...new Set([...git("diff", "--name-only", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")]),
].filter((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file));
if (files.length === 0) process.exit(0);
const run = spawnSync("npx", ["eslint", "--no-warn-ignored", ...files], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(run.status ?? 1);
