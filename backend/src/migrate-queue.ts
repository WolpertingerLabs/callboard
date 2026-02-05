#!/usr/bin/env node

import db from './db.js';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const queueDir = join(__dirname, '..', 'data', 'queue');

interface QueueItem {
  id: string;
  chat_id: string;
  user_message: string;
  scheduled_time: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  retry_count: number;
  error_message: string | null;
}

async function migrateQueueToFiles() {
  console.log('Starting queue migration from database to JSON files...');

  try {
    // Get all pending and running queue items from database
    const queueItems: QueueItem[] = db.prepare(`
      SELECT * FROM message_queue
      WHERE status IN ('pending', 'running')
      ORDER BY scheduled_time ASC
    `).all() as QueueItem[];

    console.log(`Found ${queueItems.length} queue items to migrate`);

    let migratedCount = 0;

    for (const item of queueItems) {
      const filename = `${item.id}.json`;
      const filepath = join(queueDir, filename);

      // Check if file already exists
      if (existsSync(filepath)) {
        console.log(`Skipping ${item.id} - file already exists`);
        continue;
      }

      // Write queue item to JSON file
      writeFileSync(filepath, JSON.stringify(item, null, 2));
      migratedCount++;

      console.log(`Migrated queue item ${item.id} (${item.status}) - scheduled for ${item.scheduled_time}`);
    }

    console.log(`Migration completed! Migrated ${migratedCount} queue items to ${queueDir}`);
    console.log('Note: Completed and failed items were not migrated - they remain in the database for reference');

    // Show what's in the queue directory now
    console.log('\nFiles in queue directory:');
    const { readdirSync } = await import('fs');
    const files = readdirSync(queueDir);
    files.forEach(file => console.log(`  ${file}`));

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateQueueToFiles();
}

export { migrateQueueToFiles };