import {
  DefaultRedirect,
  StepUpResume,
} from "@/components/admin/step-up-resume";
import { Layout } from "@/components/layout";
import {
  EntityAlias,
  LegacyRedirect,
  ProjectHome,
} from "@/components/legacy-redirect";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { AccountPage } from "@/pages/account";
import {
  DevicePage,
  HandoffPage,
  InvitationPage,
  RecoveryPage,
} from "@/pages/account-access";
import { AgentsPage } from "@/pages/agents";
import { ArtifactsPage } from "@/pages/artifacts";
import { AuthResultPage } from "@/pages/auth-result";
import { DecisionsPage } from "@/pages/decisions";
import { DeliveriesPage } from "@/pages/deliveries";
import { JournalPage } from "@/pages/journal";
import { LoginPage } from "@/pages/login";
import { OverviewPage } from "@/pages/overview";
import { PresencePage } from "@/pages/presence";
import { QueuePage } from "@/pages/queue";
import { RecordsPage } from "@/pages/records";
import { RoomsPage } from "@/pages/rooms";
import { RuntimePage } from "@/pages/runtime";
import { SettingsPage } from "@/pages/settings";
import { SettingsDefinitionsPage } from "@/pages/settings-definitions";
import { SignalsPage } from "@/pages/signals";
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
const TaskCreateDrawer = lazy(() =>
  import("@/components/work/task-create").then((m) => ({
    default: m.TaskCreateDrawer,
  })),
);
const RecordCreateDrawer = lazy(() =>
  import("@/components/work/record-editor").then((m) => ({
    default: m.RecordCreateDrawer,
  })),
);
const RecordDetailPage = lazy(() =>
  import("@/pages/record-detail").then((m) => ({
    default: m.RecordDetailPage,
  })),
);
import {
  BrowserRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function TasksWithDrawer() {
  const [searchParams] = useSearchParams();
  return (
    <>
      <TasksPage />
      <Suspense>
        <Outlet />
      </Suspense>
      {searchParams.get("create") === "task" && (
        <Suspense>
          <TaskCreateDrawer />
        </Suspense>
      )}
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
  const [searchParams] = useSearchParams();
  return (
    <>
      <RecordsPage />
      <Suspense>
        <Outlet />
      </Suspense>
      {searchParams.get("create") === "record" && searchParams.get("type") && (
        <Suspense>
          <RecordCreateDrawer />
        </Suspense>
      )}
    </>
  );
}

function ProjectRoutes({ projectId }: { projectId: string }) {
  return (
    <Route element={<Layout />}>
      <Route index element={<ProjectHome projectId={projectId} />} />
      <Route path="overview" element={<OverviewPage />} />
      <Route path="tasks" element={<TasksWithDrawer />}>
        <Route path=":id" element={<TaskDetailPage />} />
      </Route>
      <Route
        path="entities/*"
        element={<EntityAlias projectId={projectId} />}
      />
      <Route path="records" element={<RecordsWithDrawer />}>
        <Route path=":type/*" element={<RecordDetailPage />} />
      </Route>
      <Route path="journal" element={<JournalPage />} />
      <Route path="queue" element={<QueuePage />} />
      <Route path="decisions" element={<DecisionsPage />} />
      <Route path="decisions/:questionId" element={<DecisionsPage />} />
      <Route path="presence" element={<PresencePage />} />
      <Route path="signals" element={<SignalsPage />} />
      <Route path="rooms" element={<RoomsPage />} />
      <Route path="rooms/:roomId" element={<RoomsPage />} />
      <Route path="agents" element={<AgentsPage />} />
      <Route
        path="agents/:agentId/deliveries/:deliveryId"
        element={<AgentsPage />}
      />
      <Route path="deliveries" element={<DeliveriesPage />} />
      <Route
        path="deliveries/:agentId/:deliveryId"
        element={<DeliveriesPage />}
      />
      <Route path="runtime" element={<RuntimePage />} />
      <Route path="runtime/:agentId" element={<RuntimePage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route
        path="settings/definitions"
        element={<SettingsDefinitionsPage />}
      />
      <Route path="artifacts" element={<ArtifactsWithDrawer />}>
        <Route path="*" element={<ArtifactDetailPage />} />
      </Route>
      <Route path="*" element={<ProjectHome projectId={projectId} />} />
    </Route>
  );
}

export function AuthGate() {
  const { isLoading, isAuthenticated, projectId } = useAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  if (location.pathname === "/recover") return <RecoveryPage />;
  if (location.pathname === "/invite") return <InvitationPage />;
  if (location.pathname === "/handoff") return <HandoffPage />;

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

  if (location.pathname === "/login") return <LoginPage />;
  if (isAuthenticated && location.pathname === "/device") return <DevicePage />;
  if (isAuthenticated && location.pathname === "/account")
    return <AccountPage />;

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  if (!projectId) {
    return (
      <>
        <StepUpResume />
        <Routes>
          <Route path="*" element={<WorkspacePage />} />
        </Routes>
      </>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<DefaultRedirect projectId={projectId} />} />
      <Route path="/p/:projectId/*">{ProjectRoutes({ projectId })}</Route>
      {/* Flat URLs from before project-scoped routes keep working. */}
      <Route path="*" element={<LegacyRedirect projectId={projectId} />} />
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
