import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// No inline scripts or styles: the build emits files only, so 'self' is enough.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const headers = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Serves the built web UI; unknown routes get index.html (client-side routing). */
export function serveStatic(dir: string, pathname: string, res: ServerResponse): void {
  const root = resolve(dir);
  const index = join(root, "index.html");
  if (!existsSync(index)) {
    res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
    res.end("Web UI not built. Run `pnpm build` in the achords repo.");
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = "/";
  }
  const target = resolve(root, `.${decoded}`);
  // Anything resolving outside the dist folder is treated as an unknown app route.
  const inside = target === root || target.startsWith(root + sep);
  const isFile = inside && existsSync(target) && statSync(target).isFile();

  if (!isFile && extname(decoded)) {
    res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const file = isFile ? target : index;
  const hashedAsset = file.startsWith(join(root, "assets") + sep);
  res.writeHead(200, {
    ...headers,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(readFileSync(file));
}
