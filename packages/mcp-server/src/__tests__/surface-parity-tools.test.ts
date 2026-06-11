import { describe, expect, it } from "vitest";
import {
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
} from "./helpers/mock-facade";

const createMockClient = createMockFacade;
const asClient = asFacade;

import { registerArtifactTools } from "../tools/artifacts";
import { registerClaimTools } from "../tools/claims";
// Import all registration functions
import { registerEntityTools } from "../tools/entities";
import { registerGateTools } from "../tools/gates";
import { registerAllTools } from "../tools/index";
import { registerJournalTools } from "../tools/journal";
import { registerPresenceTools } from "../tools/presence";
import { registerSchemaTools } from "../tools/schema";
import { registerSignalTools } from "../tools/signals";
import { registerTemplateTools } from "../tools/templates";

const PROJECT_ID = "test-project";

describe("registerEntityTools", () => {
  it("registers 8 tools (tila_task_* only)", () => {
    const server = createMockServer();
    registerEntityTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(8);
  });

  it("registers archive and relationship tools for task resource type", () => {
    const server = createMockServer();
    registerEntityTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_task_archive");
    expect(toolNames).toContain("tila_task_relationships_add");
    expect(toolNames).toContain("tila_task_relationships_list");
  });
});

describe("registerArtifactTools", () => {
  it("registers 9 tools (5 existing + 2 text + 1 latest + 1 grep)", () => {
    const server = createMockServer();
    registerArtifactTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(9);
  });

  it("registers artifact relationship tools, latest helper, and grep", () => {
    const server = createMockServer();
    registerArtifactTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_artifact_relationships_add");
    expect(toolNames).toContain("tila_artifact_relationships_list");
    expect(toolNames).toContain("tila_artifact_get_latest");
    expect(toolNames).toContain("tila_artifact_grep");
  });
});

describe("registerClaimTools", () => {
  it("registers exactly 3 canonical tools by default", () => {
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    const server = createMockServer();
    registerClaimTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(3);
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_claim_acquire");
    expect(toolNames).toContain("tila_claim_release");
    expect(toolNames).toContain("tila_claim_list");
  });

  it("does NOT register old names by default", () => {
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    const server = createMockServer();
    registerClaimTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).not.toContain("tila_task_claim");
    expect(toolNames).not.toContain("tila_task_release");
  });

  it("registers 5 tools (3 canonical + 2 compat aliases) when TILA_MCP_COMPAT_ALIASES=1", () => {
    process.env.TILA_MCP_COMPAT_ALIASES = "1";
    try {
      const server = createMockServer();
      registerClaimTools(
        asServer(server),
        asClient(createMockClient()),
        PROJECT_ID,
      );
      expect(server.tool).toHaveBeenCalledTimes(5);
      const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
      expect(toolNames).toContain("tila_claim_acquire");
      expect(toolNames).toContain("tila_claim_release");
      expect(toolNames).toContain("tila_claim_list");
      expect(toolNames).toContain("tila_task_claim");
      expect(toolNames).toContain("tila_task_release");
    } finally {
      process.env.TILA_MCP_COMPAT_ALIASES = "";
    }
  });
});

describe("registerGateTools", () => {
  it("registers 3 tools (2 existing + 1 new)", () => {
    const server = createMockServer();
    registerGateTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(3);
  });

  it("registers tila_gate_cancel tool", () => {
    const server = createMockServer();
    registerGateTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_gate_cancel");
  });
});

describe("registerSignalTools", () => {
  it("registers 3 tools", () => {
    const server = createMockServer();
    registerSignalTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(3);
  });

  it("registers send, list, and ack tools", () => {
    const server = createMockServer();
    registerSignalTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_signal_send");
    expect(toolNames).toContain("tila_signal_list");
    expect(toolNames).toContain("tila_signal_ack");
  });
});

describe("registerJournalTools", () => {
  it("registers 1 tool", () => {
    const server = createMockServer();
    registerJournalTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(1);
  });

  it("registers tila_journal_list", () => {
    const server = createMockServer();
    registerJournalTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool.mock.calls[0][0]).toBe("tila_journal_list");
  });
});

describe("registerSchemaTools", () => {
  it("registers 1 tool", () => {
    const server = createMockServer();
    registerSchemaTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(1);
  });

  it("registers tila_schema_update", () => {
    const server = createMockServer();
    registerSchemaTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool.mock.calls[0][0]).toBe("tila_schema_update");
  });
});

describe("registerTemplateTools", () => {
  it("registers 2 tools", () => {
    const server = createMockServer();
    registerTemplateTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(2);
  });

  it("registers list and instantiate tools", () => {
    const server = createMockServer();
    registerTemplateTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    const toolNames = server.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(toolNames).toContain("tila_template_list");
    expect(toolNames).toContain("tila_template_instantiate");
  });
});

describe("registerPresenceTools", () => {
  it("registers 1 tool", () => {
    const server = createMockServer();
    registerPresenceTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(1);
  });

  it("registers tila_presence_heartbeat", () => {
    const server = createMockServer();
    registerPresenceTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool.mock.calls[0][0]).toBe("tila_presence_heartbeat");
  });
});

describe("registerAllTools — group gating", () => {
  it("registers all 40 tools when groups is omitted (no env var)", () => {
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    process.env.TILA_MCP_TOOLS = "";
    const server = createMockServer();
    registerAllTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
    );
    expect(server.tool).toHaveBeenCalledTimes(40);
  });

  it("registers only tasks+claims tools (11) when groups=['tasks','claims']", () => {
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    const server = createMockServer();
    registerAllTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
      ["tasks", "claims"],
    );
    expect(server.tool).toHaveBeenCalledTimes(11);
  });

  it("expands the 'core' alias to 20 coordination tools", () => {
    process.env.TILA_MCP_COMPAT_ALIASES = "";
    const server = createMockServer();
    registerAllTools(
      asServer(server),
      asClient(createMockClient()),
      PROJECT_ID,
      ["core"],
    );
    // core = tasks(8) + claims(3) + gates(3) + signals(3) + summary(1) + presence(1) + journal(1)
    expect(server.tool).toHaveBeenCalledTimes(20);
  });

  it("throws an actionable error with valid group list on unknown group", () => {
    expect(() => {
      registerAllTools(
        asServer(createMockServer()),
        asClient(createMockClient()),
        PROJECT_ID,
        ["bogus"],
      );
    }).toThrow(/Unknown TILA_MCP_TOOLS group/);
  });

  it("names the offending group and lists valid groups in the error", () => {
    let message = "";
    try {
      registerAllTools(
        asServer(createMockServer()),
        asClient(createMockClient()),
        PROJECT_ID,
        ["bogus"],
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("bogus");
    expect(message).toContain("core");
    expect(message).toContain("tasks");
  });
});
