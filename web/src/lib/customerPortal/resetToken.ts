/** Remove the one-time token before the router creates its browser history. */
export function captureResetToken(): string {
  const url = new URL(window.location.href);
  if (!/^\/portal\/[^/]+\/reset\/?$/.test(url.pathname)) return "";
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("token") ?? url.searchParams.get("token") ?? "";
  if (!fragment.has("token") && !url.searchParams.has("token")) return "";
  const fragmentHasToken = fragment.has("token");
  fragment.delete("token");
  url.searchParams.delete("token");
  const hash = fragmentHasToken ? fragment.toString() : url.hash.slice(1);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + (hash ? `#${hash}` : ""));
  return token;
}
