export type UfcScheduleSlot = {
  label: string;
  iso: string;
};

export type UfcEvent = {
  id: string;
  title: string;
  shortTitle: string;
  dateLabel: string;
  venue: string;
  city: string;
  stream: string;
  sourceUrl: string;
  mainCardIso: string | null;
  slots: UfcScheduleSlot[];
  note?: string;
};

export const ufcScheduleLastChecked = "2026-06-15";

export const ufcSchedule: UfcEvent[] = [
  {
    id: "ufc-fn-burns-malott",
    title: "UFC Fight Night: Burns vs. Malott",
    shortTitle: "Burns vs. Malott",
    dateLabel: "Saturday, April 18",
    venue: "Canada Life Centre",
    city: "Winnipeg, Canada",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-april-18-2026",
    mainCardIso: "2026-04-19T00:00:00Z",
    slots: [
      { label: "Prelims", iso: "2026-04-18T21:00:00Z" },
      { label: "Main card", iso: "2026-04-19T00:00:00Z" }
    ]
  },
  {
    id: "ufc-fn-sterling-zalal",
    title: "UFC Fight Night: Sterling vs. Zalal",
    shortTitle: "Sterling vs. Zalal",
    dateLabel: "Saturday, April 25",
    venue: "Meta APEX",
    city: "Las Vegas, Nevada",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-april-25-2026",
    mainCardIso: "2026-04-26T00:00:00Z",
    slots: [
      { label: "Prelims", iso: "2026-04-25T21:00:00Z" },
      { label: "Main card", iso: "2026-04-26T00:00:00Z" }
    ]
  },
  {
    id: "ufc-fn-della-prates",
    title: "UFC Fight Night: Della Maddalena vs. Prates",
    shortTitle: "Della Maddalena vs. Prates",
    dateLabel: "Saturday, May 2",
    venue: "RAC Arena",
    city: "Perth, Australia",
    stream: "Paramount+",
    sourceUrl: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
    mainCardIso: "2026-05-02T11:00:00Z",
    slots: [{ label: "Main card", iso: "2026-05-02T11:00:00Z" }]
  },
  {
    id: "ufc-328",
    title: "UFC 328: Chimaev vs. Strickland",
    shortTitle: "Chimaev vs. Strickland",
    dateLabel: "Saturday, May 9",
    venue: "Prudential Center",
    city: "Newark, New Jersey",
    stream: "Paramount+",
    sourceUrl: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
    mainCardIso: "2026-05-10T01:00:00Z",
    slots: [
      { label: "Early prelims", iso: "2026-05-09T21:00:00Z" },
      { label: "Prelims", iso: "2026-05-09T23:00:00Z" },
      { label: "Main card", iso: "2026-05-10T01:00:00Z" }
    ]
  },
  {
    id: "ufc-fn-allen-costa",
    title: "UFC Fight Night: Allen vs. Costa",
    shortTitle: "Allen vs. Costa",
    dateLabel: "Saturday, May 16",
    venue: "Meta APEX",
    city: "Las Vegas, Nevada",
    stream: "Paramount+",
    sourceUrl: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
    mainCardIso: "2026-05-17T00:00:00Z",
    slots: [{ label: "Main card", iso: "2026-05-17T00:00:00Z" }]
  },
  {
    id: "ufc-fn-song-figueiredo",
    title: "UFC Fight Night: Song vs. Figueiredo",
    shortTitle: "Song vs. Figueiredo",
    dateLabel: "Saturday, May 30",
    venue: "Galaxy Arena",
    city: "Macau, China",
    stream: "Paramount+",
    sourceUrl: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
    mainCardIso: "2026-05-30T11:00:00Z",
    slots: [{ label: "Main card", iso: "2026-05-30T11:00:00Z" }]
  },
  {
    id: "ufc-fn-muhammad-bonfim",
    title: "UFC Fight Night: Muhammad vs. Bonfim",
    shortTitle: "Muhammad vs. Bonfim",
    dateLabel: "Saturday, June 6",
    venue: "Meta APEX",
    city: "Las Vegas, Nevada",
    stream: "Paramount+",
    sourceUrl: "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/",
    mainCardIso: null,
    slots: [],
    note: "Start time TBA"
  },
  {
    id: "ufc-freedom-250",
    title: "UFC Freedom 250: Topuria vs. Gaethje",
    shortTitle: "Topuria vs. Gaethje",
    dateLabel: "Sunday, June 14",
    venue: "The White House South Lawn",
    city: "Washington, D.C.",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-freedom-250",
    mainCardIso: "2026-06-15T00:00:00Z",
    slots: [{ label: "Main card", iso: "2026-06-15T00:00:00Z" }]
  }
];
