import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface PluginSkill {
  name: string;
  description?: string;
  // Skills can have additional metadata we may want to track
}

export interface PluginAgent {
  name: string;
  description?: string;
  // Agents can have additional configuration we may want to track
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  skills?: PluginSkill[];
  agents?: PluginAgent[];
  // Additional fields from plugin.json that we might need
  [key: string]: any;
}

export interface Plugin {
  id: string; // unique identifier derived from directory path
  path: string; // path to .claude-plugin directory
  manifest: PluginManifest;
  skills: PluginSkill[];
  agents: PluginAgent[];
}

/**
 * Discover all plugins in the given directory and its subdirectories
 */
export function discoverPlugins(directory: string): Plugin[] {
  const plugins: Plugin[] = [];

  function searchDirectory(dir: string): void {
    if (!existsSync(dir)) return;

    try {
      const items = readdirSync(dir);

      for (const item of items) {
        const fullPath = join(dir, item);

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            // Check if this is a .claude-plugin directory
            if (item === '.claude-plugin') {
              const plugin = parsePlugin(fullPath);
              if (plugin) {
                plugins.push(plugin);
              }
            } else {
              // Recursively search subdirectories
              searchDirectory(fullPath);
            }
          }
        } catch (error) {
          // Skip items we can't stat (permissions, etc.)
          continue;
        }
      }
    } catch (error) {
      // Skip directories we can't read
      return;
    }
  }

  searchDirectory(directory);
  return plugins;
}

/**
 * Parse a plugin from a .claude-plugin directory
 */
function parsePlugin(pluginDir: string): Plugin | null {
  const manifestPath = join(pluginDir, 'plugin.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifestData = readFileSync(manifestPath, 'utf-8');
    const manifest: PluginManifest = JSON.parse(manifestData);

    // Validate required fields
    if (!manifest.name || !manifest.version || !manifest.description) {
      console.warn(`Invalid plugin manifest at ${manifestPath}: missing required fields`);
      return null;
    }

    // Create unique ID from path
    const pluginId = pluginDir.replace(/[\/\\]/g, '_').replace(/^_+|_+$/g, '');

    // Extract skills
    const skills = extractSkills(pluginDir, manifest.skills || []);

    // Extract agents
    const agents = extractAgents(pluginDir, manifest.agents || []);

    return {
      id: pluginId,
      path: pluginDir,
      manifest,
      skills,
      agents
    };
  } catch (error) {
    console.warn(`Failed to parse plugin at ${manifestPath}:`, error);
    return null;
  }
}

/**
 * Extract skills from the plugin directory
 */
function extractSkills(pluginDir: string, manifestSkills: PluginSkill[]): PluginSkill[] {
  const skillsDir = join(pluginDir, 'skills');
  const skills: PluginSkill[] = [...manifestSkills];

  if (existsSync(skillsDir)) {
    try {
      const skillFiles = readdirSync(skillsDir);

      for (const skillFile of skillFiles) {
        if (skillFile.endsWith('.md')) {
          const skillName = skillFile.replace('.md', '');

          // Only add if not already in manifest
          if (!skills.some(s => s.name === skillName)) {
            skills.push({
              name: skillName,
              description: `Skill from ${skillFile}`
            });
          }
        }
      }
    } catch (error) {
      // Skip if we can't read skills directory
    }
  }

  return skills;
}

/**
 * Extract agents from the plugin directory
 */
function extractAgents(pluginDir: string, manifestAgents: PluginAgent[]): PluginAgent[] {
  const agentsDir = join(pluginDir, 'agents');
  const agents: PluginAgent[] = [...manifestAgents];

  if (existsSync(agentsDir)) {
    try {
      const agentFiles = readdirSync(agentsDir);

      for (const agentFile of agentFiles) {
        if (agentFile.endsWith('.md')) {
          const agentName = agentFile.replace('.md', '');

          // Only add if not already in manifest
          if (!agents.some(a => a.name === agentName)) {
            agents.push({
              name: agentName,
              description: `Agent from ${agentFile}`
            });
          }
        }
      }
    } catch (error) {
      // Skip if we can't read agents directory
    }
  }

  return agents;
}

/**
 * Get plugins for a specific directory (looks in current directory only)
 */
export function getPluginsForDirectory(directory: string): Plugin[] {
  return discoverPlugins(directory);
}

/**
 * Convert plugin skills and agents to slash command format
 */
export function pluginToSlashCommands(plugin: Plugin): string[] {
  const commands: string[] = [];

  // Add skills with plugin namespace
  for (const skill of plugin.skills) {
    commands.push(`${plugin.manifest.name}:${skill.name}`);
  }

  // Add agents with plugin namespace
  for (const agent of plugin.agents) {
    commands.push(`${plugin.manifest.name}:${agent.name}`);
  }

  return commands;
}