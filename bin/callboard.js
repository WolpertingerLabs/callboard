#!/usr/bin/env node

// CLI entry point for the `callboard` command after global install.
// Sets NODE_ENV to production (unless overridden) and starts the server.
process.env.NODE_ENV = process.env.NODE_ENV || "production";

import "../backend/dist/index.js";
