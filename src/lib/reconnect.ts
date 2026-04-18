export type TimeRangeSource = {
  length: number;
  start(index: number): number;
  end(index: number): number;
};

export type RetryBackoffOptions = {
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
};

export type StalePlaylistInput = {
  nowMs: number;
  lastSequenceAtMs: number | null;
  targetDurationSeconds: number;
  staleTargetDurations: number;
};

export function retryDelayMs(
  attempt: number,
  options: RetryBackoffOptions,
  random: () => number = Math.random
) {
  const safeAttempt = Math.max(1, attempt);
  const exponential = options.baseMs * 2 ** (safeAttempt - 1);
  const capped = Math.min(options.maxMs, exponential);
  const jitterRange = capped * options.jitterRatio;
  const jitter = (random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(capped + jitter));
}

export function nextMirrorIndex(currentIndex: number, totalMirrors: number) {
  if (totalMirrors <= 1) return 0;
  return (currentIndex + 1) % totalMirrors;
}

export function shouldRotateMirror(consecutiveSourceFailures: number, totalMirrors: number, threshold: number) {
  return totalMirrors > 1 && consecutiveSourceFailures >= threshold;
}

export function isPlaylistStale({
  nowMs,
  lastSequenceAtMs,
  targetDurationSeconds,
  staleTargetDurations
}: StalePlaylistInput) {
  if (!lastSequenceAtMs) return false;

  const safeTargetSeconds = Math.max(2, targetDurationSeconds || 4);
  const staleAfterMs = safeTargetSeconds * staleTargetDurations * 1000;

  return nowMs - lastSequenceAtMs > staleAfterMs;
}

export function getBufferedAhead(buffered: TimeRangeSource, currentTime: number) {
  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index);
    const end = buffered.end(index);

    if (currentTime >= start && currentTime <= end) {
      return Math.max(0, end - currentTime);
    }
  }

  return 0;
}

export function sourceWithCacheBust(source: string, stamp: number | string) {
  const joiner = source.includes("?") ? "&" : "?";
  return `${source}${joiner}ow=${encodeURIComponent(String(stamp))}`;
}
