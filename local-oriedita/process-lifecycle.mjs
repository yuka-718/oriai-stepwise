const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const MINIMUM_STARTUP_TIMEOUT_MS = 30_000;

function finiteMilliseconds(value, fallback) {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

export function parseOrieditaStartupTimeoutMs(value, {
  fallbackMs = DEFAULT_STARTUP_TIMEOUT_MS,
  minimumMs = MINIMUM_STARTUP_TIMEOUT_MS,
} = {}) {
  const minimum = Math.max(0, finiteMilliseconds(minimumMs, MINIMUM_STARTUP_TIMEOUT_MS));
  const fallback = Math.max(minimum, finiteMilliseconds(fallbackMs, DEFAULT_STARTUP_TIMEOUT_MS));
  return Math.max(minimum, finiteMilliseconds(value, fallback));
}

function terminalStateFromChild(child) {
  if (child?.exitCode !== null && child?.exitCode !== undefined) {
    return {
      type: "exit",
      exitCode: child.exitCode,
      signalCode: child.signalCode ?? null,
      error: null,
    };
  }
  if (typeof child?.signalCode === "string" && child.signalCode) {
    return {
      type: "signal",
      exitCode: null,
      signalCode: child.signalCode,
      error: null,
    };
  }
  return null;
}

export function observeChildProcess(child) {
  if (!child || typeof child.once !== "function") {
    throw new TypeError("ChildProcess is required");
  }

  let terminalState = terminalStateFromChild(child);
  let resolveTermination;
  const termination = new Promise((resolve) => {
    resolveTermination = resolve;
  });
  const settle = (state) => {
    if (!state || terminalState) return;
    terminalState = state;
    resolveTermination(state);
  };

  child.once("error", (error) => settle({
    type: "error",
    exitCode: child.exitCode ?? null,
    signalCode: child.signalCode ?? null,
    error,
  }));
  child.once("exit", (exitCode, signalCode) => settle({
    type: "exit",
    exitCode,
    signalCode,
    error: null,
  }));
  child.once("close", (exitCode, signalCode) => settle({
    type: "close",
    exitCode,
    signalCode,
    error: null,
  }));

  if (terminalState) resolveTermination(terminalState);
  else settle(terminalStateFromChild(child));

  return {
    status() {
      return terminalState ?? terminalStateFromChild(child);
    },
    async waitForTermination(timeoutMs) {
      const current = terminalState ?? terminalStateFromChild(child);
      if (current) {
        settle(current);
        return current;
      }
      const timeout = Math.max(0, finiteMilliseconds(timeoutMs, 0));
      if (timeout === 0) return null;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeout);
        timer.unref?.();
        void termination.then(finish);
      });
    },
  };
}

export async function terminateObservedChild(child, observation, {
  graceMs = 5_000,
  killWaitMs = 5_000,
  sendSignal = (signal) => child.kill(signal),
} = {}) {
  let state = observation.status();
  if (state) return state;

  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    state = await observation.waitForTermination(graceMs);
    if (state) return state;
    throw new Error("子プロセスの起動結果を確認できませんでした");
  }

  const signal = async (name) => {
    try {
      const delivered = await sendSignal(name);
      return delivered !== false;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };

  if (!(await signal("SIGTERM"))) {
    return { type: "missing", exitCode: null, signalCode: null, error: null };
  }
  state = await observation.waitForTermination(graceMs);
  if (state) return state;

  if (!(await signal("SIGKILL"))) {
    return { type: "missing", exitCode: null, signalCode: null, error: null };
  }
  state = await observation.waitForTermination(killWaitMs);
  if (!state) throw new Error("子プロセスを停止できませんでした");
  return state;
}
