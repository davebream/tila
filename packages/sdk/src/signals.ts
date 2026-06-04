import type {
  AckSignalResponse,
  InboxResponse,
  SendSignalRequest,
  SendSignalResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export function createSignalMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/signals`;

  return {
    /** Fetch the signal inbox for the current token. GET /projects/:id/signals */
    async inbox(): Promise<InboxResponse> {
      return client.get<InboxResponse>(base);
    },

    /** Send a signal to a target. POST /projects/:id/signals/send */
    async send(req: SendSignalRequest): Promise<SendSignalResponse> {
      return client.post<SendSignalResponse>(`${base}/send`, req);
    },

    /** Acknowledge a signal. POST /projects/:id/signals/:signalId/ack */
    async ack(signalId: string): Promise<AckSignalResponse> {
      return client.post<AckSignalResponse>(`${base}/${signalId}/ack`, {});
    },
  };
}
