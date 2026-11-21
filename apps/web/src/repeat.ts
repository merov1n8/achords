// The schedule repeat picker <-> the gateway's 5-field cron (packages/core/src/cron.ts: minute
// hour day-of-month month day-of-week, local time, no names). Only shapes that round-trip
// exactly get a picker; anything else stays Custom so no schedule is silently rewritten.
import { t } from "./i18n.ts";

export type Repeat =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  /** days: 0 = Sunday … 6 = Saturday, sorted. */
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

export type RepeatKind = Repeat["kind"];
export const KINDS: RepeatKind[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];

export function toCron(r: Repeat): string {
  switch (r.kind) {
    case "hourly":
      return `${r.minute} * * * *`;
    case "daily":
      return `${r.minute} ${r.hour} * * *`;
    case "weekdays":
      return `${r.minute} ${r.hour} * * 1-5`;
    case "weekly":
      return `${r.minute} ${r.hour} * * ${r.days.join(",")}`;
    case "monthly":
      return `${r.minute} ${r.hour} ${r.day} * *`;
    case "custom":
      return r.cron.trim();
  }
}

// A plain number without leading zeros, so toCron(fromCron(x)) === x for every picker shape.
const num = (s: string | undefined, min: number, max: number) => {
  if (s === undefined || !/^(0|[1-9]\d?)$/.test(s)) return undefined;
  const n = Number(s);
  return n >= min && n <= max ? n : undefined;
};

export function fromCron(cron: string): Repeat {
  const custom: Repeat = { kind: "custom", cron: cron.trim() };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return custom;
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  const minute = num(mi, 0, 59);
  if (minute === undefined || mo !== "*") return custom;
  if (h === "*" && d === "*" && w === "*") return { kind: "hourly", minute };
  const hour = num(h, 0, 23);
  if (hour === undefined) return custom;
  if (d === "*" && w === "*") return { kind: "daily", hour, minute };
  if (d === "*" && w === "1-5") return { kind: "weekdays", hour, minute };
  if (d === "*") {
    const days = w.split(",").map((x) => num(x, 0, 6));
    const sorted = [...new Set(days)].sort();
    // Out of order or repeated days would not come back identical: leave those as Custom.
    if (days.includes(undefined) || sorted.join(",") !== w) return custom;
    return { kind: "weekly", days: sorted as number[], hour, minute };
  }
  const day = num(d, 1, 31);
  if (day !== undefined && w === "*") return { kind: "monthly", day, hour, minute };
  return custom;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;

/** "Weekdays at 09:00": what the table and the form show instead of the cron. */
export function summary(r: Repeat): string {
  switch (r.kind) {
    case "hourly":
      return t("repeat.sum.hourly", { minute: pad(r.minute) });
    case "daily":
      return t("repeat.sum.daily", { time: clock(r.hour, r.minute) });
    case "weekdays":
      return t("repeat.sum.weekdays", { time: clock(r.hour, r.minute) });
    case "weekly":
      return t("repeat.sum.weekly", {
        days: r.days.map((d) => t(`repeat.day.${d}`)).join(", "),
        time: clock(r.hour, r.minute),
      });
    case "monthly":
      return t("repeat.sum.monthly", { day: r.day, time: clock(r.hour, r.minute) });
    case "custom":
      return t("repeat.sum.custom", { cron: r.cron });
  }
}

/** Switching the Repeat select keeps the time already chosen. */
export function withKind(r: Repeat, kind: RepeatKind): Repeat {
  const hour = "hour" in r ? r.hour : 9;
  const minute = "minute" in r ? r.minute : 0;
  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "daily":
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, days: r.kind === "weekly" ? r.days : [1], hour, minute };
    case "monthly":
      return { kind, day: r.kind === "monthly" ? r.day : 1, hour, minute };
    case "custom":
      return { kind, cron: toCron(r) };
  }
}
