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
    if (tool === "WebFetch") rules.push(...input.network.map((h) => `WebFetch(domain:${h})`));
    else if (tool === "Bash") rules.push(...input.shell.map((c) => `Bash(${c}:*)`));
    else rules.push(tool);
  }
  return rules;
}
