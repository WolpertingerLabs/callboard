#!/usr/bin/env node

import { spawn } from 'child_process';

const PROCESS_NAME = 'claude-code-ui';
const SCRIPT_PATH = 'backend/dist/index.js';

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' });
    proc.on('exit', (code) => resolve(code === 0));
  });
}

async function checkPM2Available() {
  return runCommand('which', ['pm2']);
}

async function startServer() {
  const pm2Available = await checkPM2Available();

  if (pm2Available) {
    console.log('PM2 detected. Redeploying...');

    // Always delete existing process to ensure correct script path
    await runCommand('pm2', ['delete', PROCESS_NAME]);

    // Start fresh with correct script
    const startProcess = spawn('pm2', ['start', SCRIPT_PATH, '--name', PROCESS_NAME], {
      stdio: 'inherit'
    });

    startProcess.on('exit', (code) => {
      if (code === 0) {
        console.log('PM2 process started successfully.');
      }
      process.exit(code);
    });
  } else {
    console.log('PM2 not available. Starting with node...');
    const nodeProcess = spawn('node', [SCRIPT_PATH], {
      stdio: 'inherit'
    });

    nodeProcess.on('exit', (code) => {
      process.exit(code);
    });
  }
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
