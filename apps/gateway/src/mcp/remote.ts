// A remote MCP server over Streamable HTTP (ADR-0050), seen by the launcher like a stdio
// server: each JSON-RPC line from the CLI is one POST, every message of the answer (JSON or an
// SSE stream) comes back as one line. No server-initiated stream (GET): tools do not need it.

export interface RemoteServer {
  write(line: string): void;
  /** No more input: `onDone` runs once every answer has been passed on. */
  end(): void;
}

export function remoteServer(
  remote: { url: string; headers: Record<string, string> },
  onLine: (line: string) => void,
  onDone: () => void,
): RemoteServer {
  let session: string | undefined;
  let protocol: string | undefined;
  // Requests leave in order; each waits only for the previous one's headers (its session id),
  // except initialize, whose answer carries the protocol version for the next ones.
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let ended = false;
  const settle = () => {
    if (ended && pending === 0) onDone();
  };
  const emit = (data: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      const v = (m as { result?: { protocolVersion?: unknown } })?.result?.protocolVersion;
      if (typeof v === "string") protocol = v;
      onLine(JSON.stringify(m));
    }
  };
  const read = async (res: Response) => {
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      emit(await res.text());
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    for await (const chunk of res.body ?? []) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") {
          if (data.length) emit(data.join("\n"));
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length) emit(data.join("\n"));
  };
  return {
    write(line) {
      let msg: { id?: unknown; method?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const fail = (message: string) => {
        // Notifications get no answer, also not an error.
        if (msg.id !== undefined) {
          onLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } }));
        }
      };
      pending++;
      const sent = queue.then(async () => {
        const res = await fetch(remote.url, {
          method: "POST",
          // The key goes to the catalog's host only, never to a redirect target.
          redirect: "error",
          headers: {
            ...remote.headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session ? { "mcp-session-id": session } : {}),
            ...(protocol ? { "mcp-protocol-version": protocol } : {}),
          },
          body: line,
        });
        session = res.headers.get("mcp-session-id") ?? session;
        return res;
      });
      const done = sent
        .then(async (res) => {
          if (!res.ok) {
            await res.body?.cancel();
            return fail(`remote server answered HTTP ${res.status}`);
          }
          await read(res);
        })
        .catch((err: Error) => fail(`remote server not reachable (${err.name})`))
        .finally(() => {
          pending--;
          settle();
        });
      queue = msg.method === "initialize" ? done : sent.catch(() => {});
    },
    end() {
      ended = true;
      settle();
    },
  };
}
