import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// "provider/model", e.g. cli-claude/sonnet, local/qwen3
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/;
// The claude CLI accepts an alias (newest model of a family) or a full versioned name. Anything
// else is only rejected at the first model call, so catch it when the manifest is loaded.
const CLAUDE_MODEL = /^(opus|sonnet|haiku|fable|claude-[a-z]+-\d+(-\d+)*)$/;

const modelId = z
  .string()
  .regex(MODEL, "expected provider/model")
  .superRefine((m, ctx) => {
    if (m.startsWith("cli-claude/") && !CLAUDE_MODEL.test(m.slice("cli-claude/".length))) {
      ctx.addIssue({
        code: "custom",
        message: `${m}: use an alias (opus, sonnet, haiku, fable: always the newest) or a full name like claude-opus-5-5`,
      });
    }
  });

const absolutePath = z
  .string()
  .refine(
    (p) => isAbsolute(p) || p.startsWith("~/"),
    "must be an absolute path (or start with ~/)",
  );

const publish = z.enum(["review", "auto"]);

// .strict() everywhere: an unknown key is almost always a typo, and a typo in a deny-by-default
// manifest must fail loudly rather than silently drop or misname a rule.
export const manifestSchema = z
  .object({
    id: z.string().regex(ID, "lowercase letters, digits and dashes"),
    name: z.string().min(1),
    role: z.string().min(1),
    // Workflow roles (ADR-0030), e.g. [dev] or [qa]: who may move which kanban card.
    roles: z.array(z.string().regex(ID)).default([]),
    workspace: z.string().min(1),
    models: z
      .object({
        default: modelId,
        allowed: z.array(modelId).optional(),
      })
      .strict(),
    // ADR-0067: what the agent may do without asking (0 off … 5 full). While absent, the
    // tools, shell, network and container lists below apply as written.
    level: z.number().int().min(0).max(5).optional(),
    // ADR-0067 owner-approved exception: exact executables that run outside the sandbox.
    unsandboxed: z
      .array(z.string().refine(isAbsolute, "must be an absolute path to an executable"))
      .optional(),
    // ADR-0067 owner-approved exception (until ADR-0055 stage 2): a level 4+ shell stays in the
    // CLI's host sandbox next to keyed integrations (served on the gateway's side) instead of
    // moving into a container, so local apps stay reachable.
    keys_beside_host_shell: z.boolean().optional(),
    // Deprecated (ADR-0067): `tools`, `shell`, `network: ["*"]` and `container` are compiled
    // from `level`. Still parsed so agents without a level keep working until migrated
    // (`achords levels migrate`); next to a level they are a warning (`legacyBesideLevel`).
    tools: z.array(z.string().min(1)).default([]),
    mcp: z.array(z.string().min(1)).default([]),
    fs: z
      .object({
        read: z.array(absolutePath).default([]),
        write: z.array(absolutePath).default([]),
      })
      .strict()
      .default({ read: [], write: [] }),
    // Deprecated (ADR-0067), see tools. Absent = no shell at all. Present = allow-list runs
    // directly, the rest needs approval.
    shell: z
      .object({ allow: z.array(z.string().min(1)).default([]) })
      .strict()
      .optional(),
    // Named hosts stay as remit (documentation hosts); "*" is deprecated (ADR-0067), see tools.
    network: z
      .object({ allow: z.array(z.string().min(1)).default([]) })
      .strict()
      .default({ allow: [] }),
    // Deprecated (ADR-0067), see tools. ADR-0051: with "*" in network.allow the run executes in
    // an Apple container unless the owner sets false (own risk). Absent = true with "*", false otherwise. ADR-0055: an agent
    // with a shell may be put in a container too (required next to keyed integrations).
    container: z.boolean().optional(),
    // Claude --effort (codex reasoning effort, capped at high); absent = the CLI's default.
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    // ADR-0068: who pays for this agent's runs; absent = the provider's setting (Model access).
    billing: z.enum(["api", "subscription"]).optional(),
    publish_mode: z
      .object({
        default: publish.default("review"),
        channels: z.record(z.string(), publish).default({}),
      })
      .strict()
      .default({ default: "review", channels: {} }),
    budget: z
      .object({
        per_run_tokens: z.number().int().positive(),
        per_day_tokens: z.number().int().positive(),
        per_run_usd: z.number().positive(),
        per_day_usd: z.number().positive(),
      })
      .partial()
      .strict()
      .default({}),
    sensitivity: z.enum(["normal", "local-only"]).default("normal"),
    // ADR-0029: both sides must allow a delegation; the boss is implicitly allowed everywhere.
    delegation: z
      .object({
        can_delegate_to: z.array(z.string().regex(ID)).default([]),
        accepts_from: z.array(z.string().regex(ID)).default([]),
      })
      .strict()
      .default({ can_delegate_to: [], accepts_from: [] }),
  })
  .strict()
  .refine((m) => m.container === undefined || m.network.allow.includes("*") || m.shell, {
    path: ["container"],
    message: 'only with "*" in network.allow (any website) or a shell',
  })
  .transform((m) => ({
    ...m,
    models: { default: m.models.default, allowed: m.models.allowed ?? [m.models.default] },
    container: m.container ?? m.network.allow.includes("*"),
  }))
  .refine((m) => m.models.allowed.includes(m.models.default), {
    path: ["models", "default"],
    message: "must be one of models.allowed",
  });

export type Manifest = z.output<typeof manifestSchema>;

/**
 * Fields the level replaces that are still set next to a `level` (ADR-0067): ignored there, so
 * a validation warning (`achords doctor`), not an error.
 */
export function legacyBesideLevel(m: Manifest): string[] {
  if (m.level === undefined) return [];
  return [
    ...(m.tools.length ? ["tools"] : []),
    ...(m.shell ? ["shell"] : []),
    ...(m.network.allow.includes("*") ? ['network "*"'] : []),
    ...(m.container ? ["container"] : []),
  ];
}

export function parseManifest(text: string, source: string): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${source}: invalid agent manifest\n${issues}`);
  }
  return result.data;
}

export function loadManifest(path: string): Manifest {
  return parseManifest(readFileSync(path, "utf8"), path);
}

/** Loads `<dir>/<id>/agent.yaml` for every agent folder. */
export function loadAgents(dir: string): Map<string, Manifest> {
  const agents = new Map<string, Manifest>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "agent.yaml");
    if (!existsSync(path)) continue;
    const m = loadManifest(path);
    if (m.id !== entry.name) {
      throw new Error(`${path}: folder "${entry.name}" does not match id "${m.id}"`);
    }
    agents.set(m.id, m);
  }
  return agents;
}
