export type StreamMirror = {
  id: string;
  label: string;
  host: string;
  pageUrl: string;
  dashUrl: string;
  hlsUrl: string;
  delivery: "cloudflare" | "direct";
  /** Mirrors that resolve to the same nginx vhost and the same encoder output.
   *  fight.nswfiles.com and live.obnoxious.lol are one server block on one host,
   *  so rotating between them after a failure re-tries the identical origin and
   *  buys nothing but another teardown. Rotation must prefer a different origin. */
  origin: string;
};

export type StreamProtocol = "dash" | "hls";

export type StreamSource = {
  id: string;
  mirrorId: string;
  label: string;
  host: string;
  pageUrl: string;
  protocol: StreamProtocol;
  url: string;
};

export type WatchLink = {
  label: string;
  href: string;
  description: string;
};

export type PublicStreamSource = {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  description?: string;
};

const fallbackPublicSources: PublicStreamSource[] = [];

export const streamConfig = {
  appName: "ObbyWatcher",
  displayHost: "fight.nswfiles.com",
  title: "Live Fight Stream",
  schedule: "Live fight nights & PPVs",
  canonicalUrl: "https://fight.nswfiles.com/",
  chatUrl: "https://chat.obnoxious.lol/",
  discordUrl: "https://discord.gg/moddingcartel",
  twitterUrl: "https://twitter.com/obnoxiousMods",
  ircUrl: "irc://irc.obnoxious.lol:6666",
  githubUrl: "https://github.com/obnoxiousmods/obbywatcher",
  ufcScheduleUrl: "https://www.ufc.com/events",
  activeEventUrl: "https://www.ufc.com/event/ufc-freedom-250",
  paramountUfcUrl: "https://www.paramountplus.com/shows/ufc/",
  imageUrl:
    "https://images.unsplash.com/photo-1575747515871-2e323827539e?q=80&w=1200&auto=format&fit=crop",
  imageCredit: "Photo by David Guliciuc on Unsplash",
  watchLinks: [
    {
      label: "UFC schedule",
      href: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
      description: "Current Paramount+ fight calendar"
    },
    {
      label: "Tonight's card",
      href: "https://www.ufc.com/event/ufc-freedom-250",
      description: "Official UFC event page"
    },
    {
      label: "Paramount+ UFC",
      href: "https://www.paramountplus.com/shows/ufc/",
      description: "Official streaming hub"
    },
    {
      label: "Discord",
      href: "https://discord.gg/moddingcartel",
      description: "Community updates and stream help"
    },
    {
      label: "GitHub",
      href: "https://github.com/obnoxiousmods/obbywatcher",
      description: "Source repo"
    },
    {
      label: "Chat popout",
      href: "https://chat.obnoxious.lol/",
      description: "Open chat in a dedicated tab"
    }
  ] satisfies WatchLink[],
  mirrors: [
    {
      id: "fight",
      label: "Primary",
      host: "fight.nswfiles.com",
      pageUrl: "https://fight.nswfiles.com/",
      dashUrl: "https://fight.nswfiles.com/stream/ufc.mpd",
      hlsUrl: "https://fight.nswfiles.com/stream/ufc.m3u8",
      delivery: "cloudflare",
      origin: "live-vhost"
    },
    {
      id: "live",
      label: "Mirror",
      host: "live.obnoxious.lol",
      pageUrl: "https://live.obnoxious.lol/",
      dashUrl: "https://live.obnoxious.lol/stream/ufc.mpd",
      hlsUrl: "https://live.obnoxious.lol/stream/ufc.m3u8",
      delivery: "cloudflare",
      origin: "live-vhost"
    },
    {
      id: "cockpit-direct",
      label: "Direct",
      host: "s.obby.ca",
      pageUrl: "https://s.obby.ca/",
      dashUrl: "https://s.obby.ca/hls/ufc.mpd",
      hlsUrl: "https://s.obby.ca/hls/ufc.m3u8",
      delivery: "direct",
      origin: "cockpit-vhost"
    }
  ] satisfies StreamMirror[],
  publicSources: fallbackPublicSources
} as const;

export function sourcesForMirror(mirror: StreamMirror): StreamSource[] {
  return [
    {
      id: `${mirror.id}-dash`,
      mirrorId: mirror.id,
      label: `${mirror.label} DASH`,
      host: mirror.host,
      pageUrl: mirror.pageUrl,
      protocol: "dash",
      url: mirror.dashUrl
    },
    {
      id: `${mirror.id}-hls`,
      mirrorId: mirror.id,
      label: `${mirror.label} HLS`,
      host: mirror.host,
      pageUrl: mirror.pageUrl,
      protocol: "hls",
      url: mirror.hlsUrl
    }
  ];
}
