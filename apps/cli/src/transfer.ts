import { randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { homePaths, openCoreDatabase, readLivePid, setPaused } from "@achords/core";
import { open, openHomeVault, seal } from "@achords/secrets";

// Format (ADR-0021): MAGIC | u32 header length | header JSON | AES-256-GCM(gzip(payload JSON)).
// The header (KDF params, salt) is the GCM AAD, so it cannot be altered either.
const MAGIC = Buffer.from("ACHORDS-EXPORT-1");
const KDF = { name: "scrypt", N: 2 ** 17, r: 8, p: 1 } as const;
const MIN_PASSPHRASE = 12;

// Runtime state, logs and machine-bound key material never travel. core.db is added as a
// consistent snapshot instead of the live file (+WAL).
const SKIP = [/^run\//, /^logs\//, /^vault\.db/, /^core\.db/, /^master\.key$/];

export interface ArchiveFile {
  path: string;
  mode: number;
  data: string; // base64
}

export interface Payload {
  version: 1;
  createdAt: number;
  sourceHome: string;
  files: ArchiveFile[];
  secrets: { id: string; value: string }[];
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function buildArchive(payload: Payload, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const header = Buffer.from(JSON.stringify({ kdf: KDF, salt: salt.toString("base64") }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const body = seal(
    deriveKey(passphrase, salt),
    gzipSync(JSON.stringify(payload)),
    header.toString("utf8"),
  );
  return Buffer.concat([MAGIC, len, header, body]);
}

export function readArchive(bytes: Buffer, passphrase: string): Payload {
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an achords export");
  const len = bytes.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  const header = bytes.subarray(start, start + len);
  const { kdf, salt } = JSON.parse(header.toString("utf8")) as { kdf: typeof KDF; salt: string };
  if (kdf.name !== KDF.name || kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p) {
    throw new Error("unsupported export format");
  }
  let plain: Buffer;
  try {
    plain = open(
      deriveKey(passphrase, Buffer.from(salt, "base64")),
      bytes.subarray(start + len),
      header.toString("utf8"),
    );
  } catch {
    throw new Error("wrong passphrase or corrupt archive");
  }
  return JSON.parse(gunzipSync(plain).toString("utf8")) as Payload;
}

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** Writes an encrypted export of `home` to `file`. The gateway must be stopped. */
export function exportHome(
  home: string,
  file: string,
  passphrase: string,
  env: NodeJS.ProcessEnv = process.env,
): { files: number; secrets: number } {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const paths = homePaths(home);
  // A consistent snapshot, and only one machine polling Telegram / running agents at a time.
  if (readLivePid(paths.pidFile) !== undefined) {
    throw new Error("stop the gateway first: achords stop");
  }

  const files: ArchiveFile[] = walk(home)
    .filter((p) => !SKIP.some((re) => re.test(p)))
    .map((p) => {
      const full = join(home, p);
      return {
        path: p,
        mode: statSync(full).mode & 0o777,
        data: readFileSync(full).toString("base64"),
      };
    });

  if (existsSync(paths.db)) {
    const snapshot = join(paths.runDir, `export-${process.pid}.db`);
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    const db = openCoreDatabase(paths.db);
    try {
      db.prepare("VACUUM INTO ?").run(snapshot);
    } finally {
      db.close();
    }
    files.push({ path: "core.db", mode: 0o600, data: readFileSync(snapshot).toString("base64") });
    rmSync(snapshot, { force: true });
  }

  const secrets: Payload["secrets"] = [];
  if (existsSync(paths.vaultDb)) {
    const vault = openHomeVault(home, env);
    try {
      for (const s of vault.list())
        secrets.push({ id: s.id, value: vault.resolve(s.id, "cli:export") });
    } finally {
      vault.close();
    }
  }

  const bytes = buildArchive(
    { version: 1, createdAt: Date.now(), sourceHome: home, files, secrets },
    passphrase,
  );
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);

  if (existsSync(paths.db)) {
    const db = openCoreDatabase(paths.db);
    setPaused(db, true);
    db.close();
  }
  return { files: files.length, secrets: secrets.length };
}

/** Restores an export into an empty `home`. The queue starts paused. */
export function importHome(
  home: string,
  file: string,
  passphrase: string,
  env: NodeJS.ProcessEnv = process.env,
): { files: number; secrets: number } {
  const paths = homePaths(home);
  if (existsSync(paths.db) || existsSync(paths.vaultDb)) {
    throw new Error(`${home} already contains an install; import into an empty data folder`);
  }
  const payload = readArchive(readFileSync(file), passphrase);

  // Validate every path before writing anything.
  for (const f of payload.files) {
    const n = normalize(f.path);
    if (isAbsolute(f.path) || n.startsWith("..") || n.split(sep).includes("..")) {
      throw new Error(`unsafe path in archive: ${f.path}`);
    }
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const f of payload.files) {
    const target = join(home, f.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    let data = Buffer.from(f.data, "base64");
    // Agent manifests and prompts carry absolute paths of the old data folder.
    if (/^agents\/.*\.(ya?ml|md)$/.test(f.path)) {
      data = Buffer.from(data.toString("utf8").split(payload.sourceHome).join(home));
    }
    writeFileSync(target, data, { mode: f.mode & 0o777 });
  }

  const db = openCoreDatabase(paths.db); // migrates older schemas, refuses newer ones
  try {
    // Browser sessions and pending codes belong to the old machine.
    db.exec("DELETE FROM sessions; DELETE FROM pairing_codes; DELETE FROM auth_failures;");
    setPaused(db, true);
  } finally {
    db.close();
  }

  if (payload.secrets.length) {
    const vault = openHomeVault(home, env);
    try {
      for (const s of payload.secrets) vault.set(s.id, s.value, "cli:import");
    } finally {
      vault.close();
    }
  }
  return { files: payload.files.length, secrets: payload.secrets.length };
}
