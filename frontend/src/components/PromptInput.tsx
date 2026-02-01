import { useState, useRef } from 'react';

interface Props {
  onSend: (prompt: string) => void;
  disabled: boolean;
}

export default function PromptInput({ onSend, disabled }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  };

  return (
    <div style={{
      padding: '8px 12px',
      paddingBottom: 'calc(8px + var(--safe-bottom))',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      gap: 8,
      alignItems: 'flex-end',
      background: 'var(--bg)',
      flexShrink: 0,
    }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder="Send a message..."
        disabled={disabled}
        rows={1}
        style={{
          flex: 1,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 15,
          resize: 'none',
          maxHeight: 120,
          lineHeight: 1.4,
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        style={{
          background: disabled || !value.trim() ? 'var(--border)' : 'var(--accent)',
          color: '#fff',
          width: 40,
          height: 40,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          flexShrink: 0,
        }}
      >
        ↑
      </button>
    </div>
  );
}
