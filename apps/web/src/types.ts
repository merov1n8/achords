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
  missingSecrets: string[];
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
