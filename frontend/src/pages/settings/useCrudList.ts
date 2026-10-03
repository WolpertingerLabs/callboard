import { useState, useEffect, useCallback } from "react";

/** The open editor: `originalName` is the item being edited, or null when creating a new one. */
export interface CrudEditorState {
  originalName: string | null;
}

/**
 * List + single-editor state for the settings pages that manage a flat list of
 * named items (Skills, Keywords): load on mount, open an editor, save then
 * re-list, confirm then delete.
 *
 * Errors surface as `error` (the thrown error's `message`) rather than
 * throwing. A failed delete re-lists, since the server may have removed the
 * item anyway; a successful one drops it locally without a round trip.
 */
export function useCrudList<Item, Editor extends CrudEditorState>({
  list,
  nameOf,
  save,
  remove,
  confirmDeleteMessage,
}: {
  /** Fetch the whole list. Must be referentially stable (a module function), or the list reloads every render. */
  list: () => Promise<Item[]>;
  nameOf: (item: Item) => string;
  /** Persist the editor — create when `originalName` is null, update otherwise. */
  save: (editor: Editor) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
  /** The `window.confirm` prompt shown before deleting `name`. */
  confirmDeleteMessage: (name: string) => string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return list()
      .then(setItems)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [list]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Open the editor on `initial`, clearing any previous error. */
  const openEditor = (initial: Editor) => {
    setError(null);
    setEditor(initial);
  };

  const closeEditor = () => {
    setEditor(null);
    setError(null);
  };

  const handleSave = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      await save(editor);
      setEditor(null);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.confirm(confirmDeleteMessage(name))) return;
    setError(null);
    try {
      await remove(name);
      setItems((prev) => prev.filter((item) => nameOf(item) !== name));
    } catch (err: any) {
      setError(err.message);
      refresh();
    }
  };

  return { items, loading, editor, setEditor, saving, error, setError, openEditor, closeEditor, handleSave, handleDelete };
}
