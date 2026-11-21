// Shapes returned by the gateway API (kept minimal; the server is the source of truth).

export interface Thread {
  id: string;
  title: string | null;
  sensitivity: "normal" | "local-only";
  project: string | null;
  pinned: boolean;
  archived: boolean;
  /** A schedule reports here. */
  scheduled: boolean;
  /** Name of the agent that wrote last; null before any reply. */
  lastAgent: string | null;
  updatedAt: number;
}

export interface Project {
  slug: string;
  name: string;
  workspace: string;
  dir: string;
  filesDir: string;
}

export interface Message {
  id: string;
  seq: number;
  role: "user" | "agent" | "system";
  author: string | null;
  channel: "web" | "telegram" | "system";
  content: string;
  actions: { label: string; data: string }[] | null;
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  status: "queued" | "claimed" | "done" | "failed" | "cancelled";
  assigneeAgentId: string | null;
  threadId: string | null;
  parentId: string | null;
  /** Kanban column (workflow); null = shown inside its root task's card. */
  column: string | null;
  project: string | null;
  /** Made by hand and not started yet: no agent works on it until the owner starts it. */
  parked: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  workspace: string;
}

/** Write-only: the API never returns secret values. */
export interface SecretStatus {
  id: string;
  set: boolean;
  last4: string | null;
  updatedAt: number | null;
}

export interface Device {
  id: string;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

/** GET /api/integrations (ADR-0034): what each catalog integration still needs. */
export interface IntegrationStatus {
  id: string;
  name: string;
  usedBy: string[];
  command?: string;
  commandFound: boolean;
  /** Owner-wide vault ids (never values). */
  secrets: string[];
  missingSecrets: string[];
  /** Signed in from the web with this OAuth flow (ADR-0048). */
  oauth?: "google";
  /** What to install when the program is not on the PATH. */
  install?: string;
  perProject: boolean;
  projectsReady: string[];
  scoped: boolean;
  projectsScoped: string[];
  ready: boolean;
  testable: boolean;
  sites: { project: string; url: string; ready: boolean; missing: string[] }[];
  kind: "account" | "client" | "local";
}

/** GET /api/monitors (ADR-0039). */
export interface Monitor {
  id: string;
  name: string;
  kind: "site" | "stuck" | "integration";
  config: Record<string, unknown>;
  everyMinutes: number;
  enabled: boolean;
  state: "unknown" | "ok" | "alert";
  detail: string | null;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
}

/** GET /api/skills (ADR-0049). */
export interface Skill {
  workspace: string;
  name: string;
  description: string;
  enabled: boolean;
  source?: string;
  updated?: string;
  body: string;
}

export interface SkillProposal {
  id: string;
  proposedBy: string;
  workspace: string;
  name: string;
  description: string;
  body: string;
  reason: string;
  replaces: string | null;
  sourceUrl: string | null;
  createdAt: number;
}

export interface SkillsPage {
  skills: Skill[];
  workspaces: string[];
  modes: Record<string, "review" | "auto">;
  proposals: SkillProposal[];
}
