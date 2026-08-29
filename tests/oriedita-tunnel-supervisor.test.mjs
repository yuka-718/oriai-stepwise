import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  latestTunnelUrl,
  publishTunnelUrlToRegistries,
  tunnelRegistryRepos,
} from "../scripts/oriedita-tunnel-supervisor.mjs";

test("extracts the latest quick tunnel URL from cloudflared output", () => {
  const output = `
  https://old-tunnel.trycloudflare.com
  retrying
  https://current-tunnel.trycloudflare.com
  `;
  assert.equal(latestTunnelUrl(output), "https://current-tunnel.trycloudflare.com");
  assert.equal(
    latestTunnelUrl("abc123.lhr.life tunneled with tls termination, https://abc123.lhr.life"),
    "https://abc123.lhr.life",
  );
  assert.equal(
    latestTunnelUrl("your url is: https://oriai-ito-pj-2026.loca.lt"),
    "https://oriai-ito-pj-2026.loca.lt",
  );
  assert.equal(latestTunnelUrl("no tunnel yet"), null);
});

test("detects a dropped public tunnel quickly", async () => {
  const source = await readFile(new URL("../scripts/oriedita-tunnel-supervisor.mjs", import.meta.url), "utf8");
  assert.match(source, /await delay\(5_000\)/);
  assert.match(source, /failures >= 2/);
  assert.match(source, /"ServerAliveInterval=10"/);
});

test("normalizes the primary runtime registry and optional comma-separated mirrors", () => {
  assert.deepEqual(
    tunnelRegistryRepos(
      "yuka-718/oriai-stepwise",
      " yuka-718/oriai, yuka-718/ORIAI-STEPWISE, , example/backup ",
    ),
    ["yuka-718/oriai-stepwise", "yuka-718/oriai", "example/backup"],
  );
});

test("publishes one shared tunnel document to every runtime registry", async () => {
  const calls = [];
  const githubJson = async (argumentsList, input) => {
    calls.push({ argumentsList, input });
    if (argumentsList.length === 2) {
      return { sha: argumentsList[1].includes("oriai-stepwise") ? "primary-sha" : "mirror-sha" };
    }
    return {};
  };

  await publishTunnelUrlToRegistries(
    "https://current-tunnel.lhr.life",
    ["yuka-718/oriai-stepwise", "yuka-718/oriai"],
    githubJson,
    "2026-08-29T12:34:56.000Z",
  );

  const writes = calls.filter(({ argumentsList }) => argumentsList.includes("PUT"));
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map(({ argumentsList }) => argumentsList[3]).sort(),
    [
      "repos/yuka-718/oriai-stepwise/contents/oriedita-upstream.json",
      "repos/yuka-718/oriai/contents/oriedita-upstream.json",
    ].sort(),
  );
  for (const { input } of writes) {
    assert.deepEqual(
      JSON.parse(Buffer.from(input.content, "base64").toString("utf8")),
      {
        url: "https://current-tunnel.lhr.life",
        updatedAt: "2026-08-29T12:34:56.000Z",
      },
    );
    assert.match(input.sha, /^(?:primary|mirror)-sha$/);
  }
});

test("installed services use fresh one-action Codex mode and publish a rate-limited shared runtime", async () => {
  const [tunnelService, localService] = await Promise.all([
    readFile(new URL("../scripts/local-oriedita-tunnel-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-oriedita-service.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(tunnelService, /ORI_AI_TUNNEL_REGISTRY_REPO<\/key><string>yuka-718\/oriai-stepwise/);
  assert.match(tunnelService, /ORI_AI_TUNNEL_REGISTRY_MIRROR_REPOS<\/key><string>yuka-718\/oriai/);
  assert.match(tunnelService, /ORI_AI_TUNNEL_PROVIDER<\/key><string>cloudflare<\/string>/);
  assert.match(localService, /ORI_AI_DESIGN_MODE<\/key>\s*<string>codex_mcp_stepwise<\/string>/);
  assert.match(localService, /ORI_AI_MAX_JOBS_PER_WINDOW<\/key>\s*<string>3<\/string>/);
  assert.match(localService, /ORI_AI_RATE_WINDOW_MS<\/key>\s*<string>21600000<\/string>/);
  assert.match(localService, /ProcessType<\/key>\s*<string>Interactive<\/string>/);
});
