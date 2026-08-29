#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readlinkSync } from "node:fs";
import { access, appendFile, copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadKnowledgePack,
  publicKnowledgeMatch,
  publicKnowledgeReference,
  retrieveStructuralKnowledge,
} from "./knowledge-search.mjs";
import {
  loadOrigamiSearchCatalog,
  publicOrigamiWorkReference,
  searchOrigamiWorks,
  selectOrigamiReferenceImages,
} from "./origami-search-retriever.mjs";
import {
  buildPreliminaryDesignBrief,
  buildReferenceDocument,
  chooseValidatedInitialFold,
  completeDesignBrief,
} from "./reference-brief.mjs";
import {
  buildDesignGoal,
  mergeFinalEvaluation,
  validateCandidatePool,
} from "./fast-evaluation.mjs";
import { createMountainValleyVariants } from "./fold-repair.mjs";
import { foldGeometrySignature, regenerateCandidatePool } from "./regeneration.mjs";
import { DEFAULT_GROQ_MODEL, requestGroqEvaluation } from "./groq-evaluator.mjs";
import {
  fallbackStepJudgements,
  requestGroqStepEvaluation,
} from "./groq-step-evaluator.mjs";
import { evaluatePartialFold } from "./partial-evaluation.mjs";
import { runStepSearch } from "./step-search.mjs";
import { createSquareRootFold, enumerateFullWidthCreaseActions } from "./crease-actions.mjs";
import {
  assertInitialCreasesPreserved,
  assertNovelCodexActionKeys,
  runCodexOrieditaLoop,
} from "./codex-oriedita-runner.mjs";
import {
  ApiInputError,
  createOpenApiDocument,
  ORIEDITA_API_VERSION,
  validateFoldDocument,
  validateFoldRequest,
} from "./api-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const workRoot = resolve(process.env.ORI_AI_WORK_ROOT ?? join(projectRoot, "work", "local-jobs"));
const knowledgePack = await loadKnowledgePack();
const origamiSearchCatalog = await loadOrigamiSearchCatalog().catch((error) => {
  console.warn(`Origami Search索引を読み込めないため参照なしで続行します: ${error instanceof Error ? error.message : error}`);
  return null;
});
const knowledgeSearchEnabled = true;
const port = Number.parseInt(process.env.ORI_AI_LOCAL_PORT ?? "8788", 10);
const host = process.env.ORI_AI_LOCAL_HOST ?? "127.0.0.1";
const codexBatchIterations = 10;
const codexStepwiseIterations = 1;
const codexDesignModes = new Set(["codex_mcp_loop", "codex_mcp_stepwise"]);
const requestableDesignModes = new Set(codexDesignModes);
const evaluationLimit = null;
const maxCycles = 10;
const targetScore = 99;
const configuredDesignMode = process.env.ORI_AI_DESIGN_MODE?.trim();
const designMode = configuredDesignMode === "regeneration"
  || configuredDesignMode === "crease_step_search"
  || codexDesignModes.has(configuredDesignMode)
  ? configuredDesignMode
  : "codex_mcp_loop";
const stepBranchFactor = Math.min(3, Math.max(1, Number.parseInt(process.env.ORI_AI_STEP_BRANCH_FACTOR ?? "2", 10)));
const stepBeamWidth = Math.min(2, Math.max(1, Number.parseInt(process.env.ORI_AI_STEP_BEAM_WIDTH ?? "1", 10)));
const jobTimeoutMs = Math.max(60_000, Number.parseInt(process.env.ORI_AI_JOB_TIMEOUT_MS ?? "1200000", 10));
const rateWindowMs = Math.max(60_000, Number.parseInt(process.env.ORI_AI_RATE_WINDOW_MS ?? "21600000", 10));
const maxJobsPerWindow = Math.max(0, Number.parseInt(process.env.ORI_AI_MAX_JOBS_PER_WINDOW ?? "0", 10));
const trustProxy = process.env.ORI_AI_TRUST_PROXY === "1";
const groqModel = process.env.ORI_AI_GROQ_MODEL ?? DEFAULT_GROQ_MODEL;
const groqEndpoint = process.env.ORI_AI_GROQ_ENDPOINT
  ?? "https://api.groq.com/openai/v1/chat/completions";
const orieditaJar = resolve(process.env.ORIEDITA_JAR
  ?? "/Users/yukaito/Documents/oriedita/oriedita/target/oriedita-1.1.4-SNAPSHOT.jar");
const orieditaJava = process.env.ORIEDITA_JAVA ?? "java";
const userSuffix = typeof process.getuid === "function" ? process.getuid() : "user";
const orieditaRuntime = resolve(process.env.ORIEDITA_MCP_RUNTIME_DIR
  ?? join(tmpdir(), `oriedita-mcp-${userSuffix}`));
const connectionFile = resolve(orieditaRuntime, "connection.json");
const orieditaLogFile = resolve(orieditaRuntime, "oriedita-api.log");
const apiToken = process.env.ORI_AI_API_TOKEN?.trim() ?? "";

export function isCodexDesignMode(mode) {
  return codexDesignModes.has(mode);
}

export function codexBatchSizeForMode(mode) {
  if (mode === "codex_mcp_stepwise") return codexStepwiseIterations;
  if (mode === "codex_mcp_loop") return codexBatchIterations;
  return null;
}

export function codexExecutionMetadata(mode) {
  const batchSize = codexBatchSizeForMode(mode);
  if (batchSize == null) return null;
  const freshContextPerEvaluation = mode === "codex_mcp_stepwise";
  return {
    mode,
    batchSize,
    contextIsolation: freshContextPerEvaluation
      ? "fresh_ephemeral_codex_process_per_evaluation"
      : "fresh_ephemeral_codex_process_per_batch",
    freshProcessPerBatch: true,
    freshContextPerEvaluation,
    evaluationsPerCodexProcess: batchSize,
    ephemeral: true,
    userConfigIgnored: true,
    gitRepositoryRequired: false,
    conversationalSessionContinued: false,
    carriedState: [
      "explicit_job_facts",
      "current_best_fold",
      "current_best_score",
      "deduplicated_action_keys",
    ],
    stateType: "cumulative_crease_pattern_prefix",
    physicalScope: "oriedita_flat_fold_2d",
    sequentialPhysicalFolding: false,
    sequenceFeasibility: "unverified",
  };
}

export function codexServiceMetadata(defaultMode = designMode) {
  return {
    supportedModes: [...codexDesignModes],
    defaultMode,
    active: codexExecutionMetadata(defaultMode),
    modes: Object.fromEntries(
      [...codexDesignModes].map((mode) => [mode, codexExecutionMetadata(mode)]),
    ),
  };
}

export function resolveDesignModeSelection({
  requestedMode = null,
  defaultMode = designMode,
  pipeline = null,
} = {}) {
  let normalizedRequestedMode = null;
  if (requestedMode != null) {
    if (typeof requestedMode !== "string" || !requestableDesignModes.has(requestedMode)) {
      throw new HttpError(400, "未対応の設計モードです");
    }
    normalizedRequestedMode = requestedMode;
  }
  const mode = pipeline === "corigami_final_state_v1"
    ? "corigami_final_state_v1"
    : normalizedRequestedMode ?? defaultMode;
  const batchSize = codexBatchSizeForMode(mode);
  return {
    mode,
    batchSize,
    unlimitedCodexMode: batchSize != null,
  };
}

export function searchedStructuralPatternCount(prompt) {
  return typeof prompt === "string" && prompt.trim() ? 5_000 : 0;
}

export function assertSuccessfulFinalFoldCalculation(calculation, label = "最終候補") {
  if (!calculation?.started) {
    throw new Error(`${label}の平坦折り計算を開始できませんでした`);
  }
  const violationCount = calculation?.violationCount;
  if (!Number.isInteger(violationCount) || violationCount < 0) {
    throw new Error(`${label}の局所平坦折り違反数を確認できませんでした`);
  }
  if (violationCount > 0) {
    throw new Error(`${label}に局所平坦折り違反が${violationCount}件あります`);
  }
  return violationCount;
}

const cumulativeOperationCountKeys = [
  "add_line",
  "calculate_fold",
  "get_folded_figure",
  "open_file",
  "export_file",
  "required_rollbacks",
  "completed_iterations",
];

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

async function writeFileAtomically(path, data, { mode = 0o600 } = {}) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { flag: "wx", mode });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function copyFileAtomically(sourcePath, destinationPath) {
  await writeFileAtomically(destinationPath, await readFile(sourcePath));
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readLastJsonLine(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return null;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").trimEnd().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // A process can be stopped between filesystem writes. Ignore only the
        // incomplete tail and find the last fully committed JSONL record.
      }
    }
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const jsonLineTailReadSize = 64 * 1024;

async function readFileChunk(handle, length, position) {
  const chunk = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      chunk,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return chunk.subarray(0, offset);
}

async function readJsonLineTail(handle, size) {
  let position = size;
  const suffixes = [];
  while (position > 0) {
    const length = Math.min(position, jsonLineTailReadSize);
    position -= length;
    const content = await readFileChunk(handle, length, position);
    const newlineIndex = content.lastIndexOf(0x0a);
    if (newlineIndex >= 0) {
      return {
        start: position + newlineIndex + 1,
        content: Buffer.concat([content.subarray(newlineIndex + 1), ...suffixes]),
      };
    }
    suffixes.unshift(content);
  }
  return { start: 0, content: Buffer.concat(suffixes) };
}

async function repairJsonLineTail(handle) {
  const { size } = await handle.stat();
  if (size === 0) return false;
  const tail = await readJsonLineTail(handle, size);
  if (tail.start === size) return false;
  const text = tail.content.toString("utf8");
  try {
    if (!text.trim()) throw new SyntaxError("empty JSONL tail");
    JSON.parse(text);
    await handle.write("\n", size);
  } catch {
    await handle.truncate(tail.start);
  }
  return true;
}

async function readJsonLinesIfPresent(path) {
  let handle;
  try {
    handle = await open(path, "r+");
    if (await repairJsonLineTail(handle)) await handle.sync();
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          // Keep readable proofs around malformed lines left by older builds;
          // new torn tails are repaired before they can become interior lines.
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function appendDurableJsonLine(path, record) {
  const handle = await open(path, "a+", 0o600);
  try {
    await repairJsonLineTail(handle);
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendJsonLinesOnce(path, records, key) {
  const last = await readLastJsonLine(path);
  const lastKey = finiteInteger(last?.[key], 0);
  const pending = records.filter((record) => finiteInteger(record?.[key], 0) > lastKey);
  if (!pending.length) return;
  const prefix = last ? "\n" : "";
  await appendFile(path, `${prefix}${pending.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
}

export function assertCodexBatchTransition(evaluation, {
  startingBestScore = -1,
  iterationOffset = 0,
  batchSize = codexBatchIterations,
  requiredTargetScore = targetScore,
} = {}) {
  const steps = Array.isArray(evaluation?.steps) ? evaluation.steps : [];
  const expectedBatchSize = Math.max(1, finiteInteger(batchSize, codexBatchIterations));
  const offset = Math.max(0, finiteInteger(iterationOffset));
  const previousScore = Math.max(-1, Math.min(100, finiteInteger(startingBestScore, -1)));
  const score = finiteInteger(evaluation?.score, -1);
  const operationCounts = evaluation?.operation_counts ?? {};
  if (steps.length !== expectedBatchSize) {
    throw new Error(`Codexバッチの評価が完了していません (${steps.length}/${expectedBatchSize})`);
  }
  if (score < previousScore || score < 0 || score > 100) {
    throw new Error(`Codexバッチの最高点が不正です (${previousScore} -> ${score})`);
  }
  if (finiteInteger(evaluation?.iteration_offset, -1) !== offset) {
    throw new Error("Codexバッチの通算評価位置が一致しません");
  }
  if (finiteInteger(evaluation?.target_score, -1) !== requiredTargetScore) {
    throw new Error("Codexバッチの目標点が一致しません");
  }
  const targetReached = score >= requiredTargetScore;
  if (evaluation?.target_reached !== targetReached) {
    throw new Error("Codexバッチの目標到達判定が実証済み点数と一致しません");
  }
  if (operationCounts.add_line !== expectedBatchSize
      || finiteInteger(operationCounts.calculate_fold, -1) < expectedBatchSize
      || finiteInteger(operationCounts.get_folded_figure, -1) < expectedBatchSize
      || operationCounts.completed_iterations !== expectedBatchSize) {
    throw new Error("CodexバッチのOriedita実操作数が評価数と一致しません");
  }
  return {
    score,
    targetReached,
    completedEvaluations: steps.length,
    bestStep: Math.max(0, finiteInteger(evaluation?.best_step)),
  };
}

export function createCodexOperationSummary({
  requiredTargetScore = targetScore,
  mode = "codex_mcp_loop",
  batchSize = codexBatchSizeForMode(mode) ?? codexBatchIterations,
} = {}) {
  return {
    schema: "oriai-codex-unlimited-operation-summary-v1",
    design_mode: mode,
    target_score: requiredTargetScore,
    evaluation_limit: evaluationLimit,
    batch_size: batchSize,
    execution: codexExecutionMetadata(mode),
    batches_completed: 0,
    evaluations_completed: 0,
    best_score: -1,
    best_step: 0,
    target_reached: false,
    counts: Object.fromEntries(cumulativeOperationCountKeys.map((key) => [key, 0])),
    omitted_batches: 0,
    complete_batch_log: "batch-history.jsonl",
    batches: [],
  };
}

export function mergeCodexBatchOperationSummary(summary, evaluation, {
  batchNumber,
  startingBestScore,
  iterationOffset,
  artifactDirectory,
} = {}) {
  const nextCounts = { ...(summary?.counts ?? {}) };
  for (const key of cumulativeOperationCountKeys) {
    nextCounts[key] = finiteInteger(nextCounts[key]) + finiteInteger(evaluation?.operation_counts?.[key]);
  }
  const completed = Array.isArray(evaluation?.steps) ? evaluation.steps.length : 0;
  const batchRecord = {
    batch: batchNumber,
    start_step: iterationOffset + 1,
    end_step: iterationOffset + completed,
    prior_best_score: startingBestScore,
    best_score: evaluation.score,
    best_step: Math.max(finiteInteger(summary?.best_step), finiteInteger(evaluation?.best_step)),
    target_reached: evaluation.target_reached === true,
    artifact_directory: artifactDirectory,
  };
  const allRecentBatches = [...(Array.isArray(summary?.batches) ? summary.batches : []), batchRecord];
  const retainedBatches = allRecentBatches.slice(-80);
  return {
    ...(summary ?? createCodexOperationSummary()),
    batches_completed: finiteInteger(summary?.batches_completed) + 1,
    evaluations_completed: finiteInteger(summary?.evaluations_completed) + completed,
    best_score: evaluation.score,
    best_step: Math.max(finiteInteger(summary?.best_step), finiteInteger(evaluation?.best_step)),
    target_reached: evaluation.target_reached === true,
    counts: nextCounts,
    omitted_batches: Math.max(0, finiteInteger(summary?.omitted_batches) + allRecentBatches.length - retainedBatches.length),
    batches: retainedBatches,
  };
}

export async function runCodexBatchesUntilTarget({
  runBatch,
  onBatch = async () => {},
  startingBestScore = -1,
  startingIterationOffset = 0,
  startingBatchNumber = 0,
  startingBestStep = 0,
  batchSize = codexBatchIterations,
  requiredTargetScore = targetScore,
  maximumBatches = Number.POSITIVE_INFINITY,
  signal = null,
} = {}) {
  if (typeof runBatch !== "function") throw new TypeError("runBatch is required");
  let bestScore = startingBestScore;
  let iterationOffset = Math.max(0, finiteInteger(startingIterationOffset));
  let batchNumber = Math.max(0, finiteInteger(startingBatchNumber));
  let bestStep = Math.max(0, finiteInteger(startingBestStep));
  let batchesRun = 0;
  let lastBatch = null;
  while (bestScore < requiredTargetScore && batchesRun < maximumBatches) {
    if (signal?.aborted) throw new JobCancelledError();
    batchNumber += 1;
    batchesRun += 1;
    const batchOutput = await runBatch({ batchNumber, startingBestScore: bestScore, iterationOffset });
    const evaluation = batchOutput?.evaluation ?? batchOutput;
    const transition = assertCodexBatchTransition(evaluation, {
      startingBestScore: bestScore,
      iterationOffset,
      batchSize,
      requiredTargetScore,
    });
    await onBatch({
      batchNumber,
      startingBestScore: bestScore,
      iterationOffset,
      evaluation,
      batchOutput,
      transition,
    });
    bestScore = transition.score;
    iterationOffset += transition.completedEvaluations;
    if (transition.bestStep > 0) bestStep = transition.bestStep;
    lastBatch = batchOutput;
  }
  return {
    bestScore,
    bestStep,
    batchesCompleted: batchNumber,
    batchesRun,
    evaluationsCompleted: iterationOffset,
    lastBatch,
    targetReached: bestScore >= requiredTargetScore,
  };
}

function loadGroqApiKey() {
  const configured = process.env.GROQ_API_KEY?.trim();
  if (configured) return configured;
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "jp.ito-pj.ori-ai.groq", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

const groqApiKey = loadGroqApiKey();

const allowedOrigins = new Set([
  "https://yuka-718.github.io",
  "https://ori-ai-ito-pj-2026.pipipiimside.chatgpt.site",
  ...(process.env.ORI_AI_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
]);
const jobs = new Map();
const queue = [];
const maximumWaitingJobs = 3;
const JOB_REQUEUE = Symbol("JOB_REQUEUE");
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const submissionWindows = new Map();
const jobAbortControllers = new Map();
const codexActionHistoryByJob = new Map();
let activeJobId = null;
let activeJobPromise = null;
let activeOrieditaConnection = null;
let orieditaLaunchPromise = null;
let isShuttingDown = false;
let shutdownPromise = null;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  return /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function send(response, status, payload, origin) {
  response.writeHead(status, corsHeaders(origin));
  response.end(JSON.stringify(payload));
}

function clientAddress(request) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",", 1)[0].trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

function consumeSubmissionQuota(request) {
  if (maxJobsPerWindow === 0) return;
  const address = clientAddress(request);
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") return;
  const now = Date.now();
  const active = (submissionWindows.get(address) ?? []).filter((createdAt) => now - createdAt < rateWindowMs);
  if (active.length >= maxJobsPerWindow) {
    throw new HttpError(429, "利用回数の上限です。時間をおいて再実行してください");
  }
  active.push(now);
  submissionWindows.set(address, active);
}

async function readJson(request, limit = 14 * 1024 * 1024) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "application/json で送信してください");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "送信データが大きすぎます");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSONを読み取れませんでした");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createJobAdmissionGate({
  queueList,
  isActive,
  maxWaitingJobs = maximumWaitingJobs,
}) {
  let reservations = 0;

  function reserve() {
    const availableAdmissions = maxWaitingJobs + (isActive() ? 0 : 1);
    if (queueList.length + reservations >= availableAdmissions) {
      throw new HttpError(429, "処理待ちが多いため、少し待ってから再実行してください");
    }
    reservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservations -= 1;
    };
  }

  return {
    get reservations() {
      return reservations;
    },
    async run(create) {
      const release = reserve();
      try {
        return await create();
      } finally {
        release();
      }
    },
  };
}

const jobAdmissionGate = createJobAdmissionGate({
  queueList: queue,
  isActive: () => Boolean(activeJobId || activeJobPromise),
});

export class JobCancelledError extends Error {
  constructor(message = "ジョブはキャンセルされました") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export class JobRestartError extends Error {
  constructor(message = "API再起動のためジョブを中断します") {
    super(message);
    this.name = "JobRestartError";
  }
}

function isJobRestartSignal(signal) {
  return signal?.aborted === true && signal.reason instanceof JobRestartError;
}

function throwIfJobCancelled(job, signal) {
  if (job?.cancelRequested) throw new JobCancelledError();
  if (isJobRestartSignal(signal)) throw signal.reason;
  if (signal?.aborted) throw new JobCancelledError();
}

export function applyJobExecutionError(job, error, { signal = null } = {}) {
  if (!job.cancelRequested && (error instanceof JobRestartError || isJobRestartSignal(signal))) {
    job.result = null;
    job.status = "queued";
    job.message = "API再起動後に処理を再開します";
    job.error = null;
    return true;
  }
  if (job.cancelRequested || error instanceof JobCancelledError || error?.name === "AbortError") {
    job.status = "cancelled";
    job.message = "キャンセル済み";
    job.error = null;
    return false;
  }
  job.status = "failed";
  job.message = "処理に失敗しました";
  job.error = error instanceof Error ? error.message : String(error);
  return false;
}

function jobStatePath(job) {
  return join(job.directory, "job-state.json");
}

export async function persistJobState(job) {
  await writeFileAtomically(
    jobStatePath(job),
    `${JSON.stringify({ schema: "oriai-local-job-v1", job }, null, 2)}\n`,
  );
}

function isRestorableJob(value, root) {
  if (!value || typeof value !== "object") return false;
  if (!jobIdPattern.test(value.id ?? "")) return false;
  if (value.type !== "design" && value.type !== "oriedita-fold") return false;
  const expectedDirectory = resolve(root, value.id);
  return resolve(value.directory ?? "") === expectedDirectory && basename(expectedDirectory) === value.id;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processCommand(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function processWorkingDirectory(pid) {
  try {
    return resolve(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    // macOS does not expose /proc. `lsof` is part of the base system there.
  }
  for (const lsofPath of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      const output = execFileSync(lsofPath, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pathLine = output.split(/\r?\n/).find((line) => line.startsWith("n/"));
      if (pathLine) return resolve(pathLine.slice(1));
    } catch {
      // The process may have exited during inspection, or this lsof path may
      // not exist. Try the next source and ultimately fail closed.
    }
  }
  return "";
}

function inspectPosixProcessGroup(processGroup) {
  const groupId = -finiteInteger(processGroup, 0);
  if (groupId <= 1) return [];
  let output;
  try {
    output = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== groupId) return [];
    const pid = Number(match[1]);
    return [{
      pid,
      process_group: -groupId,
      command: match[3].trim(),
      cwd: processWorkingDirectory(pid),
    }];
  });
}

function leaseDirectoryBelongsToJob(leaseDirectory, jobDirectory) {
  if (typeof leaseDirectory !== "string" || typeof jobDirectory !== "string") return false;
  if (resolve(leaseDirectory) !== leaseDirectory || resolve(jobDirectory) !== jobDirectory) return false;
  const relation = relative(resolve(jobDirectory), resolve(leaseDirectory));
  return relation !== ""
    && !relation.startsWith("..")
    && !relation.startsWith("/")
    && !relation.startsWith("\\");
}

function configuredCodexName() {
  return basename(process.env.ORI_AI_CODEX_PATH?.trim() || "codex");
}

function commandExecutableName(command) {
  if (typeof command !== "string") return "";
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return basename(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function codexProcessLeaseHasJobProvenance(lease, job, platform = process.platform) {
  const pid = finiteInteger(lease?.pid, 0);
  const processGroup = finiteInteger(lease?.process_group, 0);
  const codexName = basename(String(lease?.codex_path ?? ""));
  return lease?.schema === "oriai-codex-process-lease-v1"
    && typeof lease?.lease_id === "string"
    && lease.lease_id.length > 0
    && pid > (platform === "win32" ? 0 : 1)
    && processGroup === (platform === "win32" ? pid : -pid)
    && leaseDirectoryBelongsToJob(lease?.directory, job?.directory)
    && codexName === configuredCodexName();
}

export function codexProcessLeaseMatches(lease, job, command) {
  return codexProcessLeaseHasJobProvenance(lease, job)
    && typeof command === "string"
    && command.includes(resolve(lease.directory))
    && commandExecutableName(command) === configuredCodexName();
}

function posixProcessGroupMatchesLease(lease, job, members) {
  if (!Array.isArray(members) || members.length === 0) return false;
  const expectedGroup = finiteInteger(lease.process_group, 0);
  const expectedDirectory = resolve(lease.directory);
  const relevantMembers = members.filter((member) =>
    finiteInteger(member?.pid, 0) > 0
    && finiteInteger(member?.process_group, 0) === expectedGroup);
  const leader = relevantMembers.find((member) => finiteInteger(member.pid, 0) === lease.pid);
  if (leader) {
    return typeof leader.cwd === "string"
      && leader.cwd.length > 0
      && resolve(leader.cwd) === expectedDirectory
      && codexProcessLeaseMatches(lease, job, leader.command);
  }

  // Once the detached leader is gone, the restricted MCP proxy is the
  // independently observable link between the still-reserved PGID and this
  // job. Static lease fields alone are untrusted because the inner Codex can
  // write inside its workspace.
  const restrictedProxyPath = resolve(here, "restricted-oriedita-mcp.mjs");
  return relevantMembers.some((member) =>
    typeof member.cwd === "string"
    && member.cwd.length > 0
    && resolve(member.cwd) === expectedDirectory
    && typeof member.command === "string"
    && member.command.includes(restrictedProxyPath));
}

export async function terminateStaleCodexProcessLease(job, {
  isAlive = processIsAlive,
  inspectCommand = processCommand,
  inspectProcessGroup = inspectPosixProcessGroup,
  sendSignal = (target, signal) => process.kill(target, signal),
  removeLease = (path) => rm(path, { force: true }),
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  graceMs = 5_000,
  pollMs = 50,
} = {}) {
  const leasePath = join(job.directory, "codex-process-lease.json");
  const lease = await readJsonIfPresent(leasePath);
  if (!lease) return { found: false, terminated: false };
  const pid = finiteInteger(lease.pid, 0);
  if (!codexProcessLeaseHasJobProvenance(lease, job)) {
    throw new Error("以前のCodexプロセスleaseのジョブ由来を確認できないため、安全にジョブを再開できません");
  }
  const target = finiteInteger(lease.process_group, 0);
  if (!isAlive(target)) {
    await removeLease(leasePath);
    return { found: true, terminated: false };
  }
  const assertTargetMatchesLease = () => {
    const matches = process.platform === "win32"
      ? codexProcessLeaseMatches(lease, job, inspectCommand(pid))
      : posixProcessGroupMatchesLease(lease, job, inspectProcessGroup(target));
    if (!matches) {
      throw new Error("以前のCodexプロセスleaseが実プロセスグループと一致しないため、安全にジョブを再開できません");
    }
  };
  const signalLiveTarget = (signal) => {
    if (!isAlive(target)) return false;
    assertTargetMatchesLease();
    try {
      sendSignal(target, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH" && !isAlive(target)) return false;
      throw error;
    }
  };
  const waitUntilStopped = async (duration) => {
    const deadline = Date.now() + duration;
    while (isAlive(target) && Date.now() < deadline) await wait(pollMs);
    return !isAlive(target);
  };
  let terminated = signalLiveTarget("SIGTERM");
  if (!(await waitUntilStopped(graceMs))) {
    terminated = signalLiveTarget("SIGKILL") || terminated;
    if (!(await waitUntilStopped(graceMs))) {
      throw new Error("以前のCodexプロセスを停止できないため、ジョブを再開できません");
    }
  }
  await removeLease(leasePath);
  return { found: true, terminated };
}

export async function restorePersistedJobs({
  root = workRoot,
  jobsMap = jobs,
  queueList = queue,
} = {}) {
  const restored = [];
  const pending = [];
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !jobIdPattern.test(entry.name)) continue;
    try {
      const payload = JSON.parse(await readFile(join(root, entry.name, "job-state.json"), "utf8"));
      const job = payload?.schema === "oriai-local-job-v1" ? payload.job : null;
      if (!isRestorableJob(job, root)) continue;
      if (isCodexDesignMode(job.designMode)) {
        await terminateStaleCodexProcessLease(job);
      }
      if (job.cancelRequested && job.status !== "done" && job.status !== "failed") {
        job.status = "cancelled";
        job.message = "キャンセル済み";
        job.completedAt ??= new Date().toISOString();
      } else if (job.status === "running" || job.status === "queued") {
        job.status = "queued";
        job.message = "API再起動後に処理を再開します";
        job.completedAt = null;
        job.error = null;
        pending.push(job);
      }
      jobsMap.set(job.id, job);
      restored.push(job.id);
    } catch (error) {
      console.warn(`ジョブ状態を復元できません (${entry.name}): ${error instanceof Error ? error.message : error}`);
    }
  }
  pending
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
    .forEach((job) => {
      if (!queueList.includes(job.id)) queueList.push(job.id);
    });
  return restored;
}

export async function cancelJob(job, {
  queueList = queue,
  abortController = jobAbortControllers.get(job?.id),
} = {}) {
  if (!job) throw new HttpError(404, "ジョブが見つかりません");
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
  job.cancelRequested = true;
  for (let index = queueList.length - 1; index >= 0; index -= 1) {
    if (queueList[index] === job.id) queueList.splice(index, 1);
  }
  if (job.status === "queued") {
    job.status = "cancelled";
    job.message = "キャンセル済み";
    job.completedAt = new Date().toISOString();
  } else {
    job.message = "キャンセル中";
    abortController?.abort();
  }
  await persistJobState(job);
  return job;
}

function hasApiAccess(request) {
  if (!apiToken) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(apiToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function requireApiAccess(request) {
  if (!hasApiAccess(request)) throw new HttpError(401, "有効なAPIトークンが必要です");
}

export function publicJob(job) {
  const hasMaxCycles = Object.hasOwn(job, "maxCycles");
  const hasMaxSteps = Object.hasOwn(job, "maxSteps");
  const effectiveDesignMode = job.designMode ?? designMode;
  const codexExecution = codexExecutionMetadata(effectiveDesignMode);
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result,
    error: job.error,
    cancelRequested: job.cancelRequested === true,
    progress: job.type === "design" ? {
      cycle: job.cycle ?? 0,
      maxCycles: hasMaxCycles ? job.maxCycles : maxCycles,
      bestScore: job.bestScore ?? null,
      step: job.step ?? job.cycle ?? 0,
      maxSteps: hasMaxSteps ? job.maxSteps : hasMaxCycles ? job.maxCycles : maxCycles,
      evaluationLimit: codexExecution ? evaluationLimit : (hasMaxSteps ? job.maxSteps : maxCycles),
      batchSize: codexExecution?.batchSize ?? null,
      targetScore: codexExecution ? targetScore : null,
      evaluatedNodes: job.evaluatedNodes ?? 0,
      mode: effectiveDesignMode,
      codexExecution,
    } : null,
  };
}

function validateJobInput(value) {
  const prompt = typeof value?.prompt === "string" ? value.prompt.trim().slice(0, 200) : "";
  const fold = value?.fold;
  if (!prompt && !value?.referenceImage) {
    throw new HttpError(400, "プロンプトか参考画像が必要です");
  }
  try {
    validateFoldDocument(fold);
  } catch (error) {
    if (error instanceof ApiInputError) throw new HttpError(error.status, error.message);
    throw error;
  }

  const candidates = Array.isArray(value?.candidates) && value.candidates.length
    ? value.candidates.slice(0, 3)
    : [fold];
  if (Array.isArray(value?.candidates) && value.candidates.length > 3) {
    throw new HttpError(400, "展開図候補は3件までです");
  }
  for (const candidate of candidates) {
    try {
      validateFoldDocument(candidate);
    } catch (error) {
      if (error instanceof ApiInputError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  let referenceImage = null;
  if (value?.referenceImage != null) {
    if (typeof value.referenceImage !== "string") throw new HttpError(400, "参考画像が不正です");
    const match = value.referenceImage.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new HttpError(400, "PNG、JPEG、WEBPの参考画像を使用してください");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > 10 * 1024 * 1024) throw new HttpError(413, "参考画像は10MB以下にしてください");
    referenceImage = { mimeType: match[1], bytes };
  }
  const goal = value?.goal && typeof value.goal === "object" ? value.goal : null;
  const pipeline = value?.pipeline == null ? null : String(value.pipeline);
  if (pipeline !== null && pipeline !== "corigami_final_state_v1") {
    throw new HttpError(400, "未対応の生成パイプラインです");
  }
  const requestedDesignMode = value?.designMode ?? null;
  resolveDesignModeSelection({ requestedMode: requestedDesignMode, pipeline });
  return {
    prompt,
    fold,
    candidates,
    goal,
    referenceImage,
    pipeline,
    designMode: requestedDesignMode,
  };
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

async function createJob(input) {
  return jobAdmissionGate.run(() => createJobAfterAdmission(input));
}

async function createJobAfterAdmission(input) {
  const id = randomUUID();
  const directory = join(workRoot, id);
  const candidateFolds = input.candidates;
  const goal = buildDesignGoal(input.prompt, input.goal);
  const preflight = validateCandidatePool(candidateFolds, goal);
  const inputFold = candidateFolds[preflight.selectedIndex];
  const finalStateMode = input.pipeline === "corigami_final_state_v1";
  const modeSelection = resolveDesignModeSelection({
    requestedMode: input.designMode,
    pipeline: input.pipeline,
  });
  const jobDesignMode = modeSelection.mode;
  const unlimitedCodexMode = modeSelection.unlimitedCodexMode;
  const searchedPatternCount = searchedStructuralPatternCount(input.prompt);
  const shouldRunTextRetrieval = searchedPatternCount > 0 && !finalStateMode;
  const searchWorks = origamiSearchCatalog && shouldRunTextRetrieval
    ? searchOrigamiWorks(origamiSearchCatalog, input.prompt, { minimum: 3, maximum: 5 })
    : [];
  const referenceImages = origamiSearchCatalog && shouldRunTextRetrieval
    ? await selectOrigamiReferenceImages(origamiSearchCatalog, searchWorks, {
      maximum: input.referenceImage ? 7 : 8,
    })
    : [];
  const structuralSearchPool = shouldRunTextRetrieval
    ? retrieveStructuralKnowledge(knowledgePack, input.prompt, {
      limit: 12,
      goal,
      corpusSize: searchedPatternCount,
    })
    : [];
  const structuralMatches = structuralSearchPool.slice(0, 3);
  const workReferences = searchWorks.map(publicOrigamiWorkReference);
  const knowledgeReferences = structuralMatches.map(publicKnowledgeReference);
  const references = buildReferenceDocument({
    prompt: input.prompt,
    catalog: origamiSearchCatalog,
    works: workReferences,
    images: referenceImages,
    structures: knowledgeReferences,
  });
  const designBrief = buildPreliminaryDesignBrief({
    prompt: input.prompt,
    goal,
    works: workReferences,
    structures: knowledgeReferences,
  });
  const fallbackInitialFold = createSquareRootFold(inputFold);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "iterations"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "cycles"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "batches"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "input.fold"), `${JSON.stringify(inputFold, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "brief.txt"), `${input.prompt || "参考画像をもとに設計"}\n`, { mode: 0o600 });
  await writeFile(join(directory, "goal.json"), `${JSON.stringify(goal, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "candidate-evaluation.json"), `${JSON.stringify(preflight, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "references.json"), `${JSON.stringify(references, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "design-brief.json"), `${JSON.stringify(designBrief, null, 2)}\n`, { mode: 0o600 });
  await Promise.all(candidateFolds.map((candidate, index) =>
    writeFile(join(directory, `candidate-${String(index + 1).padStart(2, "0")}.fold`), `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })
  ));
  await writeFile(join(directory, "preflight-validations.json"), `${JSON.stringify(preflight.validations, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, "iterations.json"), "[]\n", { mode: 0o600 });
  await writeFile(join(directory, "knowledge-references.json"), `${JSON.stringify(knowledgeReferences, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    join(directory, "structural-search.json"),
    `${JSON.stringify(structuralSearchPool.map(publicKnowledgeReference), null, 2)}\n`,
    { mode: 0o600 },
  );
  await Promise.all(structuralSearchPool.map((match, index) =>
    writeFile(
      join(directory, `structural-candidate-${String(index + 1).padStart(2, "0")}.fold`),
      `${JSON.stringify(match.pattern.fold, null, 2)}\n`,
      { mode: 0o600 },
    )
  ));

  let referencePath = null;
  if (input.referenceImage) {
    referencePath = join(directory, `reference${extensionForMimeType(input.referenceImage.mimeType)}`);
    await writeFile(referencePath, input.referenceImage.bytes, { mode: 0o600 });
  }
  const referencePaths = [
    ...(referencePath ? [referencePath] : []),
    ...referenceImages.map(({ local_path }) => local_path),
  ].slice(0, 8);

  const job = {
    id,
    type: "design",
    directory,
    referencePath,
    referencePaths,
    referenceImages,
    references,
    designBrief,
    structuralMatches,
    structuralSearchPool,
    searchedPatternCount,
    fallbackInitialFold,
    prompt: input.prompt,
    goal,
    preflight,
    candidateFolds,
    knowledgeMatch: null,
    knowledgeReferences,
    cycle: 0,
    step: 0,
    maxCycles: finalStateMode ? 4 : unlimitedCodexMode ? null : maxCycles,
    maxSteps: finalStateMode ? 4 : unlimitedCodexMode ? null : maxCycles,
    batchSize: modeSelection.batchSize,
    evaluationLimit: unlimitedCodexMode ? evaluationLimit : (finalStateMode ? 4 : maxCycles),
    evaluatedNodes: 0,
    designMode: jobDesignMode,
    bestScore: null,
    status: "queued",
    message: "処理待ち",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    cancelRequested: false,
  };
  await persistJobState(job);
  jobs.set(id, job);
  queue.push(id);
  void drainQueue();
  return job;
}

async function createOrieditaFoldJob(input) {
  return jobAdmissionGate.run(() => createOrieditaFoldJobAfterAdmission(input));
}

async function createOrieditaFoldJobAfterAdmission(input) {
  const id = randomUUID();
  const directory = join(workRoot, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "input.fold"), `${JSON.stringify(input.fold, null, 2)}\n`, { mode: 0o600 });

  const job = {
    id,
    type: "oriedita-fold",
    directory,
    waitMs: input.waitMs,
    status: "queued",
    message: "処理待ち",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    cancelRequested: false,
  };
  await persistJobState(job);
  jobs.set(id, job);
  queue.push(id);
  void drainQueue();
  return job;
}

async function runGroqJudge(job) {
  const foldedFigure = await orieditaRequest("/folded-figure");
  let referenceImage = null;
  if (job.referencePath) {
    const extension = job.referencePath.split(".").at(-1)?.toLowerCase();
    const mimeType = extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "webp" ? "image/webp" : "image/png";
    referenceImage = { mimeType, data: (await readFile(job.referencePath)).toString("base64") };
  }
  const { judge, metadata } = await requestGroqEvaluation({
    apiKey: groqApiKey,
    model: groqModel,
    endpoint: groqEndpoint,
    prompt: job.prompt,
    goal: job.goal,
    preflight: job.preflight,
    cycle: job.cycle,
    knowledgeMatch: job.knowledgeMatch,
    foldedImage: foldedFigure,
    referenceImage,
    timeoutMs: Math.min(jobTimeoutMs, 120_000),
  });
  const outputPath = join(job.directory, "evaluation.json");
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(judge, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(job.directory, "groq-evaluation.json"), `${JSON.stringify({ judge, metadata }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  return outputPath;
}

async function readConnection() {
  try {
    const connection = JSON.parse(await readFile(connectionFile, "utf8"));
    if (typeof connection.url !== "string" || typeof connection.token !== "string") return null;
    return connection;
  } catch {
    return null;
  }
}

async function bridgeRequest(connection, path, options = {}) {
  const response = await fetch(`${connection.url}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message ?? `Oriedita ${response.status}`);
  }
  return payload.result;
}

async function healthyConnection(connection) {
  if (!connection) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    try {
      const health = await bridgeRequest(connection, "/health", { signal: controller.signal });
      return health?.ready ? connection : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

async function launchOriedita() {
  await Promise.all([
    access(orieditaJar),
    mkdir(orieditaRuntime, { recursive: true, mode: 0o700 }),
  ]);
  await rm(connectionFile, { force: true });
  const token = randomBytes(32).toString("hex");
  const log = await open(orieditaLogFile, "a", 0o600);
  try {
    const child = spawn(orieditaJava, ["-jar", orieditaJar], {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        ORIEDITA_MCP_CONNECTION_FILE: connectionFile,
        ORIEDITA_MCP_TOKEN: token,
      },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
  } finally {
    await log.close();
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const connection = await readConnection();
    if (connection?.token === token && await healthyConnection(connection)) return connection;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Orieditaを起動できませんでした。${orieditaLogFile} を確認してください`);
}

async function ensureOriedita() {
  const active = await healthyConnection(activeOrieditaConnection);
  if (active) return active;

  const existing = await healthyConnection(await readConnection());
  if (existing) {
    activeOrieditaConnection = existing;
    return existing;
  }

  if (!orieditaLaunchPromise) {
    orieditaLaunchPromise = launchOriedita().finally(() => {
      orieditaLaunchPromise = null;
    });
  }
  activeOrieditaConnection = await orieditaLaunchPromise;
  return activeOrieditaConnection;
}

async function orieditaRequest(path, options = {}) {
  const connection = await ensureOriedita();
  try {
    return await bridgeRequest(connection, path, options);
  } catch (error) {
    activeOrieditaConnection = null;
    throw error;
  }
}

async function inspectOriedita() {
  const connection = await healthyConnection(activeOrieditaConnection)
    ?? await healthyConnection(await readConnection());
  if (!connection) return { ready: false };
  activeOrieditaConnection = connection;
  const health = await bridgeRequest(connection, "/health");
  return {
    ready: true,
    version: health.version,
  };
}

async function waitForFold(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await orieditaRequest("/state");
    if (!state.foldingTask?.running) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error("Orieditaの折り計算がタイムアウトしました");
}

async function selectOrieditaFoldableAssignment(job) {
  const selected = job.candidateFolds[job.preflight.selectedIndex];
  const variants = job.knowledgeMatch
    ? [selected]
    : createMountainValleyVariants(knowledgePack, selected, { limit: 64 });
  if (!variants.length) throw new Error("山折り・谷折り候補を作成できませんでした");
  const attempts = [];
  for (let index = 0; index < variants.length; index += 1) {
    const attemptPath = join(job.directory, `assignment-attempt-${String(index + 1).padStart(2, "0")}.fold`);
    await writeFile(attemptPath, `${JSON.stringify(variants[index], null, 2)}\n`, { mode: 0o600 });
    let state = null;
    let errorMessage = null;
    try {
      await orieditaRequest("/open", {
        method: "POST",
        body: JSON.stringify({ path: attemptPath }),
      });
      await orieditaRequest("/action", {
        method: "POST",
        body: JSON.stringify({ action: "foldAction" }),
      });
      state = await waitForFold(15_000);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const completed = Boolean(state?.foldedFigures?.completed);
    attempts.push({
      attempt: index + 1,
      assignment: variants[index]["mitou:assignmentRepair"]?.signature ?? null,
      completed,
      estimationStep: state?.foldedFigures?.estimationStep ?? null,
      error: errorMessage,
    });
    if (!completed) continue;

    await writeFile(join(job.directory, "input.fold"), `${JSON.stringify(variants[index], null, 2)}\n`, { mode: 0o600 });
    job.assignmentRepair = {
      attempts: index + 1,
      assignment: variants[index]["mitou:assignmentRepair"]?.signature ?? null,
      completed: true,
    };
    await writeFile(join(job.directory, "assignment-search.json"), `${JSON.stringify(attempts, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  job.assignmentRepair = { attempts: attempts.length, assignment: null, completed: false };
  await writeFile(join(job.directory, "assignment-search.json"), `${JSON.stringify(attempts, null, 2)}\n`, { mode: 0o600 });
  throw new Error("Orieditaで折り上がりが完了する山谷配置を見つけられませんでした");
}

async function persistFinalEvaluation(job, judge, completed, issues = []) {
  const evaluation = mergeFinalEvaluation(job.preflight, judge, { completed, issues });
  const finalRecord = evaluation.validations.at(-1);
  finalRecord.metrics.assignmentSearchAttempts = job.assignmentRepair?.attempts ?? 0;
  finalRecord.metrics.assignment = job.assignmentRepair?.assignment ?? null;
  await Promise.all([
    writeFile(
      join(job.directory, "iterations", "10-oriedita_final_fold_and_groq_visual_judge.json"),
      `${JSON.stringify(finalRecord, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(job.directory, "iterations.json"),
      `${JSON.stringify(evaluation.validations, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(job.directory, "final-evaluation.json"),
      `${JSON.stringify(evaluation, null, 2)}\n`,
      { mode: 0o600 },
    ),
  ]);
  return evaluation;
}

async function collectResult(job, evaluationPath) {
  const judge = JSON.parse(await readFile(evaluationPath, "utf8"));
  const state = await waitForFold();
  const activeFile = typeof state.file === "string" ? resolve(state.file) : "";
  if (!activeFile.startsWith(`${job.directory}/`)) {
    await persistFinalEvaluation(job, judge, false, ["最終候補がOrieditaで開かれていません"]);
    throw new Error("このジョブの展開図をOrieditaで開けませんでした");
  }
  if (!state.foldedFigures?.completed) {
    await persistFinalEvaluation(job, judge, false, ["Orieditaの折り上がり計算が未完了です"]);
    throw new Error("Orieditaの折り上がり計算が完了していません");
  }

  const finalFoldPath = join(job.directory, "final.fold");
  const finalCreasePath = join(job.directory, "final-crease.png");
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: finalFoldPath }),
  });
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: finalCreasePath }),
  });
  await Promise.all([access(finalFoldPath), access(finalCreasePath)]);
  const foldedFigure = await orieditaRequest("/folded-figure");
  const creaseBytes = await readFile(finalCreasePath);
  const foldBytes = await readFile(finalFoldPath);
  const foldedBytes = Buffer.from(foldedFigure.data, "base64");
  await writeFile(join(job.directory, "final-folded.png"), foldedBytes, { mode: 0o600 });
  const evaluation = await persistFinalEvaluation(job, judge, true);

  return {
    evaluation,
    knowledgeMatch: publicKnowledgeMatch(job.knowledgeMatch),
    knowledgeReferences: job.knowledgeReferences,
    creaseImage: `data:image/png;base64,${creaseBytes.toString("base64")}`,
    foldedImage: `data:${foldedFigure.mimeType};base64,${foldedBytes.toString("base64")}`,
    foldFile: `data:application/json;base64,${foldBytes.toString("base64")}`,
  };
}

async function copyIfPresent(source, destination) {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function prepareDesignCycle(job, candidateFolds, cycle) {
  const directory = join(job.directory, "cycles", String(cycle).padStart(2, "0"));
  const preflight = validateCandidatePool(candidateFolds, job.goal);
  const initialFold = candidateFolds[preflight.selectedIndex];
  await mkdir(join(directory, "iterations"), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(directory, "brief.txt"), `${job.prompt || "参考画像をもとに設計"}\n`, { mode: 0o600 }),
    writeFile(join(directory, "goal.json"), `${JSON.stringify(job.goal, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "input.fold"), `${JSON.stringify(initialFold, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "candidate-evaluation.json"), `${JSON.stringify(preflight, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "knowledge-references.json"), `${JSON.stringify(job.knowledgeReferences, null, 2)}\n`, { mode: 0o600 }),
    ...candidateFolds.map((candidate, index) => writeFile(
      join(directory, `candidate-${String(index + 1).padStart(2, "0")}.fold`),
      `${JSON.stringify(candidate, null, 2)}\n`,
      { mode: 0o600 },
    )),
    ...preflight.validations.map((validation) => writeFile(
      join(directory, "iterations", `${String(validation.index).padStart(2, "0")}-${validation.name}.json`),
      `${JSON.stringify(validation, null, 2)}\n`,
      { mode: 0o600 },
    )),
  ]);
  await writeFile(join(directory, "iterations.json"), `${JSON.stringify(preflight.validations, null, 2)}\n`, { mode: 0o600 });
  await Promise.all([1, 2, 3].map((index) => copyIfPresent(
    join(job.directory, `reference-${String(index).padStart(2, "0")}.fold`),
    join(directory, `reference-${String(index).padStart(2, "0")}.fold`),
  )));
  return {
    ...job,
    directory,
    cycle,
    preflight,
    candidateFolds,
    assignmentRepair: null,
  };
}

function rankRegeneratedCandidates(candidates, goal, limit = 3) {
  return candidates.map((fold) => {
    const evaluation = validateCandidatePool([fold], goal);
    const candidate = evaluation.candidates[0];
    return { fold, evaluation, hardFailures: candidate.hardFailures, scores: evaluation.selectedScores };
  }).sort((a, b) =>
    a.hardFailures - b.hardFailures
    || b.scores.physical - a.scores.physical
    || b.scores.appearance - a.scores.appearance
    || b.scores.foldability - a.scores.foldability
    || foldGeometrySignature(a.fold).localeCompare(foldGeometrySignature(b.fold))
  ).slice(0, limit).map(({ fold }) => fold);
}

function publicCycleRecord(record) {
  return {
    cycle: record.cycle,
    status: record.status,
    score: record.evaluation?.score ?? 0,
    physical: record.evaluation?.physical?.score ?? 0,
    appearance: record.evaluation?.appearance?.score ?? 0,
    foldability: record.evaluation?.foldability?.score ?? 0,
    selectedCandidate: record.evaluation?.selectedCandidate ?? record.preflight?.selectedCandidateId ?? null,
    issues: record.evaluation?.issues ?? record.issues ?? [],
    feedbackUsed: record.feedbackUsed,
  };
}

function bestCycleRecord(records) {
  return [...records].filter((record) => record.result).sort((a, b) =>
    b.evaluation.score - a.evaluation.score
    || b.evaluation.appearance.score - a.evaluation.appearance.score
    || b.evaluation.physical.score - a.evaluation.physical.score
    || a.cycle - b.cycle
  )[0] ?? null;
}

async function runRegenerationLoop(job) {
  let candidateFolds = job.candidateFolds;
  let feedback = [];
  let stopReason = "max_cycles_reached";
  const records = [];

  for (let cycle = 1; cycle <= job.maxCycles; cycle += 1) {
    job.cycle = cycle;
    job.message = `生成・評価サイクル ${cycle}/${job.maxCycles}`;
    const cycleJob = await prepareDesignCycle(job, candidateFolds, cycle);
    let record;
    try {
      await selectOrieditaFoldableAssignment(cycleJob);
      const evaluationPath = await runGroqJudge(cycleJob);
      const result = await collectResult(cycleJob, evaluationPath);
      record = {
        cycle,
        status: "completed",
        feedbackUsed: feedback,
        preflight: cycleJob.preflight,
        evaluation: result.evaluation,
        result,
      };
      records.push(record);
      const best = bestCycleRecord(records);
      job.bestScore = best?.evaluation.score ?? null;
      await writeFile(
        join(cycleJob.directory, "cycle-summary.json"),
        `${JSON.stringify(publicCycleRecord(record), null, 2)}\n`,
        { mode: 0o600 },
      );
      if (job.knowledgeMatch) {
        stopReason = "exact_knowledge_match";
        break;
      }
      if (result.evaluation.score >= targetScore) {
        stopReason = "target_score_reached";
        break;
      }
      feedback = result.evaluation.issues;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        cycle,
        status: "failed",
        feedbackUsed: feedback,
        preflight: cycleJob.preflight,
        evaluation: null,
        result: null,
        issues: [message],
      };
      records.push(record);
      feedback = [message];
      await writeFile(
        join(cycleJob.directory, "cycle-summary.json"),
        `${JSON.stringify(publicCycleRecord(record), null, 2)}\n`,
        { mode: 0o600 },
      );
      if (cycle === job.maxCycles && !bestCycleRecord(records)) throw error;
    }

    if (cycle === job.maxCycles) break;
    const currentFold = JSON.parse(await readFile(join(cycleJob.directory, "input.fold"), "utf8"));
    const regenerated = regenerateCandidatePool({
      currentFold,
      goal: job.goal,
      feedback,
      cycle: cycle + 1,
      count: 24,
    });
    candidateFolds = rankRegeneratedCandidates(regenerated, job.goal, 3);
    if (!candidateFolds.length) {
      stopReason = "regeneration_exhausted";
      break;
    }
  }

  const best = bestCycleRecord(records);
  if (!best) throw new Error("生成・評価ループで有効な候補を作成できませんでした");
  const cycles = records.map(publicCycleRecord);
  const evaluation = {
    ...best.evaluation,
    iterations: records.length,
    stop_reason: stopReason,
    mode: "generation_evaluation_regeneration_loop",
    maxCycles: job.maxCycles,
    targetScore,
    bestCycle: best.cycle,
    cycles,
  };
  const result = { ...best.result, evaluation };
  await writeFile(
    join(job.directory, "generation-loop.json"),
    `${JSON.stringify({ stopReason, targetScore, bestCycle: best.cycle, cycles }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return result;
}

function stepNodeDirectory(job, nodeId) {
  return join(job.directory, "steps", "nodes", nodeId);
}

function documentPaperBounds(document) {
  const lines = Array.isArray(document?.lines) ? document.lines : [];
  const boundary = lines.filter(({ color }) => color === "EDGE");
  const source = boundary.length ? boundary : lines;
  const points = source.flatMap((line) => [line?.a, line?.b]).filter((point) =>
    Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  if (points.length < 4) throw new Error("Orieditaの紙面座標を取得できませんでした");
  const xs = points.map(({ x }) => Number(x));
  const ys = points.map(({ y }) => Number(y));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX - minX <= 1e-9 || maxY - minY <= 1e-9) throw new Error("Orieditaの紙面寸法が不正です");
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function mapPaperPoint(point, bounds) {
  return [
    bounds.minX + Number(point[0]) * bounds.width,
    bounds.minY + Number(point[1]) * bounds.height,
  ];
}

function segmentIntersectionScore(a, b, c, d) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= 1e-9) return 0;
  const qpx = c[0] - a[0];
  const qpy = c[1] - a[1];
  const t = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  if (t <= 1e-8 || t >= 1 - 1e-8 || u < -1e-8 || u > 1 + 1e-8) return 0;
  return u <= 1e-8 || u >= 1 - 1e-8 ? 0.25 : 1;
}

function squareLineEndpoints(nx, ny, constant) {
  const points = [];
  const add = (x, y) => {
    if (x < -1e-8 || x > 1 + 1e-8 || y < -1e-8 || y > 1 + 1e-8) return;
    const point = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
    if (!points.some(([px, py]) => Math.hypot(px - point[0], py - point[1]) <= 1e-7)) points.push(point);
  };
  if (Math.abs(ny) > 1e-9) {
    add(0, constant / ny);
    add(1, (constant - nx) / ny);
  }
  if (Math.abs(nx) > 1e-9) {
    add(constant / nx, 0);
    add((constant - ny) / nx, 1);
  }
  if (points.length < 2) return null;
  let selected = [points[0], points[1]];
  let maximumDistance = -1;
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const distance = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]);
      if (distance > maximumDistance) {
        maximumDistance = distance;
        selected = [points[a], points[b]];
      }
    }
  }
  return maximumDistance > 1e-8 ? selected : null;
}

function parallelOffsetSmokeActions(fold) {
  const vertices = Array.isArray(fold?.vertices_coords) ? fold.vertices_coords : [];
  const edges = Array.isArray(fold?.edges_vertices) ? fold.edges_vertices : [];
  const assignments = Array.isArray(fold?.edges_assignment) ? fold.edges_assignment : [];
  const finiteVertices = vertices.filter((point) => Array.isArray(point)
    && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
  if (finiteVertices.length < 4) return [];
  const xs = finiteVertices.map(([x]) => Number(x));
  const ys = finiteVertices.map(([, y]) => Number(y));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 1e-9 || height <= 1e-9) return [];
  const groups = new Map();
  for (let index = 0; index < edges.length; index += 1) {
    if (assignments[index] !== "M" && assignments[index] !== "V") continue;
    const [startIndex, endIndex] = edges[index] ?? [];
    const start = vertices[startIndex];
    const end = vertices[endIndex];
    if (!Array.isArray(start) || !Array.isArray(end)) continue;
    const a = [(Number(start[0]) - minX) / width, (Number(start[1]) - minY) / height];
    const b = [(Number(end[0]) - minX) / width, (Number(end[1]) - minY) / height];
    if (![...a, ...b].every(Number.isFinite)) continue;
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-9) continue;
    dx /= length;
    dy /= length;
    if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) {
      dx *= -1;
      dy *= -1;
    }
    const angle = Math.atan2(dy, dx);
    const key = String(Math.round(angle * 1_000_000));
    const nx = -dy;
    const ny = dx;
    const constant = nx * ((a[0] + b[0]) / 2) + ny * ((a[1] + b[1]) / 2);
    const group = groups.get(key) ?? { key, nx, ny, entries: [] };
    group.entries.push({ constant, assignment: assignments[index] });
    groups.set(key, group);
  }
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const actions = [];
  const orderedGroups = [...groups.values()].sort((a, b) =>
    b.entries.length - a.entries.length || Number(a.key) - Number(b.key));
  for (const group of orderedGroups) {
    const supports = corners.map(([x, y]) => group.nx * x + group.ny * y);
    const supportMin = Math.min(...supports);
    const supportMax = Math.max(...supports);
    const ordered = [...group.entries].sort((a, b) => a.constant - b.constant);
    const probes = [
      { constant: (supportMin + ordered[0].constant) / 2, nearest: ordered[0] },
      { constant: (supportMax + ordered.at(-1).constant) / 2, nearest: ordered.at(-1) },
    ].filter(({ constant, nearest }) => Math.abs(constant - nearest.constant) > 1e-6);
    for (const { constant, nearest } of probes) {
      const endpoints = squareLineEndpoints(group.nx, group.ny, constant);
      if (!endpoints) continue;
      const assignment = nearest.assignment === "M" ? "V" : "M";
      actions.push({
        id: `parallel-offset-${group.key}-${constant.toFixed(8)}-${assignment}`,
        type: "add_crease",
        a: endpoints[0],
        b: endpoints[1],
        assignment,
        construction: "parallel_offset_smoke_probe",
        rationale: "既存の平行折り線群の外側に追加できるかを検証",
      });
    }
  }
  return actions;
}

function selectModifiabilitySmokeAction(fold, goal, document, bounds) {
  const lines = Array.isArray(document?.lines) ? document.lines : [];
  const seen = new Set();
  const actions = [
    ...parallelOffsetSmokeActions(fold),
    ...enumerateFullWidthCreaseActions({ fold, depth: 0, goal }),
  ].filter((action) => {
    const points = [action.a, action.b]
      .map(([x, y]) => `${Number(x).toFixed(7)},${Number(y).toFixed(7)}`)
      .sort()
      .join(":");
    const key = `${points}:${action.assignment}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return actions
    .map((action, index) => {
      const [a, b] = [mapPaperPoint(action.a, bounds), mapPaperPoint(action.b, bounds)];
      const intersections = lines.reduce((sum, line) => {
        if (line?.color === "EDGE") return sum;
        const c = [Number(line?.a?.x), Number(line?.a?.y)];
        const d = [Number(line?.b?.x), Number(line?.b?.y)];
        if (![...c, ...d].every(Number.isFinite)) return sum;
        return sum + segmentIntersectionScore(a, b, c, d);
      }, 0);
      return { action, a, b, intersections, index };
    })
    .sort((a, b) => a.intersections - b.intersections || a.index - b.index)[0] ?? null;
}

export async function runOrieditaModifiabilitySmokeTest({
  parentPath,
  smokePath,
  fold,
  goal = null,
  requestImpl = orieditaRequest,
  waitImpl = waitForFold,
  copyImpl = copyFile,
  removeImpl = rm,
} = {}) {
  const result = {
    schema: "oriai-oriedita-modifiability-smoke-v1",
    status: "failed",
    isolation: "temporary_fold_copy",
    action: null,
    intersection_score: null,
    line_count_before: null,
    line_count_after: null,
    add_line_completed: false,
    calculation_started: false,
    violation_count: null,
    oriedita_completed: false,
    parent_reloaded: false,
    temporary_copy_removed: false,
    reason: "Orieditaの追加折り線スモークテストを完了できませんでした",
  };
  let operationError = null;
  try {
    if (typeof parentPath !== "string" || !parentPath || typeof smokePath !== "string" || !smokePath) {
      throw new Error("スモークテスト用FOLDパスが不正です");
    }
    await copyImpl(parentPath, smokePath);
    await requestImpl("/open", {
      method: "POST",
      body: JSON.stringify({ path: smokePath }),
    });
    const document = await requestImpl("/document");
    result.line_count_before = Array.isArray(document?.lines) ? document.lines.length : null;
    const bounds = documentPaperBounds(document);
    const selected = selectModifiabilitySmokeAction(fold, goal, document, bounds);
    if (!selected) throw new Error("重複しない追加折り線を作成できませんでした");
    result.action = {
      type: "add_crease",
      a: selected.action.a,
      b: selected.action.b,
      assignment: selected.action.assignment,
      key: selected.action.id,
    };
    result.intersection_score = selected.intersections;
    await requestImpl("/line", {
      method: "POST",
      body: JSON.stringify({
        ax: selected.a[0],
        ay: selected.a[1],
        bx: selected.b[0],
        by: selected.b[1],
        color: selected.action.assignment === "V" ? "VALLEY" : "MOUNTAIN",
      }),
    });
    const documentAfter = await requestImpl("/document");
    result.line_count_after = Array.isArray(documentAfter?.lines) ? documentAfter.lines.length : null;
    if (!Number.isInteger(result.line_count_before)
      || !Number.isInteger(result.line_count_after)
      || result.line_count_after <= result.line_count_before) {
      throw new Error("Orieditaで追加折り線の実在を確認できませんでした");
    }
    result.add_line_completed = true;
    const calculation = await requestImpl("/fold-calculate", { method: "POST" });
    result.calculation_started = calculation?.started === true;
    result.violation_count = Number.isInteger(calculation?.violationCount)
      && calculation.violationCount >= 0
      ? calculation.violationCount
      : null;
    if (!result.calculation_started) {
      throw new Error("追加後の平坦折り計算を開始できませんでした");
    }
    if (result.violation_count !== 0) {
      throw new Error(result.violation_count == null
        ? "追加後の局所平坦折り違反数を確認できませんでした"
        : `追加後に局所平坦折り違反が${result.violation_count}件あります`);
    }
    const state = await waitImpl(30_000);
    result.oriedita_completed = state?.foldedFigures?.completed === true;
    if (!result.oriedita_completed) throw new Error("追加後の2D平坦折り計算が完了しませんでした");
    result.status = "passed";
    result.reason = "一時コピーへの折り線追加とOrieditaの2D平坦折り計算が完了";
  } catch (error) {
    operationError = error instanceof Error ? error.message : String(error);
    result.status = "failed";
    result.reason = operationError;
  } finally {
    try {
      if (typeof parentPath === "string" && parentPath) {
        await requestImpl("/open", {
          method: "POST",
          body: JSON.stringify({ path: parentPath }),
        });
        result.parent_reloaded = true;
      }
    } catch (error) {
      const reloadError = error instanceof Error ? error.message : String(error);
      result.status = "failed";
      result.reason = operationError
        ? `${operationError}; 親FOLDを再読込できませんでした: ${reloadError}`
        : `親FOLDを再読込できませんでした: ${reloadError}`;
    }
    try {
      if (typeof smokePath === "string" && smokePath) {
        await removeImpl(smokePath, { force: true });
        result.temporary_copy_removed = true;
      }
    } catch (error) {
      const cleanupError = error instanceof Error ? error.message : String(error);
      result.reason = `${result.reason}; 一時コピーを削除できませんでした: ${cleanupError}`;
    }
  }
  if (!result.parent_reloaded) result.status = "failed";
  return result;
}

async function ensureNodeFoldSnapshot(job, node) {
  const directory = stepNodeDirectory(job, node.id);
  const path = join(directory, "state.fold");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(node.fold, null, 2)}\n`, { mode: 0o600 });
  node.artifacts ??= {};
  node.artifacts.foldPath = path;
  return path;
}

async function ensureParentPreview(job, parent) {
  if (typeof parent.artifacts?.foldedPng === "string") return;
  const screenshot = await orieditaRequest("/screenshot?target=canvas");
  if (!screenshot?.data || !screenshot?.mimeType) throw new Error("親状態のプレビューを取得できませんでした");
  const directory = stepNodeDirectory(job, parent.id);
  const path = join(directory, "folded.png");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
  parent.artifacts ??= {};
  parent.artifacts.foldedPng = path;
  parent.artifacts.foldedMimeType = screenshot.mimeType;
}

async function simulateCreaseStep(job, { id, parent, action, depth, goal }) {
  const directory = stepNodeDirectory(job, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parentPath = await ensureNodeFoldSnapshot(job, parent);
  await orieditaRequest("/open", {
    method: "POST",
    body: JSON.stringify({ path: parentPath }),
  });
  await ensureParentPreview(job, parent);
  const before = await orieditaRequest("/document");
  const bounds = documentPaperBounds(before);
  const [a, b] = [mapPaperPoint(action.a, bounds), mapPaperPoint(action.b, bounds)];
  await orieditaRequest("/line", {
    method: "POST",
    body: JSON.stringify({
      ax: a[0],
      ay: a[1],
      bx: b[0],
      by: b[1],
      color: action.assignment === "V" ? "VALLEY" : "MOUNTAIN",
    }),
  });

  const foldPath = join(directory, "state.fold");
  const creasePath = join(directory, "crease.png");
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: foldPath }),
  });
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: creasePath }),
  });
  const fold = JSON.parse(await readFile(foldPath, "utf8"));
  const calculation = await orieditaRequest("/fold-calculate", { method: "POST" });
  let completed = false;
  let state = null;
  let foldedPath = null;
  let foldedMimeType = "image/png";
  if (calculation?.started) {
    state = await waitForFold(30_000);
    completed = Boolean(state?.foldedFigures?.completed);
    if (completed) {
      const folded = await orieditaRequest("/folded-figure");
      foldedPath = join(directory, "folded.png");
      foldedMimeType = folded.mimeType;
      await writeFile(foldedPath, Buffer.from(folded.data, "base64"), { mode: 0o600 });
    }
  }

  const partial = evaluatePartialFold({
    fold,
    goal,
    action,
    orieditaCompleted: completed,
    targetCreaseCount: job.maxSteps,
    finalStep: depth >= job.maxSteps,
  });
  const hardFailures = partial.checks
    .filter(({ status }) => status === "fail")
    .flatMap(({ issues, name }) => issues?.length ? issues : [name]);
  if (Number(calculation?.violationCount) > 0) {
    hardFailures.push(`局所平坦折り違反 ${calculation.violationCount}件`);
  }
  const physical = {
    completed,
    hardFailures: [...new Set(hardFailures)],
    score: partial.scores.physical,
    foldabilityScore: partial.scores.foldability,
    checks: partial.checks,
    structure: partial.structure,
    violationCount: Number(calculation?.violationCount) || 0,
    stateType: partial.stateType,
    actionKind: partial.actionKind,
    physicalScope: partial.physicalScope,
    sequentialPhysicalFolding: partial.sequentialPhysicalFolding,
    sequenceFeasibility: partial.sequenceFeasibility,
  };
  const artifacts = {
    foldPath,
    creasePng: creasePath,
    foldedPng: foldedPath,
    foldedMimeType,
  };
  await Promise.all([
    writeFile(join(directory, "action.json"), `${JSON.stringify(action, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "physical.json"), `${JSON.stringify(physical, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "document.json"), `${JSON.stringify(await orieditaRequest("/document"), null, 2)}\n`, { mode: 0o600 }),
  ]);
  return { fold, physical, artifacts };
}

function evaluationImagePath(imagePath) {
  if (process.platform !== "darwin") return imagePath;
  const resizedPath = imagePath.replace(/(\.[^.]+)$/i, "-evaluation$1");
  if (resizedPath === imagePath) return imagePath;
  try {
    execFileSync("/usr/bin/sips", ["-Z", "384", imagePath, "--out", resizedPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return resizedPath;
  } catch {
    return imagePath;
  }
}

async function stepCandidatePayload(node) {
  const imagePath = node.artifacts?.foldedPng ?? node.artifacts?.creasePng;
  if (typeof imagePath !== "string") throw new Error(`候補${node.id}の比較画像がありません`);
  const resizedPath = evaluationImagePath(imagePath);
  return {
    id: node.id,
    foldedImage: {
      mimeType: node.artifacts?.foldedMimeType ?? "image/png",
      data: (await readFile(resizedPath)).toString("base64"),
    },
    actionSummary: node.action ? {
      type: node.action.type,
      assignment: node.action.assignment,
      segment: { a: node.action.a, b: node.action.b },
      construction: node.action.construction,
    } : { type: "root_square" },
    physicalSummary: {
      score: node.physical?.score ?? 0,
      foldabilityScore: node.physical?.foldabilityScore ?? 0,
      priorTargetScore: node.target?.score ?? 0,
      hardFailures: node.physical?.hardFailures ?? [],
      physicalScope: node.physical?.physicalScope ?? "oriedita_flat_fold_2d",
    },
  };
}

async function stepReferenceImage(job) {
  if (!job.referencePath) return null;
  const extension = job.referencePath.split(".").at(-1)?.toLowerCase();
  const mimeType = extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "webp" ? "image/webp" : "image/png";
  return {
    mimeType,
    data: (await readFile(evaluationImagePath(job.referencePath))).toString("base64"),
  };
}

async function judgeCreaseStepCandidates(job, { candidates, goal, manifest }) {
  const byParent = new Map();
  for (const candidate of candidates) {
    const siblings = byParent.get(candidate.parentId) ?? [];
    siblings.push(candidate);
    byParent.set(candidate.parentId, siblings);
  }
  const referenceImage = await stepReferenceImage(job);
  const judgements = [];
  for (const [parentId, siblings] of byParent) {
    const parent = manifest.nodes[parentId];
    const parentPayload = await stepCandidatePayload(parent);
    const chunkSize = referenceImage ? 1 : 2;
    for (let offset = 0; offset < siblings.length; offset += chunkSize) {
      const siblingNodes = siblings.slice(offset, offset + chunkSize);
      const siblingPayloads = await Promise.all(siblingNodes.map(stepCandidatePayload));
      let evaluated;
      if (job.stepEvaluatorUnavailable) {
        evaluated = fallbackStepJudgements({ parent: parentPayload, siblings: siblingPayloads, goal });
      } else try {
        evaluated = (await requestGroqStepEvaluation({
          apiKey: groqApiKey,
          model: groqModel,
          endpoint: groqEndpoint,
          prompt: job.prompt,
          goal,
          step: siblingNodes[0]?.depth ?? 1,
          parent: parentPayload,
          siblings: siblingPayloads,
          referenceImage,
          includeParentImage: false,
          timeoutMs: Math.min(jobTimeoutMs, 120_000),
        })).judgements;
      } catch (error) {
        job.stepEvaluatorUnavailable = true;
        console.warn(`一手評価を決定論fallbackへ切り替えます: ${error instanceof Error ? error.message : error}`);
        evaluated = fallbackStepJudgements({ parent: parentPayload, siblings: siblingPayloads, goal });
      }
      const byId = new Map(evaluated.map((entry) => [entry.id, entry]));
      for (const sibling of siblingNodes) {
        const judgement = byId.get(sibling.id);
        if (judgement) judgements.push(judgement);
      }
    }
  }
  return judgements;
}

function publicStepRecord(node) {
  return {
    cycle: node.depth,
    step: node.depth,
    status: node.status,
    score: Math.round(node.target?.score ?? 0),
    physical: Math.round(node.physical?.score ?? 0),
    appearance: Math.round(node.target?.silhouetteScore ?? node.target?.score ?? 0),
    foldability: Math.round(node.physical?.foldabilityScore ?? 0),
    selectedCandidate: node.id,
    issues: node.target?.issues ?? [],
    action: node.action,
  };
}

async function finalizeStepSearchResult(job, search) {
  const best = search.bestNode;
  if (!best?.fold || best.depth < 1) throw new Error("一手ずつの探索で有効な折り線を追加できませんでした");
  const sourcePath = await ensureNodeFoldSnapshot(job, best);
  await orieditaRequest("/open", {
    method: "POST",
    body: JSON.stringify({ path: sourcePath }),
  });
  const calculation = await orieditaRequest("/fold-calculate", { method: "POST" });
  assertSuccessfulFinalFoldCalculation(calculation);
  const state = await waitForFold(30_000);
  if (!state?.foldedFigures?.completed) throw new Error("最終候補の2D平坦折り計算が完了しませんでした");

  const finalFoldPath = join(job.directory, "final.fold");
  const finalCreasePath = join(job.directory, "final-crease.png");
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: finalFoldPath }),
  });
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: finalCreasePath }),
  });
  const foldedFigure = await orieditaRequest("/folded-figure");
  const foldedBytes = Buffer.from(foldedFigure.data, "base64");
  await writeFile(join(job.directory, "final-folded.png"), foldedBytes, { mode: 0o600 });
  const pathNodes = search.bestPath.map(({ nodeId }) => search.manifest.nodes[nodeId]);
  const cycles = pathNodes.map(publicStepRecord);
  const evaluation = {
    score: Math.round(best.target?.score ?? 0),
    iterations: search.bestPath.length,
    stop_reason: search.stopReason,
    summary: best.target?.summary ?? `${search.bestPath.length}手の折り線追加と評価を完了しました`,
    issues: best.target?.issues ?? [],
    mode: "crease_by_crease_evaluation_search",
    physical: {
      score: Math.round(best.physical?.score ?? 0),
      orieditaCompleted: true,
      scope: "oriedita_flat_fold_2d",
    },
    appearance: {
      score: Math.round(best.target?.silhouetteScore ?? best.target?.score ?? 0),
      rotationNormalized: true,
      dimensions: "2d_folded_figure",
    },
    foldability: {
      score: Math.round(best.physical?.foldabilityScore ?? 0),
      layerCount: "unknown",
      clearanceIsProxy: true,
    },
    maxCycles: job.maxSteps,
    targetScore,
    bestCycle: best.depth,
    cycles,
    steps: cycles,
    search: {
      schema: search.manifest.schema,
      evaluatedNodes: search.manifest.evaluatedNodes,
      branches: Math.max(0, Object.keys(search.manifest.nodes).length - 1),
      rollbacks: search.manifest.rollbackCount,
      bestPath: search.bestPath,
      stateType: "crease_pattern_prefix",
      actionKind: "add_crease",
      physicalScope: "oriedita_flat_fold_2d",
      sequentialPhysicalFolding: false,
      sequenceFeasibility: "unverified",
    },
  };
  await Promise.all([
    writeFile(join(job.directory, "final-evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(job.directory, "generation-loop.json"), `${JSON.stringify({
      stopReason: search.stopReason,
      bestNodeId: best.id,
      bestPath: search.bestPath,
      cycles,
    }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  const [creaseBytes, foldBytes] = await Promise.all([
    readFile(finalCreasePath),
    readFile(finalFoldPath),
  ]);
  return {
    evaluation,
    knowledgeMatch: publicKnowledgeMatch(job.knowledgeMatch),
    knowledgeReferences: job.knowledgeReferences,
    creaseImage: `data:image/png;base64,${creaseBytes.toString("base64")}`,
    foldedImage: `data:${foldedFigure.mimeType};base64,${foldedBytes.toString("base64")}`,
    foldFile: `data:application/json;base64,${foldBytes.toString("base64")}`,
  };
}

async function runStepDesignLoop(job) {
  const stepsDirectory = join(job.directory, "steps");
  await mkdir(join(stepsDirectory, "nodes"), { recursive: true, mode: 0o700 });
  const source = job.candidateFolds[job.preflight.selectedIndex];
  const persist = async ({ event, node, manifest }) => {
    if (node?.fold) await ensureNodeFoldSnapshot(job, node);
    if (node?.target && node.depth > 0) {
      const directory = stepNodeDirectory(job, node.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "evaluation.json"), `${JSON.stringify({
        target: node.target,
        physical: node.physical,
        status: node.status,
      }, null, 2)}\n`, { mode: 0o600 });
    }
    await appendFile(join(stepsDirectory, "events.ndjson"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await writeFile(join(stepsDirectory, "tree.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    job.step = Math.max(job.step ?? 0, Number(node?.depth) || 0);
    job.cycle = job.step;
    job.evaluatedNodes = manifest.evaluatedNodes;
    job.bestScore = manifest.nodes[manifest.bestNodeId]?.target?.score ?? null;
    job.message = `折り線を一手ずつ追加・評価 ${job.step}/${job.maxSteps}`;
  };
  const search = await runStepSearch({
    rootFold: source,
    goal: job.goal,
    maxDepth: job.maxSteps,
    branchFactor: stepBranchFactor,
    beamWidth: stepBeamWidth,
    targetScore,
    simulate: (input) => simulateCreaseStep(job, input),
    judge: (input) => judgeCreaseStepCandidates(job, input),
    persist,
  });
  return finalizeStepSearchResult(job, search);
}

async function prepareCodexInitialFold(job) {
  const validations = [];
  const searchPool = job.structuralSearchPool?.length ? job.structuralSearchPool : job.structuralMatches;
  let incrementalCandidatePassed = false;
  for (let index = 0; index < searchPool.length && !incrementalCandidatePassed; index += 1) {
    const match = searchPool[index];
    const candidatePath = join(job.directory, `structural-candidate-${String(index + 1).padStart(2, "0")}.fold`);
    const record = {
      pattern_id: match.pattern.id,
      family: match.pattern.family,
      search_rank: index + 1,
      similarity_score: match.score ?? null,
      requires_modifiability_smoke_test: true,
      incremental_modification_ready: false,
      modifiability: {
        schema: "oriai-oriedita-modifiability-smoke-v1",
        status: "not_run",
        reason: "平坦折り検証の通過後に実行します",
      },
      status: "failed",
      oriedita_completed: false,
      violation_count: null,
      reason: "Oriedita検証を完了できませんでした",
    };
    try {
      await orieditaRequest("/open", {
        method: "POST",
        body: JSON.stringify({ path: candidatePath }),
      });
      const calculation = await orieditaRequest("/fold-calculate", { method: "POST" });
      record.violation_count = Number.isInteger(calculation?.violationCount)
        && calculation.violationCount >= 0
        ? calculation.violationCount
        : null;
      if (!calculation?.started || record.violation_count !== 0) {
        record.reason = !calculation?.started
          ? "Orieditaが平坦折り計算を開始できませんでした"
          : record.violation_count == null
            ? "Orieditaの局所平坦折り違反数を確認できませんでした"
            : `局所平坦折り違反 ${record.violation_count}件`;
      } else {
        const state = await waitForFold(30_000);
        record.oriedita_completed = state?.foldedFigures?.completed === true;
        record.status = record.oriedita_completed ? "passed" : "failed";
        if (record.status === "passed") {
          record.modifiability = await runOrieditaModifiabilitySmokeTest({
            parentPath: candidatePath,
            smokePath: join(job.directory, `.structural-smoke-${String(index + 1).padStart(2, "0")}.fold`),
            fold: match.pattern.fold,
            goal: job.goal,
          });
          record.incremental_modification_ready = record.modifiability.status === "passed";
          incrementalCandidatePassed = record.incremental_modification_ready;
        }
        record.reason = record.oriedita_completed
          ? record.incremental_modification_ready
            ? "Orieditaの2D平坦折り計算と追加折り線スモークテストが完了"
            : `Orieditaの2D平坦折り計算は完了しましたが追加折り線スモークテストは不合格: ${record.modifiability.reason}`
          : "Orieditaの2D平坦折り計算が完了しませんでした";
      }
    } catch (error) {
      record.reason = error instanceof Error ? error.message : String(error);
    }
    validations.push(record);
  }
  const selected = chooseValidatedInitialFold(searchPool, validations, job.fallbackInitialFold, {
    requireIncrementalModification: true,
  });
  if (!selected.fold) throw new Error("初期FOLDを準備できませんでした");
  const initialPath = join(job.directory, "initial.fold");
  await writeFile(initialPath, `${JSON.stringify(selected.fold, null, 2)}\n`, { mode: 0o600 });
  const passedIds = new Set(validations.filter(({ status }) => status === "passed").map(({ pattern_id: patternId }) => patternId));
  let visibleMatches = passedIds.size
    ? searchPool.filter(({ pattern }) => passedIds.has(pattern.id)).slice(0, 3)
    : searchPool.slice(0, 3);
  const selectedMatch = searchPool.find(({ pattern }) => pattern.id === selected.pattern_id) ?? null;
  if (selectedMatch && !visibleMatches.some(({ pattern }) => pattern.id === selected.pattern_id)) {
    visibleMatches = [...visibleMatches.slice(0, 2), selectedMatch];
  }
  job.structuralMatches = visibleMatches;
  job.knowledgeReferences = visibleMatches.map(publicKnowledgeReference);
  const structuralCandidates = job.knowledgeReferences.map((candidate) => ({
    ...candidate,
    validation: validations.find(({ pattern_id: patternId }) => patternId === candidate.id) ?? null,
  }));
  const selectedValidation = validations.find(({ pattern_id: patternId }) => patternId === selected.pattern_id) ?? null;
  const selectionKind = selected.fallback
    ? "square_fallback"
    : selectedMatch?.validationFallback
      ? "validation_fallback"
      : "similarity_match";
  job.references = {
    ...job.references,
    structural_knowledge: {
      ...job.references.structural_knowledge,
      candidates: structuralCandidates,
      selected_initial: {
        source: selected.source,
        pattern_id: selected.pattern_id,
        fallback: selected.fallback,
        similarity_score: selectedMatch?.score ?? null,
        similarity_reason: selectedMatch?.reason ?? null,
        family: selectedMatch?.pattern?.family ?? null,
        params: selectedMatch?.pattern?.params ?? null,
        incremental_modification_ready: selectedValidation?.incremental_modification_ready === true,
        incremental_modification_strategy: selectedValidation?.incremental_modification_ready
          ? "oriedita_add_line_calculate_reload_smoke_test"
          : null,
        modifiability: selectedValidation?.modifiability ?? null,
        search_rank: selected.pattern_id
          ? searchPool.findIndex(({ pattern }) => pattern.id === selected.pattern_id) + 1
          : null,
        modification_mode: selected.fallback ? "square_fallback" : "modify_retrieved_fold",
        selection_kind: selectionKind,
      },
    },
  };
  job.designBrief = {
    ...job.designBrief,
    design_inputs: {
      ...job.designBrief.design_inputs,
      structural_candidates: structuralCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        family: candidate.family,
        params: candidate.params,
        reason: candidate.reason,
        score: candidate.score,
        score_breakdown: candidate.scoreBreakdown,
        validation: candidate.validation,
      })),
      structural_search: {
        strategy: job.searchedPatternCount > 0
          ? "prompt_to_design_features_then_rank_5000"
          : "not_run",
        searched_pattern_count: job.searchedPatternCount,
        evaluated_candidate_count: validations.length,
        selected_pattern_id: selected.pattern_id,
        modification_mode: selected.fallback ? "square_fallback" : "modify_retrieved_fold",
        selection_kind: selectionKind,
        modifiability_validation: selectedValidation?.modifiability ?? null,
      },
    },
  };
  await Promise.all([
    writeFile(join(job.directory, "references.json"), `${JSON.stringify(job.references, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(job.directory, "design-brief.json"), `${JSON.stringify(job.designBrief, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(job.directory, "knowledge-references.json"), `${JSON.stringify(job.knowledgeReferences, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(job.directory, "structural-validation.json"), `${JSON.stringify(validations, null, 2)}\n`, { mode: 0o600 }),
  ]);
  return initialPath;
}

function buildPriorAttemptsSummary(iterationRecords, operationSummary) {
  const recent = iterationRecords.slice(-80).map((record) => ({
    step: record.step,
    score: record.score,
    accepted: record.accepted,
    action: record.action,
    add_line_arguments: record.operation_evidence?.add_line?.arguments ?? null,
  }));
  return {
    evaluations_completed: operationSummary.evaluations_completed,
    best_score: operationSummary.best_score,
    omitted_older_attempts: Math.max(0, operationSummary.evaluations_completed - recent.length),
    recent_attempts: recent,
  };
}

async function synchronizeCodexCheckpointLogs(directory, checkpoint, {
  batchSize = codexBatchIterations,
} = {}) {
  if (checkpoint?.schema !== "oriai-codex-checkpoint-v1") return;
  const summary = checkpoint.operation_summary;
  const batchNumber = finiteInteger(summary?.batches_completed);
  if (batchNumber < 1) return;
  const batchName = String(batchNumber).padStart(6, "0");
  const batchRecords = await readJsonIfPresent(join(directory, "batches", batchName, "iterations.json"));
  const batchRecord = Array.isArray(summary?.batches)
    ? summary.batches.find((record) => finiteInteger(record?.batch) === batchNumber)
    : null;
  if (!Array.isArray(batchRecords) || !batchRecord) {
    throw new Error("再開チェックポイントのバッチ記録が不足しています");
  }
  const evaluation = await readJsonIfPresent(join(directory, "batches", batchName, "evaluation.json"));
  const actionKeys = evaluation?.operation_counts?.action_keys;
  if (!Array.isArray(actionKeys) || actionKeys.length !== batchSize) {
    throw new Error("再開チェックポイントの折り線操作履歴が不足しています");
  }
  const actionRecords = actionKeys.map((actionKey, index) => ({
    step: finiteInteger(batchRecord.start_step, (batchNumber - 1) * batchSize + 1) + index,
    batch: batchNumber,
    action_key: actionKey,
  }));
  await Promise.all([
    appendJsonLinesOnce(join(directory, "iterations.jsonl"), batchRecords, "step"),
    appendJsonLinesOnce(join(directory, "batch-history.jsonl"), [batchRecord], "batch"),
    appendJsonLinesOnce(join(directory, "action-history.jsonl"), actionRecords, "step"),
  ]);
}

export async function loadCommittedCodexActionKeys(directory, batchesCompleted, {
  batchSize = codexBatchIterations,
} = {}) {
  const completed = Math.max(0, finiteInteger(batchesCompleted));
  const keys = new Set();
  for (let batchNumber = 1; batchNumber <= completed; batchNumber += 1) {
    const evaluationPath = join(
      directory,
      "batches",
      String(batchNumber).padStart(6, "0"),
      "evaluation.json",
    );
    const evaluation = await readJsonIfPresent(evaluationPath);
    if (!evaluation) throw new Error(`完了済みCodexバッチ${batchNumber}の評価記録がありません`);
    const batchKeys = assertNovelCodexActionKeys(evaluation?.operation_counts?.action_keys, {
      previousActionKeys: keys,
      expectedCount: batchSize,
    });
    for (const key of batchKeys) keys.add(key);
  }
  return keys;
}

export async function loadPersistedCodexActionHistory(directory, batchesCompleted, {
  batchSize = codexBatchIterations,
} = {}) {
  const completed = Math.max(0, finiteInteger(batchesCompleted));
  const keys = await loadCommittedCodexActionKeys(directory, completed, { batchSize });
  const events = await readJsonLinesIfPresent(join(directory, "action-attempts.jsonl"));
  const inflight = [];
  const byKey = new Map();
  for (const event of events) {
    const actionKey = event?.action_key;
    const batch = finiteInteger(event?.batch, 0);
    if (event?.schema !== "oriai-codex-action-wal-v1"
        || typeof actionKey !== "string" || !actionKey
        || batch < 1) continue;
    keys.add(actionKey);
    const current = byKey.get(actionKey);
    if (!current
        || batch > finiteInteger(current?.batch)
        || (batch === finiteInteger(current?.batch) && event.phase === "evidenced")) {
      byKey.set(actionKey, event);
    }
  }
  for (const event of byKey.values()) {
    if (finiteInteger(event.batch) > completed) inflight.push(event);
  }
  inflight.sort((left, right) =>
    finiteInteger(left?.batch) - finiteInteger(right?.batch)
    || finiteInteger(left?.batch_step) - finiteInteger(right?.batch_step)
    || String(left?.recorded_at ?? "").localeCompare(String(right?.recorded_at ?? "")));
  return { keys, inflight, events };
}

async function runCodexDesignLoop(job, { signal = null } = {}) {
  throwIfJobCancelled(job, signal);
  const batchSize = codexBatchSizeForMode(job.designMode);
  if (batchSize == null) throw new Error(`Codex設計モードが不正です: ${job.designMode}`);
  const executionMetadata = codexExecutionMetadata(job.designMode);
  const persistedInitialFoldPath = join(job.directory, "initial.fold");
  const initialFoldPath = await access(persistedInitialFoldPath)
    .then(() => persistedInitialFoldPath)
    .catch(() => prepareCodexInitialFold(job));
  const initialFold = await readFile(initialFoldPath, "utf8").then(JSON.parse);
  const batchesDirectory = join(job.directory, "batches");
  const finalFoldPath = join(job.directory, "final.fold");
  const finalCreasePath = join(job.directory, "final-crease.png");
  const finalFoldedPath = join(job.directory, "final-folded.png");
  const checkpoint = await readJsonIfPresent(join(job.directory, "codex-checkpoint.json"));
  const persistedIterations = await readJsonIfPresent(join(job.directory, "iterations.json"));
  const recentIterationRecords = Array.isArray(checkpoint?.recent_iterations)
    ? checkpoint.recent_iterations.slice(-80)
    : Array.isArray(persistedIterations?.iterations)
      ? persistedIterations.iterations.slice(-80)
      : [];
  const persistedOperationSummary = await readJsonIfPresent(join(job.directory, "operation-summary.json"));
  const legacySummaryIsCommitted = persistedOperationSummary?.schema === "oriai-codex-unlimited-operation-summary-v1"
    && finiteInteger(job.step) >= finiteInteger(persistedOperationSummary.evaluations_completed);
  let operationSummary = checkpoint?.schema === "oriai-codex-checkpoint-v1"
    ? checkpoint.operation_summary
    : legacySummaryIsCommitted
      ? persistedOperationSummary
      : createCodexOperationSummary({ mode: job.designMode, batchSize });
  if (finiteInteger(operationSummary?.batch_size, batchSize) !== batchSize) {
    throw new Error("再開チェックポイントのCodex評価バッチ数が設計モードと一致しません");
  }
  if (operationSummary?.design_mode != null && operationSummary.design_mode !== job.designMode) {
    throw new Error("再開チェックポイントのCodex設計モードがジョブと一致しません");
  }
  operationSummary = {
    ...operationSummary,
    design_mode: job.designMode,
    batch_size: batchSize,
    execution: executionMetadata,
  };
  await synchronizeCodexCheckpointLogs(job.directory, checkpoint, { batchSize });
  const expectedActionCount = finiteInteger(operationSummary.batches_completed) * batchSize;
  const persistedActionHistory = await loadPersistedCodexActionHistory(
    job.directory,
    operationSummary.batches_completed,
    { batchSize },
  );
  let attemptedActionKeys = codexActionHistoryByJob.get(job.id);
  if (!(attemptedActionKeys instanceof Set)) attemptedActionKeys = new Set();
  for (const actionKey of persistedActionHistory.keys) attemptedActionKeys.add(actionKey);
  codexActionHistoryByJob.set(job.id, attemptedActionKeys);
  let inflightActionEvents = persistedActionHistory.inflight;
  if (attemptedActionKeys.size < expectedActionCount) {
    throw new Error("完了済みバッチの折り線操作履歴が不足しています");
  }
  if (checkpoint?.action_history_count != null) {
    const checkpointActionCount = finiteInteger(checkpoint.action_history_count, -1);
    if (checkpointActionCount < expectedActionCount
        || checkpointActionCount > attemptedActionKeys.size) {
      throw new Error("再開チェックポイントの折り線操作数が一致しません");
    }
  }
  let currentBestFoldPath = initialFoldPath;
  let currentBestCreasePath = null;
  let completedBrief = checkpoint?.schema === "oriai-codex-checkpoint-v1"
    ? checkpoint.design_brief
    : await readJsonIfPresent(join(job.directory, "design-brief.json")) ?? job.designBrief;
  if (operationSummary.batches_completed > 0) {
    const latestBatchName = String(operationSummary.batches_completed).padStart(6, "0");
    currentBestFoldPath = join(batchesDirectory, latestBatchName, "best.fold");
    currentBestCreasePath = join(batchesDirectory, latestBatchName, "best-crease.png");
    await Promise.all([access(currentBestFoldPath), access(currentBestCreasePath)]);
  }

  let batchStartingActionKeys = new Set(attemptedActionKeys);
  const loop = await runCodexBatchesUntilTarget({
    startingBestScore: finiteInteger(operationSummary.best_score, -1),
    startingIterationOffset: finiteInteger(operationSummary.evaluations_completed),
    startingBatchNumber: finiteInteger(operationSummary.batches_completed),
    startingBestStep: finiteInteger(operationSummary.best_step),
    batchSize,
    requiredTargetScore: targetScore,
    maximumBatches: 1,
    signal,
    runBatch: async ({ batchNumber, startingBestScore, iterationOffset }) => {
      throwIfJobCancelled(job, signal);
      const batchName = String(batchNumber).padStart(6, "0");
      const artifactDirectory = `batches/${batchName}`;
      const batchDirectory = join(batchesDirectory, batchName);
      const batchInitialFoldPath = join(batchDirectory, "start.fold");
      const batchBestFoldPath = join(batchDirectory, "best.fold");
      const batchBestCreasePath = join(batchDirectory, "best-crease.png");
      await mkdir(batchDirectory, { recursive: true, mode: 0o700 });
      // Seed both logical paths from the committed best. The restricted MCP
      // staging layer does the same, so a rejected first action always has a
      // real rollback target and still materializes a valid best.fold.
      await Promise.all([
        copyFileAtomically(currentBestFoldPath, batchInitialFoldPath),
        copyFileAtomically(currentBestFoldPath, batchBestFoldPath),
      ]);
      batchStartingActionKeys = new Set(attemptedActionKeys);
      const incompleteBatchAttempts = inflightActionEvents
        .filter((event) => finiteInteger(event?.batch) === batchNumber)
        .map((event) => ({
          batch_step: event.batch_step,
          action_key: event.action_key,
          arguments: event.arguments ?? null,
          evidenced: event.phase === "evidenced",
        }));
      const persistActionEvent = async (event) => {
        const record = {
          schema: "oriai-codex-action-wal-v1",
          job_id: job.id,
          batch: batchNumber,
          step: iterationOffset + finiteInteger(event?.batch_step),
          ...event,
          recorded_at: new Date().toISOString(),
        };
        await appendDurableJsonLine(join(job.directory, "action-attempts.jsonl"), record);
        attemptedActionKeys.add(record.action_key);
        const existingIndex = inflightActionEvents.findIndex((candidate) =>
          candidate.action_key === record.action_key);
        if (existingIndex < 0) inflightActionEvents.push(record);
        else if (record.phase === "evidenced") inflightActionEvents[existingIndex] = record;
      };
      job.cycle = batchNumber;
      job.bestScore = startingBestScore >= 0 ? startingBestScore : null;
      job.message = `CodexがOrieditaを操作・画像評価中（${iterationOffset}回評価済み）`;
      const runnerEvaluation = await runCodexOrieditaLoop({
        directory: batchDirectory,
        prompt: job.prompt,
        goal: job.goal,
        initialFoldPath: batchInitialFoldPath,
        finalFoldPath: batchBestFoldPath,
        finalCreasePath: batchBestCreasePath,
        referencePaths: job.referencePaths,
        referenceData: job.references,
        designBrief: completedBrief,
        maximumIterations: batchSize,
        startingBestScore,
        iterationOffset,
        targetScore,
        priorAttemptsSummary: {
          ...buildPriorAttemptsSummary(recentIterationRecords, operationSummary),
          incomplete_batch_attempts: incompleteBatchAttempts,
        },
        previousActionKeys: [...batchStartingActionKeys],
        onActionAttempt: persistActionEvent,
        onActionEvidence: persistActionEvent,
        actionWalPath: join(job.directory, "action-attempts.jsonl"),
        processLeasePath: join(job.directory, "codex-process-lease.json"),
        timeoutMs: jobTimeoutMs,
        signal,
        onProgress: (localStep) => {
          job.step = iterationOffset + localStep;
          job.message = `CodexがOrieditaを操作・画像評価中（${job.step}回評価）`;
        },
      });
      const evaluation = {
        ...runnerEvaluation,
        design_mode: job.designMode,
        execution: executionMetadata,
        search_scope: {
          stateType: executionMetadata.stateType,
          physicalScope: executionMetadata.physicalScope,
          sequentialPhysicalFolding: false,
          sequenceFeasibility: "unverified",
        },
      };
      return {
        evaluation,
        artifactDirectory,
        batchDirectory,
        batchInitialFoldPath,
        batchBestFoldPath,
        batchBestCreasePath,
      };
    },
    onBatch: async ({
      batchNumber,
      startingBestScore,
      iterationOffset,
      evaluation,
      batchOutput,
    }) => {
      await Promise.all([
        access(batchOutput.batchBestFoldPath),
        access(batchOutput.batchBestCreasePath),
      ]);
      const batchBestFold = await readFile(batchOutput.batchBestFoldPath, "utf8").then(JSON.parse);
      assertInitialCreasesPreserved(initialFold, batchBestFold);
      const batchActionKeys = assertNovelCodexActionKeys(evaluation?.operation_counts?.action_keys, {
        previousActionKeys: batchStartingActionKeys,
        expectedCount: batchSize,
      });
      for (const actionKey of batchActionKeys) attemptedActionKeys.add(actionKey);
      inflightActionEvents = inflightActionEvents.filter((event) =>
        finiteInteger(event?.batch) > batchNumber);
      let runningBestScore = startingBestScore;
      const operationIterations = Array.isArray(evaluation.operation_counts?.iterations)
        ? evaluation.operation_counts.iterations
        : [];
      const batchRecords = evaluation.steps.map((step, index) => {
        if (step.accepted === true && step.score > runningBestScore) runningBestScore = step.score;
        return {
          schema: "oriai-codex-oriedita-iteration-v2",
          ...step,
          step: iterationOffset + index + 1,
          batch: batchNumber,
          batch_step: step.step,
          best_score_before_batch: startingBestScore,
          best_score_after_step: Math.max(0, runningBestScore),
          operation_evidence: operationIterations[index] ?? null,
          required_operation: {
            add_line: 1,
            calculate_fold: 1,
            get_folded_figure: 1,
            rollback_when_worse: step.accepted !== true,
          },
        };
      });
      recentIterationRecords.push(...batchRecords);
      if (recentIterationRecords.length > 80) {
        recentIterationRecords.splice(0, recentIterationRecords.length - 80);
      }
      completedBrief = completeDesignBrief(completedBrief, evaluation.design_brief);
      job.designBrief = completedBrief;
      currentBestFoldPath = batchOutput.batchBestFoldPath;
      currentBestCreasePath = batchOutput.batchBestCreasePath;
      operationSummary = mergeCodexBatchOperationSummary(operationSummary, evaluation, {
        batchNumber,
        startingBestScore,
        iterationOffset,
        artifactDirectory: batchOutput.artifactDirectory,
      });
      const completedBatchRecord = operationSummary.batches.at(-1);
      job.step = operationSummary.evaluations_completed;
      job.bestScore = operationSummary.best_score;
      await Promise.all([
        writeFile(
          join(batchOutput.batchDirectory, "evaluation.json"),
          `${JSON.stringify(evaluation, null, 2)}\n`,
          { mode: 0o600 },
        ),
        writeFile(
          join(batchOutput.batchDirectory, "operation-summary.json"),
          `${JSON.stringify(evaluation.operation_counts, null, 2)}\n`,
          { mode: 0o600 },
        ),
        writeFile(
          join(batchOutput.batchDirectory, "iterations.json"),
          `${JSON.stringify(batchRecords, null, 2)}\n`,
          { mode: 0o600 },
        ),
        writeFileAtomically(
          join(job.directory, "design-brief.json"),
          `${JSON.stringify(completedBrief, null, 2)}\n`,
        ),
        writeFileAtomically(
          join(job.directory, "iterations.json"),
          `${JSON.stringify({
            schema: "oriai-codex-recent-iterations-v1",
            total_iterations: operationSummary.evaluations_completed,
            retained_iterations: recentIterationRecords.length,
            omitted_iterations: Math.max(0, operationSummary.evaluations_completed - recentIterationRecords.length),
            complete_log: "iterations.jsonl",
            iterations: recentIterationRecords,
          }, null, 2)}\n`,
        ),
        writeFileAtomically(
          join(job.directory, "operation-summary.json"),
          `${JSON.stringify(operationSummary, null, 2)}\n`,
        ),
        ...batchRecords.map((record) => writeFile(
          join(job.directory, "iterations", `${String(record.step).padStart(6, "0")}-codex-oriedita.json`),
          `${JSON.stringify(record, null, 2)}\n`,
          { mode: 0o600 },
        )),
      ]);
      await writeFileAtomically(
        join(job.directory, "codex-checkpoint.json"),
        `${JSON.stringify({
          schema: "oriai-codex-checkpoint-v1",
          operation_summary: operationSummary,
          recent_iterations: recentIterationRecords,
          design_brief: completedBrief,
          current_best_fold: batchOutput.batchBestFoldPath,
          current_best_crease: batchOutput.batchBestCreasePath,
          action_history_count: attemptedActionKeys.size,
          action_history_file: "action-history.jsonl",
          design_mode: job.designMode,
          batch_size: batchSize,
          execution: executionMetadata,
          updated_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      await Promise.all([
        appendJsonLinesOnce(join(job.directory, "iterations.jsonl"), batchRecords, "step"),
        appendJsonLinesOnce(join(job.directory, "batch-history.jsonl"), [completedBatchRecord], "batch"),
        appendJsonLinesOnce(
          join(job.directory, "action-history.jsonl"),
          batchActionKeys.map((actionKey, index) => ({
            step: iterationOffset + index + 1,
            batch: batchNumber,
            action_key: actionKey,
          })),
          "step",
        ),
      ]);
      await persistJobState(job);
    },
  });

  if (!loop.targetReached) {
    job.message = job.designMode === "codex_mcp_stepwise"
      ? `次の独立した一手評価を待機中（${loop.evaluationsCompleted}回評価済み）`
      : `次の評価バッチを待機中（${loop.evaluationsCompleted}回評価済み）`;
    return JOB_REQUEUE;
  }
  throwIfJobCancelled(job, signal);
  const lastBatchEvaluation = loop.lastBatch?.evaluation ?? await readJsonIfPresent(join(
    batchesDirectory,
    String(loop.batchesCompleted).padStart(6, "0"),
    "evaluation.json",
  ));
  if (!lastBatchEvaluation?.target_reached || finiteInteger(lastBatchEvaluation?.score, -1) < targetScore) {
    throw new Error(`Codexの実証済み評価が${targetScore}点に到達していません`);
  }
  if (!currentBestCreasePath) throw new Error("Codexの最良展開図を確認できません");

  // Canonical public artifacts do not exist until the evidenced score reaches
  // the target. A failed batch therefore cannot overwrite a previously valid
  // best version or expose a provisional result through the jobs API.
  await copyFileAtomically(currentBestFoldPath, finalFoldPath);
  const codexFinalFold = await readFile(finalFoldPath, "utf8").then(JSON.parse);
  assertInitialCreasesPreserved(initialFold, codexFinalFold);
  await orieditaRequest("/open", {
    method: "POST",
    body: JSON.stringify({ path: finalFoldPath }),
  });
  const calculation = await orieditaRequest("/fold-calculate", { method: "POST" });
  const finalViolationCount = assertSuccessfulFinalFoldCalculation(calculation, "Codexの99点最終候補");
  const state = await waitForFold(30_000);
  if (!state?.foldedFigures?.completed) throw new Error("Codexの99点最終候補をOrieditaで計算できませんでした");
  await Promise.all([
    orieditaRequest("/export", { method: "POST", body: JSON.stringify({ path: finalFoldPath }) }),
    orieditaRequest("/export", { method: "POST", body: JSON.stringify({ path: finalCreasePath }) }),
  ]);
  const foldedFigure = await orieditaRequest("/folded-figure");
  const foldedBytes = Buffer.from(foldedFigure.data, "base64");
  await writeFileAtomically(finalFoldedPath, foldedBytes);
  const cycles = recentIterationRecords.map((step) => ({
    cycle: step.step,
    step: step.step,
    batch: step.batch,
    status: step.accepted ? "accepted" : "rolled_back",
    score: step.score,
    issues: step.issues,
    action: step.action,
    summary: step.summary,
  }));
  const lastEvaluation = lastBatchEvaluation;
  const evaluation = {
    score: loop.bestScore,
    iterations: loop.evaluationsCompleted,
    batches: loop.batchesCompleted,
    stop_reason: "target_score_reached",
    summary: lastEvaluation.summary,
    issues: lastEvaluation.issues,
    mode: job.designMode === "codex_mcp_stepwise"
      ? "codex_oriedita_mcp_stepwise"
      : "codex_oriedita_mcp_loop",
    physical: {
      score: finalViolationCount > 0 ? 0 : 100,
      orieditaCompleted: true,
      scope: "oriedita_flat_fold_2d",
    },
    appearance: {
      score: loop.bestScore,
      rotationNormalized: true,
      dimensions: "2d_folded_figure_reviewed_by_codex",
    },
    foldability: {
      score: finalViolationCount > 0 ? 0 : 100,
      layerCount: "unknown",
      clearanceIsProxy: true,
    },
    evaluationLimit,
    batchSize,
    maxCycles: evaluationLimit,
    targetScore,
    bestCycle: loop.bestStep,
    cycleWindow: {
      total: loop.evaluationsCompleted,
      retained: cycles.length,
      omitted: Math.max(0, loop.evaluationsCompleted - cycles.length),
      completeLog: "iterations.jsonl",
    },
    cycles,
    steps: cycles,
    execution: executionMetadata,
    search: {
      stateType: executionMetadata.stateType,
      actionKind: "add_crease_via_oriedita_mcp",
      evaluator: "codex_visual_review",
      physicalScope: executionMetadata.physicalScope,
      sequentialPhysicalFolding: false,
      sequenceFeasibility: "unverified",
      freshContextPerEvaluation: executionMetadata.freshContextPerEvaluation,
      conversationalSessionContinued: false,
    },
  };
  await Promise.all([
    writeFileAtomically(
      join(job.directory, "final-evaluation.json"),
      `${JSON.stringify(evaluation, null, 2)}\n`,
    ),
    writeFileAtomically(
      join(job.directory, "generation-loop.json"),
      `${JSON.stringify({
        stopReason: "target_score_reached",
        targetScore,
        scheduling: {
          policy: job.designMode === "codex_mcp_stepwise"
            ? "round_robin_per_fresh_codex_evaluation"
            : "round_robin_per_codex_batch",
          batchEvaluations: batchSize,
          cancelEndpoint: "POST /jobs/{jobId}/cancel",
          restartRecovery: true,
        },
        execution: executionMetadata,
        evaluationLimit,
        bestScore: loop.bestScore,
        bestStep: loop.bestStep,
        batchesCompleted: loop.batchesCompleted,
        evaluationsCompleted: loop.evaluationsCompleted,
      }, null, 2)}\n`,
    ),
  ]);
  const [creaseBytes, foldBytes] = await Promise.all([
    readFile(finalCreasePath),
    readFile(finalFoldPath),
  ]);
  return {
    evaluation,
    knowledgeMatch: null,
    knowledgeReferences: job.knowledgeReferences,
    creaseImage: `data:image/png;base64,${creaseBytes.toString("base64")}`,
    foldedImage: `data:${foldedFigure.mimeType};base64,${foldedBytes.toString("base64")}`,
    foldFile: `data:application/json;base64,${foldBytes.toString("base64")}`,
  };
}

async function runDesignLoop(job, { signal = null } = {}) {
  if (job.designMode === "corigami_final_state_v1") return runCOrigamiFinalState(job);
  if (isCodexDesignMode(job.designMode)) return runCodexDesignLoop(job, { signal });
  if (job.knowledgeMatch || job.designMode === "regeneration") return runRegenerationLoop(job);
  return runStepDesignLoop(job);
}

async function collectOrieditaFoldResult(job) {
  const inputPath = join(job.directory, "input.fold");
  await orieditaRequest("/open", {
    method: "POST",
    body: JSON.stringify({ path: inputPath }),
  });
  await orieditaRequest("/action", {
    method: "POST",
    body: JSON.stringify({ action: "foldAction" }),
  });
  const state = await waitForFold(job.waitMs);
  const activeFile = typeof state.file === "string" ? resolve(state.file) : "";
  if (!activeFile.startsWith(`${job.directory}/`)) {
    throw new Error("送信された展開図をOrieditaで開けませんでした");
  }
  if (!state.foldedFigures?.completed) {
    throw new Error("Orieditaで折り上がりを計算できませんでした");
  }

  const finalFoldPath = join(job.directory, "final.fold");
  const finalCreasePath = join(job.directory, "final-crease.png");
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: finalFoldPath }),
  });
  await orieditaRequest("/export", {
    method: "POST",
    body: JSON.stringify({ path: finalCreasePath }),
  });
  const [document, foldedFigure, creaseBytes, foldBytes, sourceFoldBytes] = await Promise.all([
    orieditaRequest("/document"),
    orieditaRequest("/folded-figure"),
    readFile(finalCreasePath),
    readFile(finalFoldPath),
    readFile(inputPath),
  ]);

  return {
    engine: {
      name: "Oriedita",
      version: state.version,
    },
    foldability: {
      completed: true,
      lineCount: document.lineCount,
      figureCount: state.foldedFigures.count,
    },
    creaseImage: `data:image/png;base64,${creaseBytes.toString("base64")}`,
    foldedImage: `data:${foldedFigure.mimeType};base64,${foldedFigure.data}`,
    foldFile: `data:application/json;base64,${foldBytes.toString("base64")}`,
    sourceFoldFile: `data:application/json;base64,${sourceFoldBytes.toString("base64")}`,
  };
}

async function runCOrigamiFinalState(job) {
  job.message = "第1段階: Orieditaで展開図と2D折り上がりを検証中";
  await selectOrieditaFoldableAssignment(job);
  const result = await collectOrieditaFoldResult(job);
  const evaluation = {
    score: 80,
    iterations: 4,
    summary: "展開図と2D平坦折りをOrieditaで確認し、同一CP上の折角・simple fold・narrowing状態を準備しました",
    mode: "corigami_final_state_v1",
    steps: [
      { step: 1, score: 100, status: "crease_pattern_and_flat_fold_2d_checked" },
      { step: 2, score: 75, status: "fold_angle_3d_preview_prepared" },
      { step: 3, score: 75, status: "simple_fold_posture_prepared" },
      { step: 4, score: 70, status: "narrowing_detail_prepared" },
    ],
    validation: {
      phase1: "oriedita_flat_fold_2d_checked",
      phases2To4: "zero_thickness_angle_preview",
      sameCreasePatternGraph: true,
      collision: "unchecked",
      paperThickness: "unchecked",
      foldSequence: "out_of_scope",
      implementation: "corigami-inspired-clean-room",
    },
    physical: {
      score: 100,
      orieditaCompleted: true,
      scope: "oriedita_flat_fold_2d",
    },
  };
  await writeFile(
    join(job.directory, "final-evaluation.json"),
    `${JSON.stringify(evaluation, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    ...result,
    evaluation,
    knowledgeMatch: null,
    knowledgeReferences: [],
  };
}

async function executeJob(job) {
  const abortController = new AbortController();
  jobAbortControllers.set(job.id, abortController);
  job.status = "running";
  job.message = job.type === "oriedita-fold"
    ? "Orieditaで折り上がりを計算中"
    : job.designMode === "corigami_final_state_v1"
      ? "第1段階: 展開図と2D折り上がりを検証中"
    : isCodexDesignMode(job.designMode)
      ? "CodexがOrieditaを一手ずつ操作・評価中"
      : job.designMode === "crease_step_search"
      ? "折り線を一手ずつ追加し、OrieditaとGroqで評価中"
      : "Orieditaで折り上げ、Groqが評価中";
  job.startedAt ??= new Date().toISOString();
  job.completedAt = null;
  job.error = null;
  await persistJobState(job);
  let requeue = false;
  try {
    throwIfJobCancelled(job, abortController.signal);
    if (job.type === "oriedita-fold") {
      const result = await collectOrieditaFoldResult(job);
      throwIfJobCancelled(job, abortController.signal);
      job.result = result;
    } else {
      const result = await runDesignLoop(job, { signal: abortController.signal });
      throwIfJobCancelled(job, abortController.signal);
      if (result === JOB_REQUEUE) {
        job.result = null;
        job.status = "queued";
        requeue = true;
      } else {
        job.result = result;
      }
    }
    if (!requeue) {
      job.status = "done";
      job.message = "完了";
    }
  } catch (error) {
    requeue = applyJobExecutionError(job, error, { signal: abortController.signal });
  } finally {
    jobAbortControllers.delete(job.id);
    if (!requeue) codexActionHistoryByJob.delete(job.id);
    job.completedAt = requeue ? null : new Date().toISOString();
    await persistJobState(job);
  }
  return requeue;
}

async function drainQueue() {
  if (isShuttingDown || activeJobId || activeJobPromise) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job || job.status === "cancelled" || job.cancelRequested) {
    if (!isShuttingDown) void drainQueue();
    return;
  }
  activeJobId = id;
  const execution = (async () => {
    try {
      return await executeJob(job);
    } catch (error) {
      job.status = "failed";
      job.message = "ジョブ状態を保存できませんでした";
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      await persistJobState(job).catch(() => {});
      return false;
    }
  })();
  activeJobPromise = execution;
  let requeue = false;
  try {
    requeue = await execution;
  } finally {
    if (activeJobPromise === execution) activeJobPromise = null;
    activeJobId = null;
  }
  if (isShuttingDown) return;
  if (requeue && !job.cancelRequested && job.status === "queued") queue.push(id);
  void drainQueue();
}

async function handle(request, response) {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin)) {
    send(response, 403, { ok: false, error: "このサイトからは接続できません" }, origin);
    return;
  }
  if (isShuttingDown) {
    response.setHeader("Connection", "close");
    send(response, 503, { ok: false, error: "APIを再起動しています" }, origin);
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const forwardedProtocol = trustProxy ? request.headers["x-forwarded-proto"] : null;
  const protocol = typeof forwardedProtocol === "string" ? forwardedProtocol.split(",", 1)[0] : "http";
  const serverUrl = `${protocol}://${request.headers.host ?? `${host}:${port}`}`;
  if (request.method === "GET" && url.pathname === "/openapi.json") {
    send(response, 200, createOpenApiDocument(serverUrl), origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    const codexService = codexServiceMetadata(designMode);
    const activeCodex = codexService.active;
    send(response, 200, {
      ok: true,
      result: {
        ready: true,
        busy: Boolean(activeJobId),
        queued: queue.length,
        maxIterations: evaluationLimit,
        evaluationLimit,
        batchIterations: activeCodex?.batchSize ?? codexBatchIterations,
        maxCycles: activeCodex ? evaluationLimit : maxCycles,
        targetScore,
        scheduling: {
          policy: designMode === "codex_mcp_stepwise"
            ? "round_robin_per_fresh_codex_evaluation"
            : "round_robin_per_codex_batch",
          batchEvaluations: activeCodex?.batchSize ?? codexBatchIterations,
          cancelEndpoint: "POST /jobs/{jobId}/cancel",
          restartRecovery: true,
        },
        designMode,
        codex: codexService,
        stepSearch: { maxSteps: maxCycles, branchFactor: stepBranchFactor, beamWidth: stepBeamWidth },
        knowledgeSearch: knowledgeSearchEnabled,
        rag: {
          mode: "generation_time_retrieval",
          origamiSearchWorks: origamiSearchCatalog?.index?.item_count ?? 0,
          structuralPatterns: knowledgePack.patternCount,
          referenceImageMaximum: 8,
          finishedWorkSubstitution: false,
        },
        evaluator: isCodexDesignMode(designMode)
          ? { provider: "codex", model: "Codex CLI", configured: true }
          : { provider: "groq", model: groqModel, configured: Boolean(groqApiKey) },
      },
    }, origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/oriedita/health") {
    const codexService = codexServiceMetadata(designMode);
    const activeCodex = codexService.active;
    send(response, 200, {
      ok: true,
      result: {
        service: "ori-ai-oriedita-api",
        apiVersion: ORIEDITA_API_VERSION,
        ready: true,
        busy: Boolean(activeJobId),
        queued: queue.length,
        authentication: apiToken ? "bearer" : "none",
        maxCycles: activeCodex ? evaluationLimit : maxCycles,
        evaluationLimit,
        batchIterations: activeCodex?.batchSize ?? codexBatchIterations,
        targetScore,
        scheduling: {
          policy: designMode === "codex_mcp_stepwise"
            ? "round_robin_per_fresh_codex_evaluation"
            : "round_robin_per_codex_batch",
          batchEvaluations: activeCodex?.batchSize ?? codexBatchIterations,
          cancelEndpoint: "POST /jobs/{jobId}/cancel",
          restartRecovery: true,
        },
        designMode,
        codex: codexService,
        stepSearch: { maxSteps: maxCycles, branchFactor: stepBranchFactor, beamWidth: stepBeamWidth },
        knowledgeSearch: knowledgeSearchEnabled,
        rag: {
          mode: "generation_time_retrieval",
          origamiSearchWorks: origamiSearchCatalog?.index?.item_count ?? 0,
          structuralPatterns: knowledgePack.patternCount,
          referenceImageMaximum: 8,
          finishedWorkSubstitution: false,
        },
        evaluator: isCodexDesignMode(designMode)
          ? { provider: "codex", model: "Codex CLI", configured: true }
          : { provider: "groq", model: groqModel, configured: Boolean(groqApiKey) },
        oriedita: await inspectOriedita(),
      },
    }, origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/oriedita/fold") {
    requireApiAccess(request);
    let input;
    try {
      input = validateFoldRequest(await readJson(request));
    } catch (error) {
      if (error instanceof ApiInputError) throw new HttpError(error.status, error.message);
      throw error;
    }
    consumeSubmissionQuota(request);
    const job = await createOrieditaFoldJob(input);
    send(response, 202, { ok: true, job: publicJob(job) }, origin);
    return;
  }
  const orieditaJobMatch = url.pathname.match(/^\/v1\/oriedita\/jobs\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && orieditaJobMatch) {
    requireApiAccess(request);
    const job = jobs.get(orieditaJobMatch[1]);
    if (!job || job.type !== "oriedita-fold") throw new HttpError(404, "ジョブが見つかりません");
    send(response, 200, { ok: true, job: publicJob(job) }, origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/jobs") {
    const input = validateJobInput(await readJson(request));
    consumeSubmissionQuota(request);
    const job = await createJob(input);
    send(response, 202, { ok: true, job: publicJob(job) }, origin);
    return;
  }
  const cancelMatch = url.pathname.match(/^\/jobs\/([0-9a-f-]+)\/cancel$/i);
  if (request.method === "POST" && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job || job.type !== "design") throw new HttpError(404, "ジョブが見つかりません");
    await cancelJob(job);
    send(response, job.status === "cancelled" ? 200 : 202, { ok: true, job: publicJob(job) }, origin);
    return;
  }
  const match = url.pathname.match(/^\/jobs\/([0-9a-f-]+)$/i);
  if (request.method === "GET" && match) {
    const job = jobs.get(match[1]);
    if (!job) throw new HttpError(404, "ジョブが見つかりません");
    send(response, 200, { ok: true, job: publicJob(job) }, origin);
    return;
  }
  throw new HttpError(404, "見つかりません");
}

function closeHttpServer(serverInstance) {
  if (!serverInstance?.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    serverInstance.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

export async function completeGracefulShutdown({
  serverInstance,
  abortControllers = jobAbortControllers,
  activeExecution = null,
  exitCode = null,
  exitImpl = (code) => process.exit(code),
} = {}) {
  // Calling close first stops new connections immediately. Its callback may fire
  // before the job ends, so do not exit until the active execution has settled.
  const serverCloseOutcome = closeHttpServer(serverInstance).then(
    () => ({ error: null }),
    (error) => ({ error }),
  );
  const restartError = new JobRestartError();
  for (const controller of [...abortControllers.values()]) {
    controller.abort(restartError);
  }

  let shutdownError = null;
  try {
    await activeExecution;
  } catch (error) {
    shutdownError = error;
  }
  const { error: closeError } = await serverCloseOutcome;
  shutdownError ??= closeError;
  if (shutdownError) throw shutdownError;
  if (exitCode !== null && exitCode !== undefined) exitImpl(exitCode);
}

await mkdir(workRoot, { recursive: true, mode: 0o700 });
if (process.env.ORI_AI_RESTORE_JOBS !== "0") {
  await restorePersistedJobs();
}
export const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    const status = error instanceof HttpError || error instanceof ApiInputError ? error.status : 500;
    const message = error instanceof Error ? error.message : "サーバーエラー";
    send(response, status, { ok: false, error: message }, request.headers.origin);
  });
});
server.listen(port, host, () => {
  process.stdout.write(`ORIAI local Oriedita server: http://${host}:${port}\n`);
  void drainQueue();
});

export function shutdownServer({
  exitCode = null,
  exitImpl = (code) => process.exit(code),
} = {}) {
  if (shutdownPromise) return shutdownPromise;
  isShuttingDown = true;
  shutdownPromise = completeGracefulShutdown({
    serverInstance: server,
    abortControllers: jobAbortControllers,
    activeExecution: activeJobPromise,
    exitCode,
    exitImpl,
  });
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdownServer({ exitCode: 0 }).catch((error) => {
      console.error(`APIを安全に停止できませんでした: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    });
  });
}
