import { TilaMark } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useSearchParams } from "react-router";

export function AuthResultPage() {
  const [params] = useSearchParams();
  const status = params.get("auth_status");
  const title = params.get("title") ?? (status === "error" ? "Error" : "Done");
  const message = params.get("message") ?? "";
  const isError = status === "error";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <Card
        className={
          isError ? "w-full max-w-sm border-status-red/25" : "w-full max-w-sm"
        }
      >
        <CardHeader className="items-center">
          <div className="flex items-center gap-2 text-signal-blue">
            <TilaMark size={22} />
            <span className="font-logo text-2xl tracking-tight">tila</span>
          </div>
          <h1 className="mt-2 text-center font-logo text-xl font-medium tracking-tight text-foreground">
            {title}
          </h1>
        </CardHeader>
        <CardContent className="text-center">
          {message && (
            <p className="text-sm text-muted-foreground">{message}</p>
          )}
          {isError && (
            <a
              href="/"
              className="mt-4 inline-block text-sm text-signal-blue hover:text-signal-blue-hover"
            >
              Back to login
            </a>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
