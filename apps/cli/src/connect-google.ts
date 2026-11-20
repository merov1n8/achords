// `achords connect google <client.json>`: one OAuth sign-in for the owner's Google account
// (ADR-0034). Desktop-app client, loopback redirect and PKCE, so the browser talks to Google
// directly and achords never sees the password. The resulting refresh token and the client
// credentials go straight into the vault under the ids the catalog references.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  // The Search Console server asks for the full scope; its write tools stay unlisted.
  "https://www.googleapis.com/auth/webmasters",
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

export interface ConnectDeps {
  client: GoogleClient;
  store: (id: string, value: string) => void;
  openUrl: (url: string) => void;
  print: (line: string) => void;
  authUrl?: string;
  tokenUrl?: string;
  timeoutMs?: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>achords</title><body style="font-family:system-ui;padding:2rem"><p>${msg}</p></body>`;

export async function connectGoogle(deps: ConnectDeps): Promise<{ scopes: string[] }> {
  const { client } = deps;
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let settle: { ok: (code: string) => void; fail: (e: Error) => void } | undefined;
  const codeP = new Promise<string>((ok, fail) => {
    settle = { ok, fail };
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (u.searchParams.get("state") !== state) {
      res.end(page("Sign-in refused: state mismatch. Run the command again."));
      settle?.fail(new Error("state mismatch (stale or foreign callback)"));
    } else if (u.searchParams.get("error")) {
      res.end(page("Sign-in was cancelled or refused. You can close this tab."));
      settle?.fail(new Error(`Google refused: ${u.searchParams.get("error")}`));
    } else {
      res.end(page("Google connected to achords. You can close this tab."));
      settle?.ok(u.searchParams.get("code") ?? "");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const timer = setTimeout(
    () => settle?.fail(new Error("timed out waiting for the Google sign-in")),
    deps.timeoutMs ?? 5 * 60_000,
  );

  try {
    const q = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      // offline + consent: Google returns a refresh token even on a repeated sign-in.
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const url = `${deps.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth"}?${q}`;
    deps.print("Opening the Google sign-in in your browser. If it does not open, visit:");
    deps.print(url);
    deps.openUrl(url);

    const code = await codeP;
    const res = await fetch(deps.tokenUrl ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirect,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const tok = (await res.json()) as {
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

    deps.store("google-client-id", client.clientId);
    deps.store("google-client-secret", client.clientSecret);
    deps.store("google-refresh-token", tok.refresh_token);
    if (client.projectId) deps.store("google-project-id", client.projectId);
    return { scopes };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
