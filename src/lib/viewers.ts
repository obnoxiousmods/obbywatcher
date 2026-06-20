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
