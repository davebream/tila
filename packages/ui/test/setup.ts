import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { server } from "./mocks/server";

// React Testing Library's findBy*/waitFor default to a 1000ms timeout, which is
// independent of vitest's testTimeout. The routing tests render the full auth
// gate, which resolves two sequential async hops (session status → navigate →
// tasks fetch) before the heading appears; under loaded CI runners that chain
// can exceed 1000ms and flake. Give async queries generous headroom (still well
// under the 20s vitest testTimeout).
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement matchMedia; layout.tsx uses it for dark-mode detection.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
