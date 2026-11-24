import { describe, expect, it } from "vitest";
import { classPayload, flipEnv, siteLists, toLists, toRows } from "./accounts.ts";

describe("account rows (ADR-0067 live/staging)", () => {
  it("one row per entry with its tag, sites left out", () => {
    expect(
      toRows({
        ga4: [
          { value: "1", env: "live" },
          { value: "2", env: "staging" },
        ],
        wordpress: [{ value: "https://a.example", env: "live" }],
      }),
    ).toEqual([
      { channel: "ga4", value: "1", env: "live" },
      { channel: "ga4", value: "2", env: "staging" },
    ]);
  });

  it("builds the payload: trimmed, grouped by channel, blanks and repeats left out", () => {
    expect(
      toLists([
        { channel: "GA4 ", value: " 1 ", env: "staging" },
        { channel: "ga4", value: "1", env: "live" },
        { channel: "ga4", value: "2", env: "live" },
        { channel: "", value: "x", env: "live" },
        { channel: "website", value: "  ", env: "live" },
      ]),
    ).toEqual({
      ga4: [
        { value: "1", env: "staging" },
        { value: "2", env: "live" },
      ],
    });
  });

  it("keeps site lists for sending back, flips a tag", () => {
    expect(siteLists({ ga4: ["1"], wordpress: ["https://a.example"] })).toEqual({
      wordpress: ["https://a.example"],
    });
    expect(flipEnv("live")).toBe("staging");
    expect(flipEnv("staging")).toBe("live");
  });
});

describe("classPayload", () => {
  it("sends nothing while no class is chosen", () => {
    expect(classPayload(null, false, false)).toEqual({});
  });
  it("the spend switch goes with experimental and is switched off when leaving it", () => {
    expect(classPayload("experimental", true, false)).toEqual({
      class: "experimental",
      spend_without_asking: true,
    });
    expect(classPayload("secured", true, true)).toEqual({
      class: "secured",
      spend_without_asking: false,
    });
    expect(classPayload("secured", false, false)).toEqual({ class: "secured" });
  });
});
