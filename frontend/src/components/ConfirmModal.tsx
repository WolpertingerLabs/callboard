interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  confirmStyle?: 'danger' | 'primary';
}

export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  confirmStyle = 'primary'
}: ConfirmModalProps) {
  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        background: 'var(--bg)',
        borderRadius: 8,
        padding: 24,
        width: '90%',
        maxWidth: 400,
        border: '1px solid var(--border)',
      }}>
        <h2 style={{ margin: '0 0 16px 0', fontSize: 18 }}>{title}</h2>

        <p style={{
          margin: '0 0 24px 0',
          fontSize: 14,
          color: 'var(--text)',
          lineHeight: 1.4
        }}>
          {message}
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              fontSize: 14,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              fontSize: 14,
              background: confirmStyle === 'danger' ? 'var(--danger, #dc3545)' : 'var(--accent)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}