#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const label = "jp.ito-pj.ori-ai";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
if (uid == null) throw new Error("macOSのユーザーIDを取得できませんでした");

const domain = `gui/${uid}`;
const service = `${domain}/${label}`;
const launchAgents = join(homedir(), "Library", "LaunchAgents");
const logs = join(homedir(), "Library", "Logs", "ORI-AI");
const plistPath = join(launchAgents, `${label}.plist`);
const serverPath = join(projectRoot, "local-oriedita", "server.mjs");
const applicationSupport = join(homedir(), "Library", "Application Support", "ORI-AI");
const runtimeJar = join(applicationSupport, "oriedita.jar");
const sourceRoot = process.env.ORIEDITA_SOURCE_ROOT ?? "/Users/yukaito/Documents/oriedita";
const sourceMcp = join(sourceRoot, "oriedita-mcp");
const sourceJar = join(sourceRoot, "oriedita", "target", "oriedita-1.1.4-SNAPSHOT.jar");

function launchctl(...args) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (args[0] === "bootout") return "";
    throw error;
  }
}

function commandPath(name, fallback) {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

if (process.argv.includes("--uninstall")) {
  launchctl("bootout", service);
  await rm(plistPath, { force: true });
  process.stdout.write("ORIAI local Oriedita service removed.\n");
  process.exit(0);
}

await Promise.all([
  mkdir(launchAgents, { recursive: true }),
  mkdir(logs, { recursive: true }),
  mkdir(applicationSupport, { recursive: true }),
]);
await cp(sourceJar, runtimeJar, { force: true });

const pathValue = [
  dirname(process.execPath),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
const codex = commandPath("codex", "/opt/homebrew/bin/codex");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(serverPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
    <key>ORI_AI_GROQ_MODEL</key>
    <string>qwen/qwen3.6-27b</string>
    <key>ORI_AI_DESIGN_MODE</key>
    <string>codex_mcp_stepwise</string>
    <key>ORI_AI_CODEX_PATH</key>
    <string>${xml(codex)}</string>
    <key>ORI_AI_CODEX_REASONING_EFFORT</key>
    <string>high</string>
    <key>ORI_AI_TRUST_PROXY</key>
    <string>1</string>
    <key>ORI_AI_MAX_JOBS_PER_WINDOW</key>
    <string>3</string>
    <key>ORI_AI_RATE_WINDOW_MS</key>
    <string>21600000</string>
    <key>ORIEDITA_MCP_SERVER</key>
    <string>${xml(join(sourceMcp, "server.mjs"))}</string>
    <key>ORIEDITA_JAR</key>
    <string>${xml(runtimeJar)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(join(logs, "server.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, "server-error.log"))}</string>
</dict>
</plist>
`;

launchctl("bootout", service);
await writeFile(plistPath, plist, { mode: 0o600 });
execFileSync("plutil", ["-lint", plistPath], { stdio: "inherit" });
launchctl("bootstrap", domain, plistPath);
launchctl("kickstart", "-k", service);
process.stdout.write(`ORIAI local Oriedita service installed: ${plistPath}\n`);
