import type {
  Delivery,
  DeliveryMessageRef,
  DeliveryTrace,
  DeliveryTraceItem,
} from "@tila/schemas";

export function traceItem(
  seq: number,
  over: {
    delivery?: Partial<Delivery>;
    message?: Partial<DeliveryMessageRef>;
    trace?: Partial<DeliveryTrace>;
  } = {},
): DeliveryTraceItem {
  const messageId = over.message?.id ?? crypto.randomUUID();
  return {
    delivery: {
      ordinal: seq,
      id: crypto.randomUUID(),
      message_id: messageId,
      agent_id: "worker",
      target_binding_id: null,
      target_epoch: null,
      state: "pending",
      fetched_at: null,
      fetched_binding_id: null,
      fetched_epoch: null,
      acked_at: null,
      acked_binding_id: null,
      acked_epoch: null,
      disposition: null,
      wake_suppressed: null,
      rewakes: 0,
      created_at: 1_000,
      expires_at: Date.now() + 100_000,
      ...over.delivery,
    },
    message: {
      id: messageId,
      room_id: "general",
      thread_id: null,
      seq,
      ...over.message,
    },
    trace: {
      state: "pending",
      stored: { at: 1_000 },
      wake: {
        status: "not-requested",
        suppressed: null,
        attempts: 0,
        rewakes: 0,
        last_at: null,
      },
      fetched: null,
      acknowledged: null,
      work_result: { status: "not-reported" },
      recipient: { status: "active", binding_epoch: 1 },
      ...over.trace,
    },
  };
}

/** An acknowledged delivery: accepted for processing, work still not reported. */
export const acknowledgedTrace: Partial<DeliveryTrace> = {
  state: "acked",
  wake: {
    status: "accepted",
    suppressed: null,
    attempts: 1,
    rewakes: 0,
    last_at: 1_500,
  },
  fetched: { at: 1_600, epoch: 1 },
  acknowledged: { at: 1_700, epoch: 1, disposition: "accepted" },
};
