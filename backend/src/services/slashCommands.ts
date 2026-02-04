import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const SLASH_COMMANDS_FILE = join(DATA_DIR, 'slash-commands.json');

interface SlashCommandsData {
  [directory: string]: string[];
}

/**
 * Ensure the data directory exists
 */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load slash commands data from JSON file
 */
function loadSlashCommandsData(): SlashCommandsData {
  ensureDataDir();

  if (!existsSync(SLASH_COMMANDS_FILE)) {
    return {};
  }

  try {
    const data = readFileSync(SLASH_COMMANDS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.warn('Failed to load slash commands data:', error);
    return {};
  }
}

/**
 * Save slash commands data to JSON file
 */
function saveSlashCommandsData(data: SlashCommandsData): void {
  ensureDataDir();

  try {
    writeFileSync(SLASH_COMMANDS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to save slash commands data:', error);
    throw error;
  }
}

/**
 * Get slash commands for a specific directory
 */
export function getSlashCommandsForDirectory(directory: string): string[] {
  const data = loadSlashCommandsData();
  return data[directory] || [];
}

/**
 * Set slash commands for a specific directory
 */
export function setSlashCommandsForDirectory(directory: string, commands: string[]): void {
  const data = loadSlashCommandsData();
  data[directory] = commands;
  saveSlashCommandsData(data);
}

/**
 * Get all directories that have slash commands
 */
export function getAllDirectoriesWithSlashCommands(): string[] {
  const data = loadSlashCommandsData();
  return Object.keys(data);
}

/**
 * Remove slash commands for a directory
 */
export function removeSlashCommandsForDirectory(directory: string): void {
  const data = loadSlashCommandsData();
  delete data[directory];
  saveSlashCommandsData(data);
}