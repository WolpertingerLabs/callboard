import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { createAgent } from "../../api";

export default function CreateAgent() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasManual, setAliasManual] = useState(false);
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("");
  const [personality, setPersonality] = useState("");
  const [role, setRole] = useState("");
  const [tone, setTone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const toAlias = (input: string) =>
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-/, "")
      .slice(0, 64);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!aliasManual) setAlias(toAlias(value));
  };

  const handleAliasChange = (value: string) => {
    setAliasManual(true);
    setAlias(toAlias(value));
  };

  const canSubmit = name.trim() && alias.trim() && description.trim() && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await createAgent({
        name: name.trim(),
        alias: alias.trim(),
        description: description.trim(),
        emoji: emoji.trim() || undefined,
        personality: personality.trim() || undefined,
        role: role.trim() || undefined,
        tone: tone.trim() || undefined,
      });
      navigate("/agents");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 15,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 13,
    fontWeight: 500,
    color: "var(--text-muted)",
    marginBottom: 6,
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          padding: isMobile ? "12px 16px" : "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => navigate("/agents")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            color: "var(--text-muted)",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            border: "1px solid var(--border)",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>New Agent</h1>
      </div>

      {/* Form */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          justifyContent: "center",
          padding: isMobile ? "20px 16px" : "32px 20px",
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            width: "100%",
            maxWidth: 560,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {/* Core fields */}
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Agent"
                autoFocus
                maxLength={128}
                style={inputStyle}
              />
            </div>
            <div style={{ width: 80, flexShrink: 0 }}>
              <label style={labelStyle}>Emoji</label>
              <input
                type="text"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="🤖"
                maxLength={4}
                style={{ ...inputStyle, textAlign: "center" }}
              />
            </div>
          </div>

          {/* Alias */}
          <div>
            <label style={labelStyle}>Alias</label>
            <input
              type="text"
              value={alias}
              onChange={(e) => handleAliasChange(e.target.value)}
              placeholder="my-agent"
              maxLength={64}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 14 }}
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              Unique identifier used for tooling. <span style={{ color: "var(--text)" }}>Cannot be changed after creation.</span> Lowercase letters, numbers,
              hyphens, underscores.
            </p>
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this agent does"
              maxLength={512}
              style={inputStyle}
            />
          </div>

          {/* Identity fields */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20 }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", marginBottom: 14 }}>
              Identity <span style={{ fontWeight: 400 }}>(optional — editable after creation)</span>
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>Role</label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="e.g. DevOps Assistant, Code Reviewer, Discord Bot"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Personality</label>
                <textarea
                  value={personality}
                  onChange={(e) => setPersonality(e.target.value)}
                  placeholder="Describe the agent's personality and behavior..."
                  rows={3}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    minHeight: 80,
                  }}
                />
              </div>

              <div>
                <label style={labelStyle}>Tone</label>
                <input
                  type="text"
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  placeholder="e.g. casual, professional, friendly, terse"
                  style={inputStyle}
                />
              </div>
            </div>
          </div>

          {error && (
            <div
              style={{
                background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                borderRadius: 10,
                padding: "12px 14px",
                fontSize: 13,
                color: "var(--danger)",
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              width: "100%",
              background: canSubmit ? "var(--accent)" : "var(--border)",
              color: "#fff",
              padding: "12px",
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 500,
              transition: "background 0.15s",
            }}
          >
            {loading ? "Creating..." : "Create Agent"}
          </button>
        </form>
      </div>
    </div>
  );
}
