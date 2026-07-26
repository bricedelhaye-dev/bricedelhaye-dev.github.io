import { readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", ".pnpm-store"]);
const testFiles = [];

function collectTests(directory, insideTestDirectory = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    const nextInsideTestDirectory =
      insideTestDirectory || entry.name === "test" || entry.name === "tests";

    if (entry.isDirectory()) {
      collectTests(absolutePath, nextInsideTestDirectory);
      continue;
    }

    const extension = extname(entry.name);
    const isJavaScript = [".js", ".mjs", ".cjs"].includes(extension);
    const hasTestSuffix = /\.(?:test|spec)\.(?:c|m)?js$/i.test(entry.name);

    if (entry.isFile() && isJavaScript && (insideTestDirectory || hasTestSuffix)) {
      testFiles.push(relative(root, absolutePath));
    }
  }
}

collectTests(root);
testFiles.sort();

if (testFiles.length === 0) {
  console.log("Tests existants : aucun test JavaScript détecté.");
  process.exit(0);
}

console.log(`Tests existants : ${testFiles.length} fichier(s) détecté(s).`);
const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});

process.exit(result.status ?? 1);
