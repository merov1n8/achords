import type { RefObject } from "preact";
import { useRef } from "preact/hooks";

/**
 * A click counts as "on the backdrop" only when the press also started there. A text selection
 * that starts in a field and ends outside the dialog fires `click` on the dialog itself, which
 * closed forms while the owner was editing them.
 */
export function isBackdropClick(down: unknown, up: unknown, dialog: unknown) {
  return dialog !== null && down === dialog && up === dialog;
}

/** Handlers for a native <dialog> that closes on a real backdrop click (survives re-renders). */
export function useBackdropClose(ref: RefObject<HTMLDialogElement | null>, onClose: () => void) {
  const down = useRef<EventTarget | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      down.current = e.target;
    },
    onClick: (e: MouseEvent) => {
      if (isBackdropClick(down.current, e.target, ref.current)) onClose();
      down.current = null;
    },
  };
}
