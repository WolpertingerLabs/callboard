import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PanelLeftOpen, Settings2 } from "lucide-react";
import { getJobsOverview, type JobOverviewItem } from "../api";
import { useSessionContext } from "../contexts/SessionContext";
import SidebarHeader from "../components/SidebarHeader";
import JobListItem, { ACTIVE_JOB_RUN_STATUSES } from "../components/JobListItem";
import NewChatPanel from "../components/NewChatPanel";
import type { SidebarViewMode } from "../utils/localStorage";

interface JobListProps {
  activeChatId?: string;
  onRefresh: (refreshFn: () => void) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onViewModeChange: (mode: SidebarViewMode) => void;
}

export default function JobList({
  activeChatId,
  onRefresh,
  sidebarCollapsed,
  onToggleSidebar,
  claudeLoggedIn,
  onShowClaudeModal,
  onViewModeChange,
}: JobListProps) {
  const { metadataVersion } = useSessionContext();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobOverviewItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const now = useMemo(() => Date.now(), [jobs]);

  const load = useCallback(async () => {
    try {
      const items = await getJobsOverview();
      setJobs(items);
    } catch (err) {
      console.error("Failed to load jobs overview:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Register refresh callback
  useEffect(() => {
    onRefresh(load);
  }, [onRefresh, load]);

  // Poll while any job has an active (non-terminal, non-paused) run
  const hasActiveRun = jobs.some((j) => j.latestRun && ACTIVE_JOB_RUN_STATUSES.includes(j.latestRun.status));
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, [hasActiveRun, load]);

  // Refetch when chat metadata changes (status, title) via SSE — job step
  // sessions update their chats as the run progresses
  useEffect(() => {
    if (metadataVersion === 0) return;
    const timer = setTimeout(() => load(), 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, load]);

  const handleJobClick = (job: JobOverviewItem) => {
    if (job.latestRun?.latestChatId) {
      navigate(`/chat/${job.latestRun.latestChatId}`);
    } else {
      // No run chat to show — fall back to the jobs management page
      navigate("/settings/jobs");
    }
  };

  // Collapsed sidebar state
  if (sidebarCollapsed) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 12,
          gap: 8,
          height: "100%",
        }}
      >
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            style={{
              background: "none",
              color: "var(--chatlist-icon)",
              padding: 8,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              marginBottom: 16,
            }}
            title="Expand sidebar"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <SidebarHeader
        viewMode="jobs"
        onToggleNew={() => setShowNew(!showNew)}
        onViewModeChange={onViewModeChange}
        claudeLoggedIn={claudeLoggedIn}
        onShowClaudeModal={onShowClaudeModal}
        onToggleSidebar={onToggleSidebar}
      />

      {/* Manage bar */}
      <div
        style={{
          padding: "8px 20px",
          borderBottom: "1px solid var(--chatlist-header-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        <span>
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </span>
        <button
          onClick={() => navigate("/settings/jobs")}
          title="Create and manage jobs"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 13,
            cursor: "pointer",
            padding: 0,
          }}
        >
          <Settings2 size={14} />
          Manage
        </button>
      </div>

      {showNew && <NewChatPanel onClose={() => setShowNew(false)} />}

      {/* Job list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {isLoading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>Loading...</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>No jobs yet. Create one in Settings → Jobs.</div>
        ) : (
          jobs.map((job) => (
            <JobListItem
              key={job.jobId}
              job={job}
              isActive={!!activeChatId && activeChatId === job.latestRun?.latestChatId}
              onClick={() => handleJobClick(job)}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}
