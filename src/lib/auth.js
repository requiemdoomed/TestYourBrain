import { createContext, html, useCallback, useContext, useEffect, useState } from "../../vendor/preact-htm.js";
import { api } from "./api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api("/api/auth/me")
      .then((u) => !cancelled && setUser(u))
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const out = await api("/api/auth/login", { method: "POST", json: { email, password } });
    setUser(out.user);
  }, []);

  const register = useCallback(async (name, email, password) => {
    const out = await api("/api/auth/register", { method: "POST", json: { name, email, password } });
    setUser(out.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  return html`<${AuthContext.Provider} value=${{ user, ready, login, register, logout, setUser }}>
    ${children}
  <//>`;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
