import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const root = resolve(process.cwd());
const ignoredDirectories = new Set([".git", "node_modules", ".pnpm-store"]);
const htmlFiles = [];

function collectHtmlFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectHtmlFiles(absolutePath);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") {
      htmlFiles.push(absolutePath);
    }
  }
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function isExternal(value) {
  return (
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    value.startsWith("{{") ||
    value.startsWith("${")
  );
}

function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveLink(sourceFile, rawValue) {
  const value = decodeHtml(rawValue.trim());
  if (!value || isExternal(value)) {
    return null;
  }

  const [pathAndQuery, fragment = ""] = value.split("#", 2);
  const pathPart = safeDecodeUri(pathAndQuery.split("?", 1)[0]);
  let target = pathPart
    ? pathPart.startsWith("/")
      ? resolve(root, `.${pathPart}`)
      : resolve(dirname(sourceFile), pathPart)
    : sourceFile;

  if (pathPart.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) {
    target = join(target, "index.html");
  }

  return { fragment: safeDecodeUri(fragment), target, value };
}

function isInsideRoot(target) {
  const localPath = relative(root, target);
  return (
    localPath === "" ||
    (!localPath.startsWith(`..${sep}`) && localPath !== ".." && !isAbsolute(localPath))
  );
}

collectHtmlFiles(root);
htmlFiles.sort();

const anchorsByFile = new Map();
const sources = new Map();
const idPattern = /\b(?:id|name)\s*=\s*(["'])(.*?)\1/gi;

for (const file of htmlFiles) {
  const source = readFileSync(file, "utf8");
  const anchors = new Set();
  sources.set(file, source);

  for (const match of source.matchAll(idPattern)) {
    anchors.add(decodeHtml(match[2]));
  }

  anchorsByFile.set(file, anchors);
}

const failures = [];
const attributePattern = /\b(?:href|src|poster|action)\s*=\s*(["'])(.*?)\1/gi;
const srcsetPattern = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;

function validateReference(sourceFile, source, rawValue, index) {
  const resolved = resolveLink(sourceFile, rawValue);
  if (!resolved) {
    return;
  }

  const location = `${relative(root, sourceFile)}:${lineNumber(source, index)}`;

  if (!isInsideRoot(resolved.target)) {
    failures.push(`${location} sort du dépôt : ${resolved.value}`);
    return;
  }

  if (!existsSync(resolved.target) || !statSync(resolved.target).isFile()) {
    failures.push(`${location} cible introuvable : ${resolved.value}`);
    return;
  }

  if (
    resolved.fragment &&
    extname(resolved.target).toLowerCase() === ".html" &&
    !anchorsByFile.get(resolved.target)?.has(resolved.fragment)
  ) {
    failures.push(
      `${location} ancre introuvable : ${resolved.value}`,
    );
  }
}

for (const file of htmlFiles) {
  const source = sources.get(file);

  for (const match of source.matchAll(attributePattern)) {
    validateReference(file, source, match[2], match.index);
  }

  for (const match of source.matchAll(srcsetPattern)) {
    for (const candidate of match[2].split(",")) {
      const [url] = candidate.trim().split(/\s+/, 1);
      validateReference(file, source, url, match.index);
    }
  }
}

if (failures.length > 0) {
  console.error("Liens internes invalides :");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Liens internes valides : ${htmlFiles.length} page(s) contrôlée(s).`);
}
