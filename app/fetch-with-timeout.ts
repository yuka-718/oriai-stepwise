export class LocalizedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalizedRequestError";
  }
}

type FetchTimeoutOptions = {
  timeoutMs: number;
  timeoutMessage: string;
  abortMessage: string;
  fetchImpl?: typeof fetch;
};

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  {
    timeoutMs,
    timeoutMessage,
    abortMessage,
    fetchImpl = fetch,
  }: FetchTimeoutOptions,
) {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const abortBodyRead = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
    const bytes = await Promise.race([response.arrayBuffer(), abortBodyRead]);
    if (timedOut) throw new LocalizedRequestError(timeoutMessage);
    const statusHasNoBody = response.body === null
      || response.status === 204
      || response.status === 205
      || response.status === 304;
    return new Response(statusHasNoBody ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (timedOut) throw new LocalizedRequestError(timeoutMessage);
    if (callerSignal?.aborted || error instanceof Error && error.name === "AbortError") {
      throw new LocalizedRequestError(abortMessage);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
