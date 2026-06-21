import { writeFile } from "node:fs/promises";

const PARAMOUNT_SCHEDULE_URL = "https://www.paramountplus.com/sneak-peak/ufc-schedule-2026/";
const OUTPUT_PATH = new URL("../src/config/ufcSchedule.ts", import.meta.url);
const STREAM = "Paramount+";

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

const FALLBACK_EVENTS = [
  {
    dateText: "Saturday, June 20, 2026",
    title: "UFC Fight Night: Kape vs Horiguchi",
    venueText: "Meta APEX (Las Vegas, Nevada)",
    timeText: "Prelims: 5 PM ET/2 PM PT Main card: 8 PM ET/5 PM PT"
  },
  {
    dateText: "Saturday, June 27, 2026",
    title: "UFC Fight Night: Fiziev vs Torres",
    venueText: "National Gymnastics Arena (Baku, Azerbaijan)",
    timeText: "Main card: 12 PM ET/9 AM PT"
  },
  {
    dateText: "Saturday, July 11, 2026",
    title: "UFC 329: McGregor vs. Holloway 2",
    venueText: "T-Mobile Arena (Las Vegas, Nevada)",
    timeText: "Main card: 9 PM ET/6 PM PT"
  },
  {
    dateText: "Saturday, July 18, 2026",
    title: "UFC Fight Night: TBD vs. TBD",
    venueText: "Paycom Center (Oklahoma City, Oklahoma)",
    timeText: "Main card: 8 PM ET/5 PM PT"
  },
  {
    dateText: "Saturday, July 25, 2026",
    title: "UFC Fight Night: Ankalaev vs. Rountree Jr.",
    venueText: "Etihad Arena (Abu Dhabi, United Arab Emirates)",
    timeText: "Main card: 12 PM ET/9 AM PT"
  },
  {
    dateText: "Saturday, Aug. 1, 2026",
    title: "UFC Fight Night: Medic vs Rodriguez",
    venueText: "Belgrade Arena (Serbia)",
    timeText: "Main card: 2 PM ET/11 AM PT"
  },
  {
    dateText: "Saturday, Aug. 15, 2026",
    title: "UFC 330: Makhachev vs. Machado Garry",
    venueText: "Xfinity Mobile Arena (Philadelphia, Pennsylvania)",
    timeText: ""
  },
  {
    dateText: "Sept. 5, 2026",
    title: "UFC Fight Night: TBD vs. TBD",
    venueText: "Accor Arena (Paris, France)",
    timeText: ""
  }
];

function decodeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&#8212;|&mdash;/g, "-")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#038;|&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseScheduleText(text) {
  const start = text.indexOf("Upcoming events");
  const end = text.indexOf("Past events");
  if (start === -1 || end === -1 || end <= start) return [];

  const upcoming = text.slice(start, end);
  const eventPattern =
    /Date:\s*(.*?)\s+Event:\s*(.*?)\s+Venue\s*:?\s*(.*?)(?:\s+Start time:\s*(.*?))?\s+Streaming:\s*Paramount\+/g;
  const events = [];
  let match;

  while ((match = eventPattern.exec(upcoming))) {
    events.push({
      dateText: normalizeWhitespace(match[1]),
      title: normalizeTitle(match[2]),
      venueText: normalizeWhitespace(match[3]),
      timeText: normalizeWhitespace(match[4] ?? "")
    });
  }

  return events;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTitle(value) {
  return normalizeWhitespace(value).replace(/\bvs\b/g, "vs");
}

function parseDate(dateText) {
  const match = dateText.match(/(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*)?([A-Za-z.]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) throw new Error(`Cannot parse UFC date: ${dateText}`);

  const monthKey = match[2].replace(".", "").toLowerCase();
  const month = MONTHS[monthKey];
  if (month === undefined) throw new Error(`Cannot parse UFC month: ${dateText}`);

  return {
    weekday: match[1] ?? weekdayForDate(Number(match[4]), month, Number(match[3])),
    month,
    day: Number(match[3]),
    year: Number(match[4])
  };
}

function weekdayForDate(year, month, day) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month, day, 12))
  );
}

function dateLabel(date) {
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(date.year, date.month, date.day, 12))
  );
  return `${date.weekday}, ${monthName} ${date.day}`;
}

function parseVenue(venueText, title) {
  const match = venueText.match(/^(.*?)\s*\((.*?)\)$/);
  const venue = normalizeVenue(match?.[1] ?? venueText, title);
  const city = normalizeCity(match?.[2] ?? "TBA", venue);
  return { venue, city };
}

function normalizeVenue(venue, title) {
  if (title.includes("Medic vs Rodriguez") && venue === "Belgrade Arena") return "Belgrade Arena";
  return venue.trim();
}

function normalizeCity(city, venue) {
  if (venue === "Belgrade Arena" && city === "Serbia") return "Belgrade, Serbia";
  return city.trim();
}

function parseTimeToIso(date, timeText) {
  const slots = [];
  const slotPattern = /((?:Early prelims|Prelims|Main card)):\s*([^:]+?)(?=\s+(?:Early prelims|Prelims|Main card):|$)/gi;
  let match;
  while ((match = slotPattern.exec(timeText))) {
    const label = capitalizeSlot(match[1]);
    const timeValue = normalizeWhitespace(match[2]);
    const iso = parseSlotTime(date, timeValue);
    if (!iso || slots.some((slot) => slot.iso === iso)) continue;
    slots.push({ label, iso });
  }
  return slots;
}

function capitalizeSlot(label) {
  const lower = label.toLowerCase();
  if (lower === "main card") return "Main card";
  if (lower === "early prelims") return "Early prelims";
  return "Prelims";
}

function parseSlotTime(date, timeValue) {
  const etMatch = timeValue.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*ET/i);
  const ptMatch = timeValue.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*PT/i);
  const match = etMatch ?? ptMatch;
  if (!match) return null;

  const zone = etMatch ? "ET" : "PT";
  const ambiguousPtOnly = !etMatch && (timeValue.match(/\bPT\b/gi)?.length ?? 0) > 1;
  if (ambiguousPtOnly) return null;

  const hour12 = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const hour = (hour12 % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0);
  const offsetHours = zone === "ET" ? 4 : 7;
  return new Date(Date.UTC(date.year, date.month, date.day, hour + offsetHours, minute)).toISOString();
}

function eventId(title, date) {
  const numberMatch = title.match(/^UFC\s+(\d+)/i);
  if (numberMatch) return `ufc-${numberMatch[1]}`;

  const matchups = title.match(/:\s*(.*)$/)?.[1] ?? `${date.year}-${date.month + 1}-${date.day}`;
  const slug = matchups
    .toLowerCase()
    .replace(/\bvs\.?\b/g, "vs")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug === "tbd-vs-tbd") {
    return `ufc-fn-${date.year}-${String(date.month + 1).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  }
  return `ufc-fn-${slug}`;
}

function shortTitle(title) {
  return title.replace(/^UFC\s+(?:Fight Night|[0-9]+):\s*/i, "");
}

function sourceUrl(title, date) {
  const numberMatch = title.match(/^UFC\s+(\d+)/i);
  if (numberMatch) return `https://www.ufc.com/event/ufc-${numberMatch[1]}`;

  const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(date.year, date.month, date.day, 12)))
    .toLowerCase();
  const day = date.day < 10 ? `0${date.day}` : String(date.day);
  return `https://www.ufc.com/event/ufc-fight-night-${monthName}-${day}-${date.year}`;
}

function toUfcEvent(raw) {
  const date = parseDate(raw.dateText);
  const { venue, city } = parseVenue(raw.venueText, raw.title);
  const slots = parseTimeToIso(date, raw.timeText);
  const mainCardIso = slots.find((slot) => slot.label === "Main card")?.iso ?? null;
  return {
    id: eventId(raw.title, date),
    title: raw.title,
    shortTitle: shortTitle(raw.title),
    dateLabel: dateLabel(date),
    dateIso: new Date(Date.UTC(date.year, date.month, date.day, 12)).toISOString(),
    venue,
    city,
    stream: STREAM,
    sourceUrl: sourceUrl(raw.title, date),
    mainCardIso,
    slots,
    note: slots.length === 0 ? "Start time TBA" : undefined
  };
}

function renderString(value) {
  return JSON.stringify(value);
}

function renderMaybeString(value) {
  return value === null ? "null" : renderString(value);
}

function renderEvent(event) {
  const fields = [
    `    id: ${renderString(event.id)}`,
    `    title: ${renderString(event.title)}`,
    `    shortTitle: ${renderString(event.shortTitle)}`,
    `    dateLabel: ${renderString(event.dateLabel)}`,
    `    dateIso: ${renderString(event.dateIso)}`,
    `    venue: ${renderString(event.venue)}`,
    `    city: ${renderString(event.city)}`,
    `    stream: ${renderString(event.stream)}`,
    `    sourceUrl: ${renderString(event.sourceUrl)}`,
    `    mainCardIso: ${renderMaybeString(event.mainCardIso)}`,
    renderSlots(event.slots)
  ];
  if (event.note) fields.push(`    note: ${renderString(event.note)}`);
  return `  {\n${fields.join(",\n")}\n  }`;
}

function renderSlots(slots) {
  if (slots.length === 0) return "    slots: []";
  const renderedSlots = slots
    .map((slot) => `      { label: ${renderString(slot.label)}, iso: ${renderString(slot.iso)} }`)
    .join(",\n");
  return `    slots: [\n${renderedSlots}\n    ]`;
}

function renderSchedule(events, checkedDate) {
  return `export type UfcScheduleSlot = {\n  label: string;\n  iso: string;\n};\n\nexport type UfcEvent = {\n  id: string;\n  title: string;\n  shortTitle: string;\n  dateLabel: string;\n  dateIso?: string;\n  venue: string;\n  city: string;\n  stream: string;\n  sourceUrl: string;\n  mainCardIso: string | null;\n  slots: UfcScheduleSlot[];\n  note?: string;\n};\n\nexport const ufcScheduleLastChecked = ${renderString(checkedDate)};\n\nexport const ufcSchedule: UfcEvent[] = [\n${events.map(renderEvent).join(",\n")}\n];\n`;
}

async function loadRawEvents() {
  try {
    const response = await fetch(PARAMOUNT_SCHEDULE_URL, {
      headers: {
        "user-agent": "obbywatcher-schedule-updater/1.0 (+https://fight.nswfiles.com)"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = decodeHtml(await response.text());
    const parsed = parseScheduleText(text);
    if (parsed.length >= 4) return parsed;
    throw new Error(`parsed only ${parsed.length} events`);
  } catch (error) {
    console.warn(`Using fallback UFC schedule seed: ${error.message}`);
    return FALLBACK_EVENTS;
  }
}

const rawEvents = await loadRawEvents();
const events = rawEvents.map(toUfcEvent).sort((a, b) => Date.parse(a.dateIso) - Date.parse(b.dateIso));
const checkedDate = new Date().toISOString().slice(0, 10);
await writeFile(OUTPUT_PATH, renderSchedule(events, checkedDate), "utf8");
console.log(`Wrote ${events.length} UFC events to ${OUTPUT_PATH.pathname}`);
