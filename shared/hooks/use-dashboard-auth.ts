import { useState, useEffect, useCallback } from "preact/hooks";

export type DashboardAuthStatus = "loading" | "login" | "authenticated";

/** Custom event fired when any fetch receives a 401 from dashboard endpoints. */
const AUTH_EXPIRED_EVENT = "codex:auth-expired";
const DASHBOARD_PASSWORD_KEY = "codex-proxy-dashboard-password";

function getSavedPassword(): string | null {
  try {
    const value = window.localStorage.getItem(DASHBOARD_PASSWORD_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

function savePassword(password: string): void {
  try {
    window.localStorage.setItem(DASHBOARD_PASSWORD_KEY, password);
  } catch {
    // Ignore storage failures and fall back to normal login flow.
  }
}

function clearSavedPassword(): void {
  try {
    window.localStorage.removeItem(DASHBOARD_PASSWORD_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Install a one-time global fetch wrapper that detects 401 responses
 * from dashboard-protected endpoints and dispatches an auth-expired event.
 */
let interceptorInstalled = false;
function installFetchInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const resp = await originalFetch(input, init);
    if (resp.status === 401) {
      // Only fire for dashboard endpoints, not for proxy API routes
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
      const isProxyApi = url.includes("/v1/") || url.includes("/v1beta/");
      if (!isProxyApi) {
        const probe = resp.clone();
        const body = await probe.json().catch(() => null) as { error?: string } | null;
        if (body?.error === "Dashboard login required") {
          window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
        }
      }
    }
    return resp;
  };
}

export function useDashboardAuth() {
  const [status, setStatus] = useState<DashboardAuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isRemoteSession, setIsRemoteSession] = useState(false);

  const login = useCallback(async (password: string, options?: { silent?: boolean }) => {
    if (!options?.silent) setError(null);
    try {
      const res = await fetch("/auth/dashboard-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        savePassword(password);
        setStatus("authenticated");
        setIsRemoteSession(true);
        setError(null);
        return true;
      }

      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!options?.silent) {
        setStatus("login");
        setError(data?.error || "Login failed");
      } else {
        clearSavedPassword();
      }
      return false;
    } catch {
      if (!options?.silent) {
        setStatus("login");
        setError("Network error");
      }
      return false;
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/auth/dashboard-status");
      const data: { required: boolean; authenticated: boolean } = await res.json();
      if (!data.required || data.authenticated) {
        setStatus("authenticated");
        setIsRemoteSession(data.required && data.authenticated);
        setError(null);
      } else {
        const savedPassword = getSavedPassword();
        if (savedPassword) {
          const ok = await login(savedPassword, { silent: true });
          if (!ok) setStatus("login");
        } else {
          setStatus("login");
        }
      }
    } catch {
      // If status endpoint fails, assume no gate (backwards compat)
      setStatus("authenticated");
    }
  }, [login]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Listen for auth-expired events from the global fetch interceptor
  useEffect(() => {
    installFetchInterceptor();
    const handler = async () => {
      const savedPassword = getSavedPassword();
      if (savedPassword) {
        setStatus("loading");
        const ok = await login(savedPassword, { silent: true });
        if (ok) return;
      }
      setStatus("login");
      setIsRemoteSession(false);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
  }, [login]);

  const logout = useCallback(async () => {
    try {
      await fetch("/auth/dashboard-logout", { method: "POST" });
    } finally {
      clearSavedPassword();
      setStatus("login");
      setIsRemoteSession(false);
    }
  }, []);

  return { status, error, login, logout, isRemoteSession };
}
