import type {
  SignalArgs,
  SignalContext,
} from "../../packages/cli/src/commands/signal";
export function context(values: SignalArgs): SignalContext {
  return {
    signal: {
      sendSignal: async (input) => ({ id: "signal-1", ...input }),
      listSignals: async () => [],
      historySignals: async () => ({ signals: [], next_cursor: null }),
      ackSignal: async (id) => {
        if (id === "stale")
          throw Object.assign(new Error("Stale fence"), {
            name: "TilaApiError",
            code: "stale-fence",
          });
      },
      listSignalGroups: async () => [],
      getSignalGroup: async (id) => ({
        id,
        name: "Team",
        principal_ids: ["one", "two"],
        project: values.project,
        participant_id: values["participant-id"],
      }),
      setSignalGroup: async (id, input) => ({ id, ...input }),
      deleteSignalGroup: async () => {},
    } as unknown as SignalContext["signal"],
  };
}

export const common = {
  json: { type: "boolean", default: false },
  project: { type: "string" },
  "participant-id": { type: "string" },
} as const;
export const definitions = {
  send: {
    kind: { type: "string", required: true },
    to: { type: "string", required: true },
    resource: { type: "string" },
    payload: { type: "string" },
    ttl: { type: "string" },
    "principal-id": { type: "string" },
    "group-id": { type: "string" },
  },
  inbox: {},
  history: { limit: { type: "string" }, cursor: { type: "string" } },
  ack: { id: { type: "positional", required: true } },
  groupList: {},
  groupGet: { id: { type: "positional", required: true } },
  groupSet: {
    id: { type: "positional", required: true },
    name: { type: "string", required: true },
    principals: { type: "string" },
  },
  groupDelete: { id: { type: "positional", required: true } },
} as const;
