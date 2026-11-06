import { useState } from "react";
import { FileDiff, GitPullRequest } from "lucide-react";
import GitDiffView from "../GitDiffView";
import ChatPrsView from "./ChatPrsView";
import { getChatGitTab, saveChatGitTab, type ChatGitTab } from "../../utils/localStorage";

interface ChatGitViewProps {
  folder: string;
  /** Absent for a chat not yet created. */
  chatId?: string;
}

const TABS: { tab: ChatGitTab; text: string; icon: React.ReactNode }[] = [
  { tab: "changes", text: "Changes", icon: <FileDiff size={13} /> },
  { tab: "prs", text: "PRs", icon: <GitPullRequest size={13} /> },
];

/**
 * A chat's git view: the working-tree diff ("Changes", as it always was) or
 * the PRs related to the chat, switched by a toggle at the top. The choice is
 * remembered globally, not per chat. Only the half on screen is mounted, so
 * the PRs half fetches and polls only while it is showing.
 */
export default function ChatGitView({ folder, chatId }: ChatGitViewProps) {
  const [tab, setTab] = useState<ChatGitTab>(() => getChatGitTab());

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 16px 0", flexShrink: 0 }}>
        {/* Pressed toggles, as on the Board's layout switch, not radios: two
            plain buttons in the tab order make no keyboard promise they break. */}
        <div role="group" aria-label="Git view" style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
          {TABS.map((option, i) => (
            <button
              key={option.tab}
              aria-pressed={tab === option.tab}
              onClick={() => {
                setTab(option.tab);
                saveChatGitTab(option.tab);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 10px",
                fontSize: 12,
                background: tab === option.tab ? "var(--accent)" : "var(--surface)",
                color: tab === option.tab ? "var(--text-on-accent)" : "var(--text)",
                border: "none",
                borderRight: i < TABS.length - 1 ? "1px solid var(--border)" : "none",
                cursor: "pointer",
              }}
            >
              {option.icon}
              {option.text}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "changes" ? <GitDiffView folder={folder} /> : <ChatPrsView key={`${chatId ?? ""}\0${folder}`} folder={folder} chatId={chatId} />}
      </div>
    </div>
  );
}
