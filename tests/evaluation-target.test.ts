import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatedAppearanceScore,
  hasReachedAppearanceTarget,
  TARGET_APPEARANCE_SCORE,
} from "../app/evaluation-target.ts";

test("the public result gate opens only at an evaluated appearance score of 99", () => {
  assert.equal(TARGET_APPEARANCE_SCORE, 99);
  assert.equal(hasReachedAppearanceTarget({ score: 98 }), false);
  assert.equal(hasReachedAppearanceTarget({ score: 99 }), false);
  assert.equal(hasReachedAppearanceTarget({ score: 100 }), false);
  assert.equal(hasReachedAppearanceTarget({ score: Number.NaN }), false);
  assert.equal(hasReachedAppearanceTarget({ appearance: { score: Number.NaN } }), false);
  assert.equal(hasReachedAppearanceTarget({ appearance: { score: "99" } }), false);
  assert.equal(hasReachedAppearanceTarget({
    mode: "corigami_final_state_v1",
    targetScore: 99,
    appearance: { score: 99 },
  }), false);
  assert.equal(hasReachedAppearanceTarget({
    mode: "codex_oriedita_mcp_loop",
    targetScore: 98,
    appearance: { score: 99 },
  }), false);
  assert.equal(hasReachedAppearanceTarget(null), false);
});

test("the appearance subscore is authoritative when present", () => {
  const evidence = (appearanceScore: number, mode = "codex_oriedita_mcp_loop") => ({
    mode,
    targetScore: 99,
    score: 100,
    appearance: { score: appearanceScore },
  });
  assert.equal(evaluatedAppearanceScore(evidence(98)), 98);
  assert.equal(hasReachedAppearanceTarget(evidence(98)), false);
  assert.equal(hasReachedAppearanceTarget(evidence(99)), true);
  assert.equal(hasReachedAppearanceTarget(evidence(100)), true);
  assert.equal(hasReachedAppearanceTarget(evidence(99, "codex_oriedita_mcp_stepwise")), true);
  assert.equal(hasReachedAppearanceTarget(evidence(99, "unknown_mode")), false);
});
