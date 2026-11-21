import { describe, expect, it } from "vitest";
import { isBackdropClick } from "./backdrop.ts";

describe("backdrop click", () => {
  const dialog = {};
  const field = {};
  it("closes only when the press started and ended on the backdrop", () => {
    expect(isBackdropClick(dialog, dialog, dialog)).toBe(true);
  });
  it("keeps the dialog open for a text selection dragged out of a field", () => {
    expect(isBackdropClick(field, dialog, dialog)).toBe(false);
    expect(isBackdropClick(null, dialog, dialog)).toBe(false);
    expect(isBackdropClick(dialog, field, dialog)).toBe(false);
  });
});
