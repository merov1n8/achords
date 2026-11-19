// Shapes returned by the gateway API (kept minimal; the server is the source of truth).

export interface Thread {
  id: string;
  title: string | null;
  sensitivity: "normal" | "local-only";
  updatedAt: number;
}

export interface Message {
  id: string;
  seq: number;
  role: "user" | "agent" | "system";
  author: string | null;
  channel: "web" | "telegram" | "system";
  content: string;
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  status: "queued" | "claimed" | "done" | "failed" | "cancelled";
  assigneeAgentId: string | null;
  threadId: string | null;
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
