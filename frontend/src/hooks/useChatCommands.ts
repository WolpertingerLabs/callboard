import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMcpTools, getSlashCommandsAndPlugins, listKeywords } from "../api";
import type { AppPluginsData, Keyword, McpToolsResponse, Plugin } from "shared/types/index.js";
import { getActivePlugins } from "../utils/plugins";

/**
 * What the composer can insert for a chat: slash commands (the session's own,
 * per-directory plugins', enabled app plugins'), keywords, and the MCP tools
 * listed in the commands browser.
 *
 * The command sources are filled from whichever response has them first — the
 * chat record, the new-chat folder info, or the slash-commands route — so the
 * setters are returned for the page's load paths to call.
 *
 * @param agentChat whether this chat runs with the agent tool set; `null`
 *   while that isn't known yet (an existing chat whose record hasn't loaded),
 *   which keeps whatever tools are already listed rather than guessing.
 */
export function useChatCommands(id: string | undefined, agentChat: boolean | null) {
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [activePluginIds, setActivePluginIds] = useState<string[]>([]);
  const [appPluginsData, setAppPluginsData] = useState<AppPluginsData | null>(null);
  // Injectable keywords, fetched once per mount and handed to the composer.
  // Install-global (not per-chat, not per-folder), so nothing re-fetches them
  // when the chat or directory changes — only a save from the composer or a
  // pick from Settings can change the list, and the former pushes back through
  // `onKeywordCreated`.
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolsResponse | null>(null);
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false);

  // Fetch slash commands and plugins for the chat
  const loadSlashCommands = useCallback(async () => {
    if (!id) return;
    try {
      const { slashCommands, plugins, appPlugins } = await getSlashCommandsAndPlugins(id);
      setSlashCommands(slashCommands);
      setPlugins(plugins);
      if (appPlugins) setAppPluginsData(appPlugins);
    } catch (error) {
      console.warn("Failed to load slash commands and plugins:", error);
    }
  }, [id]);

  // Fetch injectable keywords once on mount. Install-global, so no `id` or
  // `folder` in the deps: navigating between chats does not change the list.
  useEffect(() => {
    listKeywords()
      .then(setKeywords)
      .catch((err) => console.warn("Failed to load keywords:", err));
  }, []);

  /** Splice a just-created keyword in so the autocomplete sees it immediately. */
  const handleKeywordCreated = useCallback((keyword: Keyword) => {
    setKeywords((prev) => [...prev.filter((k) => k.name !== keyword.name), keyword].sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  // MCP tools, fetched once per tool-set context. Agent sessions get a
  // different set (job tools move to the agent server), and the page is not
  // remounted between chats, so the list is keyed on the context it was
  // fetched for: switching between an agent chat and an ordinary one refetches,
  // and moving between two of the same kind costs nothing.
  const mcpToolsKeyRef = useRef<boolean | null>(null);
  const mcpToolsSeqRef = useRef(0);
  useEffect(() => {
    if (agentChat === null || agentChat === mcpToolsKeyRef.current) return;
    mcpToolsKeyRef.current = agentChat;
    const seq = ++mcpToolsSeqRef.current;
    const latest = () => seq === mcpToolsSeqRef.current;
    setMcpToolsLoading(true);
    getMcpTools(agentChat ? "agent" : undefined)
      .then((tools) => {
        if (latest()) setMcpTools(tools);
      })
      .catch((err) => {
        console.warn("Failed to load MCP tools:", err);
        // Whatever is listed belongs to the other context.
        if (latest()) setMcpTools(null);
      })
      .finally(() => {
        if (latest()) setMcpToolsLoading(false);
      });
  }, [agentChat]);

  // Load active plugins from localStorage and listen for changes
  useEffect(() => {
    const loadActive = () => setActivePluginIds(Array.from(getActivePlugins()));

    loadActive();

    // Listen for storage changes (when SlashCommandsModal updates activePlugins)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "activePlugins") loadActive();
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Combine base slash commands with active plugin commands for autocomplete
  const { allSlashCommands, pluginCommandDescriptions } = useMemo(() => {
    const allCmds = [...slashCommands];
    const descriptions: Record<string, string> = {};

    // Add commands from active per-directory plugins
    for (const plugin of plugins) {
      if (activePluginIds.includes(plugin.id)) {
        for (const cmd of plugin.commands) {
          const fullName = `${plugin.manifest.name}:${cmd.name}`;
          allCmds.push(fullName);
          if (cmd.description) {
            descriptions[fullName] = cmd.description;
          }
        }
      }
    }

    // Add commands from enabled app-wide plugins
    if (appPluginsData) {
      for (const plugin of appPluginsData.plugins) {
        if (plugin.enabled) {
          for (const cmd of plugin.commands) {
            const fullName = `${plugin.manifest.name}:${cmd.name}`;
            allCmds.push(fullName);
            if (cmd.description) {
              descriptions[fullName] = cmd.description;
            }
          }
        }
      }
    }

    // De-duplicate commands that may appear in multiple sources
    const uniqueCmds = Array.from(new Set(allCmds));
    return { allSlashCommands: uniqueCmds, pluginCommandDescriptions: descriptions };
  }, [slashCommands, plugins, activePluginIds, appPluginsData]);

  return {
    slashCommands,
    setSlashCommands,
    plugins,
    setPlugins,
    activePluginIds,
    setActivePluginIds,
    appPluginsData,
    setAppPluginsData,
    loadSlashCommands,
    allSlashCommands,
    pluginCommandDescriptions,
    keywords,
    handleKeywordCreated,
    mcpTools,
    // A context still unknown with nothing listed yet is a fetch about to start.
    mcpToolsLoading: mcpToolsLoading || (agentChat === null && !mcpTools),
  };
}
