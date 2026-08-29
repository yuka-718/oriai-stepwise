import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchWithTimeout,
  LocalizedRequestError,
} from "../app/fetch-with-timeout.ts";

function abortablePendingFetch(calls: { count: number }) {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls.count += 1;
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) rejectAbort();
      else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  }) as typeof fetch;
}

test("a timed POST is attempted once and returns the configured Japanese message", async () => {
  const calls = { count: 0 };
  await assert.rejects(
    fetchWithTimeout("https://example.test/jobs", { method: "POST" }, {
      timeoutMs: 10,
      timeoutMessage: "生成開始の応答が時間内に届きませんでした。自動再送はしていません",
      abortMessage: "生成開始の通信が中止されました",
      fetchImpl: abortablePendingFetch(calls),
    }),
    (error) => error instanceof LocalizedRequestError
      && /生成開始の応答/.test(error.message)
      && /自動再送はしていません/.test(error.message),
  );
  assert.equal(calls.count, 1);
});

test("caller aborts receive an explicit Japanese abort message", async () => {
  const calls = { count: 0 };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchWithTimeout("https://example.test/jobs", {
      method: "POST",
      signal: controller.signal,
    }, {
      timeoutMs: 30_000,
      timeoutMessage: "生成開始の応答が時間内に届きませんでした",
      abortMessage: "生成開始の通信が中止されました。自動再送はしていません",
      fetchImpl: abortablePendingFetch(calls),
    }),
    (error) => error instanceof LocalizedRequestError
      && error.message === "生成開始の通信が中止されました。自動再送はしていません",
  );
  assert.equal(calls.count, 1);
});

test("the timeout remains active when headers arrive but the response body stalls", async () => {
  const calls = { count: 0 };
  const headersOnlyFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls.count += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        const rejectAbort = () => controller.error(new DOMException("Aborted", "AbortError"));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
      },
    });
    return Promise.resolve(new Response(stream, {
      status: 202,
      headers: { "Content-Type": "application/json", "X-Test": "preserved" },
    }));
  }) as typeof fetch;

  await assert.rejects(
    fetchWithTimeout("https://example.test/jobs", { method: "POST" }, {
      timeoutMs: 10,
      timeoutMessage: "応答本文が時間内に届きませんでした",
      abortMessage: "通信が中止されました",
      fetchImpl: headersOnlyFetch,
    }),
    (error) => error instanceof LocalizedRequestError
      && error.message === "応答本文が時間内に届きませんでした",
  );
  assert.equal(calls.count, 1);
});

test("a fully buffered response preserves status, headers, and JSON for callers", async () => {
  const response = await fetchWithTimeout("https://example.test/jobs/one", undefined, {
    timeoutMs: 100,
    timeoutMessage: "timeout",
    abortMessage: "abort",
    fetchImpl: (async () => new Response('{"ok":true}', {
      status: 202,
      headers: { "Content-Type": "application/json", "X-Test": "preserved" },
    })) as typeof fetch,
  });

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-test"), "preserved");
  assert.deepEqual(await response.json(), { ok: true });
});
