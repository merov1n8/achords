import { useState } from "preact/hooks";
import { pair } from "../api.ts";
import { Mark } from "../components/Mark.tsx";
import { t } from "../i18n.ts";

export function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await pair(code.trim(), name.trim() || "browser");
      onPaired();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="pair panel">
      <div class="brand">
        <Mark />
        <span class="lbl">achords</span>
      </div>
      <p class="muted">{t("pair.intro")}</p>
      <form onSubmit={submit}>
        <label class="field">
          {t("pair.code")}
          <input
            class="input"
            value={code}
            onInput={(e) => setCode(e.currentTarget.value)}
            placeholder="ABCD-EF23"
            autocomplete="one-time-code"
            autofocus
            required
          />
        </label>
        <label class="field">
          {t("pair.deviceName")}
          <input
            class="input"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            maxlength={100}
          />
        </label>
        <button type="submit" class="btn primary" disabled={busy}>
          {t("pair.submit")}
        </button>
        {error && <p class="error">{error}</p>}
      </form>
    </main>
  );
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Mac/.test(ua)
      ? "Mac"
      : /Android/.test(ua)
        ? "Android"
        : /Linux/.test(ua)
          ? "Linux"
          : /Windows/.test(ua)
            ? "Windows"
            : "Device";
  const browser = /Firefox/.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "Browser";
  return `${os} ${browser}`;
}
