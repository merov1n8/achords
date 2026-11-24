import { type Env, flipEnv } from "../accounts.ts";
import { t } from "../i18n.ts";

/** An account's or site's live/staging tag (ADR-0067): one tap switches it. */
export function EnvToggle(props: { env: Env; onChange: (env: Env) => void }) {
  return (
    <button
      type="button"
      class={`btn env ${props.env}`}
      title={t("env.toggle")}
      aria-label={`${t("env.toggle")}: ${props.env === "live" ? t("env.live") : t("env.staging")}`}
      onClick={() => props.onChange(flipEnv(props.env))}
    >
      {props.env === "live" ? t("env.live") : t("env.staging")}
    </button>
  );
}
