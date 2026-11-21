import { useState, useEffect, useRef } from "react";
import { X, Home, Folder, GitBranch, Eye, EyeOff, ChevronRight, ChevronDown, ArrowUp, RefreshCw, History } from "lucide-react";
import { browseDirectory, getFolderSuggestions, clearFolderCache, type BrowseResult, type FolderItem, type FolderSuggestion } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { readStorageItem, writeStorageItem } from "../utils/localStorage";
import { errorMessage } from "../utils/errorMessage";
import { parentDir } from "../utils/paths";
import ModalOverlay from "./ModalOverlay";
import ConfirmRemoveRecentDirectory from "./ConfirmRemoveRecentDirectory";

/** Its own key rather than a field in the settings blob — kept as-is so existing preferences survive. */
const SHOW_HIDDEN_KEY = "folderBrowser.showHidden";

interface FolderBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
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

/** Last path segment, for a row's title line. */
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "/";

export default function FolderBrowser({ isOpen, onClose, onSelect, initialPath = "/", recentDirectories, onRemoveRecentDirectory }: FolderBrowserProps) {
  const isMobile = useIsMobile();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(() => {
    return readStorageItem(SHOW_HIDDEN_KEY) === "true";
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

  // Reset state when modal opens. Declared before the browse effect so that,
  // in the commit that opens the modal, the start path is recorded before the
  // first browse reads it.
  useEffect(() => {
    if (isOpen) {
      const start = initialPath || "/";
      openedAtRef.current = start;
      setCurrentPath(start);
      setError(null);
      setConfirmRemovePath(null);
    }
  }, [isOpen, initialPath]);

  // Browse directory when path changes
  useEffect(() => {
    let cancelled = false;
    const browse = async () => {
      if (!isOpen || !currentPath) return;

      // Only the browse of the path the modal opened at may walk up.
      const firstBrowse = openedAtRef.current === currentPath;
      if (firstBrowse) openedAtRef.current = null;

      setIsLoading(true);
      setError(null);

      try {
        let result: BrowseResult;
        if (firstBrowse) {
          try {
            result = await browseDirectory(currentPath, showHidden);
            let path = currentPath;
            while (!result.exists && path !== "/") {
              path = parentDir(path) ?? "/";
              result = await browseDirectory(path, showHidden);
            }
          } catch {
            // Fall back to the root once; an error there is reported as usual.
            result = await browseDirectory("/", showHidden);
          }
        } else {
          result = await browseDirectory(currentPath, showHidden);
        }
        if (cancelled) return;
        setBrowseResult(result);
        setCurrentPath(result.currentPath); // Update with resolved path
      } catch (err) {
        if (cancelled) return;
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

  const handleToggleHidden = () => {
    const newValue = !showHidden;
    setShowHidden(newValue);
    writeStorageItem(SHOW_HIDDEN_KEY, newValue.toString());
  };

  const handleRefresh = async () => {
    if (isRefreshing || isLoading) return;
    setIsRefreshing(true);
    try {
      await clearFolderCache();
      const result = await browseDirectory(currentPath, showHidden);
      setBrowseResult(result);
      setCurrentPath(result.currentPath);
    } catch (err) {
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

  const renderRemoveButton = (dir: string, size: number, onAccent: boolean) =>
    onRemoveRecentDirectory && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setConfirmRemovePath(dir);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        aria-label={`Remove ${dir} from recent directories`}
        title={`Remove ${dir} from recent directories`}
        style={{
          background: "none",
          border: "none",
          padding: 4,
          borderRadius: 4,
          cursor: "pointer",
          color: onAccent ? "var(--text-on-accent)" : "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          minWidth: size,
          minHeight: size,
        }}
      >
        <X size={14} />
      </button>
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
              style={{
                background: showHidden ? "var(--accent)" : "var(--surface)",
                color: showHidden ? "var(--text-on-accent)" : "var(--text)",
                padding: isMobile ? "4px 8px" : "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: isMobile ? 4 : 6,
                fontSize: isMobile ? 11 : 13,
              }}
              title={showHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {showHidden ? <EyeOff size={isMobile ? 12 : 14} /> : <Eye size={isMobile ? 12 : 14} />}
              {!isMobile && (showHidden ? "Hide hidden" : "Show hidden")}
            </button>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              style={{
                background: "var(--surface)",
                color: "var(--text)",
                padding: isMobile ? "4px 8px" : "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                cursor: isRefreshing || isLoading ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: isMobile ? 4 : 6,
                fontSize: isMobile ? 11 : 13,
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
                  {recentDirectories.map((dir) => {
                    const isCurrent = currentPath === dir;
                    return (
                      <div
                        key={dir}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          background: isCurrent ? "var(--accent)" : "none",
                          color: isCurrent ? "var(--text-on-accent)" : "var(--text)",
                          borderRadius: 6,
                          marginBottom: 2,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => handleNavigate(dir)}
                          onDoubleClick={() => onSelect(dir)}
                          title={dir}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            textAlign: "left",
                            background: "none",
                            color: "inherit",
                            border: "none",
                            padding: "8px 4px 8px 12px",
                            cursor: "pointer",
                            fontSize: 13,
                          }}
                        >
                          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{baseName(dir)}</div>
                          <div
                            style={{
                              fontSize: 11,
                              opacity: 0.7,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              direction: "rtl",
                              textAlign: "left",
                            }}
                          >
                            {dir}
                          </div>
                        </button>
                        {renderRemoveButton(dir, 24, isCurrent)}
                      </div>
                    );
                  })}
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
                    minHeight: 36,
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
                {recentOpen &&
                  recentDirectories.map((dir) => {
                    const isCurrent = currentPath === dir;
                    return (
                      <div
                        key={dir}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          minHeight: 44,
                          borderRadius: 6,
                          marginBottom: 2,
                          background: isCurrent ? "var(--accent)" : "none",
                          color: isCurrent ? "var(--text-on-accent)" : "var(--text)",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => handleNavigate(dir)}
                          onDoubleClick={() => onSelect(dir)}
                          title={dir}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            minHeight: 44,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            textAlign: "left",
                            background: "none",
                            color: "inherit",
                            border: "none",
                            padding: "0 4px 0 10px",
                            cursor: "pointer",
                            fontSize: 13,
                          }}
                        >
                          <History size={14} style={{ color: isCurrent ? "inherit" : "var(--text-muted)", flexShrink: 0 }} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>{dir}</span>
                        </button>
                        {renderRemoveButton(dir, 44, isCurrent)}
                      </div>
                    );
                  })}
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
              <div style={{ padding: isMobile ? "8px 12px" : "12px 16px" }}>
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
                {browseResult.directories.map((item) => (
                  <div
                    key={item.path}
                    onClick={() => handleItemClick(item)}
                    onDoubleClick={() => handleItemDoubleClick(item)}
                    style={{
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
                      {item.isGitRepo ? (
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
                    </div>
                  </div>
                ))}

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
                {browseResult.directories.length} folders
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
