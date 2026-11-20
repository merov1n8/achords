// Minimal 5-field cron (minute hour day-of-month month day-of-week) in local time, enough for
// schedules (ADR-0033): *, lists, ranges and steps. No names (mon, jan) to keep it unambiguous.

interface Field {
  name: string;
  min: number;
  max: number;
}
const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 }, // 0 and 7 are Sunday
];

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Classic cron: with both day fields restricted, either may match. */
  dayOr: boolean;
}

function parseField(text: string, f: Field): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  const bad = () =>
    new Error(`${f.name}: "${text}" is not valid (${f.min}-${f.max}, *, lists, ranges, /step)`);
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw bad();
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (step < 1) throw new Error(`${f.name}: step must be at least 1`);
    const from = m[1] === "*" ? f.min : Number(m[2]);
    const to = m[1] === "*" ? f.max : m[3] !== undefined ? Number(m[3]) : m[4] ? f.max : from;
    if (from < f.min || to > f.max || from > to) throw bad();
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: text === "*" };
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expr}"`);
  const [mi, h, d, mo, w] = parts.map((p, i) => parseField(p, FIELDS[i] as Field)) as {
    values: Set<number>;
    any: boolean;
  }[] & { length: 5 };
  if (w?.values.has(7)) w.values.add(0);
  return {
    minutes: mi?.values as Set<number>,
    hours: h?.values as Set<number>,
    days: d?.values as Set<number>,
    months: mo?.values as Set<number>,
    weekdays: w?.values as Set<number>,
    dayOr: !d?.any && !w?.any,
  };
}

const dayMatches = (c: Cron, date: Date) => {
  const dom = c.days.has(date.getDate());
  const dow = c.weekdays.has(date.getDay());
  return c.dayOr ? dom || dow : dom && dow;
};

/** First run strictly after `after` (epoch ms), searching up to ~5 years. */
export function nextRun(expr: string | Cron, after: number): number {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d.getTime();
    }
  }
  throw new Error(`cron "${typeof expr === "string" ? expr : "?"}" never runs`);
}

/** Every run in [from, to), for timelines. */
export function occurrences(expr: string, from: number, to: number, max = 500): number[] {
  const c = parseCron(expr);
  const out: number[] = [];
  for (let t = nextRun(c, from - 1); t < to && out.length < max; t = nextRun(c, t)) out.push(t);
  return out;
}
