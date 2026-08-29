import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const simulatorRoot = new URL("../public/origami-simulator/", import.meta.url);

test("vendored simulator is pinned and retains license notices", async () => {
  const [vendorNotes, upstreamLicense, thirdPartyNotices] = await Promise.all([
    readFile(new URL("ORIAI-VENDORING.md", simulatorRoot), "utf8"),
    readFile(new URL("LICENSE", simulatorRoot), "utf8"),
    readFile(new URL("THIRD_PARTY_NOTICES.md", simulatorRoot), "utf8"),
  ]);
  assert.match(vendorNotes, /7855983a613c879c171b2b1557f8cd102d2640cf/);
  assert.match(upstreamLicense, /MIT License/);
  assert.match(thirdPartyNotices, /dat\.guiVR \| Apache-2\.0/);
  assert.match(thirdPartyNotices, /Earcut \| ISC/);
});

test("iframe bridge only accepts its same-origin direct parent", async () => {
  const importer = await readFile(new URL("js/importer.js", simulatorRoot), "utf8");
  assert.match(importer, /e\.source !== window\.parent/);
  assert.match(importer, /e\.origin !== bridgeOrigin/);
  assert.match(importer, /window\.parent\.postMessage\(message, bridgeOrigin\)/);
  assert.match(importer, /globals\.setCreasePercent\(1\)/);
  assert.match(importer, /globals\.creasePercent = 1/);
  assert.match(importer, /globals\.shouldChangeCreasePercent = true/);
  assert.match(importer, /data\.op === ['"]hello['"]/);
  assert.doesNotMatch(importer, /postMessage\([^\n]+,\s*['"]\*['"]\)/);
  for (const status of ["ready", "loaded", "error"]) {
    assert.match(importer, new RegExp(`['"]${status}['"]`));
  }
});

test("application uses a deployment-relative simulator URL and strict replies", async () => {
  const component = await readFile(new URL("../app/OrigamiSimulator3D.tsx", import.meta.url), "utf8");
  assert.match(component, /SIMULATOR_URL = "\.\/origami-simulator\/index\.html"/);
  assert.match(component, /event\.origin !== window\.location\.origin/);
  assert.match(component, /event\.source !== iframeRef\.current\?\.contentWindow/);
  assert.match(component, /armTimeout\(BOOT_TIMEOUT_MS,\s*requestId\)/);
  assert.match(component, /armTimeout\(IMPORT_TIMEOUT_MS,\s*requestId\)/);
  assert.match(component, /onLoad=\{requestReady\}/);
  assert.doesNotMatch(component, /https:\/\/origamisimulator\.org/);
});

test("application waits for a 99-point Codex and Oriedita result before showing the four final-state phases", async () => {
  const [page, finalState] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/corigami-final-state.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /API_DISCOVERY_URL/);
  assert.match(page, /api\.github\.com\/repos\/yuka-718\/oriai-stepwise\/contents\/oriedita-upstream\.json/);
  assert.match(page, /application\/vnd\.github\.raw\+json/);
  assert.match(page, /candidateToFold/);
  assert.match(page, /generateCandidates/);
  assert.doesNotMatch(page, /pipeline:\s*["']corigami_final_state_v1["']/);
  assert.match(page, /createCOrigamiFinalState/);
  assert.match(page, /apiFetch\("\/jobs"/);
  assert.match(page, /designMode: STEPWISE_DESIGN_MODE/);
  assert.match(page, /codex_mcp_stepwise/);
  assert.match(page, /waitForApiOrigin\(\)/);
  assert.match(page, /API_RECONNECT_ATTEMPTS = 30/);
  assert.match(page, /生成サーバーへ接続できませんでした/);
  assert.match(page, /waitForJob\(payload\.job\.id/);
  assert.match(page, /result && hasReachedAppearanceTarget\(result\.evaluation\)/);
  assert.match(page, /hasReachedAppearanceTarget\(payload\.job\.result\.evaluation\)/);
  assert.match(page, /TARGET_APPEARANCE_SCORE/);
  assert.match(page, /foldFromDataUrl\(completed\.foldFile\)/);
  assert.doesNotMatch(page, /foldFromDataUrl\(completed\.sourceFoldFile\)/);
  assert.doesNotMatch(page, /\?\? primaryFold/);
  assert.match(page, /href=\{result\.foldFile\}/);
  assert.match(page, /ACTIVE_JOB_STORAGE_KEY/);
  assert.match(page, /oriai-stepwise:active-codex-job:v1/);
  assert.match(page, /writeStoredActiveJob\(\{ id: payload\.job\.id, description, startedAt \}\)/);
  assert.match(page, /waitForJob\(stored\.id, \(job\) =>/);
  assert.match(page, /setProgress\(job\.progress \?\? null\)/);
  assert.match(page, /Oriedita評価済み/);
  assert.match(page, /最高点（確定済み）/);
  assert.match(page, /新しいCodex実行で一手を設計・画像評価/);
  assert.match(page, /折られた紙の3D状態を次の一手へ保持する逐次物理シミュレーションではありません/);
  assert.match(page, /src=\{result\.creaseImage\}/);
  assert.match(page, /src=\{result\.foldedImage\}/);
  assert.match(page, /<OrigamiSimulator3D foldFile=\{activeStage\.foldFile\}/);
  assert.match(page, /angle-preview/);
  assert.match(finalState, /Simple fold/);
  assert.match(finalState, /Narrowing/);
});

test("terminal job failures bypass transient polling retries", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const waitForJob = page.slice(
    page.indexOf("async function waitForJob"),
    page.indexOf("export default function Home"),
  );
  const terminalFailure = waitForJob.indexOf('payload.job.status === "failed"');
  const terminalCancellation = waitForJob.indexOf('payload.job.status === "cancelled"');

  assert.notEqual(terminalFailure, -1);
  assert.notEqual(terminalCancellation, -1);
  assert.ok(terminalFailure > waitForJob.lastIndexOf("catch (error)"));
  assert.doesNotMatch(waitForJob, /transientFailures/);
  assert.match(waitForJob, /catch \{\s*continue;\s*\}/);
});

test("job polling has no evaluation-duration timeout", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const waitForJob = page.slice(
    page.indexOf("async function waitForJob"),
    page.indexOf("export default function Home"),
  );
  assert.match(waitForJob, /for \(let attempt = 0; ; attempt \+= 1\)/);
  assert.doesNotMatch(waitForJob, /attempt < 720/);
  assert.doesNotMatch(waitForJob, /生成処理がタイムアウトしました/);
});

test("embed removes analytics and exposes only the WebGL canvas", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("index.html", simulatorRoot), "utf8"),
    readFile(new URL("css/embed.css", simulatorRoot), "utf8"),
  ]);
  assert.match(html, /css\/embed\.css/);
  assert.doesNotMatch(html, /googletagmanager/);
  assert.match(css, /body > :not\(#threeContainer\)/);
  assert.match(css, /#threeContainer canvas/);
});
