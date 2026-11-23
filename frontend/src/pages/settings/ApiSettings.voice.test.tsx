// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import ApiSettings from "./ApiSettings";

/**
 * Settings → API → OpenRouter → Voice input: the model picker.
 *
 * It needs the account-wide key to mean anything (voice bills that key), so it
 * is disabled without one; it groups dedicated speech-to-text models apart
 * from audio-capable chat models; and Save carries the choice.
 */

const h = vi.hoisted(() => ({
  updateAgentSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  getVoiceModels: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getAgentSettings: async () => h.settings,
    updateAgentSettings: h.updateAgentSettings,
    getSystemInfo: async () => ({ models: [] }),
    getOpenRouterCatalog: async () => ({ models: [], aliases: [] }),
    getVoiceModels: h.getVoiceModels,
    getPiProviders: async () => ({ providers: [] }),
    getEngines: async () => [],
    refreshEngines: async () => ({ engines: [], probed: true }),
  };
});

vi.mock("../../utils/localStorage", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDefaultProvider: () => "openrouter" };
});

const MODELS = {
  models: [
    { id: "openai/whisper-large-v3-turbo", name: "OpenAI: Whisper Large V3 Turbo", kind: "transcription" },
    { id: "openai/gpt-4o-mini-transcribe", name: "OpenAI: GPT-4o mini Transcribe", kind: "transcription" },
    { id: "google/gemini-3.5-flash", name: "Google: Gemini 3.5 Flash", kind: "chat" },
  ],
  defaultModel: "openai/whisper-large-v3-turbo",
};

async function renderPicker(settings: Record<string, unknown>): Promise<HTMLSelectElement> {
  h.settings = settings;
  render(<ApiSettings />);
  const select = (await screen.findByLabelText(/^Voice model/)) as HTMLSelectElement;
  return select;
}

beforeEach(() => {
  h.updateAgentSettings.mockClear();
  h.getVoiceModels.mockReset();
  h.getVoiceModels.mockResolvedValue(MODELS);
});

afterEach(cleanup);

describe("Settings → API → Voice input", () => {
  it("is disabled, with a hint, until an OpenRouter key is entered", async () => {
    const select = await renderPicker({});
    expect(select.disabled).toBe(true);
    expect(screen.getByText(/Add an API key above to enable voice input/)).toBeTruthy();

    fireEvent.change(document.getElementById("openRouterApiKey") as HTMLInputElement, { target: { value: "sk-or-test" } });
    expect(select.disabled).toBe(false);
    expect(screen.queryByText(/Add an API key above to enable voice input/)).toBeNull();
  });

  it("offers the default first, then speech-to-text and chat models in separate groups", async () => {
    const select = await renderPicker({ openRouterApiKey: "sk-or-test" });
    await waitFor(() => expect(select.querySelectorAll("optgroup")).toHaveLength(2));

    expect(select.options[0].value).toBe("");
    expect(select.options[0].textContent).toBe("Default (openai/whisper-large-v3-turbo)");

    const [stt, chat] = Array.from(select.querySelectorAll("optgroup"));
    expect(stt.label).toBe("Speech-to-text");
    expect(
      within(stt as HTMLElement)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["openai/whisper-large-v3-turbo", "openai/gpt-4o-mini-transcribe"]);
    expect(chat.label).toBe("Audio-capable chat models");
    expect(
      within(chat as HTMLElement)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["google/gemini-3.5-flash"]);
  });

  it("keeps a stored slug the list does not know, as a custom option", async () => {
    const select = await renderPicker({ openRouterApiKey: "sk-or-test", openRouterVoiceModel: "someone/custom-stt" });
    await waitFor(() => expect(select.value).toBe("someone/custom-stt"));
    expect(Array.from(select.options).find((o) => o.value === "someone/custom-stt")?.textContent).toMatch(/custom/);
  });

  it("still renders the default option when the list cannot be fetched", async () => {
    h.getVoiceModels.mockRejectedValue(new Error("offline"));
    const select = await renderPicker({ openRouterApiKey: "sk-or-test" });
    expect(select.options[0].value).toBe("");
    expect(select.querySelectorAll("optgroup")).toHaveLength(0);
  });

  it("sends the chosen model on Save", async () => {
    const select = await renderPicker({ openRouterApiKey: "sk-or-test" });
    await waitFor(() => expect(select.querySelectorAll("optgroup")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "google/gemini-3.5-flash" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledTimes(1));
    expect(h.updateAgentSettings.mock.calls[0][0]).toMatchObject({ openRouterVoiceModel: "google/gemini-3.5-flash" });
  });
});
