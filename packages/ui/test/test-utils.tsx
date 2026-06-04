import { AuthProvider } from "@/hooks/use-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { server } from "./mocks/server";

export * from "@testing-library/react";

interface ExtendedRenderOptions extends RenderOptions {
  route?: string;
  authenticated?: boolean;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: ExtendedRenderOptions,
) {
  const { route = "/", authenticated = true, ...renderOptions } = options ?? {};

  // Create a fresh QueryClient for each test
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  // Override sessionStatus handler if unauthenticated
  if (authenticated === false) {
    server.use(
      http.get("*/auth/session/status", () => {
        return HttpResponse.json({ ok: false }, { status: 401 });
      }),
    );
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
    renderOptions,
  );
}
