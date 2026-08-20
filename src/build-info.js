/**
 * Build-Kennung, damit ein veralteter Deploy sofort sichtbar ist.
 * Steht in GET /health, im [startup]-Log und in window.__renderState.buildId.
 *
 * RENDER_GIT_COMMIT setzt Render zur Laufzeit; GIT_COMMIT kann als Docker-ARG
 * eingebrannt werden. Ohne beides bleibt "unknown" – dann gilt `id`.
 */
export const BUILD_ID = "docker-src-copy-2026-08-20";

export function getBuildInfo() {
  return {
    id: BUILD_ID,
    gitCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown",
    gitBranch: process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || "unknown",
    node: process.version,
  };
}
