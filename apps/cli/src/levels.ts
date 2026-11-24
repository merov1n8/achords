// `achords levels migrate` (ADR-0067 step 5): every agent gets its starting level and loses its
// per-agent lists. A dry run by default; --write backs each manifest up first.
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type AgentPlan, type Catalog, planAgentMigration } from "@achords/policy";

export interface MigrateResult {
  plans: AgentPlan[];
  report: string;
  /** --write only. */
  reportFile?: string;
  backups: string[];
}

/** `20261124-101500` (UTC): sortable, safe in file names. */
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

// Shell entries are plain manifest text, but one may still carry a token typed into a command.
const redact = (cmd: string) =>
  cmd
    .replace(/((?:token|key|secret|password|passwd|bearer|authorization)\s*[=:]?\s*)\S+/gi, "$1…")
    .replace(/[A-Za-z0-9_-]{32,}/g, "…");

export function migrateLevels(opts: {
  home: string;
  catalog: Catalog;
  write: boolean;
  containerAvailable: boolean;
  now?: Date;
}): MigrateResult {
  const agentsDir = join(opts.home, "agents");
  const ids = existsSync(agentsDir)
    ? readdirSync(agentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(agentsDir, d.name, "agent.yaml")))
        .map((d) => d.name)
        .sort()
    : [];
  // One agent that cannot be patched must not stop the others (nor the report).
  const plans = ids.map((id): AgentPlan => {
    const text = readFileSync(join(agentsDir, id, "agent.yaml"), "utf8");
    try {
      return planAgentMigration(id, text, opts.catalog, {
        containerAvailable: opts.containerAvailable,
      });
    } catch (err) {
      const none = { gained: [], lost: [], dropped: [], covered: [], exceptions: [], kept: [] };
      return { id, status: "invalid", ...none, warnings: [(err as Error).message] };
    }
  });
  const now = opts.now ?? new Date();
  const ts = stamp(now);
  const backups: string[] = [];
  let reportFile: string | undefined;
  if (opts.write) {
    for (const p of plans) {
      if (p.status !== "migrate" || !p.text) continue;
      const path = join(agentsDir, p.id, "agent.yaml");
      const backup = join(opts.home, `backup-${p.id}-agent-${ts}.yaml`);
      copyFileSync(path, backup);
      backups.push(backup);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, p.text, { mode: statSync(path).mode & 0o777 });
      renameSync(tmp, path);
    }
    reportFile = join(opts.home, `levels-migration-${ts}.txt`);
  }
  const report = formatReport(plans, { ...opts, when: now, backups, reportFile });
  if (reportFile) writeFileSync(reportFile, report, { mode: 0o600 });
  return { plans, report, backups, ...(reportFile ? { reportFile } : {}) };
}

function formatReport(
  plans: AgentPlan[],
  o: {
    home: string;
    write: boolean;
    when: Date;
    backups: string[];
    reportFile?: string | undefined;
  },
): string {
  const out: string[] = [
    `achords levels migrate (ADR-0067), ${o.write ? "written" : "dry run, nothing written"}`,
    `Data folder: ${o.home}`,
    `Time: ${o.when.toISOString()}`,
    "",
  ];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    out.push(`  ${title}:`);
    for (const i of items) out.push(`    - ${i}`);
  };
  for (const p of plans) {
    switch (p.status) {
      case "leveled":
        out.push(`${p.id}: already has level ${p.level}, skipped`);
        break;
      case "no-level":
        out.push(`${p.id}: no level (the boss has no tools), unchanged`);
        break;
      case "invalid":
        out.push(`${p.id}: not migrated, its agent.yaml does not load or cannot be patched`);
        section("warnings", p.warnings);
        break;
      case "unfit":
        out.push(`${p.id}: not migrated, not in the starting assignment`);
        section("warnings", p.warnings);
        break;
      case "migrate":
        out.push(
          `${p.id}: level ${p.level} (${p.source === "table" ? "starting assignment" : "not in the starting assignment: highest level within its current rights"})`,
        );
        section("rights gained", p.gained);
        section("rights lost", p.lost);
        section("one-off commands dropped", p.dropped.map(redact));
        section("covered otherwise", p.covered.map(redact));
        section("exceptions set", p.exceptions);
        section("remit kept", p.kept);
        section("warnings", p.warnings);
        break;
    }
    out.push("");
  }
  const count = (s: AgentPlan["status"]) => plans.filter((p) => p.status === s).length;
  out.push(
    `Summary: ${count("migrate")} to level, ${count("leveled")} already leveled, ${count("no-level")} without a level, ${count("unfit") + count("invalid")} left unchanged.`,
  );
  if (o.write) {
    if (o.backups.length) out.push(`Backups: ${o.backups.join(", ")}`);
    if (o.reportFile) out.push(`Report: ${o.reportFile}`);
  } else if (count("migrate")) {
    out.push("Next: read this report, then run `pnpm achords levels migrate --write`.");
  }
  out.push(
    "The gateway re-reads agent manifests on use, so no restart is needed (a restart does no harm).",
  );
  return `${out.join("\n")}\n`;
}
