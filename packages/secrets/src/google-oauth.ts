// One Google sign-in for the owner's account (ADR-0034, ADR-0048), shared by
// `achords connect google` and the gateway's web sign-in. Desktop-app client, loopback redirect
// and PKCE: the browser talks to Google directly and achords never sees the password. The
// refresh token and the client credentials go straight into the vault under the ids the
// catalog references.
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  // The Search Console server asks for the full scope; its write tools stay unlisted.
  "https://www.googleapis.com/auth/webmasters",
];

/** Vault ids a Google sign-in fills (shared by Analytics 4 and Search Console). */
export const GOOGLE_VAULT_IDS = [
  "google-client-id",
  "google-client-secret",
  "google-refresh-token",
  "google-project-id",
];

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  projectId: string;
}

/** Reads the client JSON downloaded from Google Cloud; only the Desktop-app type works. */
export function parseClientJson(text: string): GoogleClient {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("not a JSON file");
  }
  const j = json as { installed?: Record<string, unknown>; web?: unknown };
  if (!j.installed) {
    throw new Error(
      j.web
        ? 'this is a "Web application" client; create a "Desktop app" OAuth client instead'
        : 'no "installed" section: download the JSON of a "Desktop app" OAuth client',
    );
  }
  const { client_id, client_secret, project_id } = j.installed;
  if (typeof client_id !== "string" || typeof client_secret !== "string") {
    throw new Error("client_id or client_secret missing in the JSON");
  }
  return { clientId: client_id, clientSecret: client_secret, projectId: String(project_id ?? "") };
}

export interface GoogleSigninDeps {
  store: (id: string, value: string) => void;
  authUrl?: string;
  tokenUrl?: string;
  /** How long a started sign-in may be finished (default 10 minutes). */
  ttlMs?: number;
  now?: () => number;
}

interface Pending {
  client: GoogleClient;
  redirect: string;
  verifier: string;
  /** Who started it (a web session id, "cli"): only they may finish it by pasted address. */
  owner: string;
  expires: number;
  result?: { ok: true } | { ok: false; error: string };
}

export type SigninState = { status: "pending" | "done" } | { status: "failed"; error: string };

const MAX_PENDING = 10;
const b64url = (b: Buffer) => b.toString("base64url");

/**
 * Started sign-ins, keyed by their random `state`. A state is single use and expires; the code
 * from Google is exchanged at most once, then the four vault ids are written.
 */
export function createGoogleSignins(deps: GoogleSigninDeps) {
  const ttl = deps.ttlMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const prune = () => {
    for (const [s, p] of pending) if (p.expires <= now()) pending.delete(s);
    // Oldest first (insertion order): a flood of starts cannot grow the map without limit.
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
  };

  return {
    /** The Google consent address to open; `redirect` is where Google sends the browser back. */
    start(client: GoogleClient, redirect: string, owner: string): { url: string; state: string } {
      const state = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(48));
      pending.set(state, { client, redirect, verifier, owner, expires: now() + ttl });
      prune();
      const q = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        // offline + consent: Google returns a refresh token even on a repeated sign-in.
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      });
      return {
        url: `${deps.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth"}?${q}`,
        state,
      };
    },

    /** How a sign-in started by `owner` went (for the page waiting on it). */
    status(state: string, owner: string): SigninState | undefined {
      prune();
      const p = pending.get(state);
      if (!p || p.owner !== owner) return undefined;
      if (!p.result) return { status: "pending" };
      return p.result.ok ? { status: "done" } : { status: "failed", error: p.result.error };
    },

    /**
     * Finishes a sign-in from the parameters Google sent back (`state`, `code` or `error`).
     * `owner`, when given, must be who started it (a pasted address); `accept` re-checks the
     * starter at callback time (e.g. the web session is still valid). Throws a plain reason.
     */
    async finish(
      params: URLSearchParams,
      opts: { owner?: string; accept?: (owner: string) => boolean } = {},
    ): Promise<{ scopes: string[] }> {
      prune();
      const state = params.get("state") ?? "";
      const p = pending.get(state);
      if (!p || (opts.owner !== undefined && p.owner !== opts.owner)) {
        throw new Error("this sign-in is unknown or expired; start it again");
      }
      if (p.result) throw new Error("this sign-in was already used; start it again");
      const fail = (error: string): never => {
        p.result = { ok: false, error };
        throw new Error(error);
      };
      if (opts.accept && !opts.accept(p.owner)) fail("the device that started it is signed out");
      const refused = params.get("error");
      if (refused) fail(`Google refused the sign-in (${refused})`);
      const code = params.get("code");
      if (!code) fail("the address has no sign-in code");
      p.result = { ok: false, error: "still exchanging" }; // single use from here on
      try {
        const scopes = await exchange(p, code as string);
        p.result = { ok: true };
        return { scopes };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };

  async function exchange(p: Pending, code: string): Promise<string[]> {
    const res = await fetch(deps.tokenUrl ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: p.client.clientId,
        client_secret: p.client.clientSecret,
        redirect_uri: p.redirect,
        grant_type: "authorization_code",
        code_verifier: p.verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const tok = (await res.json().catch(() => ({}))) as {
      refresh_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok) {
      throw new Error(`token exchange failed: ${tok.error_description ?? tok.error ?? res.status}`);
    }
    if (!tok.refresh_token) throw new Error("Google returned no refresh token");
    const scopes = (tok.scope ?? "").split(" ").filter(Boolean);
    const missing = GOOGLE_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) {
      throw new Error(`permissions not granted: ${missing.join(", ")} (tick every box)`);
    }
    deps.store("google-client-id", p.client.clientId);
    deps.store("google-client-secret", p.client.clientSecret);
    deps.store("google-refresh-token", tok.refresh_token);
    if (p.client.projectId) deps.store("google-project-id", p.client.projectId);
    return scopes;
  }
}

export type GoogleSignins = ReturnType<typeof createGoogleSignins>;
