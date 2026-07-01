import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowUp, Paperclip, Edit, ImageIcon, Menu } from "lucide-react";
import ImageUpload, { ALLOWED_IMAGE_TYPES, validateImageFiles } from "./ImageUpload";
import SlashCommandAutocomplete from "./SlashCommandAutocomplete";

export interface PromptMenuItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Accent styling — e.g. a pending model/effort change awaiting the next message. */
  active?: boolean;
  title?: string;
}

interface Props {
  onSend: (prompt: string, images?: File[]) => void;
  disabled: boolean;
  onSaveDraft?: (prompt: string, images?: File[], onSuccess?: () => void) => void;
  slashCommands?: string[];
  commandDescriptions?: Record<string, string>;
  onSetValue?: (setValue: (value: string) => void) => void;
  /**
   * Optional extra entries for the hamburger menu next to the Send button.
   * Used by Chat.tsx to mount the OpenRouter model/effort picker per the
   * design note: model selection should be toggle-able, not always-visible
   * in the message area. Save-as-draft is a built-in entry (when onSaveDraft
   * is provided); these render below it.
   */
  menuItems?: PromptMenuItem[];
}

function MenuRow({ icon, label, onClick, disabled, active, title }: Omit<PromptMenuItem, "key">) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 44,
        padding: "10px 12px",
        borderRadius: 8,
        border: "none",
        background: active ? "var(--accent)" : "transparent",
        color: disabled ? "var(--text-muted)" : active ? "var(--text-on-accent)" : "var(--text)",
        fontSize: 14,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background 0.15s ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled && !active) {
          e.currentTarget.style.background = "var(--bg-secondary)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export default function PromptInput({ onSend, disabled, onSaveDraft, slashCommands = [], commandDescriptions, onSetValue, menuItems = [] }: Props) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (onSetValue) {
      // Wrap in arrow function because setState interprets functions as updaters
      // When passing a function to setState, React calls it - so we return the function we want to store
      onSetValue(() => setValue);
    }
  }, [onSetValue]);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if ((!trimmed && images.length === 0) || disabled) return;

    // Send message with images
    onSend(trimmed, images.length > 0 ? images : undefined);

    // Clear input and images
    setValue("");
    setImages([]);
    setAutocompleteDismissed(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, images, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showAutocomplete && e.key === "Escape") {
      e.preventDefault();
      setAutocompleteDismissed(true);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (showAutocomplete) {
        setAutocompleteDismissed(true);
      } else {
        handleSend();
      }
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
  };

  const handleSaveDraft = useCallback(() => {
    if (!onSaveDraft || !value.trim() || disabled) return;

    const clearInput = () => {
      setValue("");
      setImages([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    };

    onSaveDraft(value.trim(), images.length > 0 ? images : undefined, clearInput);
  }, [value, images, disabled, onSaveDraft]);

  // Drag-and-drop handlers for the textarea area
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);

      if (disabled) return;

      const files = e.dataTransfer.files;
      if (files) {
        const validFiles = validateImageFiles(files);
        if (validFiles.length > 0) {
          setImages((prev) => [...prev, ...validFiles]);
        }
      }
    },
    [disabled],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) {
        setDragActive(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only hide drag state if leaving the component entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragActive(false);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const validFiles = validateImageFiles(e.target.files);
      if (validFiles.length > 0) {
        setImages((prev) => [...prev, ...validFiles]);
      }
    }
    // Reset input so re-selecting the same file works
    e.target.value = "";
  }, []);

  const openFilePicker = useCallback(() => {
    if (!disabled) {
      fileInputRef.current?.click();
    }
  }, [disabled]);

  // Derive autocomplete visibility from value (no effect needed)
  const showAutocomplete = !autocompleteDismissed && value.trim().startsWith("/") && slashCommands.length > 0;

  const handleCommandSelect = useCallback((command: string) => {
    setValue("/" + command + " ");
    setAutocompleteDismissed(true);
    textareaRef.current?.focus();
  }, []);

  const canSend = (value.trim() || images.length > 0) && !disabled;

  const hasMenu = Boolean(onSaveDraft) || menuItems.length > 0;
  const menuHasActiveItem = menuItems.some((item) => item.active);

  // Close the menu on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        textareaRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div
      style={{
        padding: "8px 12px",
        paddingBottom: "calc(8px + var(--safe-bottom))",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-sidebar)",
        flexShrink: 0,
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_TYPES.join(",")}
        multiple
        onChange={handleFileInput}
        style={{ display: "none" }}
        disabled={disabled}
      />

      {/* Image previews */}
      <ImageUpload images={images} onImagesChange={setImages} />

      {/* Message input area */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <div
          style={{ flex: 1, position: "relative" }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
        >
          <SlashCommandAutocomplete
            slashCommands={slashCommands}
            query={value}
            onSelect={handleCommandSelect}
            visible={showAutocomplete}
            commandDescriptions={commandDescriptions}
          />

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setAutocompleteDismissed(false);
            }}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={images.length > 0 ? "Add a message (optional)..." : "Send a message..."}
            disabled={disabled}
            rows={1}
            style={{
              width: "100%",
              background: "var(--surface)",
              border: `1px solid ${dragActive ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 10,
              padding: "10px 40px 10px 14px",
              fontSize: 15,
              resize: "none",
              maxHeight: 120,
              lineHeight: 1.4,
              transition: "border-color 0.2s ease",
            }}
          />

          {/* Drag overlay */}
          {dragActive && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 10,
                background: "var(--accent-bg)",
                border: "2px dashed var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                color: "var(--accent)",
                fontSize: 14,
                fontWeight: 500,
                pointerEvents: "none",
                zIndex: 5,
              }}
            >
              <ImageIcon size={16} />
              Drop images here
            </div>
          )}

          {/* Image attachment button */}
          <button
            onClick={openFilePicker}
            disabled={disabled}
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              width: 24,
              height: 24,
              borderRadius: 6,
              background: images.length > 0 ? "var(--accent)" : "var(--border)",
              color: images.length > 0 ? "var(--text-on-accent)" : "var(--text-muted)",
              border: "none",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.5 : 1,
              transition: "all 0.2s ease",
              zIndex: 6,
            }}
            title="Upload images"
          >
            <Paperclip size={14} />
          </button>
        </div>

        {/* Hamburger menu — consolidates save-draft and caller-supplied
            actions (e.g. model/effort picker on OR chats) into a single
            button whose menu expands upward above the composer. */}
        {hasMenu && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            {menuOpen && (
              <>
                {/* Click-away overlay */}
                <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
                <div
                  style={{
                    position: "absolute",
                    bottom: "calc(100% + 8px)",
                    right: 0,
                    minWidth: 220,
                    zIndex: 51,
                    padding: 4,
                    borderRadius: 10,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-md)",
                  }}
                >
                  {/* Built-in save-draft entry, followed by caller-supplied
                      entries (e.g. the OpenRouter model/effort picker). */}
                  {onSaveDraft && (
                    <MenuRow
                      icon={<Edit size={16} />}
                      label="Save as draft"
                      title="Save as draft"
                      disabled={!value.trim() || disabled}
                      onClick={() => {
                        setMenuOpen(false);
                        handleSaveDraft();
                      }}
                    />
                  )}
                  {menuItems.map((item) => (
                    <MenuRow
                      key={item.key}
                      icon={item.icon}
                      label={item.label}
                      title={item.title}
                      disabled={item.disabled}
                      active={item.active}
                      onClick={() => {
                        setMenuOpen(false);
                        item.onClick();
                      }}
                    />
                  ))}
                </div>
              </>
            )}
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="More actions"
              style={{
                background: menuOpen ? "var(--border)" : "var(--bg-secondary)",
                color: "var(--text)",
                width: 40,
                height: 40,
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                flexShrink: 0,
                border: "1px solid var(--border)",
                cursor: "pointer",
                transition: "all 0.2s ease",
                position: "relative",
              }}
            >
              <Menu size={16} />
              {/* Pending-change badge (e.g. model/effort change awaiting next message) */}
              {menuHasActiveItem && (
                <span
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    border: "2px solid var(--bg)",
                  }}
                />
              )}
            </button>
          </div>
        )}

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            background: !canSend ? "var(--border)" : "var(--accent)",
            color: "var(--text-on-accent)",
            width: 40,
            height: 40,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            flexShrink: 0,
            border: "none",
            cursor: !canSend ? "default" : "pointer",
            transition: "background 0.2s ease",
          }}
        >
          <ArrowUp size={18} />
        </button>
      </div>

      {/* Image count indicator */}
      {images.length > 0 && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 4,
            textAlign: "center" as const,
          }}
        >
          {images.length} image{images.length === 1 ? "" : "s"} selected
        </div>
      )}
    </div>
  );
}
