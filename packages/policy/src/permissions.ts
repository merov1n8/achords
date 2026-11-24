// CLI allow rules from a manifest (ADR-0010). A bare tool name in --allowedTools allows it
// everywhere, so file, fetch and shell tools are always scoped; anything not allowed is refused
// in print mode. Verified against the real claude CLI.

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// The CLI's absolute-path rule form is `//abs/path/**`.
const under = (tool: string, dir: string) => `${tool}(/${dir.replace(/\/+$/, "")}/**)`;

export function allowRules(input: {
  tools: string[];
  /** Absolute folders (already expanded and resolved). */
  read: string[];
  write: string[];
  network: string[];
  shell: string[];
}): string[] {
  const { tools } = input;
  const rules: string[] = [];
  if (tools.some((t) => READ_TOOLS.has(t))) {
    // Glob and Grep follow the Read rules.
    for (const dir of new Set([...input.write, ...input.read])) rules.push(under("Read", dir));
  }
  if (tools.some((t) => WRITE_TOOLS.has(t))) {
    for (const dir of new Set(input.write)) rules.push(under("Edit", dir));
  }
  for (const tool of tools) {
    if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) continue;
    // "*" is the open web (owner-granted full access, ADR-0035): the bare tool name.
    if (tool === "WebFetch") {
      rules.push(
        ...(input.network.includes("*")
          ? ["WebFetch"]
          : [...new Set(input.network.map((h) => `WebFetch(domain:${h.split("/")[0]})`))]),
      );
    } else if (tool === "Bash") rules.push(...input.shell.map((c) => `Bash(${c}:*)`));
    else rules.push(tool);
  }
  return rules;
}

// Sites in `network.allow` are a host ("example.com") or a host with a path prefix
// ("www.beds24.com/api/", ADR-0057). Only plain URL characters: the entries end up in a shell
// pattern.
const SITE = /^[a-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/;

/** A site entry from a URL ("https://host/path/"), or undefined when it is not a plain URL. */
export function siteOf(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash) return undefined;
  const site = u.pathname === "/" ? u.hostname : `${u.hostname}${u.pathname}`;
  return SITE.test(site) ? site : undefined;
}

/**
 * The CLI's WebFetch rules know hosts only, so a site with a path gets a PreToolUse hook (passed
 * with --settings) that refuses any URL outside the allowed sites. Undefined when no entry has
 * a path or the web is open. `..` and encoded dots are refused, so a path cannot climb out.
 */
export function webFetchSettings(network: string[]): string | undefined {
  if (network.includes("*")) return undefined;
  const sites = network.filter((s) => SITE.test(s));
  if (!sites.some((s) => s.includes("/"))) return undefined;
  const patterns = sites.flatMap((s) =>
    s.includes("/")
      ? [`https://${s}*`, `http://${s}*`]
      : [`https://${s}`, `https://${s}/*`, `http://${s}`, `http://${s}/*`],
  );
  const command = [
    `u=$(sed -n 's/.*"url" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    `case "$u" in *..*|*%2[eE]*) ;; ${patterns.join("|")}) exit 0;; esac`,
    `echo "Not allowed: $u. Allowed: ${sites.join(", ")}" >&2`,
    "exit 2",
  ].join("; ");
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "WebFetch", hooks: [{ type: "command", command }] }] },
  });
}

export const NO_COAUTHOR =
  "Commit messages must not contain Co-Authored-By lines in this project; remove the line and commit again.";

// A PreToolUse hook on Bash: no shell command mentions co-authored-by, and `git commit -F/--file`
// may not read a message file that holds it. A file the command itself writes is caught by the
// first check; an obfuscated spelling is not (the CLI's attribution setting is the first layer).
const COAUTHOR_HOOK_COMMAND = [
  "i=$(cat)",
  `refuse() { echo "${NO_COAUTHOR}" >&2; exit 2; }`,
  `case $(printf %s "$i" | tr 'A-Z' 'a-z') in *co-authored-by*) refuse;; esac`,
  `case "$i" in *commit*) ;; *) exit 0;; esac`,
  String.raw`d=$(printf %s "$i" | sed -nE 's/.*"cwd" *: *"([^"]*)".*/\1/p' | head -n 1)`,
  `[ -n "$d" ] && cd "$d" 2>/dev/null`,
  String.raw`for f in $(printf %s "$i" | sed -nE 's/.*"command" *: *"(.*)".*/\1/p' | tr -d '\042\047\134' | grep -oE -- '(-F|--file)( +|=)?[^ ;&|]+' | sed -E 's/^(-F|--file)( +|=)?//'); do [ -f "$f" ] && grep -qi co-authored-by "$f" && refuse; done`,
  "exit 0",
].join("; ");

/**
 * `--settings` for every claude run: the CLI's own commit and PR attribution off, the
 * co-authored-by hook on Bash, and the WebFetch path hook and sandbox box when given. Both hooks
 * go under one PreToolUse list so neither replaces the other.
 */
export function claudeRunSettings(
  fetchHook: string | undefined,
  box: Record<string, unknown> | undefined,
): string {
  const fetch = fetchHook
    ? (JSON.parse(fetchHook) as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse
    : [];
  return JSON.stringify({
    ...box,
    attribution: { commit: "", pr: "", sessionUrl: false },
    hooks: {
      PreToolUse: [
        ...fetch,
        { matcher: "Bash", hooks: [{ type: "command", command: COAUTHOR_HOOK_COMMAND }] },
      ],
    },
  });
}

/**
 * Whether a run reads the open web (ADR-0066), the one definition for skills, memory and the
 * publishing guard: the effective run allows any site, has WebSearch, or has full access. A
 * WebFetch limited to named hosts (the project's own sites, ADR-0057) is not open web.
 */
export function openWeb(
  run: { tools: string[]; network: { allow: string[] } },
  elevated: boolean,
): boolean {
  return elevated || run.network.allow.includes("*") || run.tools.includes("WebSearch");
}
