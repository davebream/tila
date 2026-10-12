import type {
  QueueClaimCommand,
  QueueClaimResult,
  QueueConfigureCommand,
  QueueEditCommand,
  QueueEnrollCommand,
  QueueEntry,
  QueueInspection,
  QueueListQuery,
  QueuePolicy,
  QueueRevisionCommand,
} from "@tila/schemas";

export interface QueueBackend {
  policy(): Promise<QueuePolicy>;
  configure(command: QueueConfigureCommand): Promise<QueuePolicy>;
  inspect(query?: QueueListQuery): Promise<QueueInspection>;
  enroll(command: QueueEnrollCommand): Promise<QueueEntry>;
  edit(id: string, command: QueueEditCommand): Promise<QueueEntry>;
  withdraw(id: string, command: QueueRevisionCommand): Promise<QueueEntry>;
  claimNext(command: QueueClaimCommand): Promise<QueueClaimResult>;
}
