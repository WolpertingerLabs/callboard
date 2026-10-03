// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCrudList, type CrudEditorState } from "./useCrudList";

interface Item {
  name: string;
}
interface Editor extends CrudEditorState {
  name: string;
}

function setup(items: Item[] = [{ name: "a" }, { name: "b" }]) {
  const api = {
    list: vi.fn(async () => items),
    save: vi.fn(async (_editor: Editor) => undefined),
    remove: vi.fn(async (_name: string) => undefined),
  };
  const hook = renderHook(() =>
    useCrudList<Item, Editor>({
      list: api.list,
      nameOf: (item) => item.name,
      save: api.save,
      remove: api.remove,
      confirmDeleteMessage: (name) => `Delete "${name}"?`,
    }),
  );
  return { api, hook };
}

afterEach(() => vi.restoreAllMocks());

describe("useCrudList", () => {
  it("loads once on mount", async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.items).toEqual([{ name: "a" }, { name: "b" }]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("saves, closes the editor, then re-lists", async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.openEditor({ originalName: null, name: "c" }));
    await act(() => hook.result.current.handleSave());
    expect(api.save).toHaveBeenCalledWith({ originalName: null, name: "c" });
    expect(hook.result.current.editor).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the editor open and shows the message when save fails", async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    api.save.mockRejectedValueOnce(new Error("name taken"));
    act(() => hook.result.current.openEditor({ originalName: "a", name: "b" }));
    await act(() => hook.result.current.handleSave());
    expect(hook.result.current.error).toBe("name taken");
    expect(hook.result.current.editor).toEqual({ originalName: "a", name: "b" });
    expect(hook.result.current.saving).toBe(false);
  });

  it("asks before deleting, and drops the item locally without re-listing", async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(() => hook.result.current.handleDelete("a"));
    expect(confirm).toHaveBeenLastCalledWith('Delete "a"?');
    expect(api.remove).not.toHaveBeenCalled();
    await act(() => hook.result.current.handleDelete("a"));
    expect(api.remove).toHaveBeenCalledWith("a");
    expect(hook.result.current.items).toEqual([{ name: "b" }]);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("re-lists after a failed delete", async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    api.remove.mockRejectedValueOnce(new Error("gone"));
    await act(() => hook.result.current.handleDelete("a"));
    expect(hook.result.current.error).toBe("gone");
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
});
