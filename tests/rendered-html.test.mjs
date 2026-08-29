import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the focused origami generator", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="ja"/i);
  assert.match(html, /ORIAI/);
  assert.match(html, /つくりたい折り紙を入力/);
  assert.match(html, /画像をアップロード/);
  assert.doesNotMatch(html, /<h1>展開図<\/h1>/);
  assert.doesNotMatch(html, /<h1>完成形 3D<\/h1>/);
  assert.match(html, /生成する/);
  assert.match(html, /例：翼を広げた鶴/);
  assert.doesNotMatch(html, /大きな尾びれの金魚/);
  assert.doesNotMatch(html, /origamisimulator\.org/);
  assert.doesNotMatch(html, /WHAT THIS BUILD DOES|HONEST PROTOTYPING|CANDIDATE SCORE/);
  assert.match(html, /og-oriai-vivid\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("contains the social assets, static output, and no starter preview", async () => {
  await Promise.all([
    access(new URL("../public/og-oriai-vivid.png", import.meta.url)),
    access(new URL("../public/favicon.svg", import.meta.url)),
    access(new URL("../dist/client/index.html", import.meta.url)),
  ]);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("connects to the dynamic Codex and Oriedita API and makes input errors visible", async () => {
  const [page, server, envExample, oracleDeploy] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../local-oriedita/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy-oracle.sh", import.meta.url), "utf8"),
  ]);

  assert.match(page, /runState === "error"/);
  assert.match(page, /runState === "error" \? "もう一度生成"/);
  assert.match(page, /生成中… \$\{elapsedSeconds\}秒/);
  assert.match(page, /resolveApiOrigin/);
  assert.match(page, /apiFetch\("\/jobs"/);
  assert.match(page, /designMode: STEPWISE_DESIGN_MODE/);
  assert.match(page, /codex_mcp_stepwise/);
  assert.match(page, /waitForJob/);
  assert.match(page, /job\.progress/);
  assert.match(page, /Oriedita評価済み/);
  assert.match(page, /最高点（確定済み）/);
  assert.match(page, /累積CP/);
  assert.match(page, /逐次物理シミュレーションではありません/);
  assert.match(page, /result && hasReachedAppearanceTarget\(result\.evaluation\)/);
  assert.match(page, /TARGET_APPEARANCE_SCORE/);
  assert.doesNotMatch(page, /pipeline:\s*["']corigami_final_state_v1["']/);
  assert.match(server, /codex_mcp_loop/);
  assert.match(server, /runCodexOrieditaLoop/);
  assert.match(server, /evaluationLimit = null/);
  assert.match(server, /targetScore = 99/);
  assert.match(server, /ORI_AI_MAX_JOBS_PER_WINDOW \?\? "0"/);
  assert.match(server, /if \(maxJobsPerWindow === 0\) return;/);
  assert.match(envExample, /^ORI_AI_MAX_JOBS_PER_WINDOW=0$/m);
  assert.match(envExample, /yuka-718\/oriai-stepwise\/runtime\/oriedita-upstream\.json/);
  assert.match(oracleDeploy, /ORI_AI_MAX_JOBS_PER_WINDOW=0/);
});

test("scopes GitHub Pages assets, metadata, discovery, and browser state to oriai-stepwise", async () => {
  const [page, layout, pagesScript, workflow, tunnelSupervisor] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/prepare-github-pages.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/oriedita-tunnel-supervisor.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /yuka-718\/oriai-stepwise\/contents\/oriedita-upstream\.json/);
  assert.match(page, /oriai-stepwise:active-codex-job:v1/);
  assert.match(layout, /https:\/\/yuka-718\.github\.io\/oriai-stepwise\//);
  assert.match(pagesScript, /fallbackBasePath = "\/oriai-stepwise"/);
  assert.match(pagesScript, /GITHUB_PAGES_BASE_PATH/);
  assert.match(workflow, /steps\.pages\.outputs\.base_path/);
  assert.match(workflow, /steps\.pages\.outputs\.base_url/);
  assert.match(tunnelSupervisor, /yuka-718\/oriai-stepwise/);
});
