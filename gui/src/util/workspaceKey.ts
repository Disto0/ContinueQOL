import * as URI from "uri-js";

/**
 * Derive a stable, short key from the current workspace paths.
 *
 * Used to scope per-project state (e.g. open session tabs) so that each
 * project keeps its own state, isolated from other projects and from other
 * VS Code instances.
 *
 * `window.workspacePaths` holds file:// URIs (one per workspace folder). We
 * use the first one and decode its path segments into a stable, lowercase
 * string. If no workspace is open, we fall back to "global".
 *
 * Returns "global" when no workspace is available (e.g. before the webview
 * has been initialized, or in a workspace-less context).
 */
export function getWorkspaceKey(): string {
  const paths = window.workspacePaths ?? [];
  if (paths.length === 0) {
    return "global";
  }
  try {
    const path = (URI.parse(paths[0]).path ?? "").replace(/^\//, "");
    const decoded = path
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part))
      .join("/");
    return decoded.length > 0 ? decoded.toLowerCase() : "global";
  } catch {
    return "global";
  }
}
