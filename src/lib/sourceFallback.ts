export type SourceKind = "primary" | "configured" | "public" | "custom";

export type SourceHealth = {
  degraded: boolean;
  healthy: boolean;
  ready?: boolean;
  fatal?: boolean;
  score?: number;
  reason?: string;
};

export type CandidateSource = {
  id: string;
  label: string;
  kind: Exclude<SourceKind, "custom">;
  index?: number;
  enabled: boolean;
  preferred?: boolean;
  tone?: "green" | "yellow" | "red";
  viewerCount?: number;
  lastFailureAtMs?: number | null;
  failureCount?: number;
  cooldownUntilMs?: number | null;
};

export type FallbackState = {
  mode: SourceKind;
  publicIndex: number;
  configuredId: string | null;
  nowMs: number;
  lastSwitchAtMs: number;
  primaryBadSinceMs: number | null;
  activeBadSinceMs: number | null;
  primaryRecoveredSinceMs: number | null;
};

export type FallbackPolicy = {
  switchDelayMs: number;
  returnDelayMs: number;
  switchCooldownMs: number;
  sourceCooldownMs: number;
};

export type FallbackDecision =
  | {
      action: "stay";
      reason: string;
      statePatch?: Partial<Pick<FallbackState, "primaryBadSinceMs" | "activeBadSinceMs" | "primaryRecoveredSinceMs">>;
    }
  | {
      action: "primary";
      reason: string;
      failedSourceId?: string;
      statePatch?: Partial<Pick<FallbackState, "primaryBadSinceMs" | "activeBadSinceMs" | "primaryRecoveredSinceMs">>;
    }
  | {
      action: "configured";
      id: string;
      reason: string;
      failedSourceId?: string;
      statePatch?: Partial<Pick<FallbackState, "primaryBadSinceMs" | "activeBadSinceMs" | "primaryRecoveredSinceMs">>;
    }
  | {
      action: "public";
      index: number;
      reason: string;
      failedSourceId?: string;
      statePatch?: Partial<Pick<FallbackState, "primaryBadSinceMs" | "activeBadSinceMs" | "primaryRecoveredSinceMs">>;
    };

const tonePenalty = {
  green: 0,
  yellow: 140,
  red: 900
} as const;

export function isCoolingDown(source: CandidateSource, nowMs: number) {
  return Boolean(source.cooldownUntilMs && source.cooldownUntilMs > nowMs);
}

export function fallbackSourceId(mode: SourceKind, publicIndex: number, configuredId: string | null) {
  if (mode === "primary") return "server-1";
  if (mode === "configured") return configuredId ?? "configured";
  if (mode === "public") return `public-${publicIndex}`;
  return "custom";
}

export function scoreCandidate(source: CandidateSource, nowMs: number, activeId: string | null) {
  if (!source.enabled || source.tone === "red") return Number.POSITIVE_INFINITY;
  const failures = Math.max(0, source.failureCount ?? 0);
  const failurePenalty = Math.min(450, failures * 90);
  const cooldownPenalty = isCoolingDown(source, nowMs) ? 1_200 : 0;
  const activePenalty = activeId && source.id === activeId ? 700 : 0;
  const viewerBonus = Math.min(90, Math.max(0, source.viewerCount ?? 0) * 4);
  const ageBonus = source.lastFailureAtMs ? Math.min(80, Math.max(0, nowMs - source.lastFailureAtMs) / 1000) : 80;
  return (tonePenalty[source.tone ?? "yellow"] ?? 140) + failurePenalty + cooldownPenalty + activePenalty - viewerBonus - ageBonus;
}

export function rankCandidates(sources: readonly CandidateSource[], nowMs: number, activeId: string | null) {
  return sources
    .filter((source) => source.enabled && !source.preferred && source.tone !== "red")
    .map((source) => ({ source, score: scoreCandidate(source, nowMs, activeId) }))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      return (left.source.index ?? 0) - (right.source.index ?? 0);
    })
    .map((entry) => entry.source);
}

function pickBest(
  sources: readonly CandidateSource[],
  nowMs: number,
  activeId: string | null,
  allowCoolingDown = false
) {
  const ranked = rankCandidates(sources, nowMs, activeId).filter((source) => allowCoolingDown || source.id !== activeId);
  return ranked.find((source) => allowCoolingDown || !isCoolingDown(source, nowMs)) ?? null;
}

function activeCandidateId(state: FallbackState) {
  if (state.mode === "configured") return state.configuredId;
  if (state.mode === "public") return `public-${state.publicIndex}`;
  if (state.mode === "primary") return "server-1";
  return "custom";
}

function activeFailedSourceId(state: FallbackState) {
  if (state.mode === "configured") return state.configuredId ?? undefined;
  if (state.mode === "public") return `public-${state.publicIndex}`;
  if (state.mode === "primary") return "server-1";
  return "custom";
}

function shouldWaitForSwitch(state: FallbackState, policy: FallbackPolicy) {
  return state.nowMs - state.lastSwitchAtMs < policy.switchCooldownMs;
}

function badLongEnough(sinceMs: number | null, nowMs: number, policy: FallbackPolicy) {
  return Boolean(sinceMs && nowMs - sinceMs >= policy.switchDelayMs);
}

function recoveredLongEnough(sinceMs: number | null, nowMs: number, policy: FallbackPolicy) {
  return Boolean(sinceMs && nowMs - sinceMs >= policy.returnDelayMs);
}

export function decideAutoFallback(
  state: FallbackState,
  primary: SourceHealth,
  active: SourceHealth,
  configured: readonly CandidateSource[],
  publicSources: readonly CandidateSource[],
  policy: FallbackPolicy
): FallbackDecision {
  const activeId = activeCandidateId(state);
  const configuredChoice = () => pickBest(configured, state.nowMs, activeId);
  const publicChoice = () => pickBest(publicSources, state.nowMs, activeId);

  if (shouldWaitForSwitch(state, policy)) {
    return { action: "stay", reason: "switch cooldown active" };
  }

  if (state.mode === "primary") {
    if (!primary.degraded) {
      return {
        action: "stay",
        reason: "primary healthy",
        statePatch: { primaryBadSinceMs: null, activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    const badSince = state.primaryBadSinceMs ?? state.nowMs;
    if (!badLongEnough(badSince, state.nowMs, policy)) {
      return {
        action: "stay",
        reason: "primary degradation warming up",
        statePatch: { primaryBadSinceMs: badSince, primaryRecoveredSinceMs: null }
      };
    }

    const nextConfigured = configuredChoice();
    if (nextConfigured) {
      return {
        action: "configured",
        id: nextConfigured.id,
        reason: `Primary failed, switching to ${nextConfigured.label}`,
        failedSourceId: "server-1",
        statePatch: { primaryBadSinceMs: null, activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    const nextPublic = publicChoice();
    if (nextPublic && nextPublic.index !== undefined) {
      return {
        action: "public",
        index: nextPublic.index,
        reason: `Primary failed, switching to ${nextPublic.label}`,
        failedSourceId: "server-1",
        statePatch: { primaryBadSinceMs: null, activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    return { action: "stay", reason: "primary failed but no fallback is eligible" };
  }

  if (active.degraded) {
    const badSince = state.activeBadSinceMs ?? state.nowMs;
    if (!badLongEnough(badSince, state.nowMs, policy)) {
      return {
        action: "stay",
        reason: "active source degradation warming up",
        statePatch: { activeBadSinceMs: badSince, primaryRecoveredSinceMs: null }
      };
    }

    const failedSourceId = activeFailedSourceId(state);

    if (state.mode === "public") {
      const nextPublic = publicChoice();
      if (nextPublic && nextPublic.index !== undefined) {
        return {
          action: "public",
          index: nextPublic.index,
          reason: `${nextPublic.label} selected after public source failure`,
          failedSourceId,
          statePatch: { activeBadSinceMs: null, primaryRecoveredSinceMs: null }
        };
      }
    }

    const nextConfigured = configuredChoice();
    if (nextConfigured) {
      return {
        action: "configured",
        id: nextConfigured.id,
        reason: `Active source failed, switching to ${nextConfigured.label}`,
        failedSourceId,
        statePatch: { activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    const nextPublic = publicChoice();
    if (nextPublic && nextPublic.index !== undefined) {
      return {
        action: "public",
        index: nextPublic.index,
        reason: `Active source failed, switching to ${nextPublic.label}`,
        failedSourceId,
        statePatch: { activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    if (primary.healthy || (configured.length === 0 && publicSources.length === 0)) {
      return {
        action: "primary",
        reason: "Fallback failed, returning to Server 1",
        failedSourceId,
        statePatch: { primaryBadSinceMs: null, activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    const breakGlassConfigured = pickBest(configured, state.nowMs, activeId, true);
    if (breakGlassConfigured) {
      return {
        action: "configured",
        id: breakGlassConfigured.id,
        reason: `All clean fallbacks failed, retrying ${breakGlassConfigured.label}`,
        failedSourceId,
        statePatch: { activeBadSinceMs: null, primaryRecoveredSinceMs: null }
      };
    }

    return { action: "stay", reason: "active source failed but all fallbacks are cooling down" };
  }

  if (!primary.healthy || state.mode === "custom") {
    return {
      action: "stay",
      reason: primary.healthy ? "custom source healthy" : "primary not stable enough to return",
      statePatch: { activeBadSinceMs: null, primaryRecoveredSinceMs: null }
    };
  }

  const recoveredSince = state.primaryRecoveredSinceMs ?? state.nowMs;
  if (!recoveredLongEnough(recoveredSince, state.nowMs, policy)) {
    return {
      action: "stay",
      reason: "primary recovery warming up",
      statePatch: { activeBadSinceMs: null, primaryRecoveredSinceMs: recoveredSince }
    };
  }

  return {
    action: "primary",
    reason: "Server 1 recovered",
    statePatch: { primaryBadSinceMs: null, activeBadSinceMs: null, primaryRecoveredSinceMs: null }
  };
}

export function nextFailureRecord(
  previous: { failureCount?: number; lastFailureAtMs?: number | null; cooldownUntilMs?: number | null } | undefined,
  nowMs: number,
  sourceCooldownMs: number
) {
  const failureCount = Math.min(10, (previous?.failureCount ?? 0) + 1);
  const multiplier = Math.min(4, failureCount);
  return {
    failureCount,
    lastFailureAtMs: nowMs,
    cooldownUntilMs: nowMs + sourceCooldownMs * multiplier
  };
}
