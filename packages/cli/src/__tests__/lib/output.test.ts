import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock console-table-printer
const mockAddRow = vi.fn();
const mockPrintTable = vi.fn();
vi.mock("console-table-printer", () => {
  return {
    Table: vi.fn().mockImplementation(
      class {
        addRow = mockAddRow;
        printTable = mockPrintTable;
      } as unknown as () => unknown,
    ),
  };
});

// Mock yocto-spinner
const mockStart = vi.fn().mockReturnThis();
const mockStop = vi.fn().mockReturnThis();
const mockError = vi.fn().mockReturnThis();
vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    error: mockError,
  })),
}));

describe("output utilities", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe("renderTable", () => {
    it("calls Table with columns and addRow for each row", async () => {
      const { renderTable } = await import("../../lib/output");
      const { Table } = await import("console-table-printer");
      renderTable(
        [{ id: "T-1", status: "open" }],
        [
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
        ],
      );
      expect(Table).toHaveBeenCalled();
      expect(mockAddRow).toHaveBeenCalledWith({ id: "T-1", status: "open" });
      expect(mockPrintTable).toHaveBeenCalled();
    });

    it("does not call printTable when rows is empty", async () => {
      const { renderTable } = await import("../../lib/output");
      mockPrintTable.mockClear();
      renderTable([], [{ key: "id", label: "ID" }]);
      expect(mockPrintTable).not.toHaveBeenCalled();
    });
  });

  describe("withSpinner", () => {
    it("calls start before fn and stop after fn resolves", async () => {
      const { withSpinner } = await import("../../lib/output");
      const result = await withSpinner("Loading...", async () => "done");
      expect(mockStart).toHaveBeenCalled();
      expect(mockStop).toHaveBeenCalled();
      expect(result).toBe("done");
    });

    it("calls stop in finally even when fn throws", async () => {
      const { withSpinner } = await import("../../lib/output");
      mockStop.mockClear();
      await expect(
        withSpinner("Loading...", async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
      expect(mockStop).toHaveBeenCalled();
    });
  });

  describe("formatTimestamp", () => {
    it("returns YYYY-MM-DD HH:mm format", async () => {
      const { formatTimestamp } = await import("../../lib/output");
      // 2026-05-18T14:32:00.000Z in UTC
      const epochMs = new Date("2026-05-18T14:32:00.000Z").getTime();
      const result = formatTimestamp(epochMs);
      // Result is in local time, but format should match YYYY-MM-DD HH:mm
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });

  describe("formatStatus", () => {
    it("returns a string for known statuses", async () => {
      const { formatStatus } = await import("../../lib/output");
      expect(typeof formatStatus("open")).toBe("string");
      expect(typeof formatStatus("closed")).toBe("string");
      expect(typeof formatStatus("blocked")).toBe("string");
      expect(typeof formatStatus("in-progress")).toBe("string");
    });

    it("returns the input for unknown statuses", async () => {
      const { formatStatus } = await import("../../lib/output");
      const result = formatStatus("custom-status");
      expect(result).toContain("custom-status");
    });

    it("handles null/undefined", async () => {
      const { formatStatus } = await import("../../lib/output");
      expect(formatStatus(null)).toContain("unknown");
      expect(formatStatus(undefined)).toContain("unknown");
    });
  });
});
