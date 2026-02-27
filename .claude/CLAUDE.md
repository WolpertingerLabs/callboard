# Callboard

## Development

- When running the development server, always run it in the background using `run_in_background: true` so you can test the functionality while it's running

## Production Deployment

- Production runs on port 8000 by default
- `callboard start` - start as background daemon
- `callboard stop` - stop the background server
- `callboard restart` - restart the background server
- `callboard status` - check server health, PID, port, uptime
- `callboard logs` - view and follow server logs
- `callboard config` - show effective configuration

## Linting

- `npm run lint` - lint only staged files (used in workflows)
- `npm run lint:fix` - lint and fix only staged files
- `npm run lint:all` - lint all files in the project
- `npm run lint:all:fix` - lint and fix all files in the project

## Workflow Instructions

- Use `/gsr` to build, commit, push, and restart production in one command
