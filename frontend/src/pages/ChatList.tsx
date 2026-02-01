import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { listChats, createChat, deleteChat, type Chat } from '../api';
import ChatListItem from '../components/ChatListItem';

export default function ChatList() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [folder, setFolder] = useState('');
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();

  const load = () => listChats().then(setChats);
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!folder.trim()) return;
    const chat = await createChat(folder.trim());
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
      </header>

      {showNew && (
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
        }}>
          <input
            value={folder}
            onChange={e => setFolder(e.target.value)}
            placeholder="Project folder path (e.g. /home/user/myproject)"
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
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
            onClick={handleCreate}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '10px 16px',
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            Create
          </button>
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
          />
        ))}
      </div>
    </div>
  );
}
