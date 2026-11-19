import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("core scaffold", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@achords/core");
  });
});
