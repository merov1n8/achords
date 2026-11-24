// ADR-0067 migration: from per-agent lists (tools, shell, network, container) to a level. Pure:
// the caller reads and writes the files and supplies the catalog.
import { type Catalog, grantedIntegrations, publishMode } from "./catalog.ts";
import { type CompiledLevel, compileLevel, REGISTRY_HOSTS } from "./compile.ts";
import { patchManifestText } from "./edit.ts";
import { type Manifest, parseManifest } from "./manifest.ts";

/** The owner-approved starting assignment (ADR-0067), widening included. */
export const STARTING_LEVELS: Readonly<Record<string, number>> = {
  "code-reviewer": 1,
  "game-reviewer": 1,
  marketing: 2,
  seo: 3,
  social: 3,
  advertiser: 3,
  "web-dev": 4,
  "wp-maintainer": 4,
  "game-dev": 4,
  "3d-designer": 4,
  "video-producer": 4,
};
/** Agents without a level (ADR-0067: the boss has no tools). */
export const WITHOUT_LEVEL = new Set(["boss"]);

/** What a run may do without asking, comparable between a legacy manifest and a level. */
export interface Rights {
  tools: Set<string>;
  shell: "none" | "list" | "free";
  /** Named hosts; `"*"` for the open web. */
  hosts: Set<string>;
  /** A shell or the open web outside the Apple container. */
  outsideContainer: boolean;
  /** `<integration>.<tool>` called without asking, and after the owner's review. */
  direct: Set<string>;
  review: Set<string>;
  /** Report lines. */
  labels: Set<string>;
}

const SHELL_RANK = { none: 0, list: 1, free: 2 } as const;
const ARCHIVE = /\.(zip|tar|tgz|gz|bz2|xz|7z|rar|dmg|pkg)\b/i;
const ABSOLUTE = /(^|[\s"'=])(\/|~\/)/;
const OPEN_APP = /^\s*open\s+(?:-\S+\s+)*-a\s/;
const UNITY =
  /(?:"([^"]*\/Unity\.app\/Contents\/MacOS\/Unity)"|'([^']*\/Unity\.app\/Contents\/MacOS\/Unity)'|(\/[^\s"']*\/Unity\.app\/Contents\/MacOS\/Unity))(?=\s|$)/;

/** A one-off command collected by "always" approvals: an absolute path or an archive name. */
export const isLiteralCommand = (cmd: string): boolean => ABSOLUTE.test(cmd) || ARCHIVE.test(cmd);

/** Unity editor binaries invoked by shell entries (absolute `.../Unity.app/Contents/MacOS/Unity`). */
export function unityBinaries(allow: string[]): string[] {
  const found = allow
    .map((cmd) => UNITY.exec(cmd))
    .map((m) => m?.[1] ?? m?.[2] ?? m?.[3])
    .filter((p): p is string => p !== undefined);
  return [...new Set(found)];
}

/** Rights of a manifest without a level: its lists apply as written. */
export function legacyRights(m: Manifest, catalog: Catalog): Rights {
  const r = empty();
  for (const t of m.tools) add(r, r.tools, t, `tool ${t}`);
  const where = m.container ? "in the Apple container" : "on this Mac, no sandbox";
  if (m.shell) {
    r.shell = "list";
    r.labels.add(`shell: ${m.shell.allow.length} listed command prefixes, ${where}`);
  }
  for (const h of m.network.allow) add(r, r.hosts, h, hostLabel(h, where));
  r.outsideContainer = !m.container && (!!m.shell || m.network.allow.includes("*"));
  const granted = grantedIntegrations(m, catalog);
  for (const e of granted.ok ? granted.entries : []) {
    const mode = publishMode(m, e.id);
    for (const t of e.tools.read) add(r, r.direct, `${e.id}.${t}`, `${e.id}.${t} without asking`);
    if (mode === "off") continue;
    for (const t of e.tools.write) {
      if (mode === "auto") add(r, r.direct, `${e.id}.${t}`, `${e.id}.${t} without asking`);
      else add(r, r.review, `${e.id}.${t}`, `${e.id}.${t} after your review`);
    }
  }
  return r;
}

/** Rights of a leveled manifest: the union of its runs (both modes of a split agent). */
export function levelRights(
  m: Manifest,
  catalog: Catalog,
  containerAvailable: boolean,
): { rights: Rights; runs: CompiledLevel[] } {
  const compile = (mode?: "web") =>
    compileLevel(m, {
      level: m.level ?? 0,
      project: {},
      catalog,
      run: { model: m.models.default, mode, containerAvailable },
    });
  const first = compile();
  const runs = first.split ? [first, compile("web")] : [first];
  const r = empty();
  for (const run of runs) {
    if (run.refusal) continue;
    const c = run.manifest;
    for (const t of c.tools) add(r, r.tools, t, `tool ${t}`);
    const where = c.container ? "in the Apple container" : "on this Mac, no sandbox";
    for (const h of c.network.allow) add(r, r.hosts, h, hostLabel(h, where));
    if (run.sandbox) {
      r.shell = "free";
      r.labels.add(
        `free shell, ${sandboxLabel(run.sandbox)} (with ${REGISTRY_HOSTS.length} package registry hosts)`,
      );
    }
    if ((run.sandbox || c.network.allow.includes("*")) && !c.container) r.outsideContainer = true;
    for (const [id, g] of Object.entries(run.integrations)) {
      const auto = g.publish?.mode === "auto";
      const direct = [...g.tools, ...(auto ? (g.publish?.tools ?? []) : [])].filter(
        (t) => !g.publish?.review.includes(t),
      );
      const review = [...(g.publish?.review ?? []), ...(auto ? [] : (g.publish?.tools ?? []))];
      for (const t of direct) add(r, r.direct, `${id}.${t}`, `${id}.${t} without asking`);
      for (const t of review) add(r, r.review, `${id}.${t}`, `${id}.${t} after your review`);
    }
  }
  return { rights: r, runs };
}

/** Whether `a` gives nothing beyond `b`. */
export function withinRights(a: Rights, b: Rights): boolean {
  const sub = (x: Set<string>, y: Set<string>) => [...x].every((v) => y.has(v));
  const hostsOk = b.hosts.has("*") ? true : sub(a.hosts, b.hosts);
  return (
    sub(a.tools, b.tools) &&
    SHELL_RANK[a.shell] <= SHELL_RANK[b.shell] &&
    hostsOk &&
    (!a.outsideContainer || b.outsideContainer) &&
    sub(a.direct, b.direct) &&
    [...a.review].every((v) => b.review.has(v) || b.direct.has(v))
  );
}

export interface AgentPlan {
  id: string;
  /**
   * migrate: gets `level`; leveled: has one already (skipped); no-level: the boss; unfit: no
   * level fits without widening (left as is for the owner); invalid: the manifest does not load.
   */
  status: "migrate" | "leveled" | "no-level" | "unfit" | "invalid";
  level?: number;
  /** table: the starting assignment; subset: highest level within its current rights. */
  source?: "table" | "subset";
  gained: string[];
  lost: string[];
  /** One-off literal commands dropped from shell.allow. */
  dropped: string[];
  /**
   * Literal commands whose use the level covers another way (`<command>: <how>`): the
   * `unsandboxed` executable, or opening an app (local apps, ADR-0054).
   */
  covered: string[];
  exceptions: string[];
  /** The remit it keeps (folders, integrations, models, documentation hosts). */
  kept: string[];
  warnings: string[];
  /** The patched agent.yaml (status migrate). */
  text?: string;
}

/** Plans the migration of one agent.yaml (ADR-0067). Never writes. */
export function planAgentMigration(
  id: string,
  text: string,
  catalog: Catalog,
  opts: { containerAvailable: boolean },
): AgentPlan {
  const plan: AgentPlan = {
    id,
    status: "migrate",
    gained: [],
    lost: [],
    dropped: [],
    covered: [],
    exceptions: [],
    kept: [],
    warnings: [],
  };
  let m: Manifest;
  try {
    m = parseManifest(text, `agents/${id}/agent.yaml`);
  } catch (err) {
    return { ...plan, status: "invalid", warnings: [(err as Error).message] };
  }
  if (m.level !== undefined) return { ...plan, status: "leveled", level: m.level };
  if (WITHOUT_LEVEL.has(id)) return { ...plan, status: "no-level" };

  const before = legacyRights(m, catalog);
  const allow = m.shell?.allow ?? [];
  const literals = allow.filter(isLiteralCommand);
  const named = m.network.allow.filter((h) => h !== "*");
  const drop: ("tools" | "shell" | "network" | "container")[] = ["tools", "shell", "container"];
  if (!named.length) drop.push("network");
  const patchAt = (level: number, extra: { unsandboxed?: string[]; keys?: boolean } = {}) => {
    const next = patchManifestText(
      text,
      {
        level,
        drop,
        ...(named.length && m.network.allow.includes("*") ? { remove: { network: ["*"] } } : {}),
        ...(extra.unsandboxed ? { unsandboxed: extra.unsandboxed } : {}),
        ...(extra.keys ? { keys_beside_host_shell: true } : {}),
      },
      `agents/${id}/agent.yaml`,
    );
    const after = parseManifest(next, `agents/${id}/agent.yaml`);
    return { next, after, ...levelRights(after, catalog, opts.containerAvailable) };
  };

  let chosen: ReturnType<typeof patchAt> | undefined;
  const table = STARTING_LEVELS[id];
  if (table !== undefined) {
    plan.source = "table";
    const extra: { unsandboxed?: string[]; keys?: boolean } = {};
    if (id === "game-dev") {
      const unity = unityBinaries(allow);
      if (unity.length === 1) {
        extra.unsandboxed = unity;
        plan.exceptions.push(`unsandboxed: ${unity[0]} (owner-approved Unity exception)`);
      } else {
        plan.warnings.push(
          unity.length
            ? `several Unity editor binaries in shell.allow (${unity.join(", ")}); none set as unsandboxed: add the one to use by hand`
            : "no Unity editor binary (…/Unity.app/Contents/MacOS/Unity) found in shell.allow; unsandboxed not set: add it by hand",
        );
      }
      plan.warnings.push(
        "Swift and Xcode builds need their module cache folders writable in the CLI sandbox: add them to fs.write if game-dev builds those (your decision)",
      );
    }
    if (id === "3d-designer") {
      extra.keys = true;
      plan.exceptions.push("keys_beside_host_shell: true (owner-approved exception)");
    }
    chosen = patchAt(table, extra);
  } else {
    plan.source = "subset";
    for (let level = 5; level >= 1 && !chosen; level--) {
      const candidate = patchAt(level);
      if (withinRights(candidate.rights, before)) chosen = candidate;
    }
    if (!chosen) {
      return {
        ...plan,
        status: "unfit",
        warnings: [
          "no level from 1 to 5 stays within its current rights; left unchanged (set a level by hand)",
        ],
      };
    }
  }

  const unsandboxed = chosen.after.unsandboxed ?? [];
  for (const cmd of literals) {
    const bin = unityBinaries([cmd])[0];
    if (bin && unsandboxed.includes(bin)) {
      plan.covered.push(`${cmd}: Unity runs outside the sandbox (exception)`);
    } else if (OPEN_APP.test(cmd)) {
      plan.covered.push(`${cmd}: opening apps goes through local apps (ADR-0054)`);
    } else plan.dropped.push(cmd);
  }
  plan.level = chosen.after.level ?? 0;
  plan.text = chosen.next;
  plan.gained = grouped([...chosen.rights.labels].filter((l) => !before.labels.has(l)));
  plan.lost = grouped([...before.labels].filter((l) => !chosen.rights.labels.has(l)));
  const work = chosen.runs[0];
  if (work?.split) {
    plan.warnings.push(
      `works in two modes: work (${work.sandbox ? "shell and accounts" : "accounts"}, no open web) and web (no shell, no account tools that write)`,
    );
  }
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  plan.kept = [
    `fs.read: ${list(m.fs.read)}`,
    `fs.write: ${list(m.fs.write)}`,
    `mcp: ${list(m.mcp)}`,
    `models: ${list(m.models.allowed)}`,
    ...(named.length ? [`documentation hosts (work mode): ${named.join(", ")}`] : []),
  ];
  for (const run of chosen.runs) {
    if (run.refusal) plan.warnings.push(run.refusal);
    plan.warnings.push(...run.notes);
    for (const u of run.unavailable) plan.warnings.push(`${run.mode ?? "run"}: ${u}`);
    if (run.sandbox === "container" && !chosen.after.keys_beside_host_shell) {
      plan.warnings.push(
        "its shell sits next to integrations with credentials, so work-mode runs use the Apple container",
      );
    }
  }
  plan.warnings = [...new Set(plan.warnings)];
  return plan;
}

function empty(): Rights {
  return {
    tools: new Set(),
    shell: "none",
    hosts: new Set(),
    outsideContainer: false,
    direct: new Set(),
    review: new Set(),
    labels: new Set(),
  };
}

function add(r: Rights, set: Set<string>, value: string, label: string): void {
  set.add(value);
  r.labels.add(label);
}

const hostLabel = (h: string, where: string) =>
  h === "*" ? `open web (any site), ${where}` : `host ${h}`;

const sandboxLabel = (s: string) =>
  s === "host"
    ? "in Claude's sandbox on this Mac"
    : s === "container"
      ? "in the Apple container"
      : `in the ${s} sandbox`;

/** `meta.a without asking` lines grouped per integration: `meta, without asking: a, b`. */
function grouped(labels: string[]): string[] {
  const out: string[] = [];
  const groups = new Map<string, string[]>();
  for (const l of labels) {
    const m = /^([a-z0-9-]+)\.(\S+) (without asking|after your review)$/.exec(l);
    if (!m) {
      out.push(l);
      continue;
    }
    const key = `${m[1]}, ${m[3]}`;
    groups.set(key, [...(groups.get(key) ?? []), m[2] as string]);
  }
  return [...out, ...[...groups].map(([k, tools]) => `${k}: ${tools.join(", ")}`)];
}
