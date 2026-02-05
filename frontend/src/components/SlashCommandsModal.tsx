import { X, Hash, Puzzle, Check } from 'lucide-react';
import { useState, useEffect } from 'react';
import { Plugin } from '../types/plugins';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  slashCommands: string[];
  plugins?: Plugin[];
  onCommandSelect?: (command: string) => void;
}

function getCommandDescription(command: string): string {
  const descriptions: Record<string, string> = {
    'gsr': 'Git save and reboot - builds, lints, commits changes, pushes, and reboots production',
    'compact': 'Switch to compact view mode',
    'context': 'Show context information',
    'cost': 'Display API usage costs',
    'init': 'Initialize a new project or workspace',
    'output-style:new': 'Create a new output style',
    'pr-comments': 'Generate pull request review comments',
    'release-notes': 'Generate release notes from git history',
    'todos': 'Show or manage todo items',
    'review': 'Review code changes',
    'security-review': 'Perform security review of code',
    'help': 'Show help information',
    'clear': 'Clear the conversation',
    'model': 'Switch AI model',
  };

  return descriptions[command] || 'No description available';
}

function getCommandCategory(command: string): string {
  if (['gsr', 'pr-comments', 'release-notes', 'review', 'security-review'].includes(command)) {
    return 'Development';
  }
  if (['compact', 'output-style:new', 'help', 'clear', 'model'].includes(command)) {
    return 'Interface';
  }
  if (['context', 'cost', 'todos'].includes(command)) {
    return 'Information';
  }
  if (['init'].includes(command)) {
    return 'Project';
  }
  return 'Other';
}

// Plugin activation state management
function getActivePlugins(): Set<string> {
  try {
    const active = localStorage.getItem('activePlugins');
    return new Set(active ? JSON.parse(active) : []);
  } catch {
    return new Set();
  }
}

function setActivePlugins(activeIds: Set<string>): void {
  try {
    localStorage.setItem('activePlugins', JSON.stringify(Array.from(activeIds)));
  } catch {
    // Handle localStorage errors gracefully
  }
}

export default function SlashCommandsModal({ isOpen, onClose, slashCommands, plugins = [], onCommandSelect }: Props) {
  const [activePluginIds, setActivePluginIds] = useState<Set<string>>(new Set());

  // Load active plugins from localStorage on mount
  useEffect(() => {
    setActivePluginIds(getActivePlugins());
  }, []);

  // Toggle plugin activation
  const togglePlugin = (pluginId: string) => {
    const newActiveIds = new Set(activePluginIds);
    if (newActiveIds.has(pluginId)) {
      newActiveIds.delete(pluginId);
    } else {
      newActiveIds.add(pluginId);
    }
    setActivePluginIds(newActiveIds);
    setActivePlugins(newActiveIds);
  };

  if (!isOpen) return null;

  // Group commands by category
  const categorizedCommands = slashCommands.reduce((acc, command) => {
    const category = getCommandCategory(command);
    if (!acc[category]) acc[category] = [];
    acc[category].push(command);
    return acc;
  }, {} as Record<string, string[]>);

  const handleCommandClick = (command: string) => {
    if (onCommandSelect) {
      onCommandSelect(`/${command} `);
    }
    onClose();
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '20px',
    }}>
      <div style={{
        backgroundColor: 'var(--bg)',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '600px',
        maxHeight: '80vh',
        overflow: 'hidden',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        border: '1px solid var(--border)',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <Hash size={20} color="var(--accent)" />
            <h2 style={{
              margin: 0,
              fontSize: '18px',
              fontWeight: 600,
              color: 'var(--text)',
            }}>
              Slash Commands
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{
          padding: '20px 24px 24px',
          overflowY: 'auto',
          maxHeight: 'calc(80vh - 120px)',
        }}>
          {slashCommands.length === 0 ? (
            <div style={{
              textAlign: 'center' as const,
              color: 'var(--text-muted)',
              padding: '40px 20px',
            }}>
              <p>No slash commands available yet.</p>
              <p style={{ fontSize: '14px', marginTop: '8px' }}>
                Commands will appear after sending your first message.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {Object.entries(categorizedCommands).map(([category, commands]) => (
                <div key={category}>
                  <h3 style={{
                    margin: '0 0 12px 0',
                    fontSize: '14px',
                    fontWeight: 600,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase' as const,
                    letterSpacing: '0.05em',
                  }}>
                    {category}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {commands.map((command) => (
                      <button
                        key={command}
                        onClick={() => handleCommandClick(command)}
                        style={{
                          background: 'transparent',
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                          padding: '12px 16px',
                          textAlign: 'left' as const,
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          width: '100%',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--accent-bg, rgba(59, 130, 246, 0.1))';
                          e.currentTarget.style.borderColor = 'var(--accent)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.borderColor = 'var(--border)';
                        }}
                      >
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}>
                          <code style={{
                            color: 'var(--accent)',
                            fontWeight: 600,
                            fontSize: '14px',
                            fontFamily: 'var(--font-mono)',
                          }}>
                            /{command}
                          </code>
                          <p style={{
                            margin: 0,
                            color: 'var(--text-muted)',
                            fontSize: '13px',
                            lineHeight: 1.4,
                          }}>
                            {getCommandDescription(command)}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Plugins Section */}
          {plugins.length > 0 && (
            <div style={{ marginTop: slashCommands.length > 0 ? '32px' : '0' }}>
              <h3 style={{
                margin: '0 0 16px 0',
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase' as const,
                letterSpacing: '0.05em',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}>
                <Puzzle size={16} />
                Plugins ({plugins.length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {plugins.map((plugin) => {
                  const isActive = activePluginIds.has(plugin.id);
                  const pluginCommands = [...plugin.skills, ...plugin.agents];

                  return (
                    <div
                      key={plugin.id}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        padding: '16px',
                        backgroundColor: isActive ? 'var(--accent-bg, rgba(59, 130, 246, 0.05))' : 'transparent',
                        borderColor: isActive ? 'var(--accent)' : 'var(--border)',
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: '12px',
                        marginBottom: '12px',
                      }}>
                        <div style={{ flex: 1 }}>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            marginBottom: '4px',
                          }}>
                            <code style={{
                              color: 'var(--accent)',
                              fontWeight: 600,
                              fontSize: '14px',
                              fontFamily: 'var(--font-mono)',
                            }}>
                              {plugin.manifest.name}
                            </code>
                            <span style={{
                              fontSize: '12px',
                              color: 'var(--text-muted)',
                              background: 'var(--bg-secondary)',
                              padding: '2px 6px',
                              borderRadius: '4px',
                            }}>
                              v{plugin.manifest.version}
                            </span>
                          </div>
                          <p style={{
                            margin: 0,
                            color: 'var(--text-muted)',
                            fontSize: '13px',
                            lineHeight: 1.4,
                          }}>
                            {plugin.manifest.description}
                          </p>
                        </div>
                        <button
                          onClick={() => togglePlugin(plugin.id)}
                          style={{
                            background: isActive ? 'var(--accent)' : 'transparent',
                            border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                            borderRadius: '6px',
                            padding: '6px 12px',
                            cursor: 'pointer',
                            color: isActive ? 'white' : 'var(--text)',
                            fontSize: '12px',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            transition: 'all 0.2s ease',
                          }}
                        >
                          {isActive && <Check size={14} />}
                          {isActive ? 'Active' : 'Activate'}
                        </button>
                      </div>

                      {/* Show available commands when active */}
                      {isActive && pluginCommands.length > 0 && (
                        <div style={{
                          paddingTop: '12px',
                          borderTop: '1px solid var(--border)',
                        }}>
                          <p style={{
                            margin: '0 0 8px 0',
                            fontSize: '12px',
                            color: 'var(--text-muted)',
                            fontWeight: 600,
                          }}>
                            Available Commands:
                          </p>
                          <div style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '6px',
                          }}>
                            {pluginCommands.map((item, index) => (
                              <button
                                key={index}
                                onClick={() => {
                                  if (onCommandSelect) {
                                    onCommandSelect(`/${plugin.manifest.name}:${item.name} `);
                                  }
                                  onClose();
                                }}
                                style={{
                                  background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border)',
                                  borderRadius: '4px',
                                  padding: '4px 8px',
                                  fontSize: '11px',
                                  color: 'var(--text)',
                                  cursor: 'pointer',
                                  fontFamily: 'var(--font-mono)',
                                  transition: 'all 0.2s ease',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = 'var(--accent-bg, rgba(59, 130, 246, 0.1))';
                                  e.currentTarget.style.borderColor = 'var(--accent)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = 'var(--bg-secondary)';
                                  e.currentTarget.style.borderColor = 'var(--border)';
                                }}
                              >
                                /{plugin.manifest.name}:{item.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--border)',
          backgroundColor: 'var(--bg-secondary)',
        }}>
          <p style={{
            margin: 0,
            fontSize: '12px',
            color: 'var(--text-muted)',
            textAlign: 'center' as const,
          }}>
            Type "/" in the message input to see autocomplete suggestions
          </p>
        </div>
      </div>
    </div>
  );
}