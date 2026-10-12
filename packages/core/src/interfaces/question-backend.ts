import type {
  QuestionAnswerCommand,
  QuestionAskCommand,
  QuestionCancelCommand,
  QuestionEscalateCommand,
  QuestionLinkCommand,
  QuestionListQuery,
  QuestionListResult,
  QuestionView,
} from "@tila/schemas";

export interface QuestionBackend {
  ask(command: QuestionAskCommand): Promise<QuestionView>;
  get(id: string): Promise<QuestionView>;
  list(query?: QuestionListQuery): Promise<QuestionListResult>;
  answer(id: string, command: QuestionAnswerCommand): Promise<QuestionView>;
  escalate(id: string, command: QuestionEscalateCommand): Promise<QuestionView>;
  cancel(id: string, command: QuestionCancelCommand): Promise<QuestionView>;
  linkDiscussion(
    id: string,
    command: QuestionLinkCommand,
  ): Promise<QuestionView>;
}
