import { describe, expect, it } from "vitest";
import { appearanceAttrs, parseAppearance, resolveTheme } from "./theme.ts";

const DEFAULTS = {
  theme: "system",
  lightAccent: "violet",
  darkAccent: "teal",
};

describe("appearance", () => {
  it("defaults to the system mode, violet (light) and teal (dark)", () => {
    expect(parseAppearance(null)).toEqual(DEFAULTS);
    expect(parseAppearance("garbage")).toEqual(DEFAULTS);
    // Backgrounds are fixed now; an old stored choice is simply ignored.
    expect(parseAppearance('{"theme":"neon","lightBase":"slate","darkAccent":"red"}')).toEqual(
      DEFAULTS,
    );
  });

  it("migrates the old { theme, accent } shape to both accents", () => {
    expect(parseAppearance('{"theme":"dark","accent":"teal"}')).toEqual({
      ...DEFAULTS,
      theme: "dark",
      lightAccent: "teal",
      darkAccent: "teal",
    });
  });

  it("keeps a full new shape", () => {
    const a = {
      theme: "light",
      lightAccent: "rose",
      darkAccent: "amber",
    };
    expect(parseAppearance(JSON.stringify(a))).toEqual(a);
  });

  it("resolves 'system' with the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("picks base and accent by the resolved mode", () => {
    const a = parseAppearance(null);
    expect(appearanceAttrs(a, false)).toEqual({ theme: "light", base: "warm", accent: "violet" });
    expect(appearanceAttrs(a, true)).toEqual({ theme: "dark", base: "graphite", accent: "teal" });
  });
});
