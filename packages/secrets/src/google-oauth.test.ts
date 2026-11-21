import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGoogleSignins, GOOGLE_SCOPES, parseClientJson } from "./google-oauth.ts";

const client = { clientId: "cid.apps", clientSecret: "csecret", projectId: "proj-1" };
const redirect = "http://127.0.0.1:7420/api/oauth/google/callback";
let tokenServer: Server | undefined;
afterEach(() => tokenServer?.close());

/** Fake Google token endpoint; records the forms it received. */
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

describe("parseClientJson", () => {
  it("reads a Desktop-app client", () => {
    const j = JSON.stringify({
      installed: { client_id: "a", client_secret: "b", project_id: "p" },
    });
    expect(parseClientJson(j)).toEqual({ clientId: "a", clientSecret: "b", projectId: "p" });
  });
  it("refuses a web client and junk", () => {
    expect(() => parseClientJson('{"web":{}}')).toThrow(/Desktop app/);
    expect(() => parseClientJson("nope")).toThrow(/JSON/);
  });
});

describe("Google sign-ins", () => {
  const setup = async (
    reply: object = { refresh_token: "rt-1", scope: GOOGLE_SCOPES.join(" ") },
  ) => {
    const tok = await fakeToken(reply);
    const stored: Record<string, string> = {};
    let clock = 1_000;
    const signins = createGoogleSignins({
      store: (id, v) => {
        stored[id] = v;
      },
      tokenUrl: tok.url,
      ttlMs: 60_000,
      now: () => clock,
    });
    return { tok, stored, signins, tick: (ms: number) => (clock += ms) };
  };
  const back = (state: string, extra: Record<string, string> = { code: "c-1" }) =>
    new URLSearchParams({ state, ...extra });

  it("asks for offline access with PKCE and stores the four vault ids once", async () => {
    const { tok, stored, signins } = await setup();
    const { url, state } = signins.start(client, redirect, "session-1");
    const auth = new URL(url);
    expect(auth.searchParams.get("redirect_uri")).toBe(redirect);
    expect(auth.searchParams.get("state")).toBe(state);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(signins.status(state, "session-1")).toEqual({ status: "pending" });

    await signins.finish(back(state));
    expect(stored).toEqual({
      "google-client-id": "cid.apps",
      "google-client-secret": "csecret",
      "google-refresh-token": "rt-1",
      "google-project-id": "proj-1",
    });
    expect(tok.seen[0]?.get("code")).toBe("c-1");
    expect(tok.seen[0]?.get("redirect_uri")).toBe(redirect);
    expect(tok.seen[0]?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(signins.status(state, "session-1")).toEqual({ status: "done" });
    // Single use: a replayed callback exchanges nothing.
    await expect(signins.finish(back(state))).rejects.toThrow(/already used/);
    expect(tok.seen).toHaveLength(1);
  });

  it("refuses a wrong state, another starter, and an expired sign-in", async () => {
    const { tok, stored, signins, tick } = await setup();
    const { state } = signins.start(client, redirect, "session-1");
    await expect(signins.finish(back("forged"))).rejects.toThrow(/unknown or expired/);
    await expect(signins.finish(back(state), { owner: "session-2" })).rejects.toThrow(
      /unknown or expired/,
    );
    expect(signins.status(state, "session-2")).toBeUndefined();
    tick(60_001);
    await expect(signins.finish(back(state), { owner: "session-1" })).rejects.toThrow(
      /unknown or expired/,
    );
    expect(tok.seen).toHaveLength(0);
    expect(stored).toEqual({});
  });

  it("refuses when the starting device is gone", async () => {
    const { tok, signins } = await setup();
    const { state } = signins.start(client, redirect, "session-1");
    await expect(signins.finish(back(state), { accept: () => false })).rejects.toThrow(
      /signed out/,
    );
    expect(tok.seen).toHaveLength(0);
    expect(signins.status(state, "session-1")).toMatchObject({ status: "failed" });
  });

  it("reports a cancelled sign-in and unticked permissions; stores nothing", async () => {
    const { stored, signins } = await setup({ refresh_token: "rt", scope: GOOGLE_SCOPES[0] });
    const a = signins.start(client, redirect, "s").state;
    await expect(signins.finish(back(a, { error: "access_denied" }))).rejects.toThrow(
      /access_denied/,
    );
    const b = signins.start(client, redirect, "s").state;
    await expect(signins.finish(back(b))).rejects.toThrow(/webmasters/);
    expect(signins.status(b, "s")).toMatchObject({ status: "failed", error: /webmasters/ });
    expect(stored).toEqual({});
  });

  it("reports a failed code exchange", async () => {
    const tok = await fakeToken({ error: "invalid_grant", error_description: "Bad Request" }, 400);
    const signins = createGoogleSignins({ store: () => {}, tokenUrl: tok.url });
    const { state } = signins.start(client, redirect, "s");
    await expect(signins.finish(back(state))).rejects.toThrow(/token exchange failed: Bad Request/);
  });
});
