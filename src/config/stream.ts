export type StreamMirror = {
  id: string;
  label: string;
  host: string;
  pageUrl: string;
  streamUrl: string;
};

export type WatchLink = {
  label: string;
  href: string;
  description: string;
};

export const streamConfig = {
  appName: "ObbyWatcher",
  displayHost: "live.obnoxious.lol",
  title: "Live Fight Stream",
  schedule: "Live every Saturday",
  canonicalUrl: "https://live.obnoxious.lol/",
  chatUrl: "https://chat.obnoxious.lol/",
  twitterUrl: "https://twitter.com/obnoxiousMods",
  ircUrl: "irc://irc.obnoxious.lol:6666",
  githubUrl: "https://github.com/obnoxiousmods/obbywatcher",
  ufcScheduleUrl: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
  activeEventUrl: "https://www.ufc.com/event/ufc-fight-night-april-18-2026",
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
      href: "https://www.ufc.com/event/ufc-fight-night-april-18-2026",
      description: "Official UFC event page"
    },
    {
      label: "Paramount+ UFC",
      href: "https://www.paramountplus.com/shows/ufc/",
      description: "Official streaming hub"
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
      id: "live",
      label: "Primary",
      host: "live.obnoxious.lol",
      pageUrl: "https://live.obnoxious.lol/",
      streamUrl: "https://live.obnoxious.lol/stream/ufc.m3u8"
    },
    {
      id: "fight",
      label: "Mirror",
      host: "fight.nswfiles.com",
      pageUrl: "https://fight.nswfiles.com/",
      streamUrl: "https://fight.nswfiles.com/stream/ufc.m3u8"
    }
  ] satisfies StreamMirror[]
} as const;
