#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const label = "jp.ito-pj.ori-ai-tunnel";
const uid = process.getuid?.();
if (uid == null) throw new Error("macOSのユーザーIDを取得できませんでした");
const domain = `gui/${uid}`;
const service = `${domain}/${label}`;
const launchAgents = join(homedir(), "Library", "LaunchAgents");
const logs = join(homedir(), "Library", "Logs", "ORI-AI");
const plistPath = join(launchAgents, `${label}.plist`);
const supervisor = join(projectRoot, "scripts", "oriedita-tunnel-supervisor.mjs");
const localtunnel = join(projectRoot, "node_modules", ".bin", "lt");

function commandPath(name, fallback) {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function launchctl(...argumentsList) {
  try {
    return execFileSync("launchctl", argumentsList, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (argumentsList[0] === "bootout") return "";
    throw error;
  }
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const cloudflared = commandPath("cloudflared", "/opt/homebrew/bin/cloudflared");
const gh = commandPath("gh", "/opt/homebrew/bin/gh");
const ssh = commandPath("ssh", "/usr/bin/ssh");
const pathValue = [dirname(process.execPath), dirname(cloudflared), dirname(gh), dirname(ssh), "/usr/bin", "/bin"].join(":");
await Promise.all([mkdir(launchAgents, { recursive: true }), mkdir(logs, { recursive: true })]);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(supervisor)}</string></array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(homedir())}</string>
    <key>PATH</key><string>${xml(pathValue)}</string>
    <key>ORI_AI_CLOUDFLARED</key><string>${xml(cloudflared)}</string>
    <key>ORI_AI_GH</key><string>${xml(gh)}</string>
    <key>ORI_AI_SSH</key><string>${xml(ssh)}</string>
    <key>ORI_AI_LOCALTUNNEL</key><string>${xml(localtunnel)}</string>
    <key>ORI_AI_LOCALTUNNEL_SUBDOMAIN</key><string>oriai-ito-pj-2026</string>
    <key>ORI_AI_TUNNEL_PROVIDER</key><string>cloudflare</string>
    <key>ORI_AI_TUNNEL_REGISTRY_REPO</key><string>yuka-718/oriai-stepwise</string>
    <key>ORI_AI_TUNNEL_REGISTRY_MIRROR_REPOS</key><string>yuka-718/oriai</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(logs, "tunnel.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "tunnel-error.log"))}</string>
</dict>
</plist>
`;

launchctl("bootout", service);
await writeFile(plistPath, plist, { mode: 0o600 });
execFileSync("plutil", ["-lint", plistPath], { stdio: "inherit" });
let bootstrapped = false;
for (let attempt = 0; attempt < 10; attempt += 1) {
  try {
    launchctl("bootstrap", domain, plistPath);
    bootstrapped = true;
    break;
  } catch (error) {
    if (attempt === 9) throw error;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
}
if (!bootstrapped) throw new Error("ORIAI tunnel service could not be started");
launchctl("kickstart", "-k", service);
process.stdout.write(`ORIAI tunnel service installed: ${plistPath}\n`);
