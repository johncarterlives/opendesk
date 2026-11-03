import { ApiError } from "@/lib/api/client";
import { config } from "@/lib/config";
import { queryClient } from "@/lib/queryClient";
import type { CustomerToken, CustomerLogin, PortalConfig, CustomerTicket, CustomerMessage, Page } from "./types";

let accessToken: string | null = null;
let activeSlug: string | null = null;
let activeSubject: string | null = null;
let refreshing: { slug: string; promise: Promise<boolean> } | null = null;
let generation = 0;
let identityVersion = 0;
const identityListeners = new Set<() => void>();
export function customerIdentityVersion() { return identityVersion; }
export function subscribeCustomerIdentity(listener: () => void) {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}
function clearCustomerQueries() {
  queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] === "customerPortal" && queryKey[1] !== "config" });
}
function identityChanged() {
  identityVersion++;
  identityListeners.forEach((listener) => listener());
}

export function clearCustomer() {
  generation++;
  accessToken = null;
  activeSlug = null;
  activeSubject = null;
  clearCustomerQueries();
  identityChanged();
}
async function request<T>(path: string, body?: unknown, bearer = false): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(bearer && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError({ ...problem, status: response.status });
  }
  return response.status === 204 ? undefined as T : response.json();
}
// The server validates this token. Its subject is used only to isolate local caches.
function tokenSubject(token: string): string | null {
  try {
    const payload: unknown = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload === "object" && payload !== null && "sub" in payload && typeof payload.sub === "string" ? payload.sub : null;
  } catch { return null; }
}
function acceptToken(slug: string, token: string) {
  const subject = tokenSubject(token);
  const changed = activeSubject !== subject || !subject;
  if (changed) clearCustomerQueries();
  accessToken = token;
  activeSlug = slug;
  activeSubject = subject;
  if (changed) identityChanged();
}
const publicPath = (slug: string) => `/v1/public/help/${encodeURIComponent(slug)}/portal`;
export async function refreshCustomer(slug: string): Promise<boolean> {
  if (activeSlug && activeSlug !== slug) clearCustomer();
  if (refreshing) {
    if (refreshing.slug === slug) return refreshing.promise;
    await refreshing.promise;
    return refreshCustomer(slug);
  }
  const current = generation;
  const promise = request<CustomerToken>("/v1/customer/portal/auth/refresh", { workspace_slug: slug })
    .then((result) => { if (generation !== current) return false; acceptToken(slug, result.access_token); return true; })
    .catch((error: unknown) => { if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false; throw error; }).finally(() => { refreshing = null; });
  refreshing = { slug, promise };
  return promise;
}
async function authed<T>(slug: string, path: string, body?: unknown): Promise<T> {
  if (activeSlug !== slug || !accessToken) { if (!await refreshCustomer(slug)) throw new ApiError({ status: 401 }); }
  try { return await request<T>(path, body, true); }
  catch (e) { if (!(e instanceof ApiError) || e.status !== 401 || !await refreshCustomer(slug)) throw e; return request<T>(path, body, true); }
}
export const customerPortal = {
  config: (slug: string) => request<PortalConfig>(`${publicPath(slug)}/config`),
  login: async (slug: string, email: string, password: string, turnstile_token?: string) => {
    clearCustomer();
    const result = await request<CustomerLogin>(`${publicPath(slug)}/auth/login`, { email, password, turnstile_token });
    if (!result.change_password) acceptToken(slug, result.access_token);
    return result;
  },
  forgot: (slug: string, email: string, turnstile_token?: string) => request<void>(`${publicPath(slug)}/auth/forgot`, { email, turnstile_token }),
  reset: (slug: string, token: string, password: string, turnstile_token?: string) => request<void>(`${publicPath(slug)}/auth/reset`, { token, password, turnstile_token }),
  logout: async (slug: string) => {
    try { await authed<void>(slug, "/v1/customer/portal/auth/logout", {}); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
    clearCustomer();
  },
  tickets: (slug: string, cursor?: string) => authed<Page<CustomerTicket>>(slug, `/v1/customer/portal/tickets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  ticket: (slug: string, id: string) => authed<CustomerTicket>(slug, `/v1/customer/portal/tickets/${encodeURIComponent(id)}`),
  messages: (slug: string, id: string, cursor?: string) => authed<Page<CustomerMessage>>(slug, `/v1/customer/portal/tickets/${encodeURIComponent(id)}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  reply: (slug: string, id: string, body: string) => authed<CustomerMessage>(slug, `/v1/customer/portal/tickets/${encodeURIComponent(id)}/messages`, { body }),
};
