// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import ApiSettings from "./ApiSettings";

/**
 * Settings → API → OpenRouter → Read aloud: the model and voice pickers.
 *
 * Both need the account-wide key (read aloud bills it), so both are disabled
 * without one. Voices are model-specific: the voice picker follows the chosen
 * model, resets when the model changes, and becomes a free-text field for a
 * model whose voices OpenRouter lists as unknown. PCM-only models are shown
 * but cannot be chosen. Save carries both.
 */

const h = vi.hoisted(() => ({
  updateAgentSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  getReadAloudModels: vi.fn(),
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
    getVoiceModels: async () => ({ models: [], defaultModel: "openai/whisper-large-v3-turbo" }),
    getReadAloudModels: h.getReadAloudModels,
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
    {
      id: "deepgram/aura-2",
      name: "Aura 2",
      voices: ["asteria", "luna"],
      defaultVoice: "asteria",
      formats: ["mp3", "pcm"],
      mp3: true,
      pricePerMillionChars: 30,
    },
    { id: "fish-audio/s1", name: "S1", voices: null, defaultVoice: null, formats: ["mp3", "pcm"], mp3: true, pricePerMillionChars: 15 },
    { id: "google/gemini-3.8-flash-tts", name: "Gemini TTS", voices: ["Kore"], defaultVoice: "Kore", formats: ["pcm"], mp3: false },
    {
      id: "hexgrad/kokoro-82m",
      name: "Kokoro 82M",
      voices: ["af_alloy", "af_heart", "bf_emma"],
      defaultVoice: "af_heart",
      formats: ["mp3", "pcm"],
      mp3: true,
      pricePerMillionChars: 0.99,
    },
  ],
  defaultModel: "hexgrad/kokoro-82m",
  defaultVoice: "af_heart",
};

const modelSelect = () => screen.getByLabelText(/^Read-aloud model/) as HTMLSelectElement;
const voiceField = () => screen.getByLabelText(/^Read-aloud voice/) as HTMLSelectElement | HTMLInputElement;
const values = (el: Element) =>
  within(el as HTMLElement)
    .getAllByRole("option")
    .map((o) => (o as HTMLOptionElement).value);

async function renderPickers(settings: Record<string, unknown>, opts: { loaded?: boolean } = {}): Promise<void> {
  h.settings = settings;
  render(<ApiSettings />);
  await screen.findByLabelText(/^Read-aloud model/);
  if (opts.loaded !== false) await waitFor(() => expect(modelSelect().querySelectorAll("optgroup").length).toBeGreaterThan(0));
}

beforeEach(() => {
  h.updateAgentSettings.mockClear();
  h.getReadAloudModels.mockReset();
  h.getReadAloudModels.mockResolvedValue(MODELS);
});

afterEach(cleanup);

describe("Settings → API → Read aloud", () => {
  it("disables both pickers, with a hint, until an OpenRouter key is entered", async () => {
    await renderPickers({});
    expect(modelSelect().disabled).toBe(true);
    expect(voiceField().disabled).toBe(true);
    expect(screen.getByText(/Add an API key above to enable read aloud/)).toBeTruthy();

    fireEvent.change(document.getElementById("openRouterApiKey") as HTMLInputElement, { target: { value: "sk-or-test" } });
    expect(modelSelect().disabled).toBe(false);
    expect(voiceField().disabled).toBe(false);
    expect(screen.queryByText(/Add an API key above to enable read aloud/)).toBeNull();
  });

  it("offers the default first, mp3 models with their price, and PCM-only models disabled", async () => {
    await renderPickers({ openRouterApiKey: "sk-or-test" });
    const select = modelSelect();
    expect(select.options[0].value).toBe("");
    expect(select.options[0].textContent).toBe("Default (hexgrad/kokoro-82m)");

    const [mp3, pcm] = Array.from(select.querySelectorAll("optgroup"));
    expect(values(mp3)).toEqual(["deepgram/aura-2", "fish-audio/s1", "hexgrad/kokoro-82m"]);
    expect(within(mp3 as HTMLElement).getByRole("option", { name: /kokoro/ }).textContent).toBe("hexgrad/kokoro-82m — $0.99/M chars");
    expect(pcm.label).toBe("PCM output only — not supported yet");
    expect(values(pcm)).toEqual(["google/gemini-3.8-flash-tts"]);
    expect((within(pcm as HTMLElement).getByRole("option") as HTMLOptionElement).disabled).toBe(true);
  });

  it("lists the default model's voices, with the default voice named", async () => {
    await renderPickers({ openRouterApiKey: "sk-or-test" });
    const voice = voiceField() as HTMLSelectElement;
    expect(voice.tagName).toBe("SELECT");
    expect(voice.options[0].textContent).toBe("Default (af_heart)");
    expect(values(voice)).toEqual(["", "af_alloy", "af_heart", "bf_emma"]);
  });

  it("follows the chosen model, and resets the voice when the model changes", async () => {
    await renderPickers({ openRouterApiKey: "sk-or-test" });
    fireEvent.change(voiceField(), { target: { value: "bf_emma" } });
    expect(voiceField().value).toBe("bf_emma");

    fireEvent.change(modelSelect(), { target: { value: "deepgram/aura-2" } });
    const voice = voiceField() as HTMLSelectElement;
    expect(voice.value).toBe("");
    expect(voice.options[0].textContent).toBe("Default (asteria)");
    expect(values(voice)).toEqual(["", "asteria", "luna"]);
  });

  it("is a free-text field for a model whose voices are unknown", async () => {
    await renderPickers({ openRouterApiKey: "sk-or-test", openRouterTtsModel: "fish-audio/s1" });
    const voice = voiceField();
    expect(voice.tagName).toBe("INPUT");
    expect((voice as HTMLInputElement).placeholder).toMatch(/provider-specific/);
    fireEvent.change(voice, { target: { value: "my-cloned-voice" } });
    expect(voiceField().value).toBe("my-cloned-voice");
  });

  it("keeps a stored model or voice the list does not know, as a custom option", async () => {
    await renderPickers({ openRouterApiKey: "sk-or-test", openRouterTtsVoice: "zz_unlisted" });
    expect(voiceField().value).toBe("zz_unlisted");
    expect(Array.from((voiceField() as HTMLSelectElement).options).find((o) => o.value === "zz_unlisted")?.textContent).toMatch(/custom/);
    cleanup();

    await renderPickers({ openRouterApiKey: "sk-or-test", openRouterTtsModel: "someone/custom-tts" });
    expect(modelSelect().value).toBe("someone/custom-tts");
    expect(Array.from(modelSelect().options).find((o) => o.value === "someone/custom-tts")?.textContent).toMatch(/custom/);
  });

  it("still renders the defaults when the list cannot be fetched", async () => {
    h.getReadAloudModels.mockRejectedValue(new Error("offline"));
    await renderPickers({ openRouterApiKey: "sk-or-test" }, { loaded: false });
    expect(modelSelect().options[0].textContent).toBe("Default (hexgrad/kokoro-82m)");
    expect((voiceField() as HTMLSelectElement).options[0].textContent).toBe("Default (af_heart)");
  });

  it("sends the chosen model and voice on Save", async () => {
    await renderPickers({ openRouterApiKey: "sk-or-test" });
    fireEvent.change(modelSelect(), { target: { value: "deepgram/aura-2" } });
    fireEvent.change(voiceField(), { target: { value: "luna" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(h.updateAgentSettings).toHaveBeenCalledTimes(1));
    expect(h.updateAgentSettings.mock.calls[0][0]).toMatchObject({ openRouterTtsModel: "deepgram/aura-2", openRouterTtsVoice: "luna" });
  });
});
