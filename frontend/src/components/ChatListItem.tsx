import type { Chat } from '../api';

interface Props {
  chat: Chat;
  onClick: () => void;
  onDelete: () => void;
}

export default function ChatListItem({ chat, onClick, onDelete }: Props) {
  const folderName = chat.folder.split('/').pop() || chat.folder;
  const time = new Date(chat.updated_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div
      onClick={onClick}
      style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {folderName}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chat.folder}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{time}</div>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete(); }}
        style={{
          background: 'none',
          color: 'var(--text-muted)',
          fontSize: 18,
          padding: '4px 8px',
          marginLeft: 8,
        }}
      >
        ×
      </button>
    </div>
  );
}
