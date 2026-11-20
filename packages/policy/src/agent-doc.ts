/**
 * One-line scope of an agent from its AGENT.md: the first paragraph that is not a heading.
 * Shown to the boss and delegating agents so routing follows what each agent is for.
 */
export function agentSummary(markdown: string, max = 300): string {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#"));
  return (paragraph ?? "").replace(/\s+/g, " ").slice(0, max);
}
