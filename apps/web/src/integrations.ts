import type { IntegrationStatus } from "./types.ts";

/** One choice in "Add sign-in": a web OAuth flow (all its entries) or one entry's tokens. */
export interface SigninService {
  key: string;
  name: string;
  oauth?: "google";
  entries: IntegrationStatus[];
}

/** Shared sign-ins to offer: entries with the same OAuth flow collapse into one choice. */
export function signinServices(items: IntegrationStatus[]): SigninService[] {
  const out: SigninService[] = [];
  for (const s of items) {
    if (s.kind !== "account") continue;
    const key = s.oauth ?? s.id;
    const found = out.find((x) => x.key === key);
    if (found) found.entries.push(s);
    else
      out.push({
        key,
        name: s.oauth ? "Google" : s.name,
        ...(s.oauth ? { oauth: s.oauth } : {}),
        entries: [s],
      });
  }
  return out;
}

/** Entries that lose access when `s`'s owner-wide secrets are deleted (itself first). */
export function revokeAffects(items: IntegrationStatus[], s: IntegrationStatus): string[] {
  return [
    s.name,
    ...items
      .filter((x) => x.id !== s.id && x.secrets.some((id) => s.secrets.includes(id)))
      .map((x) => x.name),
  ];
}

/** Has a shared sign-in that can be revoked (at least one of its secrets is set). */
export const revocable = (s: IntegrationStatus): boolean =>
  s.secrets.length > s.missingSecrets.length;
