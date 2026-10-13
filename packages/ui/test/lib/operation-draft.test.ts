import {
  completeOperation,
  editOperation,
  newOperation,
  releaseOperation,
  stageOperation,
} from "@/lib/operation-draft";

test("staging freezes one command and its id until the server answers", () => {
  const draft = newOperation<string, { text: string; key: string }>("a");
  const staged = stageOperation(draft, (text, id) => ({ text, key: id }));
  const again = stageOperation(editOperation(staged, "b"), (text, id) => ({
    text,
    key: id,
  }));
  expect(again.pending?.command).toEqual(staged.pending?.command);
  expect(again.pending?.command.key).toBe(staged.pending?.id);
  expect(again.value).toBe("b");
});

test("completion clears an untouched draft and keeps newer input", () => {
  const reset = () => newOperation<string, string>("");
  const staged = stageOperation(newOperation<string, string>("a"), (v) => v);
  const id = staged.pending?.id ?? "";
  expect(completeOperation(staged, id, reset).value).toBe("");
  const edited = editOperation(staged, "b");
  const done = completeOperation(edited, id, reset);
  expect(done).toMatchObject({ value: "b", pending: null });
  expect(completeOperation(edited, "other", reset)).toBe(edited);
});

test("release keeps the input and forgets the command", () => {
  const staged = stageOperation(newOperation<string, string>("a"), (v) => v);
  expect(releaseOperation(staged)).toMatchObject({ value: "a", pending: null });
});
