import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubmissionSignature,
  imageSubmissionIdentity,
  PENDING_SUBMISSION_STORAGE_KEY,
  readPendingSubmission,
  reuseOrCreatePendingSubmission,
  shouldDiscardPendingForImageSelection,
  writePendingSubmission,
  type PendingSubmission,
} from "../app/submission-idempotency.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

const firstKey = "11111111-1111-4111-8111-111111111111";
const secondKey = "22222222-2222-4222-8222-222222222222";

test("a pending submission survives reload and exact retries reuse its UUID", async () => {
  const storage = memoryStorage();
  const inputSignature = await createSubmissionSignature('{"prompt":"鶴"}');
  const initial = reuseOrCreatePendingSubmission({
    existing: null,
    inputSignature,
    prompt: "翼を広げた鶴",
    imageIdentity: null,
    randomUUID: () => firstKey,
    now: 123,
  });
  writePendingSubmission(storage, initial);

  const restored = readPendingSubmission(storage);
  const retried = reuseOrCreatePendingSubmission({
    existing: restored,
    inputSignature,
    prompt: "翼を広げた鶴",
    imageIdentity: null,
    randomUUID: () => secondKey,
    now: 456,
  });

  assert.deepEqual(retried, initial);
  assert.equal(retried.idempotencyKey, firstKey);
});

test("changed text, request data, or image identity gets a new UUID", () => {
  const existing: PendingSubmission = {
    idempotencyKey: firstKey,
    inputSignature: "signature-a",
    prompt: "鶴",
    imageIdentity: null,
    createdAt: 123,
  };
  const changed = [
    { inputSignature: "signature-a", prompt: "亀", imageIdentity: null },
    { inputSignature: "signature-b", prompt: "鶴", imageIdentity: null },
    { inputSignature: "signature-a", prompt: "鶴", imageIdentity: "image-a" },
  ];

  for (const input of changed) {
    const next = reuseOrCreatePendingSubmission({
      existing,
      ...input,
      randomUUID: () => secondKey,
      now: 456,
    });
    assert.equal(next.idempotencyKey, secondKey);
    assert.equal(next.createdAt, 456);
  }
});

test("storage rejects malformed keys, clears confirmed submissions, and fingerprints images", () => {
  const storage = memoryStorage();
  storage.setItem(PENDING_SUBMISSION_STORAGE_KEY, JSON.stringify({
    idempotencyKey: "not-a-uuid",
    inputSignature: "signature",
    prompt: "鶴",
    imageIdentity: null,
    createdAt: 123,
  }));
  assert.equal(readPendingSubmission(storage), null);

  const identity = imageSubmissionIdentity({
    name: "crane.png",
    type: "image/png",
    size: 42,
    lastModified: 99,
  });
  assert.equal(identity, '["crane.png","image/png",42,99]');

  writePendingSubmission(storage, null);
  assert.equal(storage.getItem(PENDING_SUBMISSION_STORAGE_KEY), null);
});

test("an invalid file selection keeps the pending key for the unchanged prior image", () => {
  const existing: PendingSubmission = {
    idempotencyKey: firstKey,
    inputSignature: "signature-a",
    prompt: "鶴",
    imageIdentity: '["crane.png","image/png",42,99]',
    createdAt: 123,
  };
  assert.equal(shouldDiscardPendingForImageSelection(existing, {
    name: "notes.txt",
    type: "text/plain",
    size: 12,
    lastModified: 100,
  }), false);
  assert.equal(shouldDiscardPendingForImageSelection(existing, {
    name: "crane.png",
    type: "image/png",
    size: 42,
    lastModified: 99,
  }), false);
  assert.equal(shouldDiscardPendingForImageSelection(existing, {
    name: "turtle.png",
    type: "image/png",
    size: 43,
    lastModified: 101,
  }), true);
});
