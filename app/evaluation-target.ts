export const TARGET_APPEARANCE_SCORE = 99;

type EvaluationLike = {
  score?: unknown;
  mode?: unknown;
  targetScore?: unknown;
  appearance?: { score?: unknown } | null;
};

export function evaluatedAppearanceScore(evaluation: EvaluationLike | null | undefined) {
  const supportedMode = evaluation?.mode === "codex_oriedita_mcp_loop"
    || evaluation?.mode === "codex_oriedita_mcp_stepwise";
  if (!supportedMode || evaluation?.targetScore !== TARGET_APPEARANCE_SCORE) return null;
  const value = evaluation?.appearance?.score;
  if (typeof value !== "number") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export function hasReachedAppearanceTarget(evaluation: EvaluationLike | null | undefined) {
  const score = evaluatedAppearanceScore(evaluation);
  return score !== null && score >= TARGET_APPEARANCE_SCORE;
}
