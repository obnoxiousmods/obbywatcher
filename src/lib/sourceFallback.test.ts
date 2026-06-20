import { describe, expect, it } from "vitest";
import {
  decideAutoFallback,
  nextFailureRecord,
  rankCandidates,
  type CandidateSource,
  type FallbackPolicy,
  type FallbackState,
  type SourceHealth
} from "./sourceFallback";

const policy: FallbackPolicy = {
  switchDelayMs: 10_000,
  returnDelayMs: 18_000,
  switchCooldownMs: 4_000,
  sourceCooldownMs: 30_000
};

const healthy: SourceHealth = { degraded: false, healthy: true, ready: true };
const degraded: SourceHealth = { degraded: true, healthy: false, ready: true };

function state(overrides: Partial<FallbackState> = {}): FallbackState {
  return {
    mode: "primary",
    publicIndex: 0,
    configuredId: null,
    nowMs: 50_000,
    lastSwitchAtMs: 0,
    primaryBadSinceMs: null,
    activeBadSinceMs: null,
    primaryRecoveredSinceMs: null,
    ...overrides
  };
}

function configured(overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    id: "server-2",
    label: "Server 2",
    kind: "configured",
    index: 1,
    enabled: true,
    tone: "green",
    viewerCount: 5,
    ...overrides
  };
}

function publicSource(index: number, overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    id: `public-${index}`,
    label: `Public ${index + 1}`,
    kind: "public",
    index,
    enabled: true,
    tone: "green",
    ...overrides
  };
}

describe("source fallback policy", () => {
  it("does not leave primary before degradation passes the debounce window", () => {
    const decision = decideAutoFallback(
      state({ primaryBadSinceMs: 45_000 }),
      degraded,
      degraded,
      [configured()],
      [publicSource(0)],
      policy
    );

    expect(decision).toMatchObject({
      action: "stay",
      statePatch: { primaryBadSinceMs: 45_000 }
    });
  });

  it("switches from a confirmed bad primary to the best configured fallback", () => {
    const decision = decideAutoFallback(
      state({ primaryBadSinceMs: 30_000 }),
      degraded,
      degraded,
      [configured()],
      [publicSource(0)],
      policy
    );

    expect(decision).toMatchObject({
      action: "configured",
      id: "server-2",
      failedSourceId: "server-1"
    });
  });

  it("skips configured sources in cooldown and uses the best public source", () => {
    const decision = decideAutoFallback(
      state({ primaryBadSinceMs: 30_000 }),
      degraded,
      degraded,
      [configured({ cooldownUntilMs: 90_000 })],
      [publicSource(0), publicSource(1, { tone: "yellow" })],
      policy
    );

    expect(decision).toMatchObject({
      action: "public",
      index: 0
    });
  });

  it("moves from a failed public source to the next healthy public before returning primary", () => {
    const decision = decideAutoFallback(
      state({ mode: "public", publicIndex: 0, activeBadSinceMs: 30_000 }),
      healthy,
      degraded,
      [],
      [publicSource(0), publicSource(1)],
      policy
    );

    expect(decision).toMatchObject({
      action: "public",
      index: 1,
      failedSourceId: "public-0"
    });
  });

  it("does not reselect the same failed public source as a normal fallback", () => {
    const decision = decideAutoFallback(
      state({ mode: "public", publicIndex: 0, activeBadSinceMs: 30_000 }),
      { degraded: true, healthy: false },
      degraded,
      [configured()],
      [publicSource(0)],
      policy
    );

    expect(decision).toMatchObject({
      action: "configured",
      id: "server-2",
      failedSourceId: "public-0"
    });
  });

  it("does not reselect the same failed configured source as a normal fallback", () => {
    const decision = decideAutoFallback(
      state({ mode: "configured", configuredId: "server-2", activeBadSinceMs: 30_000 }),
      { degraded: true, healthy: false },
      degraded,
      [configured()],
      [publicSource(0)],
      policy
    );

    expect(decision).toMatchObject({
      action: "public",
      index: 0,
      failedSourceId: "server-2"
    });
  });

  it("returns to Server 1 only after a stable recovery window", () => {
    const warming = decideAutoFallback(
      state({ mode: "configured", configuredId: "server-2", primaryRecoveredSinceMs: 40_000 }),
      healthy,
      healthy,
      [configured()],
      [],
      policy
    );

    const recovered = decideAutoFallback(
      state({ mode: "configured", configuredId: "server-2", primaryRecoveredSinceMs: 25_000 }),
      healthy,
      healthy,
      [configured()],
      [],
      policy
    );

    expect(warming).toMatchObject({ action: "stay" });
    expect(recovered).toMatchObject({ action: "primary", reason: "Server 1 recovered" });
  });

  it("falls back from a failed custom source without silently returning while custom is healthy", () => {
    const healthyCustom = decideAutoFallback(
      state({ mode: "custom" }),
      healthy,
      healthy,
      [configured()],
      [publicSource(0)],
      policy
    );
    const failedCustom = decideAutoFallback(
      state({ mode: "custom", activeBadSinceMs: 30_000 }),
      healthy,
      degraded,
      [configured()],
      [publicSource(0)],
      policy
    );

    expect(healthyCustom).toMatchObject({ action: "stay", reason: "custom source healthy" });
    expect(failedCustom).toMatchObject({ action: "configured", id: "server-2", failedSourceId: "custom" });
  });

  it("ranks green, low-failure, not-cooling-down sources first", () => {
    const ranked = rankCandidates(
      [
        publicSource(0, { failureCount: 4 }),
        publicSource(1, { tone: "yellow" }),
        publicSource(2, { viewerCount: 20 }),
        publicSource(3, { cooldownUntilMs: 80_000 })
      ],
      50_000,
      "public-0"
    );

    expect(ranked.map((source) => source.id)).toEqual(["public-2", "public-1", "public-0", "public-3"]);
  });

  it("records escalating source cooldowns", () => {
    const first = nextFailureRecord(undefined, 10_000, policy.sourceCooldownMs);
    const second = nextFailureRecord(first, 40_000, policy.sourceCooldownMs);

    expect(first).toEqual({ failureCount: 1, lastFailureAtMs: 10_000, cooldownUntilMs: 40_000 });
    expect(second).toEqual({ failureCount: 2, lastFailureAtMs: 40_000, cooldownUntilMs: 100_000 });
  });
});
