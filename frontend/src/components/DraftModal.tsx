import { useState, useEffect } from 'react';
import { addToBacklog, scheduleMessage } from '../api';

interface DraftModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string;
  message: string;
  onSuccess?: () => void;
}

export default function DraftModal({ isOpen, onClose, chatId, message, onSuccess }: DraftModalProps) {
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledTime, setScheduledTime] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Reset state when modal opens
      setScheduleEnabled(false);
      setScheduledTime('');
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSaveDraft = async () => {
    if (!message.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await addToBacklog(chatId, message.trim());
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save draft');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveScheduled = async () => {
    if (!message.trim() || !scheduledTime) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await scheduleMessage(chatId, message.trim(), new Date(scheduledTime).toISOString());
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save scheduled message');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    return now.toISOString().slice(0, 16);
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
        maxWidth: 500,
        border: '1px solid var(--border)',
      }}>
        <h2 style={{ margin: '0 0 16px 0', fontSize: 18 }}>Save Message</h2>

        <div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 500 }}>
              Message:
            </label>
            <div style={{
              background: 'var(--surface)',
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 14,
              maxHeight: 120,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              color: 'var(--text)',
            }}>
              {message || 'No message content'}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
                style={{ margin: 0 }}
              />
              <span style={{ fontSize: 14, fontWeight: 500 }}>Schedule for later</span>
            </label>
          </div>

          {scheduleEnabled && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 500 }}>
                Execute at:
              </label>
              <input
                type="datetime-local"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                min={getMinDateTime()}
                style={{
                  width: '100%',
                  padding: 8,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  fontSize: 14,
                }}
              />
            </div>
          )}

          {error && (
            <div style={{
              color: 'var(--danger)',
              fontSize: 12,
              marginBottom: 16,
              padding: 8,
              background: 'var(--danger-bg, rgba(255, 0, 0, 0.1))',
              borderRadius: 4,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                fontSize: 14,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                cursor: isSubmitting ? 'default' : 'pointer',
              }}
            >
              Cancel
            </button>

            {scheduleEnabled ? (
              <button
                type="button"
                onClick={handleSaveScheduled}
                disabled={isSubmitting || !message.trim() || !scheduledTime}
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  fontSize: 14,
                  background: isSubmitting || !message.trim() || !scheduledTime ? 'var(--border)' : 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  cursor: isSubmitting || !message.trim() || !scheduledTime ? 'default' : 'pointer',
                }}
              >
                {isSubmitting ? 'Scheduling...' : '⏰ Save Scheduled'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={isSubmitting || !message.trim()}
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  fontSize: 14,
                  background: isSubmitting || !message.trim() ? 'var(--border)' : 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  cursor: isSubmitting || !message.trim() ? 'default' : 'pointer',
                }}
              >
                {isSubmitting ? 'Saving...' : '💾 Save Draft'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}