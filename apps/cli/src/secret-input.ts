/**
 * Reads a secret from stdin: hidden typing on a terminal, or the whole stream when piped.
 * Secrets never come from argv, which ends up in shell history and `ps` output.
 */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (key: string) => {
      for (const ch of key) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

/**
 * Question/answer prompter. On a terminal: line input, hidden for secrets. When piped: answers
 * are taken line by line from stdin, so scripts and tests can drive interactive commands.
 */
export function createPrompter() {
  let piped: Promise<string[]> | undefined;
  const nextPiped = async () => {
    piped ??= (async () => {
      let data = "";
      for await (const chunk of process.stdin) data += chunk;
      return data.split(/\r?\n/);
    })();
    return (await piped).shift() ?? "";
  };
  return async (question: string, opts: { secret?: boolean } = {}): Promise<string> => {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${question} `);
      const answer = await nextPiped();
      process.stderr.write("\n");
      return answer;
    }
    if (opts.secret) return readSecret(`${question} `);
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(`${question} `);
    } finally {
      rl.close();
    }
  };
}
