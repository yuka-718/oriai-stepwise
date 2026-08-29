import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

process.env.ORI_AI_LOCAL_HOST = "127.0.0.1";
process.env.ORI_AI_LOCAL_PORT = "0";
process.env.ORI_AI_RESTORE_JOBS = "0";
// A legacy environment override must not change the public new-job default.
process.env.ORI_AI_DESIGN_MODE = "regeneration";

const {
  assertSuccessfulFinalFoldCalculation,
  assertCodexBatchTransition,
  appendDurableJsonLine,
  cancelJob,
  codexBatchSizeForMode,
  codexExecutionMetadata,
  codexProcessLeaseMatches,
  codexServiceMetadata,
  createCodexOperationSummary,
  createJobAdmissionGate,
  fingerprintDesignRequest,
  isCodexDesignMode,
  loadCommittedCodexActionKeys,
  loadPersistedCodexActionHistory,
  mergeCodexBatchOperationSummary,
  persistJobState,
  publicJob,
  restorePersistedJobs,
  resolveDesignModeSelection,
  runIdempotentJobCreation,
  runCodexBatchesUntilTarget,
  runOrieditaModifiabilitySmokeTest,
  searchedStructuralPatternCount,
  server,
  terminateStaleCodexProcessLease,
  validateIdempotencyKey,
} = await import("../local-oriedita/server.mjs?server-robustness-test");

if (!server.listening) await once(server, "listening");

after(async () => {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("image-only and reference-less jobs do not report a 5000-pattern text search", () => {
  assert.equal(searchedStructuralPatternCount(""), 0);
  assert.equal(searchedStructuralPatternCount("   "), 0);
  assert.equal(searchedStructuralPatternCount(null), 0);
  assert.equal(searchedStructuralPatternCount("鶴"), 5_000);
});

test("concurrent job creation reserves one active slot and at most three waiting slots", async () => {
  const queued = [];
  let active = false;
  let releaseCreations;
  const creationBarrier = new Promise((resolve) => {
    releaseCreations = resolve;
  });
  const gate = createJobAdmissionGate({
    queueList: queued,
    isActive: () => active,
    maxWaitingJobs: 3,
  });

  const submissions = Array.from({ length: 12 }, (_, index) => gate.run(async () => {
    await creationBarrier;
    queued.push(index);
    if (!active) {
      active = true;
      queued.shift();
    }
    return index;
  }));

  assert.equal(gate.reservations, 4);
  releaseCreations();
  const results = await Promise.allSettled(submissions);
  const accepted = results.filter(({ status }) => status === "fulfilled");
  const rejected = results.filter(({ status }) => status === "rejected");
  assert.equal(accepted.length, 4);
  assert.equal(rejected.length, 8);
  assert.equal(queued.length, 3);
  assert.equal(gate.reservations, 0);
  assert.ok(rejected.every(({ reason }) => reason?.status === 429));
});

test("failed job creation releases its admission reservation", async () => {
  const queued = [];
  let releaseFailure;
  let releaseCreations;
  const failureBarrier = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  const creationBarrier = new Promise((resolve) => {
    releaseCreations = resolve;
  });
  const gate = createJobAdmissionGate({
    queueList: queued,
    isActive: () => true,
    maxWaitingJobs: 3,
  });

  const failed = gate.run(async () => {
    await failureBarrier;
    throw new Error("creation failed");
  });
  const first = gate.run(() => creationBarrier);
  const second = gate.run(() => creationBarrier);
  await assert.rejects(gate.run(() => creationBarrier), (error) => error?.status === 429);

  releaseFailure();
  await assert.rejects(failed, /creation failed/);
  const replacement = gate.run(() => creationBarrier);
  assert.equal(gate.reservations, 3);

  releaseCreations();
  await Promise.all([first, second, replacement]);
  assert.equal(gate.reservations, 0);
});

test("UUID idempotency keys are normalized and malformed keys are rejected", () => {
  assert.equal(validateIdempotencyKey(null), null);
  assert.equal(
    validateIdempotencyKey(" 11111111-1111-4111-8111-AAAAAAAAAAAA "),
    "11111111-1111-4111-8111-aaaaaaaaaaaa",
  );
  assert.throws(
    () => validateIdempotencyKey("not-a-uuid"),
    (error) => error?.status === 400 && /UUID/.test(error.message),
  );
});

test("design request fingerprints are stable across object ordering and include binary input", () => {
  const first = fingerprintDesignRequest({
    prompt: "鶴",
    goal: { symmetry: true, parts: ["wing", "tail"] },
    referenceImage: { mimeType: "image/png", bytes: Buffer.from("image") },
  });
  const reordered = fingerprintDesignRequest({
    referenceImage: { bytes: new Uint8Array(Buffer.from("image")), mimeType: "image/png" },
    goal: { parts: ["wing", "tail"], symmetry: true },
    prompt: "鶴",
  });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(reordered, first);
  assert.notEqual(fingerprintDesignRequest({ prompt: "亀" }), first);
});

test("concurrent submissions with one idempotency key create exactly one job", async () => {
  const gate = createJobAdmissionGate({
    queueList: [],
    isActive: () => false,
    maxWaitingJobs: 3,
  });
  const jobsMap = new Map();
  const idempotencyMap = new Map();
  const inflightMap = new Map();
  let createCount = 0;
  let quotaCount = 0;
  let releaseCreation;
  const creationBarrier = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  const options = {
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    requestFingerprint: "a".repeat(64),
    gate,
    jobsMap,
    idempotencyMap,
    inflightMap,
    beforeCreate: () => {
      quotaCount += 1;
    },
    create: async () => {
      createCount += 1;
      await creationBarrier;
      const job = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      jobsMap.set(job.id, job);
      return job;
    },
  };

  const submissions = Array.from({ length: 8 }, () => runIdempotentJobCreation(options));
  releaseCreation();
  const results = await Promise.all(submissions);

  assert.equal(createCount, 1);
  assert.equal(quotaCount, 1);
  assert.equal(gate.reservations, 0);
  assert.ok(results.every(({ job }) => job.id === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  assert.equal(results.filter(({ created }) => created).length, 1);
});

test("an in-flight idempotency key rejects a different request fingerprint", async () => {
  const gate = createJobAdmissionGate({ queueList: [], isActive: () => false });
  const jobsMap = new Map();
  const idempotencyMap = new Map();
  const inflightMap = new Map();
  let releaseCreation;
  const creationBarrier = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  const base = {
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    requestFingerprint: "a".repeat(64),
    gate,
    jobsMap,
    idempotencyMap,
    inflightMap,
    create: async () => {
      await creationBarrier;
      const job = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      jobsMap.set(job.id, job);
      return job;
    },
  };
  const original = runIdempotentJobCreation(base);
  await assert.rejects(
    runIdempotentJobCreation({ ...base, requestFingerprint: "b".repeat(64) }),
    (error) => error?.status === 409,
  );
  releaseCreation();
  assert.equal((await original).created, true);
});

test("clients without an idempotency key retain create-on-every-request behavior", async () => {
  const gate = createJobAdmissionGate({
    queueList: [],
    isActive: () => false,
    maxWaitingJobs: 3,
  });
  let createCount = 0;
  const createLegacy = () => runIdempotentJobCreation({
    idempotencyKey: null,
    gate,
    jobsMap: new Map(),
    idempotencyMap: new Map(),
    inflightMap: new Map(),
    create: async () => ({ id: `legacy-${++createCount}` }),
  });

  const first = await createLegacy();
  const second = await createLegacy();
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(createCount, 2);
  assert.notEqual(first.job.id, second.job.id);
});

test("CORS permits Idempotency-Key and the jobs endpoint rejects a malformed key", async () => {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://${address.address}:${address.port}`;
  const preflight = await fetch(`${origin}/jobs`, {
    method: "OPTIONS",
    headers: { Origin: "https://yuka-718.github.io" },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /\bIdempotency-Key\b/i);

  const malformed = await fetch(`${origin}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "not-a-uuid",
    },
    body: "{}",
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /UUID/);
});

test("the HTTP jobs endpoint returns the original job only for the same fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-http-idempotency-"));
  try {
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const key = "44444444-4444-4444-8444-444444444444";
    const directory = join(root, id);
    const fold = {
      file_spec: 1.2,
      vertices_coords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]],
      edges_assignment: ["B", "B", "B", "B", "V"],
    };
    const body = { designMode: "codex_mcp_stepwise", prompt: "鶴", fold };
    const requestFingerprint = fingerprintDesignRequest({
      prompt: "鶴",
      fold,
      candidates: [fold],
      goal: null,
      referenceImage: null,
      pipeline: null,
      designMode: "codex_mcp_stepwise",
    });
    await mkdir(directory, { recursive: true });
    await persistJobState({
      id,
      type: "design",
      directory,
      designMode: "codex_mcp_stepwise",
      idempotencyKey: key,
      requestFingerprint,
      status: "done",
      message: "完了",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      result: {},
      error: null,
      cancelRequested: false,
    });
    await restorePersistedJobs({ root, queueList: [] });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://${address.address}:${address.port}`;
    const headers = { "Content-Type": "application/json", "Idempotency-Key": key };
    const repeated = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).job.id, id);

    const conflicting = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, prompt: "亀" }),
    });
    assert.equal(conflicting.status, 409);
    assert.match((await conflicting.json()).error, /異なる生成内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the HTTP jobs endpoint only accepts default or explicit stepwise jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-http-stepwise-default-"));
  try {
    const id = "99999999-9999-4999-8999-999999999999";
    const key = "55555555-5555-4555-8555-555555555555";
    const directory = join(root, id);
    const explicitId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const explicitKey = "66666666-6666-4666-8666-666666666666";
    const explicitDirectory = join(root, explicitId);
    const fold = {
      file_spec: 1.2,
      vertices_coords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]],
      edges_assignment: ["B", "B", "B", "B", "V"],
    };
    const body = { prompt: "鶴", fold };
    const requestFingerprint = fingerprintDesignRequest({
      prompt: "鶴",
      fold,
      candidates: [fold],
      goal: null,
      referenceImage: null,
      pipeline: null,
      designMode: null,
    });
    await mkdir(directory, { recursive: true });
    await persistJobState({
      id,
      type: "design",
      directory,
      designMode: "codex_mcp_stepwise",
      idempotencyKey: key,
      requestFingerprint,
      status: "done",
      message: "完了",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      result: {},
      error: null,
      cancelRequested: false,
    });
    const explicitBody = { ...body, designMode: "codex_mcp_stepwise" };
    const explicitRequestFingerprint = fingerprintDesignRequest({
      prompt: "鶴",
      fold,
      candidates: [fold],
      goal: null,
      referenceImage: null,
      pipeline: null,
      designMode: "codex_mcp_stepwise",
    });
    await mkdir(explicitDirectory, { recursive: true });
    await persistJobState({
      id: explicitId,
      type: "design",
      directory: explicitDirectory,
      designMode: "codex_mcp_stepwise",
      idempotencyKey: explicitKey,
      requestFingerprint: explicitRequestFingerprint,
      status: "done",
      message: "完了",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      result: {},
      error: null,
      cancelRequested: false,
    });
    await restorePersistedJobs({ root, queueList: [] });

    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://${address.address}:${address.port}`;
    const legacy = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, designMode: "codex_mcp_loop" }),
    });
    assert.equal(legacy.status, 400);
    assert.match((await legacy.json()).error, /未対応の設計モード/);

    for (const pipelineBody of [
      { ...body, pipeline: "corigami_final_state_v1" },
      { ...body, designMode: "codex_mcp_stepwise", pipeline: "corigami_final_state_v1" },
    ]) {
      const response = await fetch(`${origin}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pipelineBody),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /未対応の生成パイプライン/);
    }

    const defaulted = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    assert.equal(defaulted.status, 200);
    const payload = await defaulted.json();
    assert.equal(payload.job.id, id);
    assert.equal(payload.job.progress.mode, "codex_mcp_stepwise");
    assert.equal(payload.job.progress.batchSize, 1);
    assert.equal(payload.job.progress.codexExecution.freshContextPerEvaluation, true);

    const explicit = await fetch(`${origin}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": explicitKey },
      body: JSON.stringify(explicitBody),
    });
    assert.equal(explicit.status, 200);
    const explicitPayload = await explicit.json();
    assert.equal(explicitPayload.job.id, explicitId);
    assert.equal(explicitPayload.job.progress.mode, "codex_mcp_stepwise");
    assert.equal(explicitPayload.job.progress.batchSize, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function completedCodexBatch(score, iterationOffset, target = 99, batchSize = 10) {
  return {
    score,
    best_step: iterationOffset + batchSize,
    iteration_offset: iterationOffset,
    target_score: target,
    target_reached: score >= target,
    steps: Array.from({ length: batchSize }, (_, index) => ({
      step: index + 1,
      score,
      accepted: index === batchSize - 1,
    })),
    operation_counts: {
      add_line: batchSize,
      calculate_fold: batchSize === 1 ? 1 : batchSize + 1,
      get_folded_figure: batchSize === 1 ? 1 : batchSize + 1,
      open_file: 5,
      export_file: 3,
      required_rollbacks: Math.max(0, batchSize - 1),
      completed_iterations: batchSize,
      action_keys: Array.from(
        { length: batchSize },
        (_, index) => `MOUNTAIN:${iterationOffset + index}:0:${iterationOffset + index}:1`,
      ),
    },
  };
}

test("new design jobs default to isolated one-step mode and reject explicit legacy loop requests", () => {
  const defaultSelection = resolveDesignModeSelection({ defaultMode: "codex_mcp_loop" });
  assert.deepEqual(defaultSelection, {
    mode: "codex_mcp_stepwise",
    batchSize: 1,
    unlimitedCodexMode: true,
  });
  assert.deepEqual(resolveDesignModeSelection(), defaultSelection);
  assert.deepEqual(resolveDesignModeSelection({ defaultMode: "regeneration" }), defaultSelection);
  assert.deepEqual(resolveDesignModeSelection({ defaultMode: "crease_step_search" }), defaultSelection);
  assert.deepEqual(resolveDesignModeSelection({ defaultMode: "corigami_final_state_v1" }), defaultSelection);
  const stepwise = resolveDesignModeSelection({
    defaultMode: "codex_mcp_loop",
    requestedMode: "codex_mcp_stepwise",
  });
  assert.deepEqual(stepwise, {
    mode: "codex_mcp_stepwise",
    batchSize: 1,
    unlimitedCodexMode: true,
  });
  assert.equal(isCodexDesignMode(stepwise.mode), true);
  // Internal recognition remains for persisted legacy-job recovery only.
  assert.equal(isCodexDesignMode("codex_mcp_loop"), true);
  assert.equal(codexBatchSizeForMode("codex_mcp_loop"), 10);
  assert.equal(codexBatchSizeForMode("codex_mcp_stepwise"), 1);
  assert.throws(
    () => resolveDesignModeSelection({ requestedMode: "codex_mcp_loop" }),
    (error) => error?.status === 400,
  );
  assert.throws(
    () => resolveDesignModeSelection({ requestedMode: "untrusted_mode" }),
    (error) => error?.status === 400,
  );
  assert.throws(
    () => resolveDesignModeSelection({ pipeline: "corigami_final_state_v1" }),
    (error) => error?.status === 400 && /生成パイプライン/.test(error.message),
  );
  assert.throws(
    () => resolveDesignModeSelection({
      requestedMode: "codex_mcp_stepwise",
      pipeline: "corigami_final_state_v1",
    }),
    (error) => error?.status === 400 && /生成パイプライン/.test(error.message),
  );
});

test("stepwise Codex metadata truthfully declares fresh context and cumulative 2D CP scope", () => {
  const stepwise = codexExecutionMetadata("codex_mcp_stepwise");
  assert.equal(stepwise.batchSize, 1);
  assert.equal(stepwise.evaluationsPerCodexProcess, 1);
  assert.equal(stepwise.freshContextPerEvaluation, true);
  assert.equal(stepwise.conversationalSessionContinued, false);
  assert.equal(stepwise.stateType, "cumulative_crease_pattern_prefix");
  assert.equal(stepwise.physicalScope, "oriedita_flat_fold_2d");
  assert.equal(stepwise.sequentialPhysicalFolding, false);
  assert.deepEqual(stepwise.carriedState, [
    "explicit_job_facts",
    "current_best_fold",
    "current_best_score",
    "deduplicated_action_keys",
  ]);

  const legacy = codexExecutionMetadata("codex_mcp_loop");
  assert.equal(legacy.batchSize, 10);
  assert.equal(legacy.freshContextPerEvaluation, false);
  const service = codexServiceMetadata("codex_mcp_loop");
  assert.deepEqual(service.supportedModes, ["codex_mcp_stepwise"]);
  assert.equal(service.defaultMode, "codex_mcp_stepwise");
  assert.deepEqual(Object.keys(service.modes), ["codex_mcp_stepwise"]);
  assert.equal(service.active.batchSize, 1);
  assert.equal(service.modes.codex_mcp_stepwise.batchSize, 1);
  const stepwiseService = codexServiceMetadata("codex_mcp_stepwise");
  assert.equal(stepwiseService.active.batchSize, 1);
  assert.equal(stepwiseService.active.freshContextPerEvaluation, true);

  const serialized = publicJob({
    id: "11111111-1111-4111-8111-111111111111",
    type: "design",
    designMode: "codex_mcp_stepwise",
    status: "queued",
    message: "処理待ち",
    cycle: 0,
    step: 0,
    maxCycles: null,
    maxSteps: null,
  });
  assert.equal(serialized.progress.batchSize, 1);
  assert.equal(serialized.progress.codexExecution.freshContextPerEvaluation, true);
  assert.equal(serialized.progress.codexExecution.sequentialPhysicalFolding, false);
});

test("stepwise Codex scheduling completes exactly one evidenced action per batch", async () => {
  const observed = [];
  const result = await runCodexBatchesUntilTarget({
    batchSize: 1,
    maximumBatches: 1,
    runBatch: async ({ batchNumber, startingBestScore, iterationOffset }) => {
      observed.push({ batchNumber, startingBestScore, iterationOffset });
      return completedCodexBatch(80, iterationOffset, 99, 1);
    },
  });
  assert.deepEqual(observed, [{ batchNumber: 1, startingBestScore: -1, iterationOffset: 0 }]);
  assert.equal(result.batchesRun, 1);
  assert.equal(result.evaluationsCompleted, 1);
  assert.equal(result.targetReached, false);

  const summary = createCodexOperationSummary({ mode: "codex_mcp_stepwise" });
  assert.equal(summary.batch_size, 1);
  assert.equal(summary.execution.freshContextPerEvaluation, true);
});

test("Codex jobs have no evaluation-count limit and continue in ten-operation batches until 99", async () => {
  const scores = [42, 81, 98, 98, 99];
  const observed = [];
  const result = await runCodexBatchesUntilTarget({
    runBatch: async ({ batchNumber, startingBestScore, iterationOffset }) => {
      observed.push({ batchNumber, startingBestScore, iterationOffset });
      return completedCodexBatch(scores[batchNumber - 1], iterationOffset);
    },
  });

  assert.deepEqual(observed, [
    { batchNumber: 1, startingBestScore: -1, iterationOffset: 0 },
    { batchNumber: 2, startingBestScore: 42, iterationOffset: 10 },
    { batchNumber: 3, startingBestScore: 81, iterationOffset: 20 },
    { batchNumber: 4, startingBestScore: 98, iterationOffset: 30 },
    { batchNumber: 5, startingBestScore: 98, iterationOffset: 40 },
  ]);
  assert.equal(result.bestScore, 99);
  assert.equal(result.batchesCompleted, 5);
  assert.equal(result.evaluationsCompleted, 50);
});

test("Codex scheduling yields after one complete batch and resumes with persisted offsets", async () => {
  const observed = [];
  const result = await runCodexBatchesUntilTarget({
    startingBestScore: 81,
    startingIterationOffset: 20,
    startingBatchNumber: 2,
    startingBestStep: 17,
    maximumBatches: 1,
    runBatch: async ({ batchNumber, startingBestScore, iterationOffset }) => {
      observed.push({ batchNumber, startingBestScore, iterationOffset });
      return completedCodexBatch(90, iterationOffset);
    },
  });

  assert.deepEqual(observed, [{ batchNumber: 3, startingBestScore: 81, iterationOffset: 20 }]);
  assert.equal(result.targetReached, false);
  assert.equal(result.batchesRun, 1);
  assert.equal(result.batchesCompleted, 3);
  assert.equal(result.evaluationsCompleted, 30);
});

test("an aborted Codex batch loop does not start another evaluation", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    runCodexBatchesUntilTarget({
      signal: controller.signal,
      runBatch: async () => {
        called = true;
        return completedCodexBatch(99, 0);
      },
    }),
    (error) => error?.name === "JobCancelledError",
  );
  assert.equal(called, false);
});

test("queued and running jobs can be cancelled and cancellation survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-job-recovery-"));
  try {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const directory = join(root, id);
    await mkdir(directory, { recursive: true });
    const job = {
      id,
      type: "design",
      directory,
      designMode: "codex_mcp_loop",
      status: "queued",
      message: "処理待ち",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      cancelRequested: false,
    };
    const queued = [id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    await persistJobState(job);
    await cancelJob(job, { queueList: queued, abortController: null });
    assert.equal(job.status, "cancelled");
    assert.deepEqual(queued, ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);

    const saved = JSON.parse(await readFile(join(directory, "job-state.json"), "utf8"));
    assert.equal(saved.job.cancelRequested, true);
    assert.equal(saved.job.status, "cancelled");

    job.status = "running";
    job.cancelRequested = false;
    job.completedAt = null;
    const controller = new AbortController();
    await cancelJob(job, { queueList: [], abortController: controller });
    assert.equal(controller.signal.aborted, true);
    assert.equal(job.status, "running");
    assert.equal(job.cancelRequested, true);

    const restoredJobs = new Map();
    const restoredQueue = [];
    await restorePersistedJobs({ root, jobsMap: restoredJobs, queueList: restoredQueue });
    assert.equal(restoredJobs.get(id).status, "cancelled");
    assert.deepEqual(restoredQueue, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("running persisted jobs are requeued after an API restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-job-recovery-"));
  try {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const directory = join(root, id);
    await mkdir(directory, { recursive: true });
    await persistJobState({
      id,
      type: "design",
      directory,
      designMode: "codex_mcp_loop",
      status: "running",
      message: "実行中",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
      cancelRequested: false,
    });
    const restoredJobs = new Map();
    const restoredQueue = [];
    const restored = await restorePersistedJobs({ root, jobsMap: restoredJobs, queueList: restoredQueue });
    assert.deepEqual(restored, [id]);
    assert.equal(restoredJobs.get(id).status, "queued");
    assert.match(restoredJobs.get(id).message, /再開/);
    assert.deepEqual(restoredQueue, [id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery restores the persisted idempotency key to the original job", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-idempotency-recovery-"));
  try {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const key = "33333333-3333-4333-8333-333333333333";
    const requestFingerprint = "c".repeat(64);
    const directory = join(root, id);
    await mkdir(directory, { recursive: true });
    await persistJobState({
      id,
      type: "design",
      directory,
      designMode: "codex_mcp_stepwise",
      idempotencyKey: key,
      requestFingerprint,
      status: "done",
      message: "完了",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      result: {},
      error: null,
      cancelRequested: false,
    });
    const restoredJobs = new Map();
    const restoredQueue = [];
    const idempotencyMap = new Map();
    await restorePersistedJobs({
      root,
      jobsMap: restoredJobs,
      queueList: restoredQueue,
      idempotencyMap,
    });
    assert.deepEqual(idempotencyMap.get(key), { jobId: id, requestFingerprint });

    let created = false;
    const result = await runIdempotentJobCreation({
      idempotencyKey: key,
      requestFingerprint,
      gate: createJobAdmissionGate({ queueList: [], isActive: () => false }),
      jobsMap: restoredJobs,
      idempotencyMap,
      inflightMap: new Map(),
      create: async () => {
        created = true;
        return { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
      },
    });
    assert.equal(created, false);
    assert.equal(result.created, false);
    assert.equal(result.job.id, id);
    await assert.rejects(
      runIdempotentJobCreation({
        idempotencyKey: key,
        requestFingerprint: "d".repeat(64),
        gate: createJobAdmissionGate({ queueList: [], isActive: () => false }),
        jobsMap: restoredJobs,
        idempotencyMap,
        inflightMap: new Map(),
        create: async () => ({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      }),
      (error) => error?.status === 409,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex batch transition rejects an unverified 99 claim and incomplete Oriedita evidence", () => {
  const incomplete = completedCodexBatch(99, 10);
  incomplete.target_reached = false;
  assert.throws(
    () => assertCodexBatchTransition(incomplete, { startingBestScore: 90, iterationOffset: 10 }),
    /目標到達判定/,
  );

  const missingOperation = completedCodexBatch(98, 10);
  missingOperation.operation_counts.get_folded_figure = 9;
  assert.throws(
    () => assertCodexBatchTransition(missingOperation, { startingBestScore: 90, iterationOffset: 10 }),
    /Oriedita実操作数/,
  );
});

test("operation summary accumulates every batch without inventing an evaluation limit", () => {
  const first = completedCodexBatch(70, 0);
  const second = completedCodexBatch(99, 10);
  const initial = createCodexOperationSummary();
  const afterFirst = mergeCodexBatchOperationSummary(initial, first, {
    batchNumber: 1,
    startingBestScore: -1,
    iterationOffset: 0,
    artifactDirectory: "batches/000001",
  });
  const final = mergeCodexBatchOperationSummary(afterFirst, second, {
    batchNumber: 2,
    startingBestScore: 70,
    iterationOffset: 10,
    artifactDirectory: "batches/000002",
  });

  assert.equal(final.evaluation_limit, null);
  assert.equal(final.target_score, 99);
  assert.equal(final.batches_completed, 2);
  assert.equal(final.evaluations_completed, 20);
  assert.equal(final.best_step, 20);
  assert.equal(final.counts.add_line, 20);
  assert.equal(final.counts.calculate_fold, 22);
  assert.equal(final.counts.get_folded_figure, 22);
  assert.equal(final.counts.required_rollbacks, 18);
  assert.equal(final.target_reached, true);
  assert.deepEqual(final.batches.map(({ artifact_directory: path }) => path), [
    "batches/000001",
    "batches/000002",
  ]);

  let bounded = createCodexOperationSummary();
  for (let batchNumber = 1; batchNumber <= 100; batchNumber += 1) {
    bounded = mergeCodexBatchOperationSummary(bounded, completedCodexBatch(98, (batchNumber - 1) * 10), {
      batchNumber,
      startingBestScore: batchNumber === 1 ? -1 : 98,
      iterationOffset: (batchNumber - 1) * 10,
      artifactDirectory: `batches/${String(batchNumber).padStart(6, "0")}`,
    });
  }
  assert.equal(bounded.evaluations_completed, 1_000);
  assert.equal(bounded.batches.length, 80);
  assert.equal(bounded.omitted_batches, 20);
  assert.equal(bounded.complete_batch_log, "batch-history.jsonl");
  assert.equal(bounded.batches[0].batch, 21);
});

test("committed action history rejects a duplicate older than the retained 80 attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-action-history-"));
  try {
    const batches = join(root, "batches");
    for (let batchNumber = 1; batchNumber <= 9; batchNumber += 1) {
      const batchDirectory = join(batches, String(batchNumber).padStart(6, "0"));
      await mkdir(batchDirectory, { recursive: true });
      const evaluation = completedCodexBatch(90, (batchNumber - 1) * 10);
      await writeFile(
        join(batchDirectory, "evaluation.json"),
        JSON.stringify(evaluation),
      );
    }
    const history = await loadCommittedCodexActionKeys(root, 9);
    assert.equal(history.size, 90);

    const duplicateDirectory = join(batches, "000010");
    await mkdir(duplicateDirectory, { recursive: true });
    const duplicate = completedCodexBatch(95, 90);
    duplicate.operation_counts.action_keys[9] = "MOUNTAIN:0:0:0:1";
    await writeFile(
      join(duplicateDirectory, "evaluation.json"),
      JSON.stringify(duplicate),
    );
    await assert.rejects(
      loadCommittedCodexActionKeys(root, 10),
      /過去試行と重複/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stepwise restart history validates one action key per committed process", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-stepwise-action-history-"));
  try {
    for (let batchNumber = 1; batchNumber <= 2; batchNumber += 1) {
      const batchDirectory = join(root, "batches", String(batchNumber).padStart(6, "0"));
      await mkdir(batchDirectory, { recursive: true });
      await writeFile(
        join(batchDirectory, "evaluation.json"),
        JSON.stringify(completedCodexBatch(80 + batchNumber, batchNumber - 1, 99, 1)),
      );
    }
    const history = await loadCommittedCodexActionKeys(root, 2, { batchSize: 1 });
    assert.equal(history.size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart history combines completed and fsynced incomplete-batch action keys and repairs a torn tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-action-wal-"));
  try {
    const batchDirectory = join(root, "batches", "000001");
    await mkdir(batchDirectory, { recursive: true });
    const completed = completedCodexBatch(90, 0);
    await writeFile(join(batchDirectory, "evaluation.json"), JSON.stringify(completed));
    const inflightKey = "VALLEY:999:0:999:1000000";
    await appendDurableJsonLine(join(root, "action-attempts.jsonl"), {
      schema: "oriai-codex-action-wal-v1",
      phase: "inflight",
      batch: 2,
      batch_step: 1,
      step: 11,
      action_key: inflightKey,
      arguments: { ax: 0.000999, ay: 0, bx: 0.000999, by: 1, color: "VALLEY" },
    });
    await appendDurableJsonLine(join(root, "action-attempts.jsonl"), {
      schema: "oriai-codex-action-wal-v1",
      phase: "evidenced",
      batch: 2,
      batch_step: 1,
      step: 11,
      action_key: inflightKey,
      crease_hash_before: "before",
      crease_hash_after: "after",
    });
    await writeFile(join(root, "action-attempts.jsonl"), "{incomplete-tail", { flag: "a" });

    const history = await loadPersistedCodexActionHistory(root, 1);
    assert.equal(history.keys.size, 11);
    assert.equal(history.keys.has(completed.operation_counts.action_keys[0]), true);
    assert.equal(history.keys.has(inflightKey), true);
    assert.equal(history.inflight.length, 1);
    assert.equal(history.inflight[0].phase, "evidenced");
    assert.equal(history.inflight[0].batch, 2);
    const repairedWal = await readFile(join(root, "action-attempts.jsonl"), "utf8");
    assert.equal(repairedWal.endsWith("\n"), true);
    assert.equal(repairedWal.includes("{incomplete-tail"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable action WAL append removes a torn tail before preserving the next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-action-wal-tail-"));
  try {
    const walPath = join(root, "action-attempts.jsonl");
    const priorKeys = [
      "MOUNTAIN:101:0:101:1000000",
      "VALLEY:202:0:202:1000000",
    ];
    for (const [index, actionKey] of priorKeys.entries()) {
      await appendDurableJsonLine(walPath, {
        schema: "oriai-codex-action-wal-v1",
        phase: "evidenced",
        batch: 1,
        batch_step: index + 1,
        step: index + 1,
        action_key: actionKey,
      });
    }
    await writeFile(walPath, '{"schema":"oriai-codex-action-wal-v1","phase":"inflight"', { flag: "a" });

    const nextKey = "MOUNTAIN:303:0:303:1000000";
    await appendDurableJsonLine(walPath, {
      schema: "oriai-codex-action-wal-v1",
      phase: "inflight",
      batch: 2,
      batch_step: 1,
      step: 3,
      action_key: nextKey,
    });

    const reloaded = await loadPersistedCodexActionHistory(root, 0);
    assert.deepEqual(reloaded.events.map((event) => event.action_key), [...priorKeys, nextKey]);
    assert.deepEqual([...reloaded.keys], [...priorKeys, nextKey]);
    const persistedLines = (await readFile(walPath, "utf8")).trimEnd().split("\n");
    assert.equal(persistedLines.length, 3);
    assert.deepEqual(persistedLines.map((line) => JSON.parse(line).action_key), [...priorKeys, nextKey]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable action WAL append preserves a complete final record that only lacks a newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-action-wal-newline-"));
  try {
    const walPath = join(root, "action-attempts.jsonl");
    const first = {
      schema: "oriai-codex-action-wal-v1",
      phase: "inflight",
      batch: 1,
      batch_step: 1,
      step: 1,
      action_key: "VALLEY:404:0:404:1000000",
    };
    const second = {
      schema: "oriai-codex-action-wal-v1",
      phase: "inflight",
      batch: 1,
      batch_step: 2,
      step: 2,
      action_key: "MOUNTAIN:505:0:505:1000000",
    };
    await writeFile(walPath, JSON.stringify(first));
    await appendDurableJsonLine(walPath, second);

    const reloaded = await loadPersistedCodexActionHistory(root, 0);
    assert.deepEqual(reloaded.events.map((event) => event.action_key), [first.action_key, second.action_key]);
    const persistedLines = (await readFile(walPath, "utf8")).trimEnd().split("\n");
    assert.deepEqual(persistedLines.map((line) => JSON.parse(line)), [first, second]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart terminates only a matching stale Codex process group before requeue", async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-process-lease-"));
  try {
    const job = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", directory: root };
    const batchDirectory = join(root, "batches", "000002");
    const lease = {
      schema: "oriai-codex-process-lease-v1",
      lease_id: "lease-1",
      pid: 43210,
      process_group: process.platform === "win32" ? 43210 : -43210,
      codex_path: "/opt/bin/codex",
      directory: batchDirectory,
    };
    await writeFile(join(root, "codex-process-lease.json"), JSON.stringify(lease));
    const command = `/opt/bin/codex exec --cd ${batchDirectory}`;
    assert.equal(codexProcessLeaseMatches(lease, job, command), true);

    let alive = true;
    const signals = [];
    const result = await terminateStaleCodexProcessLease(job, {
      isAlive: (target) => {
        assert.equal(target, lease.process_group);
        return alive;
      },
      inspectCommand: () => command,
      inspectProcessGroup: (target) => {
        assert.equal(target, lease.process_group);
        return [{
          pid: lease.pid,
          process_group: lease.process_group,
          command,
          cwd: batchDirectory,
        }];
      },
      sendSignal: (target, signal) => {
        signals.push({ target, signal });
        alive = false;
      },
      wait: async () => {},
      graceMs: 1,
      pollMs: 1,
    });
    assert.deepEqual(result, { found: true, terminated: true });
    assert.deepEqual(signals, [{
      target: process.platform === "win32" ? 43210 : -43210,
      signal: "SIGTERM",
    }]);

    await writeFile(join(root, "codex-process-lease.json"), JSON.stringify(lease));
    await assert.rejects(
      terminateStaleCodexProcessLease(job, {
        isAlive: () => true,
        inspectCommand: () => "/usr/bin/not-codex --different-job",
        inspectProcessGroup: () => [{
          pid: lease.pid,
          process_group: lease.process_group,
          command: "/usr/bin/not-codex --different-job",
          cwd: batchDirectory,
        }],
        sendSignal: () => assert.fail("a reused PID must not be killed"),
      }),
      /一致しない/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart terminates a live leased process group after its Codex leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-orphaned-process-group-"));
  try {
    const job = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", directory: root };
    const batchDirectory = join(root, "batches", "000003");
    const lease = {
      schema: "oriai-codex-process-lease-v1",
      lease_id: "lease-orphan",
      pid: 43220,
      process_group: -43220,
      codex_path: "/opt/bin/codex",
      directory: batchDirectory,
    };
    const leasePath = join(root, "codex-process-lease.json");
    await writeFile(leasePath, JSON.stringify(lease));

    let groupAlive = true;
    const signals = [];
    const proxyCommand = `${process.execPath} ${resolve("local-oriedita/restricted-oriedita-mcp.mjs")}`;
    const result = await terminateStaleCodexProcessLease(job, {
      isAlive: (target) => {
        assert.equal(target, lease.process_group, "liveness must probe the exact leased PGID");
        return groupAlive;
      },
      inspectCommand: () => assert.fail("the dead leader cannot provide provenance"),
      inspectProcessGroup: (target) => {
        assert.equal(target, lease.process_group);
        return [{
          pid: lease.pid + 1,
          process_group: lease.process_group,
          command: proxyCommand,
          cwd: batchDirectory,
        }];
      },
      sendSignal: (target, signal) => {
        signals.push({ target, signal });
        if (signal === "SIGKILL") groupAlive = false;
      },
      wait: async () => {},
      graceMs: 0,
      pollMs: 1,
    });

    assert.deepEqual(result, { found: true, terminated: true });
    assert.deepEqual(signals, [
      { target: lease.process_group, signal: "SIGTERM" },
      { target: lease.process_group, signal: "SIGKILL" },
    ]);
    await assert.rejects(readFile(leasePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart leaves a live unrelated process group and its forged lease untouched", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "oriai-unrelated-process-group-"));
  try {
    const job = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", directory: root };
    const batchDirectory = join(root, "batches", "000004");
    const lease = {
      schema: "oriai-codex-process-lease-v1",
      lease_id: "lease-forged",
      pid: 43230,
      process_group: -43230,
      codex_path: "/opt/bin/codex",
      directory: batchDirectory,
    };
    const leasePath = join(root, "codex-process-lease.json");
    await writeFile(leasePath, JSON.stringify(lease));
    const signals = [];

    await assert.rejects(
      terminateStaleCodexProcessLease(job, {
        isAlive: (target) => {
          assert.equal(target, lease.process_group);
          return true;
        },
        inspectCommand: () => assert.fail("the leased leader is not alive"),
        inspectProcessGroup: () => [{
          pid: lease.pid + 7,
          process_group: lease.process_group,
          command: "/usr/bin/node /tmp/unrelated-mcp.mjs",
          cwd: batchDirectory,
        }],
        sendSignal: (target, signal) => signals.push({ target, signal }),
      }),
      /一致しない/,
    );

    assert.deepEqual(signals, []);
    assert.deepEqual(JSON.parse(await readFile(leasePath, "utf8")), lease);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health advertises a 99 target and no job-level evaluation limit", async () => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.result.targetScore, 99);
  assert.equal(payload.result.evaluationLimit, null);
  assert.equal(payload.result.maxIterations, null);
  assert.equal(payload.result.batchIterations, 1);
  assert.equal(payload.result.scheduling.policy, "round_robin_per_fresh_codex_evaluation");
  assert.equal(payload.result.scheduling.restartRecovery, true);
  assert.equal(payload.result.designMode, "codex_mcp_stepwise");
  assert.deepEqual(payload.result.codex.supportedModes, ["codex_mcp_stepwise"]);
  assert.deepEqual(Object.keys(payload.result.codex.modes), ["codex_mcp_stepwise"]);
  assert.equal(payload.result.codex.active.batchSize, 1);
  assert.equal(payload.result.codex.modes.codex_mcp_stepwise.batchSize, 1);
  assert.equal(payload.result.codex.modes.codex_mcp_stepwise.freshContextPerEvaluation, true);
  assert.equal(payload.result.codex.modes.codex_mcp_stepwise.sequentialPhysicalFolding, false);
});

test("final fold calculation requires both a started calculation and zero violations", () => {
  assert.equal(assertSuccessfulFinalFoldCalculation({ started: true, violationCount: 0 }), 0);
  assert.throws(
    () => assertSuccessfulFinalFoldCalculation({ started: false, violationCount: 0 }),
    /平坦折り計算を開始できませんでした/,
  );
  assert.throws(
    () => assertSuccessfulFinalFoldCalculation({ started: true, violationCount: 2 }),
    /局所平坦折り違反が2件あります/,
  );
  for (const violationCount of [undefined, null, Number.NaN, "0", -1, 0.5]) {
    assert.throws(
      () => assertSuccessfulFinalFoldCalculation({ started: true, violationCount }),
      /違反数を確認できませんでした/,
    );
  }
});

test("modifiability smoke-test edits only a temporary copy and reloads the parent FOLD", async () => {
  const parentPath = "/tmp/job/structural-candidate-01.fold";
  const smokePath = "/tmp/job/.structural-smoke-01.fold";
  const calls = [];
  const copied = [];
  const removed = [];
  let lineAdded = false;
  const requestImpl = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body });
    if (path === "/document") {
      return {
        lines: [
          { color: "EDGE", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
          { color: "EDGE", a: { x: 1, y: 0 }, b: { x: 1, y: 1 } },
          { color: "EDGE", a: { x: 1, y: 1 }, b: { x: 0, y: 1 } },
          { color: "EDGE", a: { x: 0, y: 1 }, b: { x: 0, y: 0 } },
          ...(lineAdded ? [{ color: "MOUNTAIN", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }] : []),
        ],
      };
    }
    if (path === "/line") lineAdded = true;
    if (path === "/fold-calculate") return { started: true, violationCount: 0 };
    return { ok: true };
  };
  const result = await runOrieditaModifiabilitySmokeTest({
    parentPath,
    smokePath,
    fold: {
      vertices_coords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0]],
      edges_assignment: ["B", "B", "B", "B"],
    },
    requestImpl,
    waitImpl: async () => ({ foldedFigures: { completed: true } }),
    copyImpl: async (source, destination) => copied.push({ source, destination }),
    removeImpl: async (path, options) => removed.push({ path, options }),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.add_line_completed, true);
  assert.equal(result.calculation_started, true);
  assert.equal(result.violation_count, 0);
  assert.equal(result.oriedita_completed, true);
  assert.equal(result.parent_reloaded, true);
  assert.equal(result.temporary_copy_removed, true);
  assert.deepEqual(copied, [{ source: parentPath, destination: smokePath }]);
  assert.deepEqual(removed, [{ path: smokePath, options: { force: true } }]);
  assert.deepEqual(
    calls.filter(({ path }) => path === "/open").map(({ body }) => body.path),
    [smokePath, parentPath],
  );
  assert.equal(calls.filter(({ path }) => path === "/line").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/document").length, 2);
  assert.equal(calls.filter(({ path }) => path === "/fold-calculate").length, 1);
  assert.equal(calls.some(({ path }) => path === "/export"), false);
});

test("modifiability smoke-test rejects an Oriedita add-line no-op", async () => {
  const parentPath = "/tmp/job/structural-candidate-01.fold";
  const smokePath = "/tmp/job/.structural-smoke-01.fold";
  const calls = [];
  const document = {
    lines: [
      { color: "EDGE", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { color: "EDGE", a: { x: 1, y: 0 }, b: { x: 1, y: 1 } },
      { color: "EDGE", a: { x: 1, y: 1 }, b: { x: 0, y: 1 } },
      { color: "EDGE", a: { x: 0, y: 1 }, b: { x: 0, y: 0 } },
    ],
  };
  const result = await runOrieditaModifiabilitySmokeTest({
    parentPath,
    smokePath,
    fold: {
      vertices_coords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0]],
      edges_assignment: ["B", "B", "B", "B"],
    },
    requestImpl: async (path) => {
      calls.push(path);
      if (path === "/document") return document;
      return { ok: true };
    },
    waitImpl: async () => ({ foldedFigures: { completed: true } }),
    copyImpl: async () => {},
    removeImpl: async () => {},
  });

  assert.equal(result.status, "failed");
  assert.equal(result.add_line_completed, false);
  assert.equal(result.line_count_before, 4);
  assert.equal(result.line_count_after, 4);
  assert.match(result.reason, /追加折り線の実在を確認できませんでした/);
  assert.equal(calls.filter((path) => path === "/fold-calculate").length, 0);
  assert.equal(result.parent_reloaded, true);
  assert.equal(result.temporary_copy_removed, true);
});
