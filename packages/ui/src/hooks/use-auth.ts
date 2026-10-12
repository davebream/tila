import { accountRequest } from "@/lib/account-api";
import { sessionLogout, sessionStatus, workspaceDeselect } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionCapabilities } from "@tila/schemas";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createElement } from "react";

interface AuthState {
  isAuthenticated: boolean;
  projectId: string | null;
  isLoading: boolean;
  /**
   * Server-computed management capabilities (#102). Null until loaded or when
   * the server did not send them. The UI never derives these from permission
   * strings or token scopes.
   */
  capabilities: SessionCapabilities | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearProject: () => Promise<void>;
  selectProject: (projectId: string) => void;
  /** Re-read `/auth/session/status` (after step-up or project selection). */
  refreshStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    projectId: null,
    isLoading: true,
    capabilities: null,
  });

  const refreshStatus = useCallback(async () => {
    const result = await sessionStatus();
    if (result) {
      setState({
        isAuthenticated: true,
        projectId: result.projectId || null,
        isLoading: false,
        capabilities: result.capabilities,
      });
    } else {
      setState({
        isAuthenticated: false,
        projectId: null,
        isLoading: false,
        capabilities: null,
      });
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const login = useCallback(
    async (email: string, password: string) => {
      await accountRequest("/auth/sign-in/email", { email, password });
      queryClient.clear();
      await refreshStatus();
    },
    [refreshStatus, queryClient],
  );

  const logout = useCallback(async () => {
    await sessionLogout();
    queryClient.clear();
    setState({
      isAuthenticated: false,
      projectId: null,
      isLoading: false,
      capabilities: null,
    });
  }, [queryClient]);

  const clearProject = useCallback(async () => {
    await workspaceDeselect();
    queryClient.clear();
    setState({
      isAuthenticated: true,
      projectId: null,
      isLoading: false,
      capabilities: null,
    });
  }, [queryClient]);

  const selectProject = useCallback(
    (projectId: string) => {
      setState((prev) => ({ ...prev, projectId, capabilities: null }));
      void refreshStatus();
    },
    [refreshStatus],
  );

  return createElement(
    AuthContext.Provider,
    {
      value: {
        ...state,
        login,
        logout,
        clearProject,
        selectProject,
        refreshStatus,
      },
    },
    children,
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
