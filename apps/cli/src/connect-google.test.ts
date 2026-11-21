import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GOOGLE_SCOPES } from "@achords/secrets";
import { afterEach, describe, expect, it } from "vitest";
import { connectGoogle } from "./connect-google.ts";

const client = { clientId: "cid.apps", clientSecret: "csecret", projectId: "proj-1" };
let tokenServer: Server | undefined;
afterEach(() => tokenServer?.close());

/** Fake Google token endpoint; records the form it received. */
async function fakeToken(reply: object, status = 200) {
  const seen: URLSearchParams[] = [];
  tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push(new URLSearchParams(body));
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((ok) => tokenServer?.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`, seen };
}

/** Plays the browser: follows the auth URL's redirect_uri with the given params. */
function browser(params: (auth: URL) => Record<string, string>) {
  return (url: string) => {
    const auth = new URL(url);
    const back = new URL(auth.searchParams.get("redirect_uri") ?? "");
    for (const [k, v] of Object.entries(params(auth))) back.searchParams.set(k, v);
    void fetch(back);
  };
}

describe("connectGoogle", () => {
  it("runs PKCE on loopback and stores the four secrets", async () => {
    const tok = await fakeToken({ refresh_token: "rt-1", scope: GOOGLE_SCOPES.join(" ") });
    const stored: Record<string, string> = {};
    let authUrl: URL | undefined;
    await connectGoogle({
      client,
      store: (id, v) => {
        stored[id] = v;
      },
      openUrl: browser((auth) => {
        authUrl = auth;
        return { code: "c-1", state: auth.searchParams.get("state") ?? "" };
      }),
      print: () => {},
      authUrl: "https://accounts.example/auth",
      tokenUrl: tok.url,
    });
    expect(stored).toEqual({
      "google-client-id": "cid.apps",
      "google-client-secret": "csecret",
      "google-refresh-token": "rt-1",
      "google-project-id": "proj-1",
    });
    expect(authUrl?.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(authUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl?.searchParams.get("access_type")).toBe("offline");
    const form = tok.seen[0];
    expect(form?.get("code")).toBe("c-1");
    expect(form?.get("code_verifier")?.length).toBeGreaterThan(40);
  });

  it("refuses a callback with the wrong state and stores nothing", async () => {
    const tok = await fakeToken({ refresh_token: "rt" });
    const stored: string[] = [];
    await expect(
      connectGoogle({
        client,
        store: (id) => stored.push(id),
        openUrl: browser(() => ({ code: "x", state: "forged" })),
        print: () => {},
        tokenUrl: tok.url,
      }),
    ).rejects.toThrow(/unknown or expired/);
    expect(stored).toEqual([]);
    expect(tok.seen).toHaveLength(0);
  });

  it("refuses when a permission box was left unticked", async () => {
    const tok = await fakeToken({ refresh_token: "rt", scope: GOOGLE_SCOPES[0] });
    const stored: string[] = [];
    await expect(
      connectGoogle({
        client,
        store: (id) => stored.push(id),
        openUrl: browser((a) => ({ code: "x", state: a.searchParams.get("state") ?? "" })),
        print: () => {},
        tokenUrl: tok.url,
      }),
    ).rejects.toThrow(/webmasters/);
    expect(stored).toEqual([]);
  });

  it("reports a cancelled sign-in", async () => {
    await expect(
      connectGoogle({
        client,
        store: () => {},
        openUrl: browser((a) => ({
          error: "access_denied",
          state: a.searchParams.get("state") ?? "",
        })),
        print: () => {},
      }),
    ).rejects.toThrow(/access_denied/);
  });
});
