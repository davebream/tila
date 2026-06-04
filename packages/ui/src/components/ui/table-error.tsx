import { ApiError } from "@/lib/api";

function errorInfo(error: unknown): {
  message: string;
  hint: string;
  code: string | null;
} {
  if (error instanceof ApiError) {
    if (error.code === "not-configured" || error.code === "http-401") {
      return {
        message: error.message,
        hint: "Try signing out and back in.",
        code: error.code,
      };
    }
    if (error.code === "http-404") {
      return {
        message: error.message,
        hint: "This resource may have been deleted.",
        code: error.code,
      };
    }
    if (error.code === "rate-limited") {
      return {
        message: error.message,
        hint: "Wait a moment, then retry.",
        code: error.code,
      };
    }
    return { message: error.message, hint: "", code: error.code };
  }
  if (error instanceof TypeError) {
    return {
      message: "Cannot reach server",
      hint: "Check that the server is running and your network is connected.",
      code: "network-error",
    };
  }
  const msg = error instanceof Error ? error.message : "Failed to load data";
  return { message: msg, hint: "", code: null };
}

export function TableError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { message, hint, code } = errorInfo(error);
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 py-12 text-center"
    >
      <div className="space-y-1">
        <p className="text-sm text-status-red">{message}</p>
        {code && (
          <p className="font-mono text-[11px] text-muted-foreground">{code}</p>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer rounded-md bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          Retry
        </button>
      )}
    </div>
  );
}
