import type { QuestionBackend } from "@tila/core";
import { type RequestOrigin, questionOps } from "@tila/ops-sqlite";
import type {
  QuestionAnswerCommand,
  QuestionAskCommand,
  QuestionCancelCommand,
  QuestionEscalateCommand,
  QuestionLinkCommand,
  QuestionListQuery,
} from "@tila/schemas";
import type { EmbeddedDb } from "./embedded-project";

/** Like embedded attempts, the database-owning process is trusted as administrator. */
export class EmbeddedQuestionBackend implements QuestionBackend {
  constructor(
    private db: EmbeddedDb,
    private origin: () => RequestOrigin,
    private retry: <T>(run: () => T) => T,
  ) {}
  private authority(): questionOps.QuestionAuthority {
    const origin = this.origin();
    return {
      origin,
      can_manage: true,
      is_owner: true,
      conversation: {
        principal_id: origin.principalId,
        participant_id: origin.participantId,
        can_manage: true,
        runtime: null,
      },
    };
  }
  async ask(input: QuestionAskCommand) {
    return this.retry(() => questionOps.ask(this.db, input, this.authority()));
  }
  async get(id: string) {
    return this.retry(() => questionOps.view(this.db, id, this.authority()));
  }
  async list(query: QuestionListQuery = {}) {
    return this.retry(() => questionOps.list(this.db, query, this.authority()));
  }
  async answer(id: string, input: QuestionAnswerCommand) {
    return this.retry(() =>
      questionOps.answer(this.db, id, input, this.authority()),
    );
  }
  async escalate(id: string, input: QuestionEscalateCommand) {
    return this.retry(() =>
      questionOps.escalate(this.db, id, input, this.authority()),
    );
  }
  async cancel(id: string, input: QuestionCancelCommand) {
    return this.retry(() =>
      questionOps.cancel(this.db, id, input, this.authority()),
    );
  }
  async linkDiscussion(id: string, input: QuestionLinkCommand) {
    return this.retry(() =>
      questionOps.linkDiscussion(this.db, id, input, this.authority()),
    );
  }
}
