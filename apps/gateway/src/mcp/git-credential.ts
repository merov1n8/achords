// ADR-0067: git's credential helper in a level 5 work-mode run (set through GIT_CONFIG_* only).
// It holds no credential: it asks the gateway with the run's push token, and the gateway answers
// from the vault for the project's own repositories. The password goes only to git's pipe.
const HUB = process.env.ACHORDS_HUB_URL ?? "";
const TOKEN = process.env.ACHORDS_GIT_TOKEN ?? "";

// git also calls `store` and `erase`; only `get` is answered.
if (process.argv[2] !== "get" || !HUB || !TOKEN) process.exit(0);

let input = "";
for await (const chunk of process.stdin) input += chunk;
const fields: Record<string, string> = {};
for (const line of input.split("\n")) {
  const at = line.indexOf("=");
  if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
}
try {
  const res = await fetch(`${HUB}/api/agent/git-credential`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ protocol: fields.protocol, host: fields.host, path: fields.path }),
    signal: AbortSignal.timeout(15_000),
  });
  const out = (await res.json()) as { ok?: boolean; username?: string; password?: string };
  if (res.ok && out.ok && out.username && out.password && !/[\n\r]/.test(out.password)) {
    process.stdout.write(`username=${out.username}\npassword=${out.password}\n`);
  } else {
    // Nothing on stdout: git then fails without a credential.
    process.stderr.write("achords: no push credential for this repository in this run\n");
  }
} catch {
  process.stderr.write("achords: the gateway did not answer the credential request\n");
}
