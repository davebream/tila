/** Clack rendering stays on stderr; prompts are forbidden in unattended modes. */
import * as prompts from "@clack/prompts";
import { currentOutput, diagnostic, requirePrompt } from "./output";

export * from "@clack/prompts";
export const text: typeof prompts.text = (options) => {
  requirePrompt(options.message);
  return prompts.text({ ...options, output: process.stderr });
};
export const password: typeof prompts.password = (options) => {
  requirePrompt(options.message);
  return prompts.password({ ...options, output: process.stderr });
};
export const confirm: typeof prompts.confirm = (options) => {
  requirePrompt(`${options.message} Supply the command's confirmation flag.`);
  return prompts.confirm({ ...options, output: process.stderr });
};
export const select: typeof prompts.select = (options) => {
  requirePrompt(options.message);
  return prompts.select({ ...options, output: process.stderr });
};
export const multiselect: typeof prompts.multiselect = (options) => {
  requirePrompt(options.message);
  return prompts.multiselect({ ...options, output: process.stderr });
};
export const intro: typeof prompts.intro = (message) => {
  diagnostic(message ?? "");
};
export const outro: typeof prompts.outro = (message) => {
  diagnostic(message ?? "");
};
export const cancel: typeof prompts.cancel = (message) => {
  diagnostic(message ?? "Cancelled");
};
export const log: typeof prompts.log = {
  message: diagnostic,
  info: diagnostic,
  success: diagnostic,
  step: diagnostic,
  warn: diagnostic,
  warning: diagnostic,
  error: diagnostic,
};
export const spinner: typeof prompts.spinner = (options) => {
  if (currentOutput()?.json || !process.stderr.isTTY || process.env.CI)
    return {
      start: (message) => {
        if (message) diagnostic(message);
      },
      stop: (message) => {
        if (message) diagnostic(message);
      },
      message: (message) => {
        if (message) diagnostic(message);
      },
      cancel: (message) => {
        if (message) diagnostic(message);
      },
      error: (message) => {
        if (message) diagnostic(message);
      },
      isCancelled: false,
    } as ReturnType<typeof prompts.spinner>;
  return prompts.spinner({ ...options, output: process.stderr });
};

export const note: typeof prompts.note = (message, title) =>
  diagnostic([title, message].filter(Boolean).join("\n"));
