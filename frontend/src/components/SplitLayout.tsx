import { useLocation } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import ChatList from '../pages/ChatList';
import Chat from '../pages/Chat';

interface SplitLayoutProps {
  onLogout: () => void;
}

export default function SplitLayout({ onLogout }: SplitLayoutProps) {
  const isMobile = useIsMobile();
  const location = useLocation();

  // Check if we're on a chat page
  const chatMatch = location.pathname.match(/^\/chat\/(.+)$/);
  const activeChatId = chatMatch ? chatMatch[1] : null;

  // Mobile behavior - keep existing full-page navigation
  if (isMobile) {
    if (activeChatId) {
      return <Chat />;
    }
    return <ChatList onLogout={onLogout} />;
  }

  // Desktop behavior - split view
  return (
    <div className="split-layout" style={{
      display: 'flex',
      height: '100%',
      overflow: 'hidden'
    }}>
      {/* Chat List Sidebar - 1/5 of width */}
      <div className="split-sidebar" style={{
        width: '20%',
        minWidth: '300px',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}>
        <ChatList onLogout={onLogout} />
      </div>

      {/* Active Chat Area - 4/5 of width */}
      <div className="split-main" style={{
        width: '80%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}>
        {activeChatId ? (
          <Chat />
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