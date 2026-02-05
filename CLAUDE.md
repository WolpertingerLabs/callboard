# Claude Code UI

## Development

- When running the development server, always run it in the background using `run_in_background: true` so you can test the functionality while it's running

## Production Deployment

- Production runs on port 8000 with PM2
- `npm start` - runs the server directly (no PM2)
- `npm run redeploy:prod` - deletes and recreates PM2 process with correct config
- To redeploy production, use: `npm run build && npm run redeploy:prod`
- PM2 commands: `pm2 list`, `pm2 logs claude-code-ui`

## Workflow Instructions

- When work is completed, commit and push changes to the repository
- After committing and pushing, ask the user if they'd like to reboot production to deploy the changes
