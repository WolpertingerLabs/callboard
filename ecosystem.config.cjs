/* global module, __dirname */
module.exports = {
  apps: [
    {
      name: "callboard",
      script: "backend/dist/index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 8000,
      },
    },
  ],
};
