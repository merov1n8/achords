import { describe, expect, it } from "vitest";
import { parseAppearance, resolveTheme } from "./theme.ts";

describe("appearance", () => {
  it("defaults to following the system, violet accent", () => {
    expect(parseAppearance(null)).toEqual({ theme: "system", accent: "violet" });
    expect(parseAppearance("garbage")).toEqual({ theme: "system", accent: "violet" });
    expect(parseAppearance('{"theme":"dark","accent":"teal"}')).toEqual({
      theme: "dark",
      accent: "teal",
    });
    expect(parseAppearance('{"theme":"neon","accent":"red"}')).toEqual({
      theme: "system",
      accent: "violet",
    });
  });

  it("resolves 'system' with the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
