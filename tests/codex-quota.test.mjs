import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRateLimits } from "../server/codex-quota.mjs";

test("normalizes the Codex rate-limit bucket into remaining quota", () => {
  const quota = normalizeRateLimits({
    rateLimits: { limitId: "fallback", primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 24.6, windowDurationMins: 300, resetsAt: 1_735_689_600 },
        secondary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: 1_736_294_400 },
      },
    },
  });

  assert.equal(quota.available, true);
  assert.equal(quota.limitId, "codex");
  assert.equal(quota.primary.remainingPercent, 75);
  assert.equal(quota.primary.resetsAt, "2025-01-01T00:00:00.000Z");
  assert.equal(quota.secondary.remainingPercent, 40);
});

test("keeps missing rate-limit fields unavailable instead of coercing them to zero", () => {
  const quota = normalizeRateLimits({ rateLimits: { limitId: "codex", primary: {} } });
  assert.equal(quota.available, true);
  assert.equal(quota.primary.usedPercent, null);
  assert.equal(quota.primary.resetsAt, null);
});
