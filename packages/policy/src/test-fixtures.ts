// Shared test fixture: a complete agent manifest.
export const WEB_DEV = `
id: web-dev
name: Web developer
role: web-dev
workspace: web-clients
models:
  default: cli-claude/sonnet
  allowed: [cli-claude/sonnet, local/qwen3]
tools: [Read, Edit]
mcp: [wordpress]
fs:
  read: [/srv/clients]
  write: [/srv/clients/site-a]
shell:
  allow: ["git status", "pnpm test"]
network:
  allow: [example.com]
publish_mode:
  default: review
  channels:
    wordpress: auto
budget:
  per_run_tokens: 200000
  per_day_usd: 5
`;
