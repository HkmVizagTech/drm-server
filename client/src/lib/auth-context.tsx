"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { restoreAppSession } from "@/lib/app-session";
import { signOutPhone } from "@/lib/phone-app";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  /** False until the first check of who is signed in has finished. */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Inside the app with no login stored (closed before Android saved it):
      // the app signs back in with the phone's own key. api() also does this
      // when a stored login has expired.
      if (!localStorage.getItem("token")) await restoreAppSession();
      try {
        const u = await apiClient.get<User>("/api/auth/me");
        if (!cancelled) setUser(u);
      } catch {
        if (!cancelled) {
          localStorage.removeItem("token");
          setUser(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email: string, password: string) => {
    const res = await apiClient.post<{ token: string; user: User }>("/api/auth/login", { email, password });
    localStorage.setItem("token", res.token);
    setUser(res.user);
    // Land people where their work is. A caller has no use for the dashboard -
    // it is donation totals and fulfilment, none of which they can act on -
    // and starting them on an empty screen they cannot use is a poor first
    // impression of a tool they will open every morning.
    router.push(homeFor(res.user.role));
  };

  const logout = () => {
    localStorage.removeItem("token");
    setUser(null);
    // In the app, signing out also signs the phone out - or the app would sign
    // straight back in with the phone's key on the next screen.
    void signOutPhone();
    router.push("/login");
  };

  return <AuthContext.Provider value={{ user, ready, login, logout }}>{children}</AuthContext.Provider>;
}

/** Where a person lands after signing in: a caller on their calls, everyone else on the dashboard. */
export function homeFor(role: string): string {
  if (role === "brick_printer") return "/seva-wall/print";
  return role === "caller" ? "/calling/start" : "/dashboard";
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
