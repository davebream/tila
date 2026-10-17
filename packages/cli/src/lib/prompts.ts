/** Clack rendering stays on stderr; prompts are forbidden in unattended modes. */
import * as prompts from "@clack/prompts";
import { currentOutput, diagnostic, requirePrompt } from "./output";

export * from "@clack/prompts";

function canRender(): boolean {
  return (
    !currentOutput()?.json &&
    Boolean(process.stderr.isTTY) &&
    !process.env.CI &&
    process.env.NO_COLOR === undefined
  );
}

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
export const intro: typeof prompts.intro = (message, options) => {
  if (canRender())
    prompts.intro(message, { ...options, output: process.stderr });
  else diagnostic(message ?? "");
};
export const outro: typeof prompts.outro = (message, options) => {
  if (canRender())
    prompts.outro(message, { ...options, output: process.stderr });
  else diagnostic(message ?? "");
};
export const cancel: typeof prompts.cancel = (message, options) => {
  if (canRender())
    prompts.cancel(message, { ...options, output: process.stderr });
  else diagnostic(message ?? "Cancelled");
};

function logMessage(
  method: keyof typeof prompts.log,
): typeof prompts.log.message {
  return (message, options) => {
    const text = Array.isArray(message) ? message.join("\n") : (message ?? "");
    if (canRender())
      prompts.log[method](text, { ...options, output: process.stderr });
    else diagnostic(text);
  };
}

export const log: typeof prompts.log = {
  message: logMessage("message"),
  info: logMessage("info"),
  success: logMessage("success"),
  step: logMessage("step"),
  warn: logMessage("warn"),
  warning: logMessage("warning"),
  error: logMessage("error"),
};
export const spinner: typeof prompts.spinner = (options) => {
  if (!canRender())
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

export const note: typeof prompts.note = (message, title, options) => {
  if (canRender())
    prompts.note(message, title, { ...options, output: process.stderr });
  else diagnostic([title, message].filter(Boolean).join("\n"));
};
