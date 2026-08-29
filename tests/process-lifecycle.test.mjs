import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  observeChildProcess,
  parseOrieditaStartupTimeoutMs,
  terminateObservedChild,
} from "../local-oriedita/process-lifecycle.mjs";

function fakeChild({ pid = 42_424, exitCode = null, signalCode = null } = {}) {
  return Object.assign(new EventEmitter(), { pid, exitCode, signalCode });
}

test("Oriedita startup timeout uses a safe fallback and minimum", () => {
  assert.equal(parseOrieditaStartupTimeoutMs(undefined), 300_000);
  assert.equal(parseOrieditaStartupTimeoutMs(""), 300_000);
  assert.equal(parseOrieditaStartupTimeoutMs("not-a-timeout"), 300_000);
  assert.equal(parseOrieditaStartupTimeoutMs("1000"), 30_000);
  assert.equal(parseOrieditaStartupTimeoutMs("45000"), 45_000);
});

test("observing a ChildProcess converts spawn ENOENT into a handled terminal state", async () => {
  const missingExecutable = join(tmpdir(), `oriai-missing-java-${process.pid}-${Date.now()}`);
  const child = spawn(missingExecutable, [], { stdio: "ignore" });
  const observation = observeChildProcess(child);
  const state = await observation.waitForTermination(2_000);

  assert.equal(state?.type, "error");
  assert.equal(state?.error?.code, "ENOENT");
});

test("a signalCode is terminal even when exitCode remains null", async () => {
  const child = fakeChild({ signalCode: "SIGTERM" });
  const observation = observeChildProcess(child);
  const signals = [];
  const state = await terminateObservedChild(child, observation, {
    sendSignal: (signal) => signals.push(signal),
  });

  assert.equal(state.signalCode, "SIGTERM");
  assert.deepEqual(signals, []);
});

test("TERM completion is awaited and does not send an unnecessary KILL", async () => {
  const child = fakeChild();
  const observation = observeChildProcess(child);
  const signals = [];
  let terminationObserved = false;
  const state = await terminateObservedChild(child, observation, {
    graceMs: 100,
    killWaitMs: 100,
    sendSignal: (signal) => {
      signals.push(signal);
      queueMicrotask(() => {
        child.signalCode = signal;
        terminationObserved = true;
        child.emit("exit", null, signal);
      });
      return true;
    },
  });

  assert.equal(terminationObserved, true);
  assert.equal(state.signalCode, "SIGTERM");
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("KILL is sent only after TERM grace expires and its termination is awaited", async () => {
  const child = fakeChild();
  const observation = observeChildProcess(child);
  const signals = [];
  let killTerminationObserved = false;
  const state = await terminateObservedChild(child, observation, {
    graceMs: 10,
    killWaitMs: 100,
    sendSignal: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setTimeout(() => {
          child.signalCode = signal;
          killTerminationObserved = true;
          child.emit("close", null, signal);
        }, 5);
      }
      return true;
    },
  });

  assert.equal(killTerminationObserved, true);
  assert.equal(state.signalCode, "SIGKILL");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
