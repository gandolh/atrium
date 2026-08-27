import type { LatexFile } from "@ebook-reader/shared";

/**
 * Project-path helpers shared by the file tree and the editor shell
 * (brief 38 chunk 8). Pure functions, no React, no network — the tree shape
 * and the "can I open this in the source pane?" question both live here so the
 * two components cannot disagree about them.
 */

/**
 * The extensions the API serves as `text/plain` (`latex-routes.ts`'s
 * `TEXT_EXTENSIONS`). Anything else — a figure, a bundled PDF — is bytes, and
 * the source pane shows a "not editable here" state for it rather than
 * rendering the raw octets as UTF-8.
 *
 * Deliberately a copy rather than an import: `apps/api` is not a dependency of
 * `apps/web`, and this is a display decision (what to open in an editor), not
 * the server's decision (what content type to send). They agree today because
 * they describe the same set of files; if they ever drift, the worst case here
 * is a file that opens read-only, not a corrupted write.
 */
const TEXT_EXTENSIONS = new Set([
  "tex",
  "bib",
  "cls",
  "sty",
  "bst",
  "txt",
  "md",
  "csv",
  "json",
  "log",
  "yml",
  "yaml",
]);

/** Lowercased extension without the dot, or `""` for an extensionless path. */
export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** True when the source pane can open this path as editable text. */
export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

/** Last segment of a project-relative path. */
export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Everything before the last segment, or `""` at the project root. */
export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** A file size for the tree's secondary line. Tabular by inheritance from `body`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; file: LatexFile };

/**
 * Fold a flat `LatexFile[]` into the nested shape the tree renders.
 *
 * The API returns paths, not a hierarchy (`figures/plot.png`, not a `figures`
 * node), because directories are not first-class in a project — they exist
 * only as the prefix of some file, and the server prunes one the moment its
 * last file leaves. So the hierarchy is derived here, per render, from the
 * only thing that is authoritative: the list of files.
 *
 * Directories sort before files, then both alphabetically and
 * case-insensitively, so `figures/` sits above `main.tex` and the ordering
 * does not shuffle when a file is renamed.
 */
export function buildFileTree(files: LatexFile[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let level = root;
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      let dir = level.find(
        (n): n is Extract<TreeNode, { kind: "dir" }> => n.kind === "dir" && n.name === segments[i],
      );
      if (!dir) {
        dir = { kind: "dir", name: segments[i], path: prefix, children: [] };
        level.push(dir);
      }
      level = dir.children;
    }
    level.push({ kind: "file", name: segments[segments.length - 1], path: file.path, file });
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) if (node.kind === "dir") sort(node.children);
    return nodes;
  };

  return sort(root);
}
