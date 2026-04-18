export type StreamMirror = {
  id: string;
  label: string;
  host: string;
  pageUrl: string;
  streamUrl: string;
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
  imageUrl:
    "https://images.unsplash.com/photo-1575747515871-2e323827539e?q=80&w=1200&auto=format&fit=crop",
  imageCredit: "Photo by David Guliciuc on Unsplash",
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
