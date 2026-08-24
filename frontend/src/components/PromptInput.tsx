import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowUp, Paperclip, Edit, ImageIcon, Menu, Braces } from "lucide-react";
import ImageUpload, { ALLOWED_IMAGE_TYPES, validateImageFiles } from "./ImageUpload";
import SlashCommandAutocomplete from "./SlashCommandAutocomplete";
import KeywordAutocomplete from "./KeywordAutocomplete";
import SaveKeywordModal from "./SaveKeywordModal";
import CommandChip from "./CommandChip";
import MenuRow, { type MenuItem } from "./MenuRow";
import { findKeywordToken, matchKeywords, insertKeyword, insertTextAt } from "../utils/keywordTrigger";
import type { Keyword } from "../api";

export type PromptMenuItem = MenuItem;

/**
 * Fold a chip back into the prompt string the harness expects.
 *
 * The chip is presentation only — what leaves this component is byte-identical
 * to what the composer produced when the command was plain text, so nothing
 * downstream (queue, draft, session) learns that chips exist. Prose typed
 * alongside the chip becomes the command's arguments, which is what makes
 * `/model opus` still expressible.
 */
export function composePrompt(command: string | null, text: string): string {
  const trimmed = text.trim();
  if (!command) return trimmed;
  return trimmed ? `/${command} ${trimmed}` : `/${command}`;
}

/**
 * Inverse of {@link composePrompt}, for values handed in from outside (a draft
 * being reloaded, mostly). Only a leading token that is a *known* command
 * chips; anything else stays literal text, so raw `/whatever` keeps behaving
 * exactly as it did before chips existed.
 */
export function parseLeadingCommand(text: string, commands: string[]): { command: string | null; rest: string } {
  const match = /^\s*\/(\S+)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!match || !commands.includes(match[1])) return { command: null, rest: text };
  return { command: match[1], rest: match[2] ?? "" };
}

/** Drop the leading `/token` the autocomplete matched on, keeping the rest. */
export function stripLeadingCommandToken(text: string): string {
  const match = /^\s*\/\S*[ \t]?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

interface Props {
  onSend: (prompt: string, images?: File[]) => void;
  disabled: boolean;
  onSaveDraft?: (prompt: string, images?: File[], onSuccess?: () => void) => void;
  slashCommands?: string[];
  commandDescriptions?: Record<string, string>;
  onSetValue?: (setValue: (value: string) => void) => void;
  /** Chat the composer is attached to — the chip popover fetches against it. */
  chatId?: string;
  /**
   * Directory the composer's chat lives in. The chip popover falls back to it
   * when there is no chat yet: on `/chat/new` the id is undefined, and picking
   * a skill there is the single most common way a chip gets created.
   */
  folder?: string;
  /** Per-directory plugin ids the user has switched on, as the listing uses. */
  activePlugins?: string[];
  /**
   * Optional extra entries for the hamburger menu next to the Send button.
   * Used by Chat.tsx to mount the per-chat model/effort picker per the
   * design note: model selection should be toggle-able, not always-visible
   * in the message area. Save-as-draft is a built-in entry (when onSaveDraft
   * is provided); these render below it.
   */
  menuItems?: PromptMenuItem[];
  /**
   * Injectable keywords, fetched once by the page and handed down.
   *
   * A prop rather than a fetch in here: the composer is mounted on every chat
   * and on `/chat/new`, and the list is install-global, so fetching locally
   * would be one request per mount for data that never varies by chat.
   */
  keywords?: Keyword[];
  /**
   * Called with a keyword just created from the composer's "Save as keyword"
   * entry, so the caller can splice it into `keywords` and make it usable
   * immediately rather than on the next page load.
   */
  onKeywordCreated?: (keyword: Keyword) => void;
  /**
   * Registration callback handing out an insert-at-caret function, following
   * the same shape as {@link Props.onSetValue}.
   *
   * The slash-commands modal's Keywords tab inserts through this: it has no
   * `$token` to replace, only a caret. That path is also the mobile path —
   * typing `$` is a keyboard layer away on iOS — so it is not a nicety.
   */
  onInsertAtCaret?: (insert: (text: string) => void) => void;
}

export default function PromptInput({
  onSend,
  disabled,
  onSaveDraft,
  slashCommands = [],
  commandDescriptions,
  onSetValue,
  chatId,
  folder,
  activePlugins,
  menuItems = [],
  keywords = [],
  onKeywordCreated,
  onInsertAtCaret,
}: Props) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [focused, setFocused] = useState(false);
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The one command currently held as a chip. Picking a second replaces it.
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [chipPopoverOpen, setChipPopoverOpen] = useState(false);
  // A value handed in from outside that did not chip. Held because the command
  // list it was matched against may simply not have arrived yet — see below.
  const [unchippedValue, setUnchippedValue] = useState<string | null>(null);
  // Caret offset in the textarea, mirrored into state because the `$keyword`
  // menu is derived at render time and the DOM's selection is not reactive.
  const [caret, setCaret] = useState(0);
  /**
   * Start offset of a `$token` the user dismissed with Escape.
   *
   * Keyed on the offset rather than a bare boolean so the menu stays shut while
   * they keep typing *that* token, but a `$` typed anywhere else opens normally.
   */
  const [keywordDismissedAt, setKeywordDismissedAt] = useState<number | null>(null);
  /**
   * An explicitly chosen highlight, or null to mean "use the default".
   *
   * The default is the crux of the Enter-key behaviour: index 0 once a query
   * character has been typed, and *nothing* for a bare `$`. See
   * `keywordHighlight` below.
   */
  const [keywordHighlightOverride, setKeywordHighlightOverride] = useState<number | null>(null);
  const [saveKeywordBody, setSaveKeywordBody] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Caret to restore once React has committed a programmatic value change.
   *
   * Setting `value` re-renders the textarea and drops the caret at the end, so
   * insertion has to put it back *after* the commit — hence a ref plus the
   * dep-less effect below, rather than a `setSelectionRange` inline.
   */
  const pendingCaretRef = useRef<number | null>(null);
  /**
   * The current value, for callbacks that must stay referentially stable —
   * `insertAtCaret` is handed to the parent, and re-registering it on every
   * keystroke would push a re-render up the tree per character typed.
   *
   * Synced in an effect rather than assigned during render: a ref written
   * mid-render is a mutation the React compiler cannot reason about, and it
   * bails out of optimizing this whole component when it sees one. The lag is
   * immaterial here — `insertAtCaret` is only ever called from a modal the user
   * had to open first, which is many commits later.
   */
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  /**
   * Set the chip, and close any popover belonging to the chip being replaced.
   *
   * `chipPopoverOpen` is reported *by* the chip, so a chip that goes away while
   * its popover is open (replaced from an external setValue, unmounted on a
   * route change) never gets to report the close, and the stale `true` would
   * silently disable Backspace-deletes-chip for the rest of the session.
   */
  const changeActiveCommand = useCallback((next: string | null) => {
    setActiveCommand(next);
    setChipPopoverOpen(false);
  }, []);

  /**
   * The composer's value as the rest of the app sets it — a whole prompt
   * string, which may lead with a command. Splitting it here is what makes a
   * saved draft come back as the chip it was sent as, rather than as text.
   */
  const applyExternalValue = useCallback(
    (next: string) => {
      const { command, rest } = parseLeadingCommand(next, slashCommands);
      changeActiveCommand(command);
      setValue(rest);
      setAutocompleteDismissed(false);
      // Nothing matched — but `slashCommands` is fetched, and the app restores
      // a router draft on the render right after it hands out this setter, so
      // "no match" here usually means "the list is still in flight" rather than
      // "not a command". Keep the string so a later list can still chip it.
      setUnchippedValue(command ? null : next);
    },
    [slashCommands, changeActiveCommand],
  );

  /**
   * Second look at a value that arrived before the command list did.
   *
   * Only while the textarea still holds exactly what was put there: once the
   * user has typed, the string is theirs and re-chipping it under them would be
   * the composer editing their message.
   */
  useEffect(() => {
    if (unchippedValue === null || value !== unchippedValue) return;
    const { command, rest } = parseLeadingCommand(unchippedValue, slashCommands);
    if (!command) return;
    changeActiveCommand(command);
    setValue(rest);
    setUnchippedValue(null);
  }, [unchippedValue, value, slashCommands, changeActiveCommand]);

  useEffect(() => {
    if (onSetValue) {
      // Wrap in arrow function because setState interprets functions as updaters
      // When passing a function to setState, React calls it - so we return the function we want to store
      onSetValue(() => applyExternalValue);
    }
  }, [onSetValue, applyExternalValue]);

  const clearComposer = useCallback(() => {
    setValue("");
    setImages([]);
    setUnchippedValue(null);
    changeActiveCommand(null);
    setCaret(0);
    setKeywordDismissedAt(null);
    setKeywordHighlightOverride(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [changeActiveCommand]);

  const handleSend = useCallback(async () => {
    const prompt = composePrompt(activeCommand, value);
    if ((!prompt && images.length === 0) || disabled) return;

    // Send message with images
    onSend(prompt, images.length > 0 ? images : undefined);

    // Clear input and images
    clearComposer();
    setAutocompleteDismissed(false);
  }, [value, activeCommand, images, disabled, onSend, clearComposer]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showAutocomplete && e.key === "Escape") {
      e.preventDefault();
      setAutocompleteDismissed(true);
      return;
    }

    // ── Keyword menu ────────────────────────────────────────────────────
    // Only reachable when the slash autocomplete is closed — `keywordMenuOpen`
    // is false whenever `showAutocomplete` is true, so slash always wins.
    if (keywordMenuOpen && activeKeywordToken) {
      if (e.key === "Escape") {
        e.preventDefault();
        setKeywordDismissedAt(activeKeywordToken.start);
        setKeywordHighlightOverride(null);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        // From "nothing highlighted", ArrowDown lands on the first row and
        // ArrowUp on the last — and either way a highlight now exists, so the
        // next Enter inserts instead of dismissing.
        const from = keywordHighlight < 0 ? (step === 1 ? -1 : 0) : keywordHighlight;
        setKeywordHighlightOverride((from + step + keywordMatches.length) % keywordMatches.length);
        return;
      }
      if (e.key === "Tab") {
        // Tab is the primary insert key and has no competing meaning here, so
        // it completes the top match even when nothing is highlighted yet.
        e.preventDefault();
        selectKeyword(keywordMatches[keywordHighlight >= 0 ? keywordHighlight : 0]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (keywordHighlight >= 0) {
          selectKeyword(keywordMatches[keywordHighlight]);
        } else {
          // Nothing highlighted: dismiss, and deliberately do *not* send. Same
          // shape as the slash autocomplete's Enter — one keystroke closes the
          // menu, the next one sends.
          setKeywordDismissedAt(activeKeywordToken.start);
        }
        return;
      }
    }

    // Backspace at the very start of the prose deletes the chip, the way it
    // would delete the character that used to sit there.
    if (e.key === "Backspace" && activeCommand && !chipPopoverOpen) {
      const el = e.currentTarget as HTMLTextAreaElement;
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        changeActiveCommand(null);
        return;
      }
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
    const prompt = composePrompt(activeCommand, value);
    if (!onSaveDraft || !prompt || disabled) return;

    onSaveDraft(prompt, images.length > 0 ? images : undefined, clearComposer);
  }, [value, activeCommand, images, disabled, onSaveDraft, clearComposer]);

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

  /**
   * The `$name` token the caret is inside, or null.
   *
   * Suppressed outright while the slash-command autocomplete is up: slash wins,
   * and the two menus are never both on screen. (A composer whose value starts
   * with `/` is a command, and `$` inside its arguments can wait.)
   *
   * Derived plainly rather than through `useMemo`, like `showAutocomplete`
   * above: a backwards scan of one token and a filter over a short list are
   * cheaper than the bookkeeping, and hand-memoizing them made the React
   * compiler bail out of optimizing the whole component.
   */
  const rawKeywordToken = showAutocomplete || keywords.length === 0 ? null : findKeywordToken(value, caret);
  const activeKeywordToken = rawKeywordToken && rawKeywordToken.start !== keywordDismissedAt ? rawKeywordToken : null;

  const keywordMatches = activeKeywordToken ? matchKeywords(keywords, activeKeywordToken.query) : [];

  /**
   * Which row Enter and Tab act on, or -1 for none.
   *
   * A bare `$` highlights nothing on purpose. The failure this prevents is the
   * expensive one: a menu that pops up on a stray `$` and then swallows the
   * Enter the user meant as "send". With no highlight there is nothing to
   * insert, so Enter falls through to the same dismiss-without-sending branch
   * the slash autocomplete already uses — one keystroke lost, not a message
   * mangled. Typing a query character, or pressing an arrow, opts in.
   */
  const keywordHighlight = (() => {
    if (keywordMatches.length === 0) return -1;
    const fallback = activeKeywordToken?.query ? 0 : -1;
    const raw = keywordHighlightOverride ?? fallback;
    if (raw < 0) return -1;
    return Math.min(raw, keywordMatches.length - 1);
  })();

  const keywordMenuOpen = keywordMatches.length > 0;

  /** Track the caret so the menu can be derived from it. */
  const syncCaret = useCallback((el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? 0);
  }, []);

  /**
   * Commit a programmatic value change and park the caret after the new text.
   *
   * Shared by both insertion paths — the `$token` replacement and the modal's
   * insert-at-caret — because both have the same three obligations: keep focus
   * in the textarea, put the caret where the user's next keystroke belongs, and
   * re-run the autosize so the box grows to fit a multi-line snippet.
   */
  const commitInsertion = useCallback((next: string, nextCaret: number) => {
    setValue(next);
    setCaret(nextCaret);
    pendingCaretRef.current = nextCaret;
    setKeywordDismissedAt(null);
    setKeywordHighlightOverride(null);
    // Typed-or-inserted text is the user's; a late command list must not chip it.
    setUnchippedValue(null);
  }, []);

  // A plain function, not a `useCallback`: it closes over the token derived
  // this render and is only ever passed to the menu, which re-renders with it
  // anyway. Memoizing it bought nothing and cost the compiler its optimization.
  const selectKeyword = (keyword: Keyword) => {
    if (!activeKeywordToken) return;
    const { value: next, caret: nextCaret } = insertKeyword(value, activeKeywordToken, keyword.body);
    commitInsertion(next, nextCaret);
  };

  /**
   * Insert text wherever the caret is, replacing any selection.
   *
   * Referentially stable (reads `valueRef`), because it is handed to the parent
   * through `onInsertAtCaret` and re-registering it per keystroke would push a
   * re-render up the tree on every character typed.
   */
  const insertAtCaret = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      const current = valueRef.current;
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const { value: next, caret: nextCaret } = insertTextAt(current, start, end, text);
      commitInsertion(next, nextCaret);
    },
    [commitInsertion],
  );

  useEffect(() => {
    // Wrapped in an arrow for the same reason `onSetValue` is: the parent holds
    // this in a `useState`, which would otherwise call it as an updater.
    onInsertAtCaret?.(() => insertAtCaret);
  }, [onInsertAtCaret, insertAtCaret]);

  /**
   * Restore the caret after a programmatic value change lands in the DOM.
   *
   * No dependency array on purpose: this has to run after *whichever* render
   * commits the new value, and it costs one null check on the renders where
   * nothing is pending.
   */
  useEffect(() => {
    const target = pendingCaretRef.current;
    if (target === null) return;
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(target, target);
    handleInput();
  });

  const handleCommandSelect = useCallback(
    (command: string) => {
      // Only the token the autocomplete matched on leaves the textarea — anything
      // typed after it was the user's prose and stays theirs.
      changeActiveCommand(command);
      setUnchippedValue(null);
      setValue((prev) => stripLeadingCommandToken(prev));
      setAutocompleteDismissed(true);
      textareaRef.current?.focus();
    },
    [changeActiveCommand],
  );

  // A chip alone is sendable: /compact and /clear take no argument.
  const canSend = (value.trim() || activeCommand || images.length > 0) && !disabled;

  // "Save as keyword" is unconditional, so the menu always has at least one
  // entry — the other two sources only decide how full it is.
  const hasMenu = true;
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
        {/* The input "box" is this wrapper, not the textarea: the chip has to
            read as sitting inside the field alongside the prose, so the border,
            background and radius live out here and the textarea is transparent.
            It was already the positioning context for the drag overlay and the
            paperclip button, so nothing else had to move. */}
        <div
          className="composer-field"
          style={{
            flex: 1,
            position: "relative",
            background: "var(--surface)",
            border: `1px solid ${dragActive || focused ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 10,
            transition: "border-color 0.2s ease",
          }}
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

          {/* Renders nothing when no keyword matches — which is exactly what
              makes `$HOME`, `$PATH` and LaTeX `$$…$$` harmless in prose. */}
          <KeywordAutocomplete
            matches={keywordMatches}
            highlightedIndex={keywordHighlight}
            onHighlight={setKeywordHighlightOverride}
            onSelect={selectKeyword}
          />

          {activeCommand && (
            <div style={{ padding: "8px 40px 0 12px" }}>
              <CommandChip
                // Keyed on the command: the chip caches the body it fetched,
                // so replacing one command with another has to be a new chip
                // and not the old one wearing a new name.
                key={activeCommand}
                name={activeCommand}
                chatId={chatId}
                folder={folder}
                activePlugins={activePlugins}
                description={commandDescriptions?.[activeCommand]}
                onRemove={() => changeActiveCommand(null)}
                onOpenChange={setChipPopoverOpen}
              />
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="composer-textarea"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setAutocompleteDismissed(false);
              // Typed text is the user's; a late command list must not rewrite it.
              setUnchippedValue(null);
              syncCaret(e.target);
              // Typing re-derives the highlight from the query: an explicit
              // choice belongs to the match list it was made against, and that
              // list has just changed under it.
              setKeywordHighlightOverride(null);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(e) => syncCaret(e.currentTarget)}
            onSelect={(e) => syncCaret(e.currentTarget)}
            onClick={(e) => syncCaret(e.currentTarget)}
            onInput={handleInput}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={images.length > 0 ? "Add a message (optional)..." : "Send a message..."}
            disabled={disabled}
            rows={1}
            style={{
              display: "block",
              width: "100%",
              background: "transparent",
              border: "none",
              // No `outline: none` here, deliberately. The ring moves to the
              // wrapper (see `focused` above), but suppressing it inline would
              // outrank every rule in index.css and take the :focus-visible and
              // forced-colors fallbacks down with it. `.composer-textarea` owns
              // both halves of that trade-off in the stylesheet.
              padding: "10px 40px 10px 14px",
              fontSize: 15,
              resize: "none",
              maxHeight: 120,
              lineHeight: 1.4,
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
                color: "var(--accent-text)",
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
                      entries (e.g. the per-chat model/effort picker). */}
                  {onSaveDraft && (
                    <MenuRow
                      icon={<Edit size={16} />}
                      label="Save as draft"
                      title="Save as draft"
                      disabled={(!value.trim() && !activeCommand) || disabled}
                      onClick={() => {
                        setMenuOpen(false);
                        handleSaveDraft();
                      }}
                    />
                  )}
                  {/* Turn what is in the composer into a reusable `$keyword`.
                      Seeded from the selection when there is one, otherwise
                      from the whole composer — read off the DOM here because
                      the selection is not mirrored into state. */}
                  <MenuRow
                    icon={<Braces size={16} />}
                    label="Save as keyword"
                    title="Save the composer's text as a reusable $keyword"
                    disabled={!value.trim() || disabled}
                    onClick={() => {
                      setMenuOpen(false);
                      const el = textareaRef.current;
                      const start = el?.selectionStart ?? 0;
                      const end = el?.selectionEnd ?? 0;
                      setSaveKeywordBody(end > start ? value.slice(start, end) : value);
                    }}
                  />
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

      <SaveKeywordModal
        isOpen={saveKeywordBody !== null}
        initialBody={saveKeywordBody ?? ""}
        onClose={() => setSaveKeywordBody(null)}
        onSaved={(keyword) => {
          setSaveKeywordBody(null);
          onKeywordCreated?.(keyword);
        }}
      />
    </div>
  );
}
