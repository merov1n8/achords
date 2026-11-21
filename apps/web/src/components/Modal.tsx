import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { t } from "../i18n.ts";

/**
 * A modal on the native <dialog>: focus stays inside, Escape and a click on the backdrop close
 * it. Used for every add, edit and confirm form so the pages stay tables.
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click mirrors Escape, which the native dialog handles
    <dialog
      ref={ref}
      class={`modal ${props.wide ? "wide" : ""}`}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose();
      }}
    >
      <header class="modal-h">
        <h2 id={titleId}>{props.title}</h2>
        <button
          type="button"
          class="iconbtn"
          onClick={props.onClose}
          aria-label={t("common.close")}
        >
          <X class="icon" />
        </button>
      </header>
      <div class="modal-b">{props.children}</div>
      {props.footer && <footer class="modal-f">{props.footer}</footer>}
    </dialog>
  );
}

/** "Are you sure?" in a small modal; the action runs only on the explicit button. */
export function Confirm(props: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await props.onConfirm();
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            class={`btn ${props.danger ? "danger-solid" : "primary"}`}
            disabled={busy}
            onClick={run}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p>{props.message}</p>
      {error && <p class="error">{error}</p>}
    </Modal>
  );
}
