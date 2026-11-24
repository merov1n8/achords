// ADR-0067, the secured-live rule: on a secured project (or one whose class is not chosen yet)
// live targets are read-only for every agent, at every level and under every approval. It is a
// project property, so the launcher enforces it per call, for agent runs and owner-approved
// publishes alike.
import { accountRefs, type CatalogEntry, secretRefs, toolClass } from "./catalog.ts";
import type { AccountEntry, Env, ProjectClass } from "./projects.ts";

/** What the launcher needs to refuse writes to live targets of one integration in one project. */
export interface LiveGuard {
  /** Write tools covered (every class but `read`). */
  tools: string[];
  /** Arguments naming the target (the catalog's scope args); none: the target is fixed. */
  args: string[];
  strip?: string | undefined;
  /** Targets writes may go to: the project's `staging` entries. */
  staging: string[];
  /** Environment of the target a call goes to when it names none; unset: it cannot be told. */
  unnamed?: Env | undefined;
}

/** Unset counts as secured until the owner chooses (ADR-0067). */
export const isSecured = (project: { class?: ProjectClass | undefined }): boolean =>
  project.class !== "experimental";

export const LIVE_HINT =
  "on a secured project writes go to staging targets only. Switch the target to staging in the project form, or deliver the work as a package (a diff or export plus a checklist) for the owner to deploy.";

/**
 * The guard for an entry in a project, or undefined when the rule does not apply: an experimental
 * project, no write tools, or an entry that reaches none of the project's accounts or sites
 * (a local app, an owner-wide service without scope).
 */
export function liveGuard(
  entry: CatalogEntry,
  project: {
    class?: ProjectClass | undefined;
    integrationEntries: Record<string, AccountEntry[]>;
  },
): LiveGuard | undefined {
  if (!isSecured(project)) return undefined;
  const tools = entry.tools.write.filter((t) => toolClass(entry, t) !== "read");
  if (!tools.length) return undefined;
  const of = (channel: string) => project.integrationEntries[channel] ?? [];
  if (entry.scope) {
    const all = (entry.scope.channels ?? [entry.sites?.channel ?? entry.id]).flatMap(of);
    return {
      tools,
      args: entry.scope.args,
      ...(entry.scope.strip ? { strip: entry.scope.strip } : {}),
      staging: all.filter((e) => e.env === "staging").map((e) => e.value),
      // Same condition as the launcher's `optional`: the only target there is.
      ...(entry.scope.optional && all.length === 1 ? { unnamed: all[0]?.env } : {}),
    };
  }
  // No target argument: the server writes to what it was configured with, i.e. every site of a
  // `sites` entry and the first entry of each `{account:<channel>}`.
  const refs = accountRefs(entry).filter((c) => c !== entry.sites?.channel);
  const perProject = secretRefs(entry).some((r) => r.includes("{project}"));
  if (!entry.sites && !refs.length && !perProject) return undefined;
  const fixed = [
    ...(entry.sites ? of(entry.sites.channel) : []),
    ...refs.flatMap((c) => of(c).slice(0, 1)),
  ];
  // Credentials per client without a named account: the target is the client's, its env unknown.
  return {
    tools,
    args: [],
    staging: [],
    ...(fixed.length
      ? { unnamed: fixed.every((e) => e.env === "staging") ? "staging" : "live" }
      : {}),
  };
}

/** Why a call writes to a live target (or one that cannot be told), or undefined when it may pass. */
export function liveRefusal(
  guard: LiveGuard,
  tool: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!guard.tools.includes(tool)) return undefined;
  const norm = (v: string) =>
    guard.strip && v.startsWith(guard.strip) ? v.slice(guard.strip.length) : v;
  const values: unknown[] = [];
  for (const arg of guard.args) {
    const v = input?.[arg];
    if (v === undefined) continue;
    values.push(...(Array.isArray(v) ? v : [v]));
  }
  if (!values.length) {
    if (guard.unnamed === "staging") return undefined;
    return guard.unnamed === "live"
      ? `${tool} writes to a live target, which is read-only: ${LIVE_HINT}`
      : `${tool} does not say which target it writes to, so it is treated as live: ${LIVE_HINT}`;
  }
  const staging = new Set(guard.staging.map(norm));
  const live = values.find(
    (v) => !(typeof v === "string" || typeof v === "number") || !staging.has(norm(String(v))),
  );
  return live === undefined
    ? undefined
    : `${String(live)} is a live target and read-only: ${LIVE_HINT}`;
}
