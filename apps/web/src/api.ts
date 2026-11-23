export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Per-session anti-CSRF token, held in memory only (the session itself is an HttpOnly cookie).
let csrf: string | undefined;

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(init.body !== undefined || method !== "GET"
        ? { "content-type": "application/json" }
        : {}),
      ...(csrf && method !== "GET" ? { "x-achords-csrf": csrf } : {}),
    },
    ...(init.body !== undefined
      ? { body: JSON.stringify(init.body) }
      : method !== "GET"
        ? { body: "{}" }
        : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

/** Returns the device name if this browser is paired, undefined if not. */
export async function loadSession(): Promise<string | undefined> {
  try {
    const s = await api<{ device: { deviceName: string }; csrf: string }>("/api/session");
    csrf = s.csrf;
    return s.device.deviceName;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return undefined;
    throw err;
  }
}

export async function pair(code: string, deviceName: string): Promise<void> {
  const r = await api<{ csrf: string }>("/api/pair", {
    method: "POST",
    body: { code, deviceName },
  });
  csrf = r.csrf;
}

export async function logout(): Promise<void> {
  await api("/api/logout", { method: "POST" });
  csrf = undefined;
}

/** Sends a recorded voice note; the gateway transcribes it locally and returns the text. */
export async function transcribe(audio: Blob): Promise<string> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": audio.type || "audio/webm",
      ...(csrf ? { "x-achords-csrf": csrf } : {}),
    },
    body: audio,
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data.text ?? "";
}

/** Uploads one image for a chat; returns its path on the host (for the message's image line). */
export async function uploadImage(threadId: string, file: Blob): Promise<string> {
  const res = await fetch(`/api/threads/${threadId}/images`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": file.type, ...(csrf ? { "x-achords-csrf": csrf } : {}) },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !data.path) throw new ApiError(res.status, data.error ?? res.statusText);
  return data.path;
}
