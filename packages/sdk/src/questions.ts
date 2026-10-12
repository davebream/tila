import type { QuestionBackend } from "@tila/core";
import {
  type QuestionAnswerCommand,
  type QuestionAskCommand,
  type QuestionCancelCommand,
  type QuestionEscalateCommand,
  type QuestionLinkCommand,
  type QuestionListQuery,
  QuestionListResultSchema,
  type QuestionRequest,
  QuestionRequestSchema,
  QuestionViewSchema,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export class RemoteQuestionBackend implements QuestionBackend {
  private base: string;
  constructor(
    private client: TilaClient,
    projectId: string,
  ) {
    this.base = `/projects/${encodeURIComponent(projectId)}/questions`;
  }
  private async mutate(path: string, command: { idempotency_key: string }) {
    const response = await this.client.post<{ result: unknown }>(
      `${this.base}${path}`,
      command,
      { idempotencyKey: command.idempotency_key },
    );
    return QuestionViewSchema.parse(response.result);
  }
  ask(command: QuestionAskCommand) {
    return this.mutate("", command);
  }
  async get(id: string) {
    return QuestionViewSchema.parse(
      (
        await this.client.get<{ result: unknown }>(
          `${this.base}/${encodeURIComponent(id)}`,
        )
      ).result,
    );
  }
  async list(query: QuestionListQuery = {}) {
    const params = Object.fromEntries(
      Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    return QuestionListResultSchema.parse(
      (await this.client.get<{ result: unknown }>(this.base, params)).result,
    );
  }
  answer(id: string, command: QuestionAnswerCommand) {
    return this.mutate(`/${encodeURIComponent(id)}/answer`, command);
  }
  escalate(id: string, command: QuestionEscalateCommand) {
    return this.mutate(`/${encodeURIComponent(id)}/escalate`, command);
  }
  cancel(id: string, command: QuestionCancelCommand) {
    return this.mutate(`/${encodeURIComponent(id)}/cancel`, command);
  }
  linkDiscussion(id: string, command: QuestionLinkCommand) {
    return this.mutate(`/${encodeURIComponent(id)}/link-discussion`, command);
  }
}
export function executeQuestionRequest(
  questions: QuestionBackend,
  raw: QuestionRequest,
) {
  const r = QuestionRequestSchema.parse(raw);
  switch (r.action) {
    case "ask":
      return questions.ask(r.command);
    case "get":
      return questions.get(r.id);
    case "list":
      return questions.list(r.query);
    case "answer":
      return questions.answer(r.id, r.command);
    case "escalate":
      return questions.escalate(r.id, r.command);
    case "cancel":
      return questions.cancel(r.id, r.command);
    case "link-discussion":
      return questions.linkDiscussion(r.id, r.command);
  }
}
export function questionFacade(backend: QuestionBackend): QuestionBackend {
  return {
    ask: (c) => backend.ask(c),
    get: (id) => backend.get(id),
    list: (q) => backend.list(q),
    answer: (id, c) => backend.answer(id, c),
    escalate: (id, c) => backend.escalate(id, c),
    cancel: (id, c) => backend.cancel(id, c),
    linkDiscussion: (id, c) => backend.linkDiscussion(id, c),
  };
}
