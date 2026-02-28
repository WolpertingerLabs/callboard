import { useMemo } from "react";
import { getCommandDescription } from "../utils/commands";

interface Props {
  slashCommands: string[];
  query: string;
  onSelect: (command: string) => void;
  visible: boolean;
  commandDescriptions?: Record<string, string>;
}

export default function SlashCommandAutocomplete({ slashCommands, query, onSelect, visible, commandDescriptions }: Props) {
  const filteredCommands = useMemo(() => {
    if (!query || !query.startsWith("/")) return [];

    const searchTerm = query.slice(1).toLowerCase(); // Remove the '/' prefix

    return slashCommands
      .filter((cmd) => cmd.toLowerCase().includes(searchTerm))
      .sort((a, b) => {
        // Prioritize commands that start with the search term
        const aStartsWith = a.toLowerCase().startsWith(searchTerm);
        const bStartsWith = b.toLowerCase().startsWith(searchTerm);

        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;

        // Then sort alphabetically
        return a.localeCompare(b);
      })
      .slice(0, 10); // Limit to 10 results
  }, [slashCommands, query]);

  if (!visible || filteredCommands.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        marginBottom: "8px",
        maxHeight: "200px",
        overflowY: "auto",
        zIndex: 1000,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          fontSize: 11,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border)",
          fontWeight: 600,
        }}
      >
        Available Commands ({filteredCommands.length})
      </div>

      {filteredCommands.map((command, index) => (
        <button
          key={command}
          onClick={() => onSelect(command)}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "transparent",
            border: "none",
            textAlign: "left" as const,
            fontSize: 14,
            color: "var(--text)",
            cursor: "pointer",
            borderBottom: index < filteredCommands.length - 1 ? "1px solid var(--border)" : "none",
            transition: "background 0.1s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--accent-bg, rgba(59, 130, 246, 0.1))";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <code
              style={{
                background: "var(--bg-secondary)",
                padding: "2px 6px",
                borderRadius: "4px",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                color: "var(--accent)",
              }}
            >
              {command}
            </code>
            {(commandDescriptions?.[command] || getCommandDescription(command)) && (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                {commandDescriptions?.[command] || getCommandDescription(command)}
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
