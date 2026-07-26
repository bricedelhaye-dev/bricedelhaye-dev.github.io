import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", ".pnpm-store"]);
const extensions = new Set([".js", ".mjs", ".cjs"]);

function collectJavaScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(absolutePath));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

const files = collectJavaScriptFiles(root).sort();
let failed = false;

for (const file of files) {
  if (!statSync(file).isFile()) {
    continue;
  }

  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`JavaScript valide : ${files.length} fichier(s) contrôlé(s).`);
}
