#!/usr/bin/env node
// Stand-in for Apple's `container` CLI in tests (ADR-0051).
// FAKE_CONTAINER_RECORD: file each call appends {argv} to (one JSON line per call).
// `run`: runs the command after the image on the host, in the -w folder, with only the -e names
// (and the FAKE_* test switches) in its environment, like the VM would. `kill`: recorded only.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_CONTAINER_RECORD) {
  appendFileSync(process.env.FAKE_CONTAINER_RECORD, `${JSON.stringify({ argv })}\n`);
}
if (argv[0] !== "run") process.exit(0);

const WITH_VALUE = new Set(["--name", "--cpus", "--memory", "--mount", "-e", "-w", "--progress"]);
const env = { PATH: process.env.PATH ?? "" };
let cwd = "/";
let i = 1;
while (i < argv.length && argv[i].startsWith("-")) {
  const flag = argv[i];
  if (WITH_VALUE.has(flag)) {
    const value = argv[i + 1];
    if (flag === "-e") env[value] = process.env[value] ?? "";
    if (flag === "-w") cwd = value;
    i += 2;
  } else i += 1;
}
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FAKE_")) env[k] = v;
const [, command, ...args] = argv.slice(i); // image, then the command
const child = spawn(command, args, { cwd, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
