import { MessageSquare, Play, Plus, Trash2 } from "lucide-preact";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { Confirm, Modal } from "../components/Modal.tsx";
import { t } from "../i18n.ts";
import { ago, columnLabel } from "../kanban.ts";
import { usePoll } from "../poll.ts";
import type { Agent, Task } from "../types.ts";

type Item = { id: number; text: string; done: boolean };
type Comment = { id: number; text: string; createdAt: number };
type Detail = Task & { description: string | null; checklist: Item[]; comments: Comment[] };

/** Card details: edit title and description, sub-items, own comments, move, start, delete. */
export function CardModal(props: {
  id: string;
  columns: string[];
  agents: Agent[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/tasks/${props.id}`;
  const card = usePoll(() => api<Detail>(base), 10000, [props.id]);
  const [title, setTitle] = useState<string>();
  const [desc, setDesc] = useState<string>();
  const [newItem, setNewItem] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [startAgent, setStartAgent] = useState("");
  const c = card.data;
  const workers = props.agents.filter((a) => a.id !== "boss");

  const call = async (path: string, method: string, body?: unknown) => {
    setError(undefined);
    try {
      await api(path, { method, ...(body !== undefined ? { body } : {}) });
      card.refresh();
      props.onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  const dirty =
    c &&
    ((title ?? c.title) !== c.title || (desc ?? c.description ?? "") !== (c.description ?? ""));
  const save = async () => {
    if (!c) return;
    const body = {
      ...((title ?? c.title) !== c.title ? { title } : {}),
      ...((desc ?? c.description ?? "") !== (c.description ?? "") ? { description: desc } : {}),
    };
    if (await call(base, "PATCH", body)) {
      setTitle(undefined);
      setDesc(undefined);
    }
  };

  if (confirmDelete && c) {
    return (
      <Confirm
        title={t("card.deleteTitle")}
        message={t("card.deleteConfirm", { title: c.title })}
        confirmLabel={t("card.delete")}
        danger
        onConfirm={async () => {
          await api(base, { method: "DELETE" });
          props.onChanged();
          props.onClose();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <Modal
      wide
      title={c?.title ?? t("app.loading")}
      onClose={props.onClose}
      footer={
        c && (
          <>
            <button type="button" class="btn danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 class="icon" />
              {t("card.delete")}
            </button>
            <span class="grow" />
            <button type="button" class="btn ghost" onClick={props.onClose}>
              {t("common.close")}
            </button>
            <button type="button" class="btn primary" disabled={!dirty} onClick={save}>
              {t("common.save")}
            </button>
          </>
        )
      }
    >
      {!c && card.error && <p class="error">{card.error}</p>}
      {c && (
        <>
          <div class="row wrap small muted card-meta">
            <span>{c.assigneeAgentId ?? t("kanban.unassigned")}</span>
            {c.parked ? (
              <span class="chip">{t("kanban.notStarted")}</span>
            ) : (
              <span>{t(`status.${c.status}`)}</span>
            )}
            <span>{ago(c.updatedAt)}</span>
            {c.threadId && (
              <a href={`/chat/${c.threadId}`} onClick={props.onClose}>
                <MessageSquare class="icon" /> {t("card.openChat")}
              </a>
            )}
          </div>
          {c.parked && (
            <div class="panel start-card">
              <p class="muted small">{t("card.notStartedHelp")}</p>
              <div class="row wrap">
                {!c.assigneeAgentId && (
                  <select
                    class="input grow"
                    aria-label={t("card.agent")}
                    value={startAgent}
                    onChange={(e) => setStartAgent(e.currentTarget.value)}
                  >
                    <option value="">{t("card.pickAgent")}</option>
                    {workers.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.id})
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  class="btn primary"
                  disabled={!c.assigneeAgentId && !startAgent}
                  onClick={() =>
                    call(`${base}/start`, "POST", startAgent ? { agent: startAgent } : {})
                  }
                >
                  <Play class="icon" />
                  {t("card.start")}
                </button>
              </div>
            </div>
          )}
          <label class="field">
            {t("card.title")}
            <input
              class="input"
              value={title ?? c.title}
              maxLength={200}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <label class="field">
            {t("card.description")}
            <textarea
              class="input"
              rows={4}
              value={desc ?? c.description ?? ""}
              onInput={(e) => setDesc(e.currentTarget.value)}
            />
          </label>
          {c.column && props.columns.length > 0 && (
            <label class="field">
              {t("card.column")}
              <select
                class="input"
                value={c.column}
                onChange={(e) =>
                  call(`${base}/move`, "POST", { from: c.column, to: e.currentTarget.value })
                }
              >
                {props.columns.map((col) => (
                  <option key={col} value={col}>
                    {columnLabel(col)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <h3 class="sec">{t("card.checklist")}</h3>
          <ul class="checklist">
            {c.checklist.map((item) => (
              <li key={item.id} class="row">
                <input
                  type="checkbox"
                  checked={item.done}
                  aria-label={item.text}
                  onChange={(e) =>
                    call(`${base}/checklist/${item.id}`, "PATCH", { done: e.currentTarget.checked })
                  }
                />
                <span class={`grow ${item.done ? "muted strike" : ""}`}>{item.text}</span>
                <button
                  type="button"
                  class="iconbtn"
                  aria-label={t("card.removeItem")}
                  onClick={() => call(`${base}/checklist/${item.id}`, "DELETE")}
                >
                  <Trash2 class="icon" />
                </button>
              </li>
            ))}
          </ul>
          <form
            class="row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                newItem.trim() &&
                (await call(`${base}/checklist`, "POST", { text: newItem.trim() }))
              )
                setNewItem("");
            }}
          >
            <input
              class="input"
              placeholder={t("card.addItem")}
              value={newItem}
              maxLength={500}
              onInput={(e) => setNewItem(e.currentTarget.value)}
            />
            <button type="submit" class="btn" disabled={!newItem.trim()}>
              <Plus class="icon" />
              {t("card.add")}
            </button>
          </form>

          <h3 class="sec">{t("card.comments")}</h3>
          <p class="muted small">{t("card.commentsHint")}</p>
          <ul class="comments">
            {c.comments.map((cm) => (
              <li key={cm.id}>
                <div class="row small muted">
                  <span class="grow">{ago(cm.createdAt)}</span>
                  <button
                    type="button"
                    class="iconbtn"
                    aria-label={t("card.deleteComment")}
                    onClick={() => call(`${base}/comments/${cm.id}`, "DELETE")}
                  >
                    <Trash2 class="icon" />
                  </button>
                </div>
                <div class="content">{cm.text}</div>
              </li>
            ))}
          </ul>
          <textarea
            class="input"
            rows={2}
            placeholder={t("card.addComment")}
            value={comment}
            maxLength={5000}
            onInput={(e) => setComment(e.currentTarget.value)}
          />
          <div class="row end">
            <button
              type="button"
              class="btn"
              disabled={!comment.trim()}
              onClick={async () => {
                if (await call(`${base}/comments`, "POST", { text: comment.trim() }))
                  setComment("");
              }}
            >
              {t("card.postComment")}
            </button>
          </div>
          {error && <p class="error">{error}</p>}
        </>
      )}
    </Modal>
  );
}
