import { describe, expect, it } from "vitest";
import { tailscaleHost } from "./tailscale.ts";

describe("tailscale host name", () => {
  it("returns this machine's MagicDNS name without the trailing dot", () => {
    const json = JSON.stringify({ Self: { DNSName: "mac.tail5d5684.ts.net.", Online: true } });
    expect(tailscaleHost(json)).toBe("mac.tail5d5684.ts.net");
  });
  it("is undefined when Tailscale is logged out, offline or the output is not JSON", () => {
    expect(tailscaleHost(JSON.stringify({ Self: { DNSName: "" } }))).toBeUndefined();
    expect(tailscaleHost(JSON.stringify({ BackendState: "NeedsLogin" }))).toBeUndefined();
    expect(tailscaleHost("not json")).toBeUndefined();
  });
  it("accepts only a ts.net name (nothing a status output could smuggle in)", () => {
    expect(
      tailscaleHost(JSON.stringify({ Self: { DNSName: "evil.example.com." } })),
    ).toBeUndefined();
    expect(tailscaleHost(JSON.stringify({ Self: { DNSName: "a b.ts.net." } }))).toBeUndefined();
  });
});
