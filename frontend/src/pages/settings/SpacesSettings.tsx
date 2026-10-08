import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Layers, Plus, Trash2 } from "lucide-react";
import type { SpaceListItem, SpacePatch } from "shared/types/space.js";
import { DEFAULT_SPACE_ID, SPACE_ACCENTS, SPACE_INSTRUCTIONS_MAX, UI_AGENT_PROVIDER_KINDS } from "shared/types/index.js";
import type { AppPlugin, CustomSkillListItem, UiAgentProviderKind } from "shared/types/index.js";
import {
  createSpace,
  deleteSpace,
  getAppPlugins,
  getSpaceFolderGroups,
  listCustomSkills,
  listSpaces,
  moveToSpace,
  updateSpace,
  type SpaceFolderGroup,
} from "../../api";
import { useSpaces } from "../../contexts/SpaceContext";
import { SpaceDot, spaceLabel } from "../../components/SpaceChip";
import ModalOverlay from "../../components/ModalOverlay";
import PermissionSettings from "../../components/PermissionSettings";
import { errorMessage } from "../../utils/errorMessage";
import { headerStyle, helpStyle, inputStyle, labelStyle, sectionStyle, subtitleStyle } from "./styles";

const buttonStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
};
const primaryButton: React.CSSProperties = { ...buttonStyle, background: "var(--accent)", color: "var(--text-on-accent)", border: "1px solid var(--accent)" };
const iconButton: React.CSSProperties = { ...buttonStyle, padding: "4px 6px", display: "inline-flex", alignItems: "center" };

/**
 * Settings → Spaces. Every write is a delta (`PATCH` with only the field that
 * changed), so two tabs editing different fields of one space never undo each
 * other — the normal shape over remote access.
 */
export default function SpacesSettings() {
  const { refreshSpaces: refreshSwitcher } = useSpaces();
  const [spaces, setSpaces] = useState<SpaceListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_SPACE_ID);
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SpaceListItem | null>(null);
  const [sorting, setSorting] = useState(false);

  const load = useCallback(async () => {
    try {
      setSpaces(await listSpaces({ includeArchived: true, includeCounts: true }));
    } catch (err) {
      setError(errorMessage(err, "Failed to load spaces"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Apply one delta, then refresh this page and the sidebar switcher. */
  const patch = async (id: string, delta: SpacePatch) => {
    setError(null);
    try {
      await updateSpace(id, delta);
      await load();
      await refreshSwitcher();
      return true;
    } catch (err) {
      setError(errorMessage(err, "Failed to update space"));
      return false;
    }
  };

  const create = async () => {
    if (!newName.trim()) return;
    setError(null);
    try {
      const liveBefore = spaces.filter((s) => !s.archived).length;
      const created = await createSpace({ name: newName.trim(), ...(newEmoji.trim() && { emoji: newEmoji.trim() }) });
      setNewName("");
      setNewEmoji("");
      setSelectedId(created.id);
      await load();
      await refreshSwitcher();
      // The first extra space is when a flat history wants sorting: offer it once.
      if (liveBefore === 1) setSorting(true);
    } catch (err) {
      setError(errorMessage(err, "Failed to create space"));
    }
  };

  const live = spaces.filter((s) => !s.archived);
  const move = async (space: SpaceListItem, dir: -1 | 1) => {
    const index = live.findIndex((s) => s.id === space.id);
    const other = live[index + dir];
    if (!other) return;
    // Swap the two orders — two single-field deltas.
    await patch(space.id, { order: other.order });
    await patch(other.id, { order: space.order });
  };

  const selected = spaces.find((s) => s.id === selectedId) ?? spaces[0];

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={sectionStyle}>
        <div style={headerStyle}>
          <Layers size={18} />
          <h3 style={{ margin: 0, fontSize: 16 }}>Spaces</h3>
        </div>
        <div style={subtitleStyle}>
          Separate areas of work — the sidebar, board, search and agents’ chat tools show one space at a time. A chat’s whole tree lives in one space; folders
          can be used in several.
        </div>

        {error && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
          {spaces.map((space) => (
            <div
              key={space.id}
              onClick={() => setSelectedId(space.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 6,
                border: `1px solid ${space.id === selected?.id ? "var(--accent)" : "var(--border)"}`,
                background: space.id === selected?.id ? "var(--accent-light)" : "var(--surface)",
                cursor: "pointer",
                opacity: space.archived ? 0.6 : 1,
              }}
            >
              <SpaceDot space={space} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>{spaceLabel(space)}</span>
              {space.archived && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>archived</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {space.chatCount} chat{space.chatCount === 1 ? "" : "s"}
              </span>
              {!space.archived && (
                <>
                  <button
                    aria-label={`Move ${space.name} up`}
                    style={iconButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      void move(space, -1);
                    }}
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    aria-label={`Move ${space.name} down`}
                    style={iconButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      void move(space, 1);
                    }}
                  >
                    <ArrowDown size={12} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            aria-label="New space emoji"
            value={newEmoji}
            onChange={(e) => setNewEmoji(e.target.value)}
            placeholder="🙂"
            style={{ ...inputStyle, width: 56 }}
          />
          <input
            aria-label="New space name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            placeholder="New space name (e.g. Work)"
            style={inputStyle}
          />
          <button
            style={{ ...primaryButton, display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", flexShrink: 0 }}
            onClick={() => void create()}
            disabled={!newName.trim()}
          >
            <Plus size={14} /> Add
          </button>
        </div>
        {live.length > 1 && (
          <button style={{ ...buttonStyle, marginTop: 10 }} onClick={() => setSorting(true)}>
            Sort existing chats into spaces…
          </button>
        )}
      </div>

      {selected && <SpaceEditor key={selected.id} space={selected} onPatch={patch} onDelete={() => setDeleting(selected)} />}

      {deleting && (
        <DeleteSpaceDialog
          space={deleting}
          spaces={live.filter((s) => s.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            setSelectedId(DEFAULT_SPACE_ID);
            await load();
            await refreshSwitcher();
          }}
        />
      )}

      {sorting && (
        <SortChatsSheet
          spaces={live}
          onClose={() => setSorting(false)}
          onDone={async () => {
            setSorting(false);
            await load();
            await refreshSwitcher();
          }}
        />
      )}
    </div>
  );
}

function SpaceEditor({
  space,
  onPatch,
  onDelete,
}: {
  space: SpaceListItem;
  onPatch: (id: string, delta: SpacePatch) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(space.name);
  const [emoji, setEmoji] = useState(space.emoji ?? "");
  const [rules, setRules] = useState((space.folderRules ?? []).join("\n"));
  const [instructions, setInstructions] = useState(space.instructions ?? "");
  const [plugins, setPlugins] = useState<AppPlugin[]>([]);
  const [skills, setSkills] = useState<CustomSkillListItem[]>([]);
  const isDefault = space.id === DEFAULT_SPACE_ID;
  const defaults = space.defaults ?? {};

  useEffect(() => {
    getAppPlugins()
      .then((data) => setPlugins(data.plugins.filter((p) => p.enabled)))
      .catch(() => {});
    listCustomSkills()
      .then(setSkills)
      .catch(() => {});
  }, []);

  const scopeList = (key: "plugins" | "skills", all: string[]) => {
    const allowed = space.agentScope?.[key];
    return {
      restricted: allowed !== undefined,
      has: (id: string) => allowed === undefined || allowed.includes(id),
      toggleRestricted: (on: boolean) => void onPatch(space.id, { agentScope: { [key]: on ? all : null } }),
      toggle: (id: string, on: boolean) => {
        const current = allowed ?? all;
        const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
        void onPatch(space.id, { agentScope: { [key]: next } });
      },
    };
  };
  const pluginScope = scopeList(
    "plugins",
    plugins.map((p) => p.id),
  );
  const skillScope = scopeList(
    "skills",
    skills.map((s) => s.name),
  );

  return (
    <div style={sectionStyle}>
      <div style={{ ...headerStyle, justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{spaceLabel(space)}</h3>
        {!isDefault && (
          <div style={{ display: "flex", gap: 8 }}>
            <button style={buttonStyle} onClick={() => void onPatch(space.id, { archived: !space.archived })}>
              {space.archived ? "Unarchive" : "Archive"}
            </button>
            <button style={{ ...buttonStyle, color: "var(--danger)" }} onClick={onDelete}>
              <Trash2 size={13} style={{ verticalAlign: "middle" }} /> Delete
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 8, marginBottom: 12 }}>
        <div>
          <label style={labelStyle} htmlFor="space-emoji">
            Emoji
          </label>
          <input
            id="space-emoji"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            onBlur={() => emoji !== (space.emoji ?? "") && void onPatch(space.id, { emoji: emoji.trim() || null })}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="space-name">
            Name
          </label>
          <input
            id="space-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== space.name && void onPatch(space.id, { name: name.trim() })}
            style={inputStyle}
          />
        </div>
      </div>

      <label style={labelStyle}>Accent</label>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <button
          aria-pressed={!space.color}
          onClick={() => void onPatch(space.id, { color: null })}
          style={{ ...buttonStyle, fontSize: 12, outline: !space.color ? "2px solid var(--accent)" : undefined }}
        >
          None
        </button>
        {SPACE_ACCENTS.map((accent) => (
          <button
            key={accent}
            aria-label={`Accent ${accent}`}
            aria-pressed={space.color === accent}
            onClick={() => void onPatch(space.id, { color: accent })}
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              border: "1px solid var(--border)",
              background: `var(--space-accent-${accent})`,
              outline: space.color === accent ? "2px solid var(--text)" : undefined,
              outlineOffset: 2,
              cursor: "pointer",
            }}
          />
        ))}
      </div>

      {!isDefault && (
        <>
          <label style={labelStyle} htmlFor="space-rules">
            Folder rules
          </label>
          <textarea
            id="space-rules"
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            onBlur={() => {
              const next = rules
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean);
              if (next.join("\n") !== (space.folderRules ?? []).join("\n")) void onPatch(space.id, { folderRules: next.length ? next : null });
            }}
            rows={3}
            placeholder={"~/work/**\n/srv/client-repo"}
            style={{ ...inputStyle, fontFamily: "monospace" }}
          />
          <div style={{ ...helpStyle, marginBottom: 12 }}>
            One per line. New chats started without a space, and CLI sessions Callboard discovers, land here when their folder matches. A plain path means that
            folder and everything under it; <code>*</code> matches within a folder name, <code>**</code> across them. Rules never move existing chats.
          </div>
        </>
      )}

      <label style={labelStyle} htmlFor="space-instructions">
        Instructions for chats in this space
      </label>
      <textarea
        id="space-instructions"
        value={instructions}
        maxLength={SPACE_INSTRUCTIONS_MAX}
        onChange={(e) => setInstructions(e.target.value)}
        rows={4}
        placeholder="e.g. Use British English. Ticket numbers look like ACME-123."
        style={inputStyle}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ ...helpStyle, flex: 1 }}>
          Appended to the system prompt of every regular chat in this space (Claude Code and Codex). {instructions.length}/{SPACE_INSTRUCTIONS_MAX}
        </span>
        <button
          style={buttonStyle}
          disabled={instructions === (space.instructions ?? "")}
          onClick={() => void onPatch(space.id, { instructions: instructions.trim() || null })}
        >
          Save instructions
        </button>
      </div>

      <h4 style={{ margin: "16px 0 6px", fontSize: 14 }}>New-chat defaults</h4>
      <div style={{ ...helpStyle, marginBottom: 8 }}>
        Remembered from the last chat started in this space, and editable here. Anything unset falls back to this browser’s own defaults.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        <div>
          <label style={labelStyle} htmlFor="space-provider">
            Engine
          </label>
          <select
            id="space-provider"
            value={defaults.provider ?? ""}
            onChange={(e) => void onPatch(space.id, { defaults: { provider: (e.target.value || null) as UiAgentProviderKind | null } })}
            style={inputStyle}
          >
            <option value="">(browser default)</option>
            {UI_AGENT_PROVIDER_KINDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle} htmlFor="space-model">
            Model
          </label>
          <input
            id="space-model"
            defaultValue={defaults.model ?? ""}
            onBlur={(e) => e.target.value !== (defaults.model ?? "") && void onPatch(space.id, { defaults: { model: e.target.value.trim() || null } })}
            placeholder="(browser default)"
            style={inputStyle}
          />
        </div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={defaults.worktreeByDefault === true}
          onChange={(e) => void onPatch(space.id, { defaults: { worktreeByDefault: e.target.checked } })}
        />
        New worktree by default
      </label>
      {defaults.defaultPermissions ? (
        <div style={{ marginBottom: 8 }}>
          <PermissionSettings
            title="Default permissions"
            permissions={defaults.defaultPermissions}
            onChange={(next) => void onPatch(space.id, { defaults: { defaultPermissions: next } })}
          />
          <button style={{ ...buttonStyle, marginTop: 6 }} onClick={() => void onPatch(space.id, { defaults: { defaultPermissions: null } })}>
            Use browser default permissions
          </button>
        </div>
      ) : (
        <div style={{ ...helpStyle, marginBottom: 8 }}>Permissions: browser default (set by starting a chat in this space).</div>
      )}
      {(defaults.recentDirectories?.length ?? 0) > 0 && (
        <div style={{ ...helpStyle, marginBottom: 8 }}>
          Recent folders: {defaults.recentDirectories!.map((d) => d.path).join(", ")}{" "}
          <button
            style={{ ...buttonStyle, padding: "2px 8px", fontSize: 11 }}
            onClick={() => void onPatch(space.id, { defaults: { recentDirectories: null } })}
          >
            Clear
          </button>
        </div>
      )}

      <h4 style={{ margin: "16px 0 6px", fontSize: 14 }}>What agents get</h4>
      <div style={{ ...helpStyle, marginBottom: 8 }}>
        Limit which plugins (and their MCP servers) and custom skills load in this space’s chats — e.g. keep a work Slack connection out of Personal.
      </div>
      <ScopeChecklist
        label="Plugins & MCP servers"
        restricted={pluginScope.restricted}
        onRestrict={pluginScope.toggleRestricted}
        items={plugins.map((p) => ({ id: p.id, label: p.manifest.name }))}
        has={pluginScope.has}
        onToggle={pluginScope.toggle}
      />
      <ScopeChecklist
        label="Custom skills"
        restricted={skillScope.restricted}
        onRestrict={skillScope.toggleRestricted}
        items={skills.map((s) => ({ id: s.name, label: s.name }))}
        has={skillScope.has}
        onToggle={skillScope.toggle}
      />
    </div>
  );
}

function ScopeChecklist({
  label,
  restricted,
  onRestrict,
  items,
  has,
  onToggle,
}: {
  label: string;
  restricted: boolean;
  onRestrict: (on: boolean) => void;
  items: { id: string; label: string }[];
  has: (id: string) => boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
        <input type="checkbox" checked={restricted} onChange={(e) => onRestrict(e.target.checked)} />
        Only selected {label.toLowerCase()}
      </label>
      {restricted &&
        (items.length === 0 ? (
          <div style={{ ...helpStyle, marginLeft: 24 }}>None installed.</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", margin: "6px 0 0 24px" }}>
            {items.map((item) => (
              <label key={item.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={has(item.id)} onChange={(e) => onToggle(item.id, e.target.checked)} />
                {item.label}
              </label>
            ))}
          </div>
        ))}
    </div>
  );
}

function DeleteSpaceDialog({
  space,
  spaces,
  onClose,
  onDeleted,
}: {
  space: SpaceListItem;
  spaces: SpaceListItem[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [moveTo, setMoveTo] = useState(DEFAULT_SPACE_ID);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    try {
      await deleteSpace(space.id, space.chatCount > 0 ? moveTo : undefined);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err, "Failed to delete space"));
    }
  };
  return (
    <ModalOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-label="Delete space"
        style={{ background: "var(--bg)", borderRadius: 8, padding: 20, width: "90%", maxWidth: 400, border: "1px solid var(--border)" }}
      >
        <h2 style={{ margin: "0 0 10px", fontSize: 17 }}>Delete “{space.name}”?</h2>
        {space.chatCount > 0 ? (
          <>
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              It holds {space.chatCount} chat{space.chatCount === 1 ? "" : "s"}. Move them to:
            </p>
            <select aria-label="Move chats to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={inputStyle}>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {spaceLabel(s)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>It holds no chats.</p>
        )}
        {error && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{ ...primaryButton, background: "var(--danger)", border: "1px solid var(--danger)", color: "var(--text-on-danger)" }}
            onClick={() => void run()}
          >
            Delete space
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

/**
 * The one-time "sort existing chats" sheet. General's trees grouped by the
 * repo their root ran in; each group can go to a space with one choice, and
 * optionally become a folder rule so future chats there follow.
 */
function SortChatsSheet({ spaces, onClose, onDone }: { spaces: SpaceListItem[]; onClose: () => void; onDone: () => void }) {
  const [groups, setGroups] = useState<SpaceFolderGroup[] | null>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSpaceFolderGroups(DEFAULT_SPACE_ID)
      .then(setGroups)
      .catch((err) => setError(errorMessage(err, "Failed to group chats")));
  }, []);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const rulesBySpace = new Map<string, string[]>();
      for (const group of groups ?? []) {
        const target = assign[group.displayFolder];
        if (!target || target === DEFAULT_SPACE_ID) continue;
        await moveToSpace(target, { folder: group.displayFolder, fromSpace: DEFAULT_SPACE_ID });
        if (remember[group.displayFolder]) rulesBySpace.set(target, [...(rulesBySpace.get(target) ?? []), group.displayFolder]);
      }
      for (const [spaceId, folders] of rulesBySpace) {
        const existing = spaces.find((s) => s.id === spaceId)?.folderRules ?? [];
        await updateSpace(spaceId, { folderRules: [...new Set([...existing, ...folders])] });
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Failed to sort chats"));
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-label="Sort existing chats"
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 20,
          width: "92%",
          maxWidth: 640,
          maxHeight: "80vh",
          overflowY: "auto",
          border: "1px solid var(--border)",
        }}
      >
        <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>Sort existing chats</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)" }}>
          Your chats are all in General. Send each project’s chats to a space in one go — anything you leave stays in General.
        </p>
        {groups === null && !error && <p style={{ fontSize: 13 }}>Loading…</p>}
        {groups?.length === 0 && <p style={{ fontSize: 13 }}>Nothing to sort.</p>}
        {groups?.map((group) => (
          <div
            key={group.displayFolder}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-light)" }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  direction: "rtl",
                  textAlign: "left",
                }}
              >
                {group.displayFolder}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {group.chatCount} chat{group.chatCount === 1 ? "" : "s"} · last active {new Date(group.lastActivityAt).toLocaleDateString()}
              </div>
            </div>
            <select
              aria-label={`Space for ${group.displayFolder}`}
              value={assign[group.displayFolder] ?? DEFAULT_SPACE_ID}
              onChange={(e) => setAssign((a) => ({ ...a, [group.displayFolder]: e.target.value }))}
              style={{ ...inputStyle, width: 150 }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {spaceLabel(s)}
                </option>
              ))}
            </select>
            <label
              title="Also send future chats in this folder here"
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}
            >
              <input
                type="checkbox"
                disabled={(assign[group.displayFolder] ?? DEFAULT_SPACE_ID) === DEFAULT_SPACE_ID}
                checked={!!remember[group.displayFolder]}
                onChange={(e) => setRemember((r) => ({ ...r, [group.displayFolder]: e.target.checked }))}
              />
              rule
            </label>
          </div>
        ))}
        {error && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={buttonStyle} onClick={onClose}>
            Later
          </button>
          <button style={primaryButton} disabled={busy || !Object.values(assign).some((v) => v !== DEFAULT_SPACE_ID)} onClick={() => void apply()}>
            {busy ? "Moving…" : "Move chats"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
