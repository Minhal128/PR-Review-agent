import type { FileDiff } from "./types.ts";

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into per-file entries.
 *
 * The important output is `commentableLines`: GitHub rejects a review comment
 * whose line is not part of the diff, and a rejected comment fails the whole
 * review call - not just that one comment. So every finding is checked against
 * this set before it is posted inline.
 */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diff.split("\n");

  let cur: FileDiff | null = null;
  let patchLines: string[] = [];
  let newLine = 0;
  let inHunk = false;

  const flush = () => {
    if (cur) {
      cur.patch = patchLines.join("\n");
      files.push(cur);
    }
    cur = null;
    patchLines = [];
    inHunk = false;
    newLine = 0;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = {
        path: pathFromHeader(line),
        isNew: false,
        isDeleted: false,
        isBinary: false,
        patch: "",
        commentableLines: new Set<number>(),
      };
      continue;
    }
    if (!cur) continue;

    // File-level metadata, before the first hunk.
    if (!inHunk) {
      if (line.startsWith("new file mode")) {
        cur.isNew = true;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        cur.isDeleted = true;
        continue;
      }
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        cur.isBinary = true;
        continue;
      }
      // The `+++ b/path` line is more reliable than the `diff --git` header when
      // the path contains spaces, so prefer it when present.
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") cur.path = stripPrefix(p);
        continue;
      }
      if (line.startsWith("--- ")) continue;
      if (line.startsWith("index ") || line.startsWith("similarity index")) continue;
      if (line.startsWith("rename ") || line.startsWith("old mode") || line.startsWith("new mode")) {
        continue;
      }
    }

    const m = HUNK.exec(line);
    if (m) {
      inHunk = true;
      newLine = Number(m[1]);
      patchLines.push(line);
      continue;
    }
    if (!inHunk) continue;

    patchLines.push(line);

    // "No newline at end of file" annotates the previous line; it is not a line.
    if (line.startsWith("\\")) continue;

    const kind = line[0];
    if (kind === "+") {
      cur.commentableLines.add(newLine);
      newLine++;
    } else if (kind === "-") {
      // Removed from the old file - the new file's numbering does not advance.
    } else {
      // Context line (leading space), or an empty trailing line in the diff.
      newLine++;
    }
  }
  flush();

  return files;
}

function pathFromHeader(line: string): string {
  // `diff --git a/foo/bar.ts b/foo/bar.ts`
  const rest = line.slice("diff --git ".length);
  const half = Math.floor(rest.length / 2);
  const candidate = rest.slice(half).trim();
  return stripPrefix(candidate || rest.trim());
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

/** Files worth spending tokens on. */
export function reviewable(files: FileDiff[], ignore: string[]): FileDiff[] {
  return files.filter((f) => {
    if (f.isDeleted || f.isBinary) return false;
    if (f.commentableLines.size === 0) return false;
    return !ignore.some((pattern) => globMatch(pattern, f.path));
  });
}

/**
 * Minimal glob for ignore lists: a single star matches within one path segment,
 * a double star matches across segments. Not a full glob implementation - it
 * only needs to handle the patterns people put in an ignore list.
 *
 * The case that matters: a leading double-star must also match zero directories,
 * so the lockfile pattern catches `package-lock.json` at the repo root and not
 * only nested copies. Translating it to a plain `.*` misses the root file.
 */
export function globMatch(pattern: string, path: string): boolean {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          rx += "(?:.*/)?"; // zero or more directories
          i += 2;
        } else {
          rx += ".*";
          i += 1;
        }
      } else {
        rx += "[^/]*"; // stays inside one segment
      }
      continue;
    }
    rx += /[a-zA-Z0-9_-]/.test(c) ? c : "\\" + c;
  }
  return new RegExp(`^${rx}$`).test(path);
}
