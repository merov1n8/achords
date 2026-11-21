import { KeyRound, Plus, Trash2 } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import { SecretInput } from "../views/SecretInput.tsx";
import { Confirm, Modal } from "./Modal.tsx";

type Site = {
  url: string;
  secrets: { user: string; password: string };
  missing: string[];
  legacy: boolean;
  ready: boolean;
};

/**
 * A project's WordPress sites (ADR-0047): any number, each with its own user and application
 * password in the vault (write-only). `slug` may be "own" for work without a client.
 */
export function Sites(props: { slug: string }) {
  const base = `/api/projects/${props.slug}/sites/wordpress`;
  const sites = usePoll(() => api<{ sites: Site[] }>(base), 30000, [props.slug]);
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const list = sites.data?.sites ?? [];
  return (
    <div class="field">
      <div class="row">
        <span class="grow">{t("sites.title")}</span>
        <button type="button" class="btn" onClick={() => setAdding(true)}>
          <Plus class="icon" />
          {t("sites.add")}
        </button>
      </div>
      {list.length === 0 ? (
        <span class="muted small">{t("sites.empty")}</span>
      ) : (
        <table>
          <tbody>
            {list.map((s) => (
              <tr key={s.url}>
                <td>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.url}
                  </a>
                </td>
                <td>
                  {s.ready ? (
                    <span class="chip done">{t("integrations.ready")}</span>
                  ) : (
                    <span class="chip local">{t("sites.needsLogin")}</span>
                  )}
                </td>
                <td class="actions">
                  <button type="button" class="btn ghost" onClick={() => setCreds(s.url)}>
                    <KeyRound class="icon" />
                    {t("sites.login")}
                  </button>
                  <button
                    type="button"
                    class="iconbtn"
                    aria-label={t("sites.remove")}
                    title={t("sites.remove")}
                    onClick={() => setRemoving(s.url)}
                  >
                    <Trash2 class="icon" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span class="muted small">{t("sites.help")}</span>
      {sites.error && <span class="error small">{sites.error}</span>}
      {adding && (
        <AddSite
          base={base}
          onClose={() => setAdding(false)}
          onAdded={(url) => {
            setAdding(false);
            sites.refresh();
            setCreds(url);
          }}
        />
      )}
      {creds && (
        <SiteLogin
          slug={props.slug}
          url={creds}
          onClose={() => setCreds(undefined)}
          onSaved={sites.refresh}
        />
      )}
      {removing && (
        <Confirm
          title={t("sites.removeTitle")}
          message={t("sites.removeConfirm", { url: removing })}
          confirmLabel={t("sites.remove")}
          danger
          onConfirm={async () => {
            await api(`${base}/${encodeURIComponent(removing)}`, { method: "DELETE" });
            sites.refresh();
          }}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </div>
  );
}

function AddSite(props: { base: string; onClose: () => void; onAdded: (url: string) => void }) {
  const [url, setUrl] = useState("https://");
  const [error, setError] = useState<string>();
  const submit = async (e: Event) => {
    e.preventDefault();
    setError(undefined);
    try {
      const out = await api<{ sites: Site[] }>(props.base, { method: "POST", body: { url } });
      // The API normalises the address (lowercase host, no trailing slash).
      const added = out.sites.find(
        (s) => s.url.toLowerCase() === url.trim().replace(/\/+$/, "").toLowerCase(),
      );
      props.onAdded(added?.url ?? out.sites.at(-1)?.url ?? url);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title={t("sites.add")}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="add-site" class="btn primary">
            {t("sites.add")}
          </button>
        </>
      }
    >
      <form id="add-site" onSubmit={submit}>
        <label class="field">
          {t("sites.address")}
          <input
            class="input"
            type="url"
            inputMode="url"
            required
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </label>
        {error && <p class="error">{error}</p>}
      </form>
    </Modal>
  );
}

/**
 * The login of one WordPress site (user + application password, write-only into the vault).
 * Closes once both are set. Used under Projects → Edit and on the Integrations page.
 */
export function SiteLogin(props: {
  slug: string;
  url: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const base = `/api/projects/${props.slug}/sites/wordpress`;
  const sites = usePoll(() => api<{ sites: Site[] }>(base), 30000, [props.slug]);
  const site = sites.data?.sites.find((s) => s.url === props.url);
  const [savedParts, setSavedParts] = useState<string[]>([]);
  const saved = (part: "user" | "password") => {
    sites.refresh();
    props.onSaved();
    const now = [...savedParts, part];
    setSavedParts(now);
    const isSet = (p: "user" | "password") =>
      now.includes(p) || site?.legacy || !site?.missing.includes(site.secrets[p]);
    if (isSet("user") && isSet("password")) props.onClose();
  };
  return (
    <Modal title={t("sites.loginTitle", { url: props.url })} onClose={props.onClose}>
      {site ? (
        <>
          <p class="muted small">{t("sites.loginHelp")}</p>
          <SecretInput
            id={site.secrets.user}
            label={t("projects.wordpressUser")}
            type="text"
            set={!site.missing.includes(site.secrets.user) || site.legacy}
            onSaved={() => saved("user")}
          />
          <SecretInput
            id={site.secrets.password}
            label={t("projects.wordpressPassword")}
            set={!site.missing.includes(site.secrets.password) || site.legacy}
            onSaved={() => saved("password")}
          />
          {site.legacy && <p class="muted small">{t("sites.legacy")}</p>}
        </>
      ) : (
        <p class={sites.error ? "error" : "muted"}>{sites.error ?? t("app.loading")}</p>
      )}
    </Modal>
  );
}
