export type UfcScheduleSlot = {
  label: string;
  iso: string;
};

export type UfcEvent = {
  id: string;
  title: string;
  shortTitle: string;
  dateLabel: string;
  dateIso?: string;
  venue: string;
  city: string;
  stream: string;
  sourceUrl: string;
  mainCardIso: string | null;
  slots: UfcScheduleSlot[];
  note?: string;
};

export const ufcScheduleLastChecked = "2026-07-11";

export const ufcSchedule: UfcEvent[] = [
  {
    id: "ufc-329",
    title: "UFC 329: McGregor vs. Holloway 2",
    shortTitle: "McGregor vs. Holloway 2",
    dateLabel: "Saturday, July 11",
    dateIso: "2026-07-11T12:00:00.000Z",
    venue: "T-Mobile Arena",
    city: "Las Vegas, Nevada",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-329",
    mainCardIso: "2026-07-12T01:00:00.000Z",
    slots: [
      { label: "Early prelims", iso: "2026-07-11T21:00:00.000Z" },
      { label: "Prelims", iso: "2026-07-11T23:00:00.000Z" },
      { label: "Main card", iso: "2026-07-12T01:00:00.000Z" }
    ]
  },
  {
    id: "ufc-fn-du-plessis-vs-usman",
    title: "UFC Fight Night: Du Plessis vs. Usman",
    shortTitle: "Du Plessis vs. Usman",
    dateLabel: "Saturday, July 18",
    dateIso: "2026-07-18T12:00:00.000Z",
    venue: "Paycom Center",
    city: "Oklahoma City, Oklahoma",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-july-18-2026",
    mainCardIso: "2026-07-19T00:00:00.000Z",
    slots: [
      { label: "Main card", iso: "2026-07-19T00:00:00.000Z" }
    ]
  },
  {
    id: "ufc-fn-ankalaev-vs-rountree-jr",
    title: "UFC Fight Night: Ankalaev vs. Rountree Jr.",
    shortTitle: "Ankalaev vs. Rountree Jr.",
    dateLabel: "Saturday, July 25",
    dateIso: "2026-07-25T12:00:00.000Z",
    venue: "Etihad Arena",
    city: "Abu Dhabi, United Arab Emirates",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-july-25-2026",
    mainCardIso: "2026-07-25T16:00:00.000Z",
    slots: [
      { label: "Main card", iso: "2026-07-25T16:00:00.000Z" }
    ]
  },
  {
    id: "ufc-fn-medic-vs-rodriguez",
    title: "UFC Fight Night: Medic vs Rodriguez",
    shortTitle: "Medic vs Rodriguez",
    dateLabel: "Saturday, August 1",
    dateIso: "2026-08-01T12:00:00.000Z",
    venue: "Belgrade Arena",
    city: "Belgrade, Serbia",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-august-01-2026",
    mainCardIso: "2026-08-01T18:00:00.000Z",
    slots: [
      { label: "Main card", iso: "2026-08-01T18:00:00.000Z" }
    ]
  },
  {
    id: "ufc-330",
    title: "UFC 330: Makhachev vs. Machado Garry",
    shortTitle: "Makhachev vs. Machado Garry",
    dateLabel: "Saturday, August 15",
    dateIso: "2026-08-15T12:00:00.000Z",
    venue: "Xfinity Mobile Arena",
    city: "Philadelphia, Pennsylvania",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-330",
    mainCardIso: "2026-08-16T01:00:00.000Z",
    slots: [
      { label: "Main card", iso: "2026-08-16T01:00:00.000Z" }
    ]
  },
  {
    id: "ufc-fn-hernandez-vs-rodrigues",
    title: "UFC Fight Night: Hernandez vs. Rodrigues",
    shortTitle: "Hernandez vs. Rodrigues",
    dateLabel: "Saturday, August 22",
    dateIso: "2026-08-22T12:00:00.000Z",
    venue: "Golden 1 Center",
    city: "Sacramento, California",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-august-22-2026",
    mainCardIso: "2026-08-22T22:00:00.000Z",
    slots: [
      { label: "Main card", iso: "2026-08-22T22:00:00.000Z" }
    ]
  },
  {
    id: "ufc-fn-2026-08-29",
    title: "UFC Fight Night: TBD vs. TBD",
    shortTitle: "TBD vs. TBD",
    dateLabel: "Saturday, August 29",
    dateIso: "2026-08-29T12:00:00.000Z",
    venue: "Oriental Sports Center",
    city: "Pudong District China",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-august-29-2026",
    mainCardIso: "2026-08-29T22:00:00.000Z",
    slots: [
      { label: "Main card", iso: "2026-08-29T22:00:00.000Z" }
    ]
  },
  {
    id: "ufc-fn-2026-09-05",
    title: "UFC Fight Night: TBD vs. TBD",
    shortTitle: "TBD vs. TBD",
    dateLabel: "Saturday, September 5",
    dateIso: "2026-09-05T12:00:00.000Z",
    venue: "Accor Arena",
    city: "Paris, France",
    stream: "Paramount+",
    sourceUrl: "https://www.ufc.com/event/ufc-fight-night-september-05-2026",
    mainCardIso: null,
    slots: [],
    note: "Start time TBA"
  }
];
