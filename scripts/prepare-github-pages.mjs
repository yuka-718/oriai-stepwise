import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const outputRoot = resolve("dist/client");
const fallbackBasePath = "/oriai-stepwise";
const textExtensions = new Set([".html", ".rsc", ".js", ".css", ".json", ""]);
const rootPaths = [
  "/_next/",
  "/favicon.png",
  "/og-studio.png",
];

function normalizeBasePath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

const basePath = normalizeBasePath(
  process.env.GITHUB_PAGES_BASE_PATH ?? fallbackBasePath,
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : [path];
      }),
    )
  ).flat();
}

function addBasePath(source) {
  let result = source;

  rootPaths.forEach((rootPath, index) => {
    const prefixedPath = `${basePath}${rootPath}`;
    const token = `__ORI_AI_PREFIXED_${index}__`;
    result = result.replaceAll(prefixedPath, token);
    result = result.replaceAll(rootPath, prefixedPath);
    result = result.replaceAll(token, prefixedPath);
  });

  return result;
}

await access(join(outputRoot, "index.html"));

for (const path of await listFiles(outputRoot)) {
  if (!textExtensions.has(extname(path))) continue;

  const source = await readFile(path, "utf8");
  const next = addBasePath(source);
  if (next !== source) await writeFile(path, next);
}

await writeFile(join(outputRoot, ".nojekyll"), "");

const indexHtml = await readFile(join(outputRoot, "index.html"), "utf8");
if (indexHtml.includes('"/_next/') || indexHtml.includes('href="/favicon.png')) {
  throw new Error("GitHub Pages build still contains an unprefixed root asset URL");
}
if (basePath && indexHtml.includes(`${basePath}${basePath}`)) {
  throw new Error("GitHub Pages build contains a duplicated base path");
}
console.log(`Prepared GitHub Pages output for ${basePath ? `${basePath}/` : "/"}`);
