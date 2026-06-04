import {
  sessionExchange,
  sessionLogout,
  sessionStatus,
  workspaceDeselect,
} from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
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
}

interface AuthContextValue extends AuthState {
  login: (projectId: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
  clearProject: () => Promise<void>;
  selectProject: (projectId: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    projectId: null,
    isLoading: true,
  });

  useEffect(() => {
    sessionStatus().then((result) => {
      if (result) {
        if (result.projectId) {
          setState({
            isAuthenticated: true,
            projectId: result.projectId,
            isLoading: false,
          });
        } else {
          setState({
            isAuthenticated: true,
            projectId: null,
            isLoading: false,
          });
        }
      } else {
        setState({ isAuthenticated: false, projectId: null, isLoading: false });
      }
    });
  }, []);

  const login = useCallback(async (projectId: string, token: string) => {
    await sessionExchange(token, projectId);
    setState({ isAuthenticated: true, projectId, isLoading: false });
  }, []);

  const logout = useCallback(async () => {
    await sessionLogout();
    queryClient.clear();
    setState({ isAuthenticated: false, projectId: null, isLoading: false });
  }, [queryClient]);

  const clearProject = useCallback(async () => {
    await workspaceDeselect();
    queryClient.clear();
    setState({ isAuthenticated: true, projectId: null, isLoading: false });
  }, [queryClient]);

  const selectProject = useCallback((projectId: string) => {
    setState((prev) => ({ ...prev, projectId }));
  }, []);

  return createElement(
    AuthContext.Provider,
    { value: { ...state, login, logout, clearProject, selectProject } },
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
