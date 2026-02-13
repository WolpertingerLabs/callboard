import { useState, useEffect } from "react";
import { X, Home, Folder, GitBranch, Eye, EyeOff, ChevronRight, ArrowUp } from "lucide-react";
import { browseDirectory, getFolderSuggestions, type BrowseResult, type FolderItem, type FolderSuggestion } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import ModalOverlay from "./ModalOverlay";

interface FolderBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export default function FolderBrowser({ isOpen, onClose, onSelect, initialPath = "/" }: FolderBrowserProps) {
  const isMobile = useIsMobile();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(() => {
    return localStorage.getItem("folderBrowser.showHidden") === "true";
  });
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([]);

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

  // Browse directory when path changes
  useEffect(() => {
    const browse = async () => {
      if (!isOpen || !currentPath) return;

      setIsLoading(true);
      setError(null);

      try {
        const result = await browseDirectory(currentPath, showHidden);
        setBrowseResult(result);
        setCurrentPath(result.currentPath); // Update with resolved path
      } catch (err: any) {
        setError(err.message || "Failed to browse directory");
        setBrowseResult(null);
      } finally {
        setIsLoading(false);
      }
    };

    browse();
  }, [currentPath, showHidden, isOpen]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentPath(initialPath || "/");
      setError(null);
    }
  }, [isOpen, initialPath]);

  const handleToggleHidden = () => {
    const newValue = !showHidden;
    setShowHidden(newValue);
    localStorage.setItem("folderBrowser.showHidden", newValue.toString());
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

  if (!isOpen) return null;

  return (
    <ModalOverlay>
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
                color: showHidden ? "#fff" : "var(--text)",
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
              <div style={{ padding: "16px 16px 12px 16px" }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 }}>Quick Access</div>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.path}
                    onClick={() => handleNavigate(suggestion.path)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: currentPath === suggestion.path ? "var(--accent)" : "none",
                      color: currentPath === suggestion.path ? "#fff" : "var(--text)",
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
                        <GitBranch size={isMobile ? 14 : 16} style={{ color: "var(--accent)", flexShrink: 0 }} />
                      ) : (
                        <Folder size={isMobile ? 14 : 16} style={{ color: "var(--accent)", flexShrink: 0 }} />
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
                color: "#fff",
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
    </ModalOverlay>
  );
}
