import { useLocation } from 'react-router-dom';
import { useRef } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import ChatList from '../pages/ChatList';
import Chat from '../pages/Chat';

interface SplitLayoutProps {
  onLogout: () => void;
}

export default function SplitLayout({ onLogout }: SplitLayoutProps) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const chatListRefreshRef = useRef<(() => void) | null>(null);

  // Check if we're on a chat page
  const chatMatch = location.pathname.match(/^\/chat\/(.+)$/);
  const activeChatId = chatMatch ? chatMatch[1] : null;

  const refreshChatList = () => {
    chatListRefreshRef.current?.();
  };

  // Mobile behavior - keep existing full-page navigation
  if (isMobile) {
    if (activeChatId) {
      return <Chat onChatListRefresh={refreshChatList} />;
    }
    return <ChatList onLogout={onLogout} onRefresh={(fn) => { chatListRefreshRef.current = fn; }} />;
  }

  // Desktop behavior - split view
  return (
    <div className="split-layout" style={{
      display: 'flex',
      height: '100%',
      overflow: 'hidden'
    }}>
      {/* Chat List Sidebar - 1/4 of width */}
      <div className="split-sidebar" style={{
        width: '25%',
        minWidth: '300px',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}>
        <ChatList onLogout={onLogout} onRefresh={(fn) => { chatListRefreshRef.current = fn; }} />
      </div>

      {/* Active Chat Area - 3/4 of width */}
      <div className="split-main" style={{
        width: '75%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}>
        {activeChatId ? (
          <Chat onChatListRefresh={refreshChatList} />
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            fontSize: 16,
          }}>
            Select a chat to start coding
          </div>
        )}
      </div>
    </div>
  );
}