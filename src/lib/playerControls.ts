import type { UfcEvent } from "../config/ufcSchedule";

export type PlayerUiState = {
  volume: number;
  muted: boolean;
  statsOpen: boolean;
  moreMenuOpen: boolean;
};

export type PlayerUiAction =
  | { type: "set-volume"; volume: number }
  | { type: "toggle-muted" }
  | { type: "set-muted"; muted: boolean }
  | { type: "toggle-stats" }
  | { type: "toggle-more" }
  | { type: "set-more"; open: boolean };

export const initialPlayerUiState: PlayerUiState = {
  volume: 1,
  muted: false,
  statsOpen: false,
  moreMenuOpen: false
};

export function clampVolume(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function playerUiReducer(state: PlayerUiState, action: PlayerUiAction): PlayerUiState {
  switch (action.type) {
    case "set-volume": {
      const volume = clampVolume(action.volume);
      return {
        ...state,
        volume,
        muted: volume === 0 ? true : false
      };
    }
    case "toggle-muted":
      return { ...state, muted: !state.muted };
    case "set-muted":
      return { ...state, muted: action.muted };
    case "toggle-stats":
      return { ...state, statsOpen: !state.statsOpen };
    case "toggle-more":
      return { ...state, moreMenuOpen: !state.moreMenuOpen };
    case "set-more":
      return { ...state, moreMenuOpen: action.open };
    default:
      return state;
  }
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--";
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function formatSignedSeconds(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--";
  return `${Math.max(0, seconds).toFixed(1)}s`;
}

export function getLiveEdgeFromSeekable(seekable: TimeRanges) {
  if (seekable.length === 0) return null;
  return seekable.end(seekable.length - 1);
}

export function getLiveLagSeconds(video: HTMLVideoElement) {
  const liveEdge = getLiveEdgeFromSeekable(video.seekable);
  if (liveEdge === null) return null;
  return Math.max(0, liveEdge - video.currentTime);
}

export function formatEventTime(iso: string, locale = undefined as string | undefined) {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(iso));
}

export function eventStartMs(event: UfcEvent) {
  const firstSlot = event.slots[0]?.iso ?? event.mainCardIso ?? event.dateIso;
  return firstSlot ? Date.parse(firstSlot) : Number.POSITIVE_INFINITY;
}

export function eventEndMs(event: UfcEvent) {
  const lastSlot = event.slots.at(-1)?.iso ?? event.mainCardIso;
  if (!lastSlot) return Number.POSITIVE_INFINITY;
  return Date.parse(lastSlot) + 6 * 60 * 60 * 1000;
}

export function getEventPhase(event: UfcEvent, nowMs = Date.now()) {
  const firstKnownStreamSlot = event.slots[0]?.iso ?? event.mainCardIso;
  if (!firstKnownStreamSlot) return "TBA";
  const startMs = Date.parse(firstKnownStreamSlot);
  const endMs = eventEndMs(event);
  if (nowMs >= startMs && nowMs <= endMs) return "Now";
  if (nowMs < startMs) return "Next";
  return "Replay";
}

export function getScheduleBuckets(events: readonly UfcEvent[], nowMs = Date.now()) {
  const sorted = [...events].sort((a, b) => eventStartMs(a) - eventStartMs(b));
  const current = sorted.find((event) => getEventPhase(event, nowMs) === "Now") ?? null;
  const next = sorted.find((event) => eventStartMs(event) > nowMs) ?? null;
  const upcoming = sorted.filter((event) => eventStartMs(event) > nowMs).slice(0, 5);

  return { current, next, upcoming };
}
