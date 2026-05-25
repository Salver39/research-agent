const KEY_PREFIX = "owner_token:";
const KEY_AUTH = "auth_token";

export function saveOwnerToken(sessionId: string, token: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_PREFIX + sessionId, token);
  } catch {
    /* private mode / quota */
  }
}

export function saveAuthToken(token: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_AUTH, token);
  } catch {
    /* private mode / quota */
  }
}

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY_AUTH);
  } catch {
    return null;
  }
}

export function clearAuthToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY_AUTH);
  } catch {
    /* ignore */
  }
}

export function authBearer(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getOwnerToken(sessionId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
}

export function authHeaders(sessionId: string): Record<string, string> {
  const token = getOwnerToken(sessionId);
  return token ? { "X-Owner-Token": token } : {};
}

export function withTokenQuery(url: string, sessionId: string): string {
  const token = getOwnerToken(sessionId);
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
