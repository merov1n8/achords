// Reply alerts for the open web app: a chime when an agent replies in any chat, and the number
// of chats with unread replies in the tab title. "Read" is per browser: the chat was open while
// the tab was visible.

export type Seen = Record<string, number>;
export interface AlertState {
  /** Last agent message seen per chat (message seq). */
  seen: Seen;
  /** Highest reply seq of the previous look; absent right after loading the page. */
  max?: number;
}

export function replyState(
  threads: { id: string; lastAgentSeq: number | null }[],
  prev: AlertState | undefined,
  openId: string | undefined,
  visible: boolean,
): { seen: Seen; max: number; unread: number; chime: boolean } {
  const known = prev?.seen;
  const seen: Seen = { ...known };
  let max = 0;
  let unread = 0;
  for (const th of threads) {
    const last = th.lastAgentSeq ?? 0;
    max = Math.max(max, last);
    // Never looked before: what is there now counts as read. A chat that appears later counts
    // from its first reply.
    if (seen[th.id] === undefined) seen[th.id] = known ? 0 : last;
    if (visible && th.id === openId) seen[th.id] = last;
    if (last > (seen[th.id] as number)) unread++;
  }
  return { seen, max, unread, chime: prev?.max !== undefined && max > prev.max };
}

/**
 * How a chat in the list asks for attention: "unread" while an agent reply is unread, "waiting"
 * when that chat also waits for the owner's answer. Opening the chat marks it read, so both
 * clear until something new arrives. A chat never looked at counts as read, as in replyState.
 */
export function attention(
  th: { id: string; lastAgentSeq: number | null; waitingOwner: boolean },
  seen: Seen | undefined,
  openId: string | undefined,
): "waiting" | "unread" | undefined {
  const last = seen?.[th.id];
  if (th.id === openId || last === undefined || (th.lastAgentSeq ?? 0) <= last) return undefined;
  return th.waitingOwner ? "waiting" : "unread";
}

/** A name with its unread count, the same wherever the count shows: "Chat (2)", or just "Chat". */
export const withCount = (label: string, unread: number) =>
  unread > 0 ? `${label} (${unread})` : label;

let ctx: AudioContext | undefined;

/** Browsers start audio only after a click or key press; call this from one. */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // No Web Audio: no chime.
  }
}

/** A soft two-note chime, synthesized (no sound file). */
export function chime(): void {
  if (ctx?.state !== "running") return;
  const now = ctx.currentTime;
  for (const [i, freq] of [880, 1318.5].entries()) {
    const start = now + i * 0.12;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.95);
  }
}

const SEEN_KEY = "achords.seenReplies";
export const loadSeen = (): Seen | undefined => {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Seen) : undefined;
  } catch {
    return undefined;
  }
};
const saveSeen = (seen: Seen) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private window or blocked storage: marks last until the page closes.
  }
};

/**
 * Watches the chats while the app is open: chimes on a new agent reply and shows the number of
 * chats with unread replies in the tab title; `onUnread` gets the same number for the menu.
 */
export function watchReplies(
  list: () => Promise<{ id: string; lastAgentSeq: number | null }[]>,
  openThread: () => string | undefined,
  onUnread: (unread: number) => void = () => {},
  everyMs = 5000,
): () => void {
  const saved = loadSeen();
  let state: AlertState | undefined = saved ? { seen: saved } : undefined;
  let threads: { id: string; lastAgentSeq: number | null }[] | undefined;
  const apply = () => {
    if (!threads) return;
    const r = replyState(threads, state, openThread(), document.visibilityState === "visible");
    state = { seen: r.seen, max: r.max };
    saveSeen(r.seen);
    document.title = withCount("Achords", r.unread);
    onUnread(r.unread);
    if (r.chime) chime();
  };
  const look = () =>
    list()
      .then((t) => {
        threads = t;
        apply();
      })
      .catch(() => {});
  look();
  const id = setInterval(look, everyMs);
  document.addEventListener("visibilitychange", apply);
  addEventListener("popstate", apply);
  addEventListener("pointerdown", unlockAudio);
  addEventListener("keydown", unlockAudio);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", apply);
    removeEventListener("popstate", apply);
    removeEventListener("pointerdown", unlockAudio);
    removeEventListener("keydown", unlockAudio);
    document.title = "Achords";
    onUnread(0);
  };
}
