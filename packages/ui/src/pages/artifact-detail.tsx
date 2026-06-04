import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { TableError } from "@/components/ui/table-error";
import { useAuth } from "@/hooks/use-auth";
import { getArtifactBlob } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import { ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

const MAX_TEXT_PREVIEW = 50 * 1024;

const TEXT_TYPES = [
  "text/",
  "application/json",
  "application/toml",
  "application/yaml",
  "application/xml",
];

function parseArtifactKey(key: string): { entity: string; hash: string } {
  const parts = key.split("/");
  if (parts.length >= 3) {
    return { entity: parts[1], hash: parts.slice(2).join("/") };
  }
  return { entity: "", hash: key };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ContentState =
  | { type: "loading" }
  | { type: "error"; cause: unknown }
  | { type: "markdown"; html: string }
  | { type: "text"; text: string; truncated: boolean; fullSize: number }
  | { type: "binary"; contentType: string; key: string };

export function ArtifactDetailPage() {
  const { projectId } = useAuth();
  const params = useParams();
  const navigate = useNavigate();
  const key = params["*"] ?? "";
  const parsed = parseArtifactKey(key);

  const [content, setContent] = useState<ContentState>({ type: "loading" });
  const [viewRawError, setViewRawError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadContent = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (!key || !projectId) return;
      setContent({ type: "loading" });
      try {
        const response = await getArtifactBlob(projectId, key);
        if (signal?.cancelled) return;
        const contentType =
          response.headers.get("Content-Type") ?? "application/octet-stream";
        const isMarkdown =
          contentType.includes("markdown") || key.endsWith(".md");
        const isText = TEXT_TYPES.some((t) => contentType.startsWith(t));
        if (isMarkdown) {
          const text = await response.text();
          if (signal?.cancelled) return;
          const html = renderMarkdown(text);
          setContent({ type: "markdown", html });
        } else if (isText) {
          const text = await response.text();
          if (signal?.cancelled) return;
          if (text.length > MAX_TEXT_PREVIEW) {
            setContent({
              type: "text",
              text: text.slice(0, MAX_TEXT_PREVIEW),
              truncated: true,
              fullSize: text.length,
            });
          } else {
            setContent({
              type: "text",
              text,
              truncated: false,
              fullSize: text.length,
            });
          }
        } else {
          setContent({ type: "binary", contentType, key });
        }
      } catch (err) {
        if (signal?.cancelled) return;
        setContent({ type: "error", cause: err });
      }
    },
    [key, projectId],
  );

  useEffect(() => {
    setViewRawError(false);
    const signal = { cancelled: false };
    loadContent(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadContent]);

  const handleViewRaw = useCallback(async () => {
    if (!projectId) return;
    setViewRawError(false);
    try {
      const res = await getArtifactBlob(projectId, key);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      setViewRawError(true);
    }
  }, [key, projectId]);

  if (!key) {
    return <Navigate to={`/p/${projectId}/artifacts`} replace />;
  }

  return (
    <Drawer
      onClose={() => navigate(`/p/${projectId}/artifacts`)}
      title={
        parsed.entity ? (
          <span className="flex items-center gap-1.5">
            <Link
              to={`/p/${projectId}/tasks/${parsed.entity}`}
              className="text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue"
            >
              {parsed.entity}
            </Link>
          </span>
        ) : (
          key
        )
      }
      expanded={expanded}
      headerActions={
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      }
    >
      <div className="space-y-4 p-6">
        {parsed.entity && (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {key}
          </p>
        )}

        {content.type === "loading" && (
          <p className="text-muted-foreground">Loading...</p>
        )}

        {content.type === "error" && (
          <TableError error={content.cause} onRetry={() => loadContent()} />
        )}

        {content.type === "markdown" && (
          <div
            className="tila-prose"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Rendered markdown from trusted artifact blob, sanitized by DOMPurify
            dangerouslySetInnerHTML={{ __html: content.html }}
          />
        )}

        {content.type === "text" && (
          <>
            <pre className="overflow-x-auto rounded-md bg-background p-3 text-xs text-foreground whitespace-pre-wrap break-all">
              {content.text}
            </pre>
            {content.truncated && (
              <p className="text-sm text-muted-foreground">
                Content truncated at{" "}
                <span className="tila-num">
                  {formatBytes(MAX_TEXT_PREVIEW)}
                </span>
                . Full size:{" "}
                <span className="tila-num">
                  {formatBytes(content.fullSize)}
                </span>
                .
              </p>
            )}
          </>
        )}

        {content.type === "binary" && (
          <>
            <div className="border-t border-border">
              <Table aria-label="Artifact metadata">
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium text-muted-foreground">
                      Key
                    </TableCell>
                    <TableCell className="text-foreground">
                      {content.key}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium text-muted-foreground">
                      Content-Type
                    </TableCell>
                    <TableCell className="text-foreground">
                      {content.contentType}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleViewRaw}>
                <ExternalLink size={14} className="mr-1.5" />
                Open in new tab
              </Button>
              {viewRawError && (
                <span className="text-xs text-status-red" role="alert">
                  Failed to load. Try again or check the server.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}
