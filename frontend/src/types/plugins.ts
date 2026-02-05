export interface PluginSkill {
  name: string;
  description?: string;
}

export interface PluginAgent {
  name: string;
  description?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  skills?: PluginSkill[];
  agents?: PluginAgent[];
  [key: string]: any;
}

export interface Plugin {
  id: string;
  path: string;
  manifest: PluginManifest;
  skills: PluginSkill[];
  agents: PluginAgent[];
}