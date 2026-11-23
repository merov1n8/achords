// Routes are plain paths (/chat/<id>, /kanban, /settings/<section>); the gateway serves the app
// for every path that is not a file or the API.

export const routeOf = (pathname: string): string[] =>
  pathname.split("/").filter(Boolean).map(decodeURIComponent);

/** The in-app path a click on this link should open without a reload, or undefined. */
export function inAppPath(
  href: string | null,
  origin: string,
  opts: { target?: string; download?: boolean; modified?: boolean } = {},
): string | undefined {
  if (!href || opts.modified || opts.download || (opts.target && opts.target !== "_self")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || url.pathname.startsWith("/api/") || url.hash) return undefined;
  return url.pathname + url.search;
}

export function navigate(path: string): void {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}
