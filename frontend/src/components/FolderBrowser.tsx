import { useState, useEffect, useRef, useMemo } from "react";
import { X, Home, Folder, GitBranch, GitFork, Eye, EyeOff, ChevronRight, ChevronDown, ArrowUp, RefreshCw } from "lucide-react";
import { browseDirectory, getFolderSuggestions, clearFolderCache, type BrowseResult, type FolderItem, type FolderSuggestion } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { readStorageItem, writeStorageItem } from "../utils/localStorage";
import { errorMessage } from "../utils/errorMessage";
import { parentDir } from "../utils/paths";
import ModalOverlay from "./ModalOverlay";
import ConfirmRemoveRecentDirectory from "./ConfirmRemoveRecentDirectory";
import RecentDirectoryRow, { FocusTag } from "./RecentDirectoryRow";

/** Its own key rather than a field in the settings blob — kept as-is so existing preferences survive. */
const SHOW_HIDDEN_KEY = "folderBrowser.showHidden";
/**
 * Hiding worktrees filters the listing client-side, so (unlike `showHidden`) it
 * never takes part in fetching: not in the browse effect, its refs, or refresh.
 */
const HIDE_WORKTREES_KEY = "folderBrowser.hideWorktrees";

interface FolderBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  /**
   * A folder inside `initialPath` to mark as the one picked last time — it is
   * highlighted in the listing (and scrolled to) and tagged in "Previously
   * used". Like `initialPath`, it is read when the browser opens.
   */
  focusPath?: string;
  /**
   * What `focusPath` is, for its tag: the folder picked last time
   * (`"last-used"`, the default) or the one already in the caller's field
   * (`"current"`).
   */
  focusKind?: FocusKind;
  /**
   * Folders this picker has been used for before, most recent first — shown as
   * a "Previously used" section. Omitted (or empty), the section is not shown.
   */
  recentDirectories?: string[];
  /**
   * Removes a folder from `recentDirectories`, after the user confirms. Omitted,
   * the section has no remove buttons.
   */
  onRemoveRecentDirectory?: (path: string) => void;
}

export type FocusKind = "last-used" | "current";
const FOCUS_LABEL: Record<FocusKind, string> = { "last-used": "last used", current: "current" };

export default function FolderBrowser({
  isOpen,
  onClose,
  onSelect,
  initialPath = "/",
  focusPath,
  focusKind = "last-used",
  recentDirectories,
  onRemoveRecentDirectory,
}: FolderBrowserProps) {
  const isMobile = useIsMobile();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(() => {
    return readStorageItem(SHOW_HIDDEN_KEY) === "true";
  });
  const [hideWorktrees, setHideWorktrees] = useState(() => {
    return readStorageItem(HIDE_WORKTREES_KEY) === "true";
  });
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** The recent folder awaiting a "remove?" confirmation, if any. */
  const [confirmRemovePath, setConfirmRemovePath] = useState<string | null>(null);
  /** Mobile only: whether the "Previously used" block is expanded. */
  const [recentOpen, setRecentOpen] = useState(true);
  /**
   * The path the browser was opened at, until it has been browsed once. That
   * first browse may land on a folder that has since gone away (a recent
   * folder deleted, a typed path that never existed); it walks up to the
   * nearest ancestor that exists rather than showing an empty, unselectable
   * listing. Navigation after that is the user's and is shown as-is.
   */
  const openedAtRef = useRef<string | null>(null);
  /**
   * The start props as of the latest render, read only when the browser opens.
   * They are derived from the recent list (FolderSelector), which changes while
   * the browser is open — a removal, a space refresh — and that must not yank
   * the user back to wherever the new list would have started.
   */
  const startPropsRef = useRef({ initialPath, focusPath, focusKind });
  /** `focusPath` and its tag as they were when the browser opened. */
  const [openedFocus, setOpenedFocus] = useState<{ path: string; label: string } | null>(null);
  /**
   * The listing the user is asking for right now. A refresh started before
   * they navigated (or toggled hidden files) must not land on top of the
   * listing they moved to.
   */
  const wantedRef = useRef({ currentPath, showHidden });
  /** Scroll the `openedFocus` row into view once the first listing is shown. */
  const scrollToFocusRef = useRef(false);
  /**
   * What the displayed `browseResult` is a listing of. A browse that resolves
   * to a different path (walk-up, symlinks) sets `currentPath` to the resolved
   * one; without this, that would fetch the same listing again.
   */
  const shownRef = useRef<{ path: string; showHidden: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showRecent = !!recentDirectories && recentDirectories.length > 0;
  // The server's own "recent" suggestions are a different, older list; with
  // the section shown they would only duplicate or contradict it.
  const quickAccess = showRecent ? suggestions.filter((s) => s.type !== "recent") : suggestions;

  // Load folder suggestions on mount
  useEffect(() => {
    const loadSuggestions = async () => {
      try {
        const result = await getFolderSuggestions();
        setSuggestions(result.suggestions);
      } catch (err) {
        console.error("Failed to load suggestions:", err);
      }
    };

    if (isOpen) {
      loadSuggestions();
    }
  }, [isOpen]);

  useEffect(() => {
    startPropsRef.current = { initialPath, focusPath, focusKind };
    wantedRef.current = { currentPath, showHidden };
  });

  // Reset state when modal opens — on the closed→open transition only. Declared
  // before the browse effect so that, in the commit that opens the modal, the
  // start path is recorded before the first browse reads it.
  useEffect(() => {
    if (isOpen) {
      const start = startPropsRef.current.initialPath || "/";
      openedAtRef.current = start;
      shownRef.current = null;
      scrollToFocusRef.current = true;
      const { focusPath: focus, focusKind: kind } = startPropsRef.current;
      setOpenedFocus(focus ? { path: focus, label: FOCUS_LABEL[kind] } : null);
      setCurrentPath(start);
      setError(null);
      setConfirmRemovePath(null);
    }
  }, [isOpen]);

  // Browse directory when path changes
  useEffect(() => {
    let cancelled = false;
    const browse = async () => {
      if (!isOpen || !currentPath) return;
      // Already showing this exact listing — see shownRef.
      const shown = shownRef.current;
      if (shown && shown.path === currentPath && shown.showHidden === showHidden) {
        // A browse cancelled on the way here (hidden files toggled on and back
        // off, a navigation away and back) never cleared its loading state.
        setIsLoading(false);
        setError(null);
        return;
      }

      // Only the browse of the path the modal opened at may walk up. The mark
      // is cleared once such a browse completes, not when it starts, so one
      // cancelled midway (hidden files toggled) still walks up when it re-runs.
      const firstBrowse = openedAtRef.current === currentPath;

      setIsLoading(true);
      setError(null);

      try {
        let result: BrowseResult;
        if (firstBrowse) {
          try {
            result = await browseDirectory(currentPath, showHidden);
            let path = currentPath;
            while (!result.exists && path !== "/") {
              if (cancelled) return;
              path = parentDir(path) ?? "/";
              result = await browseDirectory(path, showHidden);
            }
          } catch {
            if (cancelled) return;
            // Fall back to the root once; an error there is reported as usual.
            result = await browseDirectory("/", showHidden);
          }
        } else {
          result = await browseDirectory(currentPath, showHidden);
        }
        if (cancelled) return;
        if (firstBrowse) openedAtRef.current = null;
        shownRef.current = { path: result.currentPath, showHidden };
        setBrowseResult(result);
        setCurrentPath(result.currentPath); // Update with resolved path
      } catch (err) {
        if (cancelled) return;
        if (firstBrowse) openedAtRef.current = null;
        shownRef.current = null;
        setError(errorMessage(err, "Failed to browse directory"));
        setBrowseResult(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    browse();
    return () => {
      cancelled = true;
    };
  }, [currentPath, showHidden, isOpen]);

  // Bring the folder picked last time into view in the first listing shown.
  useEffect(() => {
    if (!browseResult || !scrollToFocusRef.current) return;
    scrollToFocusRef.current = false;
    const row = listRef.current?.querySelector<HTMLElement>('[data-focus-row="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [browseResult]);

  const handleToggleHidden = () => {
    const newValue = !showHidden;
    setShowHidden(newValue);
    writeStorageItem(SHOW_HIDDEN_KEY, newValue.toString());
  };

  const handleToggleWorktrees = () => {
    const newValue = !hideWorktrees;
    setHideWorktrees(newValue);
    writeStorageItem(HIDE_WORKTREES_KEY, newValue.toString());
  };

  // The rows actually listed. The focus row is kept even when it is a
  // worktree, so its outline and scroll-into-view still have something to land on.
  const visibleDirectories = useMemo(() => {
    const dirs = browseResult?.directories ?? [];
    return hideWorktrees ? dirs.filter((d) => !d.isWorktree || d.path === openedFocus?.path) : dirs;
  }, [browseResult, hideWorktrees, openedFocus]);
  const hiddenWorktreeCount = (browseResult?.directories.length ?? 0) - visibleDirectories.length;

  /** The header's toggle/action buttons; `active` is a toggle that is on. */
  const headerButtonStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--accent)" : "var(--surface)",
    color: active ? "var(--text-on-accent)" : "var(--text)",
    padding: isMobile ? "4px 8px" : "6px 12px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: isMobile ? 4 : 6,
    fontSize: isMobile ? 11 : 13,
  });

  const handleRefresh = async () => {
    if (isRefreshing || isLoading) return;
    setIsRefreshing(true);
    const requested = { currentPath, showHidden };
    const stillWanted = () => wantedRef.current.currentPath === requested.currentPath && wantedRef.current.showHidden === requested.showHidden;
    try {
      await clearFolderCache();
      const result = await browseDirectory(requested.currentPath, requested.showHidden);
      if (!stillWanted()) return;
      shownRef.current = { path: result.currentPath, showHidden: requested.showHidden };
      setBrowseResult(result);
      setCurrentPath(result.currentPath);
    } catch (err) {
      if (!stillWanted()) return;
      setError(errorMessage(err, "Failed to refresh directory"));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  const handleItemClick = (item: FolderItem) => {
    if (item.type === "directory") {
      handleNavigate(item.path);
    }
  };

  const handleItemDoubleClick = (item: FolderItem) => {
    if (item.type === "directory") {
      onSelect(item.path);
    }
  };

  const getPathSegments = (path: string) => {
    const segments = path.split("/").filter(Boolean);
    return [
      { name: "Root", path: "/" },
      ...segments.map((segment, index) => ({
        name: segment,
        path: "/" + segments.slice(0, index + 1).join("/"),
      })),
    ];
  };

  const renderRecentRow = (dir: string, compact: boolean) => (
    <RecentDirectoryRow
      key={dir}
      path={dir}
      compact={compact}
      isCurrent={currentPath === dir}
      tag={openedFocus?.path === dir ? openedFocus.label : undefined}
      onNavigate={handleNavigate}
      onSelect={onSelect}
      onRemove={onRemoveRecentDirectory && setConfirmRemovePath}
    />
  );

  if (!isOpen) return null;

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: isMobile ? 0 : 12,
          width: isMobile ? "100%" : "90%",
          height: isMobile ? "100%" : "90%",
          maxWidth: isMobile ? "none" : 1000,
          maxHeight: isMobile ? "none" : 700,
          border: isMobile ? "none" : "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: isMobile ? "12px 16px" : "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-secondary)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12 }}>
            <h2 style={{ fontSize: isMobile ? 16 : 18, fontWeight: 600, margin: 0 }}>Select Folder</h2>
            <button
              onClick={handleToggleHidden}
              aria-label="Show hidden files"
              aria-pressed={showHidden}
              style={headerButtonStyle(showHidden)}
              title={showHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {showHidden ? <EyeOff size={isMobile ? 12 : 14} /> : <Eye size={isMobile ? 12 : 14} />}
              {!isMobile && (showHidden ? "Hide hidden" : "Show hidden")}
            </button>
            <button
              onClick={handleToggleWorktrees}
              aria-label="Hide worktrees"
              aria-pressed={hideWorktrees}
              style={headerButtonStyle(hideWorktrees)}
              title={hideWorktrees ? "Show git worktrees" : "Hide git worktrees"}
            >
              <GitFork size={isMobile ? 12 : 14} />
              {!isMobile && (hideWorktrees ? "Show worktrees" : "Hide worktrees")}
            </button>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              style={{
                ...headerButtonStyle(false),
                cursor: isRefreshing || isLoading ? "default" : "pointer",
                opacity: isRefreshing || isLoading ? 0.6 : 1,
              }}
              title="Refresh directory listing"
            >
              <RefreshCw size={isMobile ? 12 : 14} style={isRefreshing ? { animation: "spin 1s linear infinite" } : undefined} />
            </button>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              padding: isMobile ? 6 : 8,
              cursor: "pointer",
              color: "var(--text-muted)",
              borderRadius: 6,
            }}
          >
            <X size={isMobile ? 18 : 20} />
          </button>
        </div>

        {/* Breadcrumb */}
        <div
          style={{
            padding: isMobile ? "8px 16px" : "12px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            overflow: "auto",
          }}
        >
          {getPathSegments(currentPath).map((segment, index, segments) => (
            <div key={segment.path} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                onClick={() => handleNavigate(segment.path)}
                style={{
                  background: "none",
                  border: "none",
                  color: index === segments.length - 1 ? "var(--text)" : "var(--accent)",
                  cursor: index === segments.length - 1 ? "default" : "pointer",
                  fontSize: isMobile ? 12 : 14,
                  padding: "4px 8px",
                  borderRadius: 4,
                  textDecoration: "none",
                }}
              >
                {index === 0 ? <Home size={isMobile ? 14 : 16} /> : segment.name}
              </button>
              {index < segments.length - 1 && <ChevronRight size={isMobile ? 12 : 14} style={{ color: "var(--text-muted)" }} />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            overflow: "hidden",
          }}
        >
          {/* Sidebar with suggestions - hidden on mobile */}
          {!isMobile && (
            <div
              style={{
                width: 240,
                borderRight: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                overflow: "auto",
              }}
            >
              {showRecent && (
                <div style={{ padding: "16px 16px 0 16px" }} data-testid="folder-browser-recent">
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 }}>Previously used</div>
                  {recentDirectories.map((dir) => renderRecentRow(dir, false))}
                </div>
              )}
              <div style={{ padding: "16px 16px 12px 16px" }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 }}>Quick Access</div>
                {quickAccess.map((suggestion) => (
                  <button
                    key={suggestion.path}
                    onClick={() => handleNavigate(suggestion.path)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: currentPath === suggestion.path ? "var(--accent)" : "none",
                      color: currentPath === suggestion.path ? "var(--text-on-accent)" : "var(--text)",
                      border: "none",
                      padding: "8px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      marginBottom: 2,
                      fontSize: 13,
                    }}
                    title={suggestion.description}
                  >
                    <div style={{ fontWeight: 500 }}>{suggestion.name}</div>
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.7,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {suggestion.path}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Main content area */}
          <div style={{ flex: 1, overflow: "auto" }}>
            {/* Previously used — mobile has no sidebar, so it heads the list */}
            {isMobile && showRecent && (
              <div style={{ padding: "8px 12px 0 12px" }} data-testid="folder-browser-recent">
                <button
                  type="button"
                  onClick={() => setRecentOpen((open) => !open)}
                  aria-expanded={recentOpen}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    minHeight: 44,
                    background: "none",
                    border: "none",
                    padding: "4px 0",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--text-muted)",
                    textAlign: "left",
                  }}
                >
                  {recentOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Previously used ({recentDirectories.length})
                </button>
                {recentOpen && recentDirectories.map((dir) => renderRecentRow(dir, true))}
                <div style={{ borderBottom: "1px solid var(--border)", marginTop: 4 }} />
              </div>
            )}
            {isLoading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 200,
                  color: "var(--text-muted)",
                }}
              >
                Loading...
              </div>
            ) : error ? (
              <div
                style={{
                  padding: isMobile ? 16 : 20,
                  color: "var(--danger)",
                  textAlign: "center",
                }}
              >
                {error}
              </div>
            ) : browseResult ? (
              <div ref={listRef} style={{ padding: isMobile ? "8px 12px" : "12px 16px" }}>
                {/* Parent directory link */}
                {browseResult.parent && (
                  <div
                    onClick={() => handleNavigate(browseResult.parent!)}
                    onDoubleClick={() => handleNavigate(browseResult.parent!)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: isMobile ? 6 : 8,
                      padding: isMobile ? "6px 10px" : "8px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      marginBottom: isMobile ? 6 : 8,
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <ArrowUp size={isMobile ? 14 : 16} style={{ color: "var(--text-muted)" }} />
                    <span style={{ fontSize: isMobile ? 13 : 14 }}>.. (Parent Directory)</span>
                  </div>
                )}

                {/* Directories */}
                {visibleDirectories.map((item) => {
                  // The folder opened above, shown among its siblings. Marked
                  // with an outline, not a fill: a fill would read as
                  // "selected", but Select Folder picks the folder shown.
                  const isFocus = item.path === openedFocus?.path;
                  return (
                    <div
                      key={item.path}
                      onClick={() => handleItemClick(item)}
                      onDoubleClick={() => handleItemDoubleClick(item)}
                      data-focus-row={isFocus ? "true" : undefined}
                      style={{
                        border: `1px solid ${isFocus ? "var(--accent)" : "transparent"}`,
                        display: "flex",
                        alignItems: "center",
                        gap: isMobile ? 8 : 12,
                        padding: isMobile ? "8px 10px" : "8px 12px",
                        borderRadius: 6,
                        cursor: "pointer",
                        marginBottom: 2,
                        opacity: item.isHidden ? 0.6 : 1,
                        minHeight: isMobile ? 44 : 40, // Better touch target on mobile
                      }}
                      onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface)")}
                      onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 8, flex: 1, minWidth: 0 }}>
                        {item.isWorktree ? (
                          <span title="Git worktree" style={{ display: "flex", flexShrink: 0 }}>
                            <GitFork size={isMobile ? 14 : 16} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                          </span>
                        ) : item.isGitRepo ? (
                          <GitBranch size={isMobile ? 14 : 16} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                        ) : (
                          <Folder size={isMobile ? 14 : 16} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                        )}
                        <span
                          style={{
                            fontSize: isMobile ? 13 : 14,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.name}
                        </span>
                        {isFocus && <FocusTag label={openedFocus.label} />}
                      </div>
                    </div>
                  );
                })}

                {browseResult.directories.length === 0 && browseResult.files.length === 0 && (
                  <div
                    style={{
                      textAlign: "center",
                      color: "var(--text-muted)",
                      padding: isMobile ? 30 : 40,
                      fontSize: isMobile ? 13 : 14,
                    }}
                  >
                    This directory is empty
                  </div>
                )}

                {visibleDirectories.length === 0 && hiddenWorktreeCount > 0 && (
                  <div
                    style={{
                      textAlign: "center",
                      color: "var(--text-muted)",
                      padding: isMobile ? 30 : 40,
                      fontSize: isMobile ? 13 : 14,
                    }}
                  >
                    All folders here are worktrees.{" "}
                    <button
                      onClick={handleToggleWorktrees}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        color: "var(--accent-text)",
                        textDecoration: "underline",
                        cursor: "pointer",
                        font: "inherit",
                      }}
                    >
                      Show worktrees
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: isMobile ? "16px 16px 24px 16px" : "12px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--bg-secondary)",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: isMobile ? 12 : 13, color: "var(--text-muted)" }}>
            {browseResult && (
              <>
                {visibleDirectories.length} folders
                {hiddenWorktreeCount > 0 && ` (${hiddenWorktreeCount} ${hiddenWorktreeCount === 1 ? "worktree" : "worktrees"} hidden)`}
                {browseResult.files.length > 0 && `, ${browseResult.files.length} files`}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: isMobile ? 8 : 12 }}>
            <button
              onClick={onClose}
              style={{
                background: "var(--surface)",
                color: "var(--text)",
                padding: isMobile ? "6px 12px" : "8px 16px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                cursor: "pointer",
                fontSize: isMobile ? 13 : 14,
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => onSelect(currentPath)}
              disabled={!browseResult?.exists}
              style={{
                background: browseResult?.exists ? "var(--accent)" : "var(--border)",
                color: "var(--text-on-accent)",
                padding: isMobile ? "6px 12px" : "8px 16px",
                borderRadius: 6,
                border: "none",
                cursor: browseResult?.exists ? "pointer" : "default",
                fontSize: isMobile ? 13 : 14,
              }}
            >
              Select Folder
            </button>
          </div>
        </div>
      </div>
      {/* Inside this overlay, so it stacks above the browser rather than under it. */}
      <ConfirmRemoveRecentDirectory path={confirmRemovePath} onConfirm={(path) => onRemoveRecentDirectory?.(path)} onClose={() => setConfirmRemovePath(null)} />
    </ModalOverlay>
  );
}
