import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { type SigninService, signinServices } from "../integrations.ts";
import type { Agent, IntegrationStatus } from "../types.ts";
import { SecretInput } from "./SecretInput.tsx";

/** "Add sign-in": pick a shared service, then sign in to Google or type the tokens. */
export function AddSignin(props: {
  items: IntegrationStatus[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const services = signinServices(props.items);
  const [key, setKey] = useState(services[0]?.key ?? "");
  const service = services.find((s) => s.key === key);
  // Saved means done: refresh the page behind and close.
  const done = () => {
    props.onSaved();
    props.onClose();
  };
  return (
    <Modal
      title={t("integrations.addSignin")}
      onClose={props.onClose}
      footer={
        <button type="button" class="btn ghost" onClick={props.onClose}>
          {t("common.close")}
        </button>
      }
    >
      <label class="field">
        {t("integrations.service")}
        <select class="input" value={key} onChange={(e) => setKey(e.currentTarget.value)}>
          {services.map((s) => (
            <option key={s.key} value={s.key}>
              {s.oauth ? `${s.name} (${s.entries.map((e) => e.name).join(", ")})` : s.name}
            </option>
          ))}
        </select>
      </label>
      {service?.oauth === "google" ? (
        <GoogleSignin key={key} onSaved={done} />
      ) : (
        service && <Tokens key={key} service={service} onSaved={props.onSaved} onDone={done} />
      )}
    </Modal>
  );
}

/** Write-only inputs for the vault ids the service's entries use. */
function Tokens(props: { service: SigninService; onSaved: () => void; onDone: () => void }) {
  const ids = [...new Set(props.service.entries.flatMap((e) => e.secrets))];
  const missing = new Set(props.service.entries.flatMap((e) => e.missingSecrets));
  const [saved, setSaved] = useState<string[]>([]);
  // Closes once every missing token is saved (or after replacing one when none was missing).
  const onSaved = (id: string) => {
    const now = [...saved, id];
    setSaved(now);
    if ([...missing].every((m) => now.includes(m))) props.onDone();
    else props.onSaved();
  };
  return (
    <>
      <p class="muted small">{t("integrations.tokensHelp")}</p>
      {ids.map((id) => (
        <SecretInput
          key={id}
          id={id}
          label={t("integrations.setSecret")}
          set={!missing.has(id)}
          onSaved={() => onSaved(id)}
        />
      ))}
    </>
  );
}

type Phase =
  | { at: "client" }
  | { at: "waiting"; url: string; state: string }
  | { at: "done" }
  | { at: "failed"; error: string };

/**
 * Google from the web (ADR-0048): the Desktop-app client JSON, then Google's consent page in a
 * new tab. Google sends the browser back to the gateway on 127.0.0.1; on another device that
 * page fails to load, so its address can be pasted here instead.
 */
function GoogleSignin(props: { onSaved: () => void }) {
  const [client, setClient] = useState("");
  const [phase, setPhase] = useState<Phase>({ at: "client" });
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Wait for the callback to land (same computer).
  const waiting = phase.at === "waiting" ? phase.state : undefined;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      try {
        const s = await api<{ status: string; error?: string }>(
          `/api/oauth/google/status/${waiting}`,
        );
        if (s.status === "done") {
          setPhase({ at: "done" });
          props.onSaved();
        } else if (s.status === "failed") setPhase({ at: "failed", error: s.error ?? "" });
      } catch (err) {
        setPhase({ at: "failed", error: (err as Error).message });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting]);

  const start = async () => {
    setError(undefined);
    setBusy(true);
    // Opened in the click itself, so the browser does not block it; filled in once known.
    const tab = window.open("", "_blank");
    try {
      const out = await api<{ url: string; state: string }>("/api/oauth/google/start", {
        method: "POST",
        body: { client: client.trim() },
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = out.url;
      }
      setPhase({ at: "waiting", ...out });
    } catch (err) {
      tab?.close();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await api("/api/oauth/google/finish", { method: "POST", body: { url: pasted.trim() } });
      setPhase({ at: "done" });
      props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase.at === "done") return <p>✓ {t("integrations.google.done")}</p>;
  if (phase.at === "failed") {
    return (
      <>
        <p class="error">{t("integrations.google.failed", { reason: phase.error })}</p>
        <button type="button" class="btn" onClick={() => setPhase({ at: "client" })}>
          {t("integrations.google.again")}
        </button>
      </>
    );
  }
  if (phase.at === "waiting") {
    return (
      <>
        <p>
          {t("integrations.google.waiting")}{" "}
          <a href={phase.url} target="_blank" rel="noopener noreferrer">
            {t("integrations.google.openAgain")}
          </a>
        </p>
        <label class="field">
          {t("integrations.google.paste")}
          <input
            class="input mono"
            type="text"
            autocomplete="off"
            placeholder="http://127.0.0.1:…/api/oauth/google/callback?…"
            value={pasted}
            onInput={(e) => setPasted(e.currentTarget.value)}
          />
        </label>
        <button type="button" class="btn" disabled={busy || !pasted.trim()} onClick={finish}>
          {t("integrations.google.finish")}
        </button>
        {error && <p class="error small">{error}</p>}
      </>
    );
  }
  return (
    <>
      <p class="muted small">{t("integrations.google.help")}</p>
      <label class="field">
        {t("integrations.google.file")}
        <input
          class="input"
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            if (file) setClient(await file.text());
          }}
        />
      </label>
      <label class="field">
        {t("integrations.google.pasteJson")}
        <textarea
          class="input mono"
          rows={4}
          spellcheck={false}
          value={client}
          onInput={(e) => setClient(e.currentTarget.value)}
        />
      </label>
      <button type="button" class="btn primary" disabled={busy || !client.trim()} onClick={start}>
        {t("integrations.google.signIn")}
      </button>
      {error && <p class="error small">{error}</p>}
    </>
  );
}

/** "Add app" / "Edit": a local app, whether its program is found, and which agents may use it. */
export function LocalApp(props: {
  items: IntegrationStatus[];
  /** Editing this one (fixed); otherwise the owner picks. */
  edit?: IntegrationStatus;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(props.edit?.id ?? props.items[0]?.id ?? "");
  const app = props.items.find((s) => s.id === id);
  const [agents, setAgents] = useState<Agent[]>();
  const [chosen, setChosen] = useState<string[]>(app?.usedBy ?? []);
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<Agent[]>("/api/agents")
      .then(setAgents)
      .catch((err: Error) => setError(err.message));
  }, []);
  const pick = (next: string) => {
    setId(next);
    setChosen(props.items.find((s) => s.id === next)?.usedBy ?? []);
  };
  const save = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/api/integrations/${id}/agents`, { method: "PUT", body: { agents: chosen } });
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title={props.edit ? props.edit.name : t("integrations.addApp")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="local-app" class="btn primary" disabled={!app}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <form id="local-app" onSubmit={save}>
        {!props.edit && (
          <label class="field">
            {t("integrations.app")}
            <select class="input" value={id} onChange={(e) => pick(e.currentTarget.value)}>
              {props.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {app && (
          <div class="field small">
            {app.commandFound ? (
              <span class="muted">
                ✓ {t("integrations.programFound", { command: app.command ?? "" })}
              </span>
            ) : (
              <>
                <span class="error">
                  {t("integrations.noCommand", { command: app.command ?? "" })}
                </span>
                {app.install && <span class="muted">{app.install}</span>}
              </>
            )}
          </div>
        )}
        <div class="field">
          {t("integrations.whichAgents")}
          <div class="row wrap">
            {(agents ?? []).map((a) => (
              <label key={a.id} class="row">
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  onChange={() =>
                    setChosen(
                      chosen.includes(a.id) ? chosen.filter((x) => x !== a.id) : [...chosen, a.id],
                    )
                  }
                />
                {a.name} <code class="muted small">{a.id}</code>
              </label>
            ))}
          </div>
        </div>
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}
