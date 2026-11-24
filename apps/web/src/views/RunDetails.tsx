import { Loader, X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { formatTokens, formatUsd, hasOpenWork, type ThreadSummary } from "../chat.ts";
import { useBackdropClose } from "../components/backdrop.ts";
import { t } from "../i18n.ts";

const CHIP = { running: "done", queued: "local", waiting: "todo", idle: "" } as const;

/** Third column of the chat page (and the info sheet): who works on this chat, tokens, cost. */
export function RunDetails(props: { summary: ThreadSummary; onStop: () => void }) {
  const s = props.summary;
  return (
    <div class="rundetails">
      <div class="card kpi hl">
        <span class="k">
          <Loader class={`icon ${s.agentsWorking ? "spin" : ""}`} />
          {t("chat.activeRun")}
        </span>
        <span class="v">
          {s.tasksDone} / {s.tasksTotal}
        </span>
        <span class="s">
          {t("chat.tasksDone")}
          {" · "}
          {s.waitingOwner ? (
            <strong class="waiting-you">{t("chat.waitingYou")}</strong>
          ) : s.agentsWorking ? (
            t("chat.nWorking", { n: s.agentsWorking })
          ) : (
            t("chat.nothingRunning")
          )}
        </span>
        {/* <progress> keeps the CSP strict: no inline width styles. */}
        <progress max={Math.max(s.tasksTotal, 1)} value={s.tasksDone} />
      </div>
      <div class="kpi-pair">
        <div class="card kpi">
          <span class="k">{t("chat.tokens")}</span>
          <span class="v">{formatTokens(s.tokensIn + s.tokensCached + s.tokensOut)}</span>
          <span class="s">
            {t("chat.tokensInOut", {
              in: formatTokens(s.tokensIn + s.tokensCached),
              cached: formatTokens(s.tokensCached),
              out: formatTokens(s.tokensOut),
            })}
          </span>
          {s.resumedIn + s.resumedCached > 0 && (
            <span class="s">
              {t("chat.resumedRead", {
                in: formatTokens(s.resumedIn + s.resumedCached),
                cached: formatTokens(s.resumedCached),
              })}
            </span>
          )}
        </div>
        <div class="card kpi">
          <span class="k">{t("chat.cost")}</span>
          <span class="v">{formatUsd(s.costUsd)}</span>
          <span class="s">
            {s.budgetDayUsd
              ? t("chat.budgetDay", { usd: formatUsd(s.budgetDayUsd) })
              : t("chat.noBudget")}
          </span>
        </div>
      </div>
      <div class="card kpi participants">
        <div class="k">{t("chat.participants")}</div>
        {s.participants.length === 0 && <p class="muted small">{t("chat.noParticipants")}</p>}
        <ul>
          {s.participants.map((p) => (
            <li key={p.agent} class="row">
              <span class="avatar" aria-hidden="true">
                {p.name.slice(0, 2)}
              </span>
              <span class="grow">{p.name}</span>
              <span class={`chip ${CHIP[p.status]}`}>
                <span class="dot" />
                {t(`chat.status.${p.status}`)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {hasOpenWork(s) && (
        <button type="button" class="btn danger stop-run" onClick={props.onStop}>
          {t("chat.stop")}
        </button>
      )}
    </div>
  );
}

/**
 * The run details when there is no room for the third column: a bottom sheet on phones (the More
 * sheet pattern), a side sheet on narrower desktops.
 */
export function RunSheet(props: {
  open: boolean;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropClose(ref, props.onClose);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      class="more-sheet run-sheet"
      aria-label={t("chat.details")}
      onClose={props.onClose}
      {...backdrop}
    >
      <span class="grabber" />
      <header class="row">
        <h2 class="grow">{t("chat.details")}</h2>
        <button
          type="button"
          class="iconbtn sheet-close"
          onClick={props.onClose}
          aria-label={t("common.close")}
        >
          <X class="icon" />
        </button>
      </header>
      {props.children}
    </dialog>
  );
}
