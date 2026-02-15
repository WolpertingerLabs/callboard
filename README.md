# Claude Code UI

A full-stack web interface for the [Anthropic Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent SDK, providing real-time chat, tool permission management, image uploads, git integration, and more.

## Features

- **Real-Time Streaming Chat** - Conversations with Claude streamed via Server-Sent Events (SSE), with support for thinking, tool calls, and permission requests
- **Tool Permission Controls** - Approve, deny, or auto-allow file reads, file writes, code execution, and web access per session
- **Image Uploads** - Attach images to messages for visual context
- **Git Integration** - Browse branches, create worktrees, switch branches, and view diffs directly from the UI
- **Folder Browser** - Select and validate project directories to work in
- **Queue Management** - Save draft messages to a queue for later execution
- **Slash Commands** - Autocomplete-enabled slash commands from your project's configuration
- **Plugin Support** - Load custom plugins that extend Claude's capabilities
- **Responsive Design** - Split-pane layout for desktop, single-column for mobile
- **Markdown Rendering** - Rich text with GitHub Flavored Markdown and syntax-highlighted code blocks
- **Authentication** - Password-based login with secure cookie sessions, rate limiting, and auto-extending TTL
- **API Documentation** - Auto-generated OpenAPI spec available at `/api/docs`

## Tech Stack

| Layer               | Technology                                   |
| ------------------- | -------------------------------------------- |
| **Frontend**        | React 18, TypeScript, Vite, React Router     |
| **Backend**         | Express.js, TypeScript                       |
| **AI Integration**  | `@anthropic-ai/claude-agent-sdk`             |
| **Styling**         | CSS with custom properties (dark/light mode) |
| **Icons**           | Lucide React                                 |
| **Markdown**        | react-markdown, rehype-highlight, remark-gfm |
| **File Uploads**    | Multer                                       |
| **Logging**         | Winston                                      |
| **Testing**         | Vitest                                       |
| **Linting**         | ESLint, Prettier                             |
| **Process Manager** | PM2 (production)                             |
| **Storage**         | File-based (JSONL chat logs, JSON metadata)  |

## Getting Started

### Prerequisites

- **Node.js** 22+ (managed via nvm)
- **npm** 9+
- **Claude Code CLI** installed and authenticated

### Setup

1. Clone the repository:

```bash
git clone <repository-url>
cd claude-code-ui
```

2. Install dependencies:

```bash
npm install
```

3. Configure environment variables:

```bash
cp .env.example .env
```

Edit `.env` and set your `AUTH_PASSWORD`:

```env
PORT=8000
DEV_PORT_UI=3000
DEV_PORT_SERVER=3002
LOG_LEVEL=info
AUTH_PASSWORD=your-secure-password
```

| Variable          | Default      | Description                                          |
| ----------------- | ------------ | ---------------------------------------------------- |
| `PORT`            | `8000`       | Production server port                               |
| `DEV_PORT_UI`     | `3000`       | Frontend dev server port                             |
| `DEV_PORT_SERVER` | `3002`       | Backend dev server port                              |
| `LOG_LEVEL`       | `info`       | Winston log level (`error`, `warn`, `info`, `debug`) |
| `AUTH_PASSWORD`   | _(required)_ | Password for logging in to the UI                    |

### Development

Start both the frontend and backend dev servers concurrently:

```bash
npm run dev
```

- Frontend: `http://localhost:3000` (proxies API requests to the backend)
- Backend: `http://localhost:3002`

### Production

Build and start:

```bash
npm run build
npm start
```

Or build and redeploy via PM2 in one step:

```bash
npm run build && npm run redeploy:prod
```

The production server runs on port 8000 and serves the built frontend as static files.

### PM2 Management

```bash
pm2 list                    # List running processes
pm2 logs claude-code-ui     # View logs
pm2 restart claude-code-ui  # Restart the app
```

## Project Structure

```
claude-code-ui/
├── frontend/               # React frontend
│   └── src/
│       ├── components/     # UI components (MessageBubble, PromptInput, etc.)
│       ├── pages/          # Route pages (Chat, ChatList, Queue, Login)
│       ├── hooks/          # Custom React hooks
│       ├── types/          # Frontend-specific types
│       ├── utils/          # Client utilities
│       ├── api.ts          # API client layer
│       └── App.tsx         # Root component and routing
├── backend/                # Express backend
│   └── src/
│       ├── routes/         # API route handlers (chats, stream, images, queue, git, folders)
│       ├── services/       # Business logic (claude SDK, chat storage, sessions, etc.)
│       ├── utils/          # Server utilities (logger, SSE, git helpers)
│       ├── auth.ts         # Authentication middleware
│       ├── swagger.ts      # OpenAPI spec generation
│       └── index.ts        # Server entry point
├── shared/                 # Shared TypeScript types (used by both frontend & backend)
│   └── types/              # Chat, message, stream, permissions, plugin types
├── data/                   # Runtime data (gitignored)
│   ├── chats/              # JSONL chat session files
│   ├── images/             # Uploaded images
│   ├── queue/              # Draft queue items
│   └── sessions.json       # Active auth sessions
├── .env.example            # Environment variable template
├── ecosystem.config.cjs    # PM2 process configuration
├── eslint.config.js        # ESLint configuration
├── tsconfig.base.json      # Shared TypeScript config
└── package.json            # Workspace root (npm workspaces)
```

## API Endpoints

### Authentication

| Method | Endpoint           | Description                 |
| ------ | ------------------ | --------------------------- |
| `POST` | `/api/auth/login`  | Log in with password        |
| `POST` | `/api/auth/logout` | Destroy session             |
| `GET`  | `/api/auth/check`  | Check authentication status |

### Chats

| Method   | Endpoint                  | Description                                                      |
| -------- | ------------------------- | ---------------------------------------------------------------- |
| `GET`    | `/api/chats`              | List chats (paginated)                                           |
| `GET`    | `/api/chats/:id`          | Get chat metadata                                                |
| `GET`    | `/api/chats/:id/messages` | Get message history                                              |
| `DELETE` | `/api/chats/:id`          | Delete a chat                                                    |
| `GET`    | `/api/chats/new/info`     | Get info for starting a new chat (git status, commands, plugins) |

### Streaming

| Method | Endpoint                 | Description                                           |
| ------ | ------------------------ | ----------------------------------------------------- |
| `POST` | `/api/chats/new/message` | Create a new chat and stream the first response (SSE) |
| `POST` | `/api/chats/:id/message` | Send a message to an existing chat (SSE)              |
| `POST` | `/api/chats/:id/respond` | Respond to a permission or user question prompt       |
| `POST` | `/api/chats/:id/stop`    | Stop a running session                                |

### Images

| Method | Endpoint                    | Description             |
| ------ | --------------------------- | ----------------------- |
| `POST` | `/api/chats/:chatId/images` | Upload images to a chat |

### Queue

| Method   | Endpoint         | Description        |
| -------- | ---------------- | ------------------ |
| `GET`    | `/api/queue`     | List queued drafts |
| `POST`   | `/api/queue`     | Create a draft     |
| `DELETE` | `/api/queue/:id` | Delete a draft     |

### Git

| Method | Endpoint                 | Description                        |
| ------ | ------------------------ | ---------------------------------- |
| `GET`  | `/api/git/info`          | Get git repo info for a folder     |
| `GET`  | `/api/git/diff`          | Get git diff for a folder          |
| `POST` | `/api/git/switch-branch` | Switch or create a branch/worktree |

### Folders

| Method | Endpoint                   | Description               |
| ------ | -------------------------- | ------------------------- |
| `GET`  | `/api/folders/browse`      | Browse directory contents |
| `GET`  | `/api/folders/validate`    | Validate a folder path    |
| `GET`  | `/api/folders/suggestions` | Get folder suggestions    |

### Docs

| Method | Endpoint    | Description                          |
| ------ | ----------- | ------------------------------------ |
| `GET`  | `/api/docs` | Auto-generated OpenAPI specification |

## Scripts

| Command                 | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `npm run dev`           | Start frontend and backend dev servers concurrently      |
| `npm run build`         | Build shared types, backend, and frontend for production |
| `npm start`             | Start the production server (`NODE_ENV=production`)      |
| `npm run redeploy:prod` | Delete and recreate the PM2 process                      |
| `npm test`              | Run tests (Vitest)                                       |
| `npm run test:watch`    | Run tests in watch mode                                  |
| `npm run lint`          | Lint staged files only                                   |
| `npm run lint:fix`      | Lint and auto-fix staged files                           |
| `npm run lint:all`      | Lint all project files                                   |
| `npm run lint:all:fix`  | Lint and auto-fix all project files                      |
| `npm run prettier`      | Format changed files with Prettier                       |
| `npm run clean`         | Remove all build artifacts                               |

## License

[License information]
