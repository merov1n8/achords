import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { usePoll } from "../poll.ts";
import { SecretInput } from "../views/SecretInput.tsx";

/**
 * ADR-0067: the project's push token for its git repositories (level 5 agents push through the
 * gateway's credential helper). Write-only into the vault; shown only with a repository listed.
 */
export function GitToken(props: { slug: string }) {
  const token = usePoll(
    () =>
      api<{ id: string; set: boolean; repositories: string[] }>(
        `/api/projects/${props.slug}/git-token`,
      ),
    30000,
    [props.slug],
  );
  const d = token.data;
  if (!d?.repositories.length) return null;
  return (
    <div class="field">
      <span>
        {t("gitToken.title")}{" "}
        {d.set ? (
          <span class="chip done">{t("integrations.ready")}</span>
        ) : (
          <span class="chip local">{t("gitToken.missing")}</span>
        )}
      </span>
      <span class="muted small">{d.repositories.join(", ")}</span>
      <SecretInput id={d.id} label={t("gitToken.label")} set={d.set} onSaved={token.refresh} />
      <span class="muted small">{t("gitToken.help")}</span>
      {token.error && <span class="error small">{token.error}</span>}
    </div>
  );
}
