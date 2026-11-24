// Unsent text per chat, kept in this browser: switching chats or pages never loses it.
const PREFIX = "achords.draft.";
/** Drafts untouched this long are dropped (the chat may be gone). */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const store = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function loadDraft(threadId: string, s: Store | undefined = store()): string {
  try {
    const v = JSON.parse(s?.getItem(PREFIX + threadId) ?? "null") as { text?: unknown } | null;
    return typeof v?.text === "string" ? v.text : "";
  } catch {
    return "";
  }
}

export function saveDraft(
  threadId: string,
  text: string,
  s: Store | undefined = store(),
  now = Date.now(),
): void {
  if (!s) return;
  try {
    if (text.trim()) s.setItem(PREFIX + threadId, JSON.stringify({ text, at: now }));
    else s.removeItem(PREFIX + threadId);
  } catch {
    // A full or blocked storage only costs the draft.
  }
}

/** Drops drafts older than 30 days. */
export function pruneDrafts(s: Store | undefined = store(), now = Date.now()): void {
  if (!s) return;
  const old: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    try {
      const at = (JSON.parse(s.getItem(k) ?? "{}") as { at?: number }).at ?? 0;
      if (now - at > MAX_AGE_MS) old.push(k);
    } catch {
      old.push(k);
    }
  }
  for (const k of old) s.removeItem(k);
}
