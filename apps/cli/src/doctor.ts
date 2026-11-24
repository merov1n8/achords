import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HomePaths } from "@achords/core";
import { t } from "@achords/i18n";
import { detectPlatform, recommendModels } from "@achords/platform";
import {
  type IntegrationStatus,
  integrationStatus,
  legacyBesideLevel,
  loadAgents,
  loadCatalog,
  loadProjects,
  ownProject,
} from "@achords/policy";
import { installedLaunchdPath, protectedFolderOf } from "./launchd.ts";

export interface Check {
  name: string;
  level: "ok" | "info" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/** Everything the checks read from the system, injectable for tests. */
export interface DoctorEnv {
  paths: HomePaths;
  nodeVersion: string;
  platform: NodeJS.Platform;
  gatewayEntry: string;
  userHome: string;
  webDist: string;
  which: (bin: string) => string | undefined;
  version: (bin: string) => string | undefined;
  serviceLoaded: () => boolean;
  gatewayResponds: () => Promise<boolean>;
  vaultStatus: () => { ok: true; telegram: boolean } | { ok: false; error: string };
  /** PATH the installed service runs with (undefined: no service installed yet). */
  servicePath?: string | undefined;
  ramGb: number;
  hasWhisperModel: boolean;
  /** Models pulled in the local Ollama, or undefined if it is not reachable. */
  ollamaModels: () => Promise<string[] | undefined>;
  /** Integrations from the catalog (ADR-0034), checked against the service's PATH and vault. */
  integrations?: () => IntegrationStatus[];
  /** Agents with a level that still set fields the level replaces (ADR-0067), with those fields. */
  legacyBesideLevel?: () => string[];
}

/** One check per integration an agent uses: program, credentials, project setup. */
export function integrationChecks(list: IntegrationStatus[]): Check[] {
  return list
    .filter((s) => s.usedBy.length)
    .map((s): Check => {
      const name = t("cli.doctor.integration", { id: s.id });
      const agents = s.usedBy.join(", ");
      if (!s.commandFound) {
        return {
          name,
          level: "fail",
          detail: t("cli.doctor.integrationCommand", { command: s.command ?? "" }),
          fix: t(s.command === "uvx" ? "cli.doctor.uvxFix" : "cli.doctor.npxFix"),
        };
      }
      if (s.missingSecrets.length) {
        const google = s.missingSecrets.some((id) => id.startsWith("google-"));
        return {
          name,
          level: "fail",
          detail: t("cli.doctor.integrationSecrets", { ids: s.missingSecrets.join(", ") }),
          fix: google
            ? t("cli.doctor.googleFix")
            : s.missingSecrets.map((id) => `achords secret set ${id}`).join(" && "),
        };
      }
      if (s.perProject && !s.projectsReady.length) {
        return {
          name,
          level: "warn",
          detail: t("cli.doctor.integrationNoProject"),
          fix: t("cli.doctor.integrationProjectFix", { id: s.id }),
        };
      }
      if (s.scoped && !s.projectsScoped.length) {
        return {
          name,
          level: "warn",
          detail: t("cli.doctor.integrationNoTargets"),
          fix: t("cli.doctor.integrationTargetsFix"),
        };
      }
      const projects = [...s.projectsReady, ...s.projectsScoped];
      return {
        name,
        level: "ok",
        detail: t("cli.doctor.integrationOk", {
          agents,
          projects: projects.length ? projects.join(", ") : "-",
        }),
      };
    });
}

// node:sqlite with extension loading needs 22.13+ (ADR-0022).
const MIN_NODE: [number, number] = [22, 13];

const atLeast = (v: string, [maj, min]: [number, number]) => {
  const [a = 0, b = 0] = v.split(".").map(Number);
  return a > maj || (a === maj && b >= min);
};

export async function runDoctor(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  add(
    atLeast(env.nodeVersion, MIN_NODE)
      ? { name: t("cli.doctor.node"), level: "ok", detail: `v${env.nodeVersion}` }
      : {
          name: t("cli.doctor.node"),
          level: "fail",
          detail: `v${env.nodeVersion}`,
          fix: t("cli.doctor.nodeFix", { version: MIN_NODE.join(".") }),
        },
  );

  const claude = env.which("claude");
  const claudeDir = claude?.slice(0, claude.lastIndexOf("/"));
  const serviceSeesClaude =
    env.servicePath === undefined || !claudeDir || env.servicePath.split(":").includes(claudeDir);
  add(
    claude && !serviceSeesClaude
      ? {
          name: t("cli.doctor.claudeCli"),
          level: "fail",
          detail: t("cli.doctor.claudePath", { claude, dir: claudeDir ?? "" }),
          fix: t("cli.doctor.claudePathFix"),
        }
      : claude
        ? { name: t("cli.doctor.claudeCli"), level: "ok", detail: env.version("claude") ?? claude }
        : {
            name: t("cli.doctor.claudeCli"),
            level: "fail",
            detail: t("cli.doctor.notOnPath"),
            fix: t("cli.doctor.claudeFix"),
          },
  );

  add(
    env.which("git")
      ? {
          name: t("cli.doctor.git"),
          level: "ok",
          detail: env.version("git") ?? t("cli.doctor.found"),
        }
      : {
          name: t("cli.doctor.git"),
          level: "warn",
          detail: t("cli.doctor.notFound"),
          fix: t("cli.doctor.gitFix"),
        },
  );

  if (!existsSync(env.paths.home)) {
    add({
      name: t("cli.doctor.dataFolder"),
      level: "info",
      detail: t("cli.doctor.homeMissing", { home: env.paths.home }),
      fix: t("cli.doctor.runInit"),
    });
  } else {
    const mode = statSync(env.paths.home).mode & 0o777;
    add(
      mode & 0o077
        ? {
            name: t("cli.doctor.dataFolder"),
            level: "warn",
            detail: t("cli.doctor.homeOpen", { home: env.paths.home, mode: mode.toString(8) }),
            fix: `chmod 700 ${env.paths.home}`,
          }
        : { name: t("cli.doctor.dataFolder"), level: "ok", detail: env.paths.home },
    );
  }

  add(
    existsSync(join(env.webDist, "index.html"))
      ? { name: t("cli.doctor.webUi"), level: "ok", detail: t("cli.doctor.built") }
      : {
          name: t("cli.doctor.webUi"),
          level: "warn",
          detail: t("cli.doctor.notBuilt"),
          fix: t("cli.doctor.buildFix"),
        },
  );

  if (env.platform === "darwin") {
    const folder = protectedFolderOf(env.gatewayEntry, env.userHome);
    add(
      folder
        ? {
            name: t("cli.doctor.macFolderName"),
            level: "warn",
            detail: t("cli.doctor.macFolder", { folder }),
            fix: t("cli.doctor.macFolderFix"),
          }
        : { name: t("cli.doctor.macFolderName"), level: "ok", detail: t("cli.doctor.macFolderOk") },
    );
  }

  add(
    env.serviceLoaded()
      ? { name: t("cli.doctor.service"), level: "ok", detail: t("cli.status.loaded") }
      : {
          name: t("cli.doctor.service"),
          level: "warn",
          detail: t("cli.status.notLoaded"),
          fix: t("cli.doctor.runStart"),
        },
  );
  add(
    (await env.gatewayResponds())
      ? { name: t("cli.doctor.gateway"), level: "ok", detail: t("cli.doctor.responding") }
      : {
          name: t("cli.doctor.gateway"),
          level: "warn",
          detail: t("cli.doctor.notResponding"),
          fix: t("cli.doctor.runStart"),
        },
  );

  const vault = env.vaultStatus();
  if (!vault.ok) {
    add({
      name: t("cli.doctor.vault"),
      level: "fail",
      detail: t("cli.doctor.vaultError", { error: vault.error }),
      fix: t("cli.doctor.vaultFix"),
    });
  } else {
    add({ name: t("cli.doctor.vault"), level: "ok", detail: t("cli.doctor.vaultOk") });
    add(
      vault.telegram
        ? { name: t("cli.doctor.telegram"), level: "ok", detail: t("cli.doctor.telegramOk") }
        : {
            name: t("cli.doctor.telegram"),
            level: "info",
            detail: t("cli.doctor.telegramMissing"),
            fix: t("cli.doctor.telegramFix"),
          },
    );
  }
  // Optional (ADR-0006): only `local-only` work needs it, so never a failure.
  const { chat, embedding } = recommendModels(env.ramGb);
  const pulled = await env.ollamaModels();
  const has = (m: string) => pulled?.some((p) => p === m || p === `${m}:latest`) ?? false;
  if (pulled === undefined) {
    add({
      name: t("cli.doctor.localModels"),
      level: "info",
      detail: t("cli.doctor.ollamaDown"),
      fix: t("cli.doctor.ollamaFix", { chat, embedding }),
    });
  } else {
    const missing = [chat, embedding].filter((m) => !has(m));
    add(
      missing.length
        ? {
            name: t("cli.doctor.localModels"),
            level: "info",
            detail: t("cli.doctor.ollamaRecommend", { ram: env.ramGb, chat }),
            fix: missing.map((m) => `ollama pull ${m}`).join(" && "),
          }
        : {
            name: t("cli.doctor.localModels"),
            level: "ok",
            detail: t("cli.doctor.ollamaOk", { chat, embedding }),
          },
    );
  }
  if (env.integrations) {
    try {
      for (const c of integrationChecks(env.integrations())) add(c);
    } catch (err) {
      add({
        name: t("cli.doctor.integrations"),
        level: "fail",
        detail: (err as Error).message,
      });
    }
  }
  // A warning, not an error: the level wins and the old fields are ignored (ADR-0067).
  const legacy = env.legacyBesideLevel?.() ?? [];
  if (legacy.length) {
    add({
      name: t("cli.doctor.levels"),
      level: "warn",
      detail: t("cli.doctor.levelsLegacy", { agents: legacy.join("; ") }),
      fix: t("cli.doctor.levelsFix"),
    });
  }
  // Optional (ADR-0014): only voice notes need it.
  const whisper = env.which("whisper-cli");
  add(
    whisper && env.hasWhisperModel
      ? { name: t("cli.doctor.speech"), level: "ok", detail: t("cli.doctor.whisperOk") }
      : {
          name: t("cli.doctor.speech"),
          level: "info",
          detail: whisper ? t("cli.doctor.whisperModel") : t("cli.doctor.whisperCli"),
          fix: whisper
            ? t("cli.doctor.whisperModelFix", {
                dir: env.paths.whisperModel.replace(/\/[^/]+$/, ""),
              })
            : t("cli.doctor.whisperCliFix"),
        },
  );
  return checks;
}

export function systemDoctorEnv(
  paths: HomePaths,
  gatewayEntry: string,
  serviceLoaded: () => boolean,
  vaultStatus: DoctorEnv["vaultStatus"],
  secretIds: () => string[] = () => [],
): DoctorEnv {
  const run = (bin: string, args: string[]) => {
    try {
      return execFileSync(bin, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const port = Number(process.env.ACHORDS_PORT ?? 7420);
  return {
    paths,
    nodeVersion: process.versions.node,
    platform: process.platform,
    gatewayEntry,
    userHome: homedir(),
    webDist: new URL("../../web/dist/", import.meta.url).pathname,
    which: (bin) => run("/usr/bin/which", [bin]),
    version: (bin) => run(bin, ["--version"])?.split("\n")[0],
    serviceLoaded,
    // Any HTTP answer (401 without a session) means the gateway is up.
    gatewayResponds: async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.status > 0;
      } catch {
        return false;
      }
    },
    vaultStatus,
    servicePath: process.platform === "darwin" ? installedLaunchdPath() : undefined,
    integrations: () => {
      // Agents run under the service, so look for npx/uvx on its PATH, not the shell's.
      const path =
        (process.platform === "darwin" ? installedLaunchdPath() : undefined) ??
        process.env.PATH ??
        "";
      const ids = new Set(secretIds());
      return integrationStatus(
        loadCatalog(
          new URL("../../../seed/catalog/", import.meta.url).pathname,
          join(paths.home, "catalog"),
        ),
        loadAgents(join(paths.home, "agents")).values(),
        [...loadProjects(join(paths.home, "projects")).values(), ownProject(paths.home)],
        (id) => ids.has(id),
        (bin) => path.split(":").some((dir) => dir && existsSync(join(dir, bin))),
      );
    },
    legacyBesideLevel: () => {
      const dir = join(paths.home, "agents");
      if (!existsSync(dir)) return [];
      try {
        return [...loadAgents(dir).values()]
          .map((m) => [m.id, legacyBesideLevel(m)] as const)
          .filter(([, fields]) => fields.length)
          .map(([id, fields]) => `${id} (${fields.join(", ")})`);
      } catch {
        return []; // an agent that does not load is reported by the integrations check
      }
    },
    ramGb: detectPlatform().ramGb,
    hasWhisperModel: existsSync(paths.whisperModel),
    ollamaModels: async () => {
      try {
        const res = await fetch("http://127.0.0.1:11434/api/tags", {
          signal: AbortSignal.timeout(2000),
        });
        const body = (await res.json()) as { models?: { name: string }[] };
        return (body.models ?? []).map((m) => m.name);
      } catch {
        return undefined;
      }
    },
  };
}
