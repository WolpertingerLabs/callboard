import { useState, useEffect } from 'react';
import { Folder, AlertCircle, CheckCircle, Search } from 'lucide-react';
import { validatePath, type ValidateResult } from '../api/folders';
import FolderBrowser from './FolderBrowser';

interface FolderSelectorProps {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

export default function FolderSelector({
  value,
  onChange,
  placeholder = "Project folder path (e.g. /home/user/myproject)",
  autoFocus = false,
  disabled = false
}: FolderSelectorProps) {
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);

  // Validate path when value changes
  useEffect(() => {
    if (!value.trim()) {
      setValidation(null);
      return;
    }

    const validateAsync = async () => {
      setIsValidating(true);
      try {
        const result = await validatePath(value);
        setValidation(result);
      } catch (err) {
        setValidation({
          valid: false,
          exists: false,
          readable: false
        });
      } finally {
        setIsValidating(false);
      }
    };

    const timeoutId = setTimeout(validateAsync, 300); // Debounce validation
    return () => clearTimeout(timeoutId);
  }, [value]);

  const getValidationIcon = () => {
    if (!value.trim()) return null;
    if (isValidating) return <div className="spinner" style={{ width: 16, height: 16 }} />;

    if (validation?.valid && validation?.isDirectory) {
      return <CheckCircle size={16} style={{ color: 'var(--success, #10b981)' }} />;
    } else if (validation?.exists && !validation?.isDirectory) {
      return <AlertCircle size={16} style={{ color: 'var(--warning, #f59e0b)' }} />;
    } else if (!validation?.exists) {
      return <AlertCircle size={16} style={{ color: 'var(--danger, #ef4444)' }} />;
    }

    return <AlertCircle size={16} style={{ color: 'var(--text-muted)' }} />;
  };

  const getValidationMessage = () => {
    if (!value.trim() || isValidating) return null;

    if (validation?.valid && validation?.isDirectory) {
      return validation.isGit ?
        <span style={{ color: 'var(--success, #10b981)', fontSize: 12 }}>✓ Valid git repository</span> :
        <span style={{ color: 'var(--success, #10b981)', fontSize: 12 }}>✓ Valid directory</span>;
    } else if (validation?.exists && !validation?.isDirectory) {
      return <span style={{ color: 'var(--warning, #f59e0b)', fontSize: 12 }}>⚠ Path exists but is not a directory</span>;
    } else if (!validation?.exists) {
      return <span style={{ color: 'var(--danger, #ef4444)', fontSize: 12 }}>✗ Directory does not exist</span>;
    } else if (!validation?.readable) {
      return <span style={{ color: 'var(--danger, #ef4444)', fontSize: 12 }}>✗ Directory is not accessible</span>;
    }

    return null;
  };

  return (
    <div>
      <div style={{
        display: 'flex',
        gap: 8,
        position: 'relative'
      }}>
        <div style={{
          flex: 1,
          position: 'relative',
          display: 'flex',
          alignItems: 'center'
        }}>
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            autoFocus={autoFocus}
            disabled={disabled}
            onKeyDown={e => {
              if (e.key === 'Enter' && validation?.valid && validation?.isDirectory) {
                // Could trigger submit if needed
              }
            }}
            style={{
              width: '100%',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              paddingRight: validation ? 40 : 12,
              fontSize: 14,
              color: 'var(--text)',
              outline: 'none',
              transition: 'border-color 0.2s ease',
              ...(validation?.valid && validation?.isDirectory ? {
                borderColor: 'var(--success, #10b981)'
              } : validation && !validation.valid ? {
                borderColor: 'var(--danger, #ef4444)'
              } : {})
            }}
          />
          {(validation || isValidating) && (
            <div style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center'
            }}>
              {getValidationIcon()}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowBrowser(true)}
          disabled={disabled}
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text)',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            cursor: disabled ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 14,
            opacity: disabled ? 0.6 : 1,
            transition: 'background-color 0.2s ease'
          }}
          title="Browse folders"
          onMouseOver={e => {
            if (!disabled) {
              e.currentTarget.style.background = 'var(--surface)';
            }
          }}
          onMouseOut={e => {
            if (!disabled) {
              e.currentTarget.style.background = 'var(--bg-secondary)';
            }
          }}
        >
          <Search size={16} />
          Browse
        </button>
      </div>

      {getValidationMessage() && (
        <div style={{ marginTop: 6 }}>
          {getValidationMessage()}
        </div>
      )}

      <FolderBrowser
        isOpen={showBrowser}
        onClose={() => setShowBrowser(false)}
        onSelect={(path) => {
          onChange(path);
          setShowBrowser(false);
        }}
        initialPath={value || undefined}
      />
    </div>
  );
}