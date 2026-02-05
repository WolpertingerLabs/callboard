# Claude Code UI

## Development

- When running the development server, always run it in the background using `run_in_background: true` so you can test the functionality while it's running

## Production Deployment

- Production runs on port 8000 with PM2
- `npm start` - runs the server directly (no PM2)
- `npm run redeploy:prod` - deletes and recreates PM2 process with correct config
- To redeploy production, use: `npm run build && npm run redeploy:prod`
- PM2 commands: `pm2 list`, `pm2 logs claude-code-ui`

## Linting

- `npm run lint` - lint only staged files (used in workflows)
- `npm run lint:fix` - lint and fix only staged files
- `npm run lint:all` - lint all files in the project
- `npm run lint:all:fix` - lint and fix all files in the project

## Workflow Instructions

- Use `/gsr` to build, commit, push, and redeploy production in one command
