import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ArtifactsPage } from "@/pages/artifacts";
import { AuthResultPage } from "@/pages/auth-result";
import { JournalPage } from "@/pages/journal";
import { LoginPage } from "@/pages/login";
import { PresencePage } from "@/pages/presence";
import { RecordsPage } from "@/pages/records";
import { TasksPage } from "@/pages/tasks";
import { WorkspacePage } from "@/pages/workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";

const ArtifactDetailPage = lazy(() =>
  import("@/pages/artifact-detail").then((m) => ({
    default: m.ArtifactDetailPage,
  })),
);
const TaskDetailPage = lazy(() =>
  import("@/pages/task-detail").then((m) => ({
    default: m.TaskDetailPage,
  })),
);
const RecordDetailPage = lazy(() =>
  import("@/pages/record-detail").then((m) => ({
    default: m.RecordDetailPage,
  })),
);
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useSearchParams,
} from "react-router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function TasksWithDrawer() {
  return (
    <>
      <TasksPage />
      <Suspense>
        <Outlet />
      </Suspense>
    </>
  );
}

function ArtifactsWithDrawer() {
  return (
    <>
      <ArtifactsPage />
      <Suspense>
        <Outlet />
      </Suspense>
    </>
  );
}

function RecordsWithDrawer() {
  return (
    <>
      <RecordsPage />
      <Suspense>
        <Outlet />
      </Suspense>
    </>
  );
}

function ProjectRoutes({ projectId }: { projectId: string }) {
  return (
    <Route element={<Layout />}>
      <Route index element={<Navigate to="tasks" replace />} />
      <Route path="tasks" element={<TasksWithDrawer />}>
        <Route path=":id" element={<TaskDetailPage />} />
      </Route>
      <Route
        path="entities"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
      <Route
        path="entities/:id"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
      <Route path="records" element={<RecordsWithDrawer />}>
        <Route path=":type/*" element={<RecordDetailPage />} />
      </Route>
      <Route path="journal" element={<JournalPage />} />
      <Route path="presence" element={<PresencePage />} />
      <Route path="artifacts" element={<ArtifactsWithDrawer />}>
        <Route path="*" element={<ArtifactDetailPage />} />
      </Route>
      <Route
        path="*"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
    </Route>
  );
}

export function AuthGate() {
  const { isLoading, isAuthenticated, projectId } = useAuth();
  const [searchParams] = useSearchParams();

  if (searchParams.has("auth_status")) {
    return <AuthResultPage />;
  }

  if (isLoading) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: role="status" on div is the correct pattern for loading indicators
      <div
        role="status"
        className="flex min-h-screen items-center justify-center bg-background text-muted-foreground"
      >
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  if (!projectId) {
    return (
      <Routes>
        <Route path="*" element={<WorkspacePage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
      <Route path="/p/:projectId/*">{ProjectRoutes({ projectId })}</Route>
      {/* Legacy flat routes redirect to project-scoped */}
      <Route
        path="/entities"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
      <Route
        path="/entities/:id"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
      <Route
        path="/journal"
        element={<Navigate to={`/p/${projectId}/journal`} replace />}
      />
      <Route
        path="/presence"
        element={<Navigate to={`/p/${projectId}/presence`} replace />}
      />
      <Route
        path="/records"
        element={<Navigate to={`/p/${projectId}/records`} replace />}
      />
      <Route
        path="/artifacts"
        element={<Navigate to={`/p/${projectId}/artifacts`} replace />}
      />
      <Route
        path="*"
        element={<Navigate to={`/p/${projectId}/tasks`} replace />}
      />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
