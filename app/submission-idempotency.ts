export const PENDING_SUBMISSION_STORAGE_KEY = "oriai-stepwise:pending-codex-submission:v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PendingSubmission = {
  idempotencyKey: string;
  inputSignature: string;
  prompt: string;
  imageIdentity: string | null;
  createdAt: number;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem" | "removeItem">;

export function imageSubmissionIdentity(file: {
  name: string;
  type: string;
  size: number;
  lastModified: number;
}) {
  return JSON.stringify([file.name, file.type, file.size, file.lastModified]);
}

export function shouldDiscardPendingForImageSelection(
  pending: PendingSubmission | null,
  file: { name: string; type: string; size: number; lastModified: number },
) {
  if (!file.type.startsWith("image/")) return false;
  return pending !== null && pending.imageIdentity !== imageSubmissionIdentity(file);
}

export async function createSubmissionSignature(requestBody: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requestBody),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readPendingSubmission(storage: StorageReader) {
  try {
    const value = JSON.parse(
      storage.getItem(PENDING_SUBMISSION_STORAGE_KEY) ?? "null",
    ) as Partial<PendingSubmission> | null;
    if (!value
      || typeof value.idempotencyKey !== "string"
      || !UUID_PATTERN.test(value.idempotencyKey)
      || typeof value.inputSignature !== "string"
      || value.inputSignature.length === 0
      || typeof value.prompt !== "string"
      || !(value.imageIdentity === null || typeof value.imageIdentity === "string")
      || typeof value.createdAt !== "number"
      || !Number.isFinite(value.createdAt)) {
      return null;
    }
    return {
      idempotencyKey: value.idempotencyKey.toLowerCase(),
      inputSignature: value.inputSignature,
      prompt: value.prompt,
      imageIdentity: value.imageIdentity,
      createdAt: value.createdAt,
    } satisfies PendingSubmission;
  } catch {
    return null;
  }
}

export function writePendingSubmission(
  storage: StorageWriter,
  submission: PendingSubmission | null,
) {
  try {
    if (submission) {
      storage.setItem(PENDING_SUBMISSION_STORAGE_KEY, JSON.stringify(submission));
    } else {
      storage.removeItem(PENDING_SUBMISSION_STORAGE_KEY);
    }
  } catch {
    // The request can still use its per-attempt key if browser storage is unavailable.
  }
}

export function reuseOrCreatePendingSubmission({
  existing,
  inputSignature,
  prompt,
  imageIdentity,
  randomUUID = () => globalThis.crypto.randomUUID(),
  now = Date.now(),
}: {
  existing: PendingSubmission | null;
  inputSignature: string;
  prompt: string;
  imageIdentity: string | null;
  randomUUID?: () => string;
  now?: number;
}) {
  if (existing
    && existing.inputSignature === inputSignature
    && existing.prompt === prompt
    && existing.imageIdentity === imageIdentity) {
    return existing;
  }

  const idempotencyKey = randomUUID().toLowerCase();
  if (!UUID_PATTERN.test(idempotencyKey)) {
    throw new Error("生成リクエスト識別子を作成できませんでした");
  }
  return {
    idempotencyKey,
    inputSignature,
    prompt,
    imageIdentity,
    createdAt: now,
  } satisfies PendingSubmission;
}
