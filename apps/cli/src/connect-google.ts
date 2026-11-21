// `achords connect google <client.json>`: the Google sign-in from the terminal. The OAuth part
// (state, PKCE, code exchange, vault ids) is shared with the web sign-in in @achords/secrets;
// here only a one-off loopback server receives Google's redirect.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGoogleSignins, type GoogleClient } from "@achords/secrets";

export interface ConnectDeps {
  client: GoogleClient;
  store: (id: string, value: string) => void;
  openUrl: (url: string) => void;
  print: (line: string) => void;
  authUrl?: string;
  tokenUrl?: string;
  timeoutMs?: number;
}

const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>achords</title><body style="font-family:system-ui;padding:2rem"><p>${msg}</p></body>`;

export async function connectGoogle(deps: ConnectDeps): Promise<{ scopes: string[] }> {
  const signins = createGoogleSignins({
    store: deps.store,
    ...(deps.authUrl ? { authUrl: deps.authUrl } : {}),
    ...(deps.tokenUrl ? { tokenUrl: deps.tokenUrl } : {}),
  });
  let settle: { ok: (r: { scopes: string[] }) => void; fail: (e: Error) => void } | undefined;
  const done = new Promise<{ scopes: string[] }>((ok, fail) => {
    settle = { ok, fail };
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    signins.finish(u.searchParams).then(
      (r) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Google connected to achords. You can close this tab."));
        settle?.ok(r);
      },
      (err: Error) => {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Sign-in did not work. See the terminal, then run the command again."));
        settle?.fail(err);
      },
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const timer = setTimeout(
    () => settle?.fail(new Error("timed out waiting for the Google sign-in")),
    deps.timeoutMs ?? 5 * 60_000,
  );
  try {
    const { url } = signins.start(deps.client, redirect, "cli");
    deps.print("Opening the Google sign-in in your browser. If it does not open, visit:");
    deps.print(url);
    deps.openUrl(url);
    return await done;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
