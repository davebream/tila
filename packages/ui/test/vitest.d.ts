import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // biome-ignore lint/suspicious/noExplicitAny: required by vitest module augmentation
  interface Assertion<T = any>
    extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<unknown, unknown> {}
}
