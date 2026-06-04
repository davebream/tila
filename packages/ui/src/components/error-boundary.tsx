import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6"
        >
          <p className="text-lg text-foreground">Something went wrong.</p>
          <p className="max-w-md text-center font-mono text-sm text-muted-foreground">
            {this.state.error?.message}
          </p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="rounded-md bg-signal-blue px-4 py-2 text-sm text-primary-foreground hover:bg-signal-blue-hover"
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
