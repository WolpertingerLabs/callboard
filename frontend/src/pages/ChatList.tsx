import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { listChats, createChat, deleteChat, getSessionStatus, type Chat, type SessionStatus, type DefaultPermissions } from '../api';
import ChatListItem from '../components/ChatListItem';
import PermissionSettings from '../components/PermissionSettings';

export default function ChatList({ onLogout }: { onLogout: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [folder, setFolder] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [defaultPermissions, setDefaultPermissions] = useState<DefaultPermissions>({
    fileOperations: 'ask',
    codeExecution: 'ask',
    webAccess: 'ask',
  });
  const navigate = useNavigate();

  const load = async () => {
    const chats = await listChats();
    setChats(chats);

    // Fetch session statuses for all chats
    const statuses = new Map<string, SessionStatus>();
    await Promise.all(chats.map(async (chat) => {
      try {
        const status = await getSessionStatus(chat.id);
        if (status.active) {
          statuses.set(chat.id, status);
        }
      } catch {} // Ignore errors for individual status checks
    }));
    setSessionStatuses(statuses);
  };

  useEffect(() => { load(); }, []);

  // Unique recent directories from existing chats, most recent first
  const recentDirs = useMemo(() => {
    const seen = new Set<string>();
    return chats
      .filter(c => {
        if (seen.has(c.folder)) return false;
        seen.add(c.folder);
        return true;
      })
      .map(c => c.folder);
  }, [chats]);

  const handleCreate = async (dir?: string) => {
    const target = dir || folder.trim();
    if (!target) return;
    const chat = await createChat(target, defaultPermissions);
    setFolder('');
    setShowNew(false);
    navigate(`/chat/${chat.id}`);
  };

  const handleDelete = async (id: string) => {
    await deleteChat(id);
    load();
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Claude Code</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => navigate('/queue')}
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text)',
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 14,
              border: '1px solid var(--border)',
            }}
          >
            💾 Drafts
          </button>
          <button
            onClick={() => setShowNew(!showNew)}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            New Chat
          </button>
          <button
            onClick={onLogout}
            style={{
              background: 'transparent',
              color: 'var(--fg)',
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 14,
              border: '1px solid var(--border)',
            }}
          >
            Logout
          </button>
        </div>
      </header>

      {showNew && (
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--border)',
        }}>
          <PermissionSettings
            permissions={defaultPermissions}
            onChange={setDefaultPermissions}
          />

          {recentDirs.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                Recent directories
              </div>
              {recentDirs.map(dir => (
                <button
                  key={dir}
                  onClick={() => handleCreate(dir)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    fontSize: 14,
                    marginBottom: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {dir}
                </button>
              ))}
              <div style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                margin: '10px 0 6px',
              }}>
                Or enter a new path
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={folder}
              onChange={e => setFolder(e.target.value)}
              placeholder="Project folder path (e.g. /home/user/myproject)"
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              autoFocus
              style={{
                flex: 1,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 14,
              }}
            />
            <button
              onClick={() => handleCreate()}
              disabled={!folder.trim()}
              style={{
                background: folder.trim() ? 'var(--accent)' : 'var(--border)',
                color: '#fff',
                padding: '10px 16px',
                borderRadius: 8,
                fontSize: 14,
              }}
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {chats.length === 0 && (
          <p style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center' }}>
            No chats yet. Create one to get started.
          </p>
        )}
        {chats.map(chat => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            onClick={() => navigate(`/chat/${chat.id}`)}
            onDelete={() => handleDelete(chat.id)}
            sessionStatus={sessionStatuses.get(chat.id)}
          />
        ))}
      </div>
    </div>
  );
}
