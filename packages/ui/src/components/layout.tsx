import { useAuth } from "@/hooks/use-auth";
import {
  workspaceDeselect,
  workspaceProjects,
  workspaceSelect,
} from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { ErrorBoundary } from "./error-boundary";
import { Button } from "./ui/button";
import { CommandPalette } from "./ui/command-palette";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { WelcomeBanner } from "./ui/welcome-banner";

type Density = "compact" | "comfortable" | "cozy";
type Theme = "dark" | "light" | "system";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* noop in test env */
  }
}

function resolveTheme(pref: Theme): "dark" | "light" {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useDisplayPrefs() {
  const [density, setDensityState] = useState<Density>(
    () => (readStorage("tila-density") as Density) || "comfortable",
  );
  const [theme, setThemeState] = useState<Theme>(
    () => (readStorage("tila-theme") as Theme) || "system",
  );

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    writeStorage("tila-density", d);
    document.documentElement.setAttribute("data-density", d);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writeStorage("tila-theme", t);
    document.documentElement.setAttribute("data-theme", resolveTheme(t));
  }, []);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    document.documentElement.setAttribute("data-theme", resolveTheme(theme));
  }, [density, theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange() {
      document.documentElement.setAttribute(
        "data-theme",
        resolveTheme("system"),
      );
    }
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { density, setDensity, theme, setTheme };
}

function DisplaySettings() {
  const { density, setDensity, theme, setTheme } = useDisplayPrefs();
  const [open, setOpen] = useState(false);

  const densities: Density[] = ["compact", "comfortable", "cozy"];
  const themes: Theme[] = ["system", "dark", "light"];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-2 py-1 text-[13px] text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground hover:bg-[var(--color-row-hover-2)] cursor-pointer"
          aria-label="Display settings"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 border-border bg-card p-0">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Density
          </span>
        </div>
        <div className="px-1 py-1" role="radiogroup" aria-label="Density">
          {densities.map((d) => (
            <button
              key={d}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: button with role="radio" inside radiogroup is correct ARIA pattern
              role="radio"
              aria-checked={density === d}
              className={`w-full text-left text-[13px] px-2 py-1 rounded-sm cursor-pointer transition-[background-color,color] duration-150 ${density === d ? "text-signal-blue bg-tint-blue-15" : "text-muted-foreground hover:text-foreground hover:bg-[var(--color-row-hover-2)]"}`}
              onClick={() => setDensity(d)}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="px-3 py-2 border-t border-border">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Theme
          </span>
        </div>
        <div className="px-1 py-1" role="radiogroup" aria-label="Theme">
          {themes.map((t) => (
            <button
              key={t}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: button with role="radio" inside radiogroup is correct ARIA pattern
              role="radio"
              aria-checked={theme === t}
              className={`w-full text-left text-[13px] px-2 py-1 rounded-sm cursor-pointer transition-[background-color,color] duration-150 ${theme === t ? "text-signal-blue bg-tint-blue-15" : "text-muted-foreground hover:text-foreground hover:bg-[var(--color-row-hover-2)]"}`}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TilaMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="410 850 470 360"
      fill="currentColor"
      width={size}
      height={size}
      aria-label="tila logo"
      role="img"
    >
      <title>tila logo</title>
      <path d="M701.628 860.994c22.092 12.302 45.529 26.971 67.251 40.057l102.365 61.261-169.513 101.118c-5.174-3.48-11.495-7.04-16.931-10.19-51.113-29.59-101.25-61.552-152.585-90.705z" />
      <path d="M564.739 1064.82c8.501 3.1 36.108 20.2 44.739 25.37a4954 4954 0 0 0 92.542 55.13c45.148-25.79 90.945-54.1 135.923-80.64q16.508 9.795 33.132 19.41a2422 2422 0 0 0-31.614 18.97 11044 11044 0 0 1-137.666 82.46c-55.938-33.31-113.522-68.96-169.664-101.32 10.417-5.66 22.305-13.18 32.608-19.38" />
      <path d="M565.263 1003.95c3.541 1.13 11.511 6.52 15.284 8.67 40.739 23.25 80.465 49.57 121.697 71.84 14.102-7.39 33.592-19.71 47.523-28.03l87.793-52.52q16.898 9.765 33.674 19.74c-9.91 6.4-22.41 13.34-32.734 19.41a11108 11108 0 0 1-136.6 81.56c-56.464-31.44-113.388-68.71-170.026-101 11.054-6.06 22.506-13.16 33.389-19.67" />
    </svg>
  );
}

function ProjectSwitcher() {
  const { projectId, clearProject, selectProject } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const { data: projects, isError } = useQuery({
    queryKey: ["workspace-projects"],
    queryFn: async () => (await workspaceProjects()).projects,
    enabled: open,
    staleTime: 60_000,
  });

  async function handleSwitch(targetProjectId: string) {
    setSwitching(targetProjectId);
    try {
      await workspaceDeselect();
      await workspaceSelect(targetProjectId);
      queryClient.clear();
      selectProject(targetProjectId);
      setOpen(false);
      navigate(`/p/${targetProjectId}/tasks`);
    } catch {
      setSwitching(null);
    }
  }

  async function handleBackToProjects() {
    setOpen(false);
    try {
      await clearProject();
    } catch {
      /* best-effort — navigate regardless */
    }
    navigate("/");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-foreground transition-colors hover:bg-signal-blue/10 cursor-pointer"
          aria-label={`Switch project (current: ${projectId})`}
        >
          <span className="font-mono text-xs">{projectId}</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 border-border bg-card p-0">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Projects
          </span>
        </div>
        <div className="max-h-48 overflow-y-auto">
          {!projects && !isError && (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              Loading...
            </div>
          )}
          {isError && (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              Could not load projects
            </div>
          )}
          {projects?.map((project) => {
            const isCurrent = project.projectId === projectId;
            return (
              <button
                key={project.projectId}
                type="button"
                disabled={isCurrent || switching !== null}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-background disabled:opacity-50 cursor-pointer disabled:cursor-default"
                onClick={() => {
                  if (!isCurrent) handleSwitch(project.projectId);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground truncate">
                    {project.displayName || project.projectId}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">
                    {project.repos
                      .map((r) => `${r.owner}/${r.repo}`)
                      .join(", ")}
                  </div>
                </div>
                {isCurrent && (
                  <div className="shrink-0 size-1.5 rounded-full bg-status-green" />
                )}
                {switching === project.projectId && (
                  <span className="shrink-0 text-[11px] text-signal-blue">
                    ...
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={handleBackToProjects}
          >
            All projects
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Layout() {
  const { projectId, logout } = useAuth();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const prefix = projectId ? `/p/${projectId}` : "";

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  async function handleLogout() {
    if (!window.confirm("Sign out of this session?")) return;
    try {
      await logout();
    } catch {
      /* best-effort — clear local state regardless */
    }
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-card focus:text-foreground focus:border focus:border-border focus:rounded-md focus:m-2"
      >
        Skip to content
      </a>
      <header className="flex h-[52px] items-center justify-between border-b border-border bg-card px-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3 md:gap-8">
          <span className="shrink-0 flex items-center gap-1.5 text-signal-blue">
            <TilaMark size={18} />
            <span className="font-logo text-[18px] font-bold tracking-[-0.03em]">
              tila
            </span>
          </span>
          <ProjectSwitcher />
          <nav className="flex items-center gap-1 overflow-x-auto">
            {["Tasks", "Records", "Journal", "Presence", "Artifacts"].map(
              (label) => (
                <NavLink
                  key={label}
                  to={`${prefix}/${label.toLowerCase()}`}
                  className={({ isActive }) =>
                    `shrink-0 text-[13px] rounded-sm px-2.5 py-1.5 transition-[background-color,color] duration-150 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue ${isActive ? "text-signal-blue bg-tint-blue-15" : "text-muted-foreground hover:text-foreground hover:bg-[var(--color-row-hover-2)]"}`
                  }
                >
                  {label}
                </NavLink>
              ),
            )}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden md:flex items-center gap-1 rounded-sm px-2 py-1 text-[13px] text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground hover:bg-[var(--color-row-hover-2)] cursor-pointer"
          >
            <kbd className="font-mono text-[11px] leading-none px-[5px] pt-[3px] pb-[2px] rounded-[4px] bg-background border border-border border-b-2 text-muted-foreground">
              ⌘K
            </kbd>
          </button>
          <a
            href="https://github.com/davebream/tila#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden md:flex items-center rounded-sm px-1.5 py-1 text-[13px] text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground hover:bg-[var(--color-row-hover-2)]"
            title="Documentation"
            aria-label="Documentation"
          >
            ?
          </a>
          <DisplaySettings />
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            Sign out
          </Button>
        </div>
      </header>
      <main id="main-content" className="flex-1">
        <WelcomeBanner />
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
