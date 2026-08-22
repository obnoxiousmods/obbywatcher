export type ViewerSnapshot = {
  total?: number | null;
  by_source?: Record<string, number | null | undefined> | null;
  sources?: Array<{ id: string; viewer_count?: number | null }> | null;
};

function cleanCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function viewerCountForSource(viewers: ViewerSnapshot | null | undefined, sourceId: string, fallback = 0) {
  const bySource = cleanCount(viewers?.by_source?.[sourceId]);
  if (bySource !== null) return bySource;

  const sourceEntry = viewers?.sources?.find((source) => source.id === sourceId);
  const sourceCount = cleanCount(sourceEntry?.viewer_count);
  if (sourceCount !== null) return sourceCount;

  return cleanCount(fallback) ?? 0;
}

export function totalViewerCount(viewers: ViewerSnapshot | null | undefined, fallback = 0) {
  const total = cleanCount(viewers?.total);
  if (total !== null) return total;

  const bySource = Object.values(viewers?.by_source ?? {})
    .map(cleanCount)
    .filter((count): count is number => count !== null);
  if (bySource.length > 0) return bySource.reduce((sum, count) => sum + count, 0);

  const sourceCounts = (viewers?.sources ?? [])
    .map((source) => cleanCount(source.viewer_count))
    .filter((count): count is number => count !== null);
  if (sourceCounts.length > 0) return sourceCounts.reduce((sum, count) => sum + count, 0);

  return cleanCount(fallback) ?? 0;
}

/** A single viewer heartbeat's playback-quality payload. */
export type QoeReport = {
  reattaches: number;
  dropped_frames: number;
  live_latency_seconds: number | null;
  /** Why the player last degraded. Without it the server can see THAT viewers
   *  re-attach but never why, which is the difference between a diagnosable
   *  regression and a guess. Truncated: this is a label, not a log line. */
  last_error: string | null;
  /** Which mirror the viewer is on. `playback` only carries the protocol, so
   *  a mirror-specific fault is otherwise invisible in aggregate. */
  mirror_id: string | null;
};

/**
 * Turn the player's cumulative counters into per-heartbeat deltas.
 *
 * recoveryCount and droppedFrames are cumulative for the life of a player
 * instance, and both reset to zero when the pipeline is rebuilt (a source
 * switch, an overlay toggle). Reporting the raw value would double-count on the
 * server and reporting a naive difference would send a negative spike after
 * every rebuild, so a decrease is treated as a reset and contributes nothing.
 */
export function qoeDelta(
  current: {
    recoveryCount: number;
    droppedFrames: number;
    liveLatencySeconds: number | null;
    lastError?: string | null;
    mirrorId?: string | null;
  },
  previous: { recoveryCount: number; droppedFrames: number }
): QoeReport {
  const latency = current.liveLatencySeconds;
  const lastError = current.lastError?.trim();
  return {
    reattaches: Math.max(0, current.recoveryCount - previous.recoveryCount),
    dropped_frames: Math.max(0, current.droppedFrames - previous.droppedFrames),
    live_latency_seconds:
      latency != null && Number.isFinite(latency) ? Math.round(latency * 10) / 10 : null,
    last_error: lastError ? lastError.slice(0, 200) : null,
    mirror_id: current.mirrorId || null
  };
}
