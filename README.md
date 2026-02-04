# Claude Code UI

A modern web interface for interacting with Claude Code, featuring real-time chat, file uploads, queue management, and authentication.

## Features

- **Interactive Chat Interface**: Real-time messaging with Claude using Server-Sent Events
- **File Upload Support**: Upload and share images in conversations
- **Queue Management**: View and manage queued requests
- **Authentication**: Secure login system with session management
- **Slash Commands**: Autocomplete support for slash commands
- **Responsive Design**: Split layout optimized for desktop and mobile
- **Markdown Rendering**: Rich text rendering with syntax highlighting

## Tech Stack

### Frontend
- **React 18** with TypeScript
- **Vite** for build tooling
- **React Router** for navigation
- **Lucide React** for icons
- **React Markdown** with syntax highlighting

### Backend
- **Express.js** with TypeScript
- **SQLite** database with better-sqlite3
- **OpenRouter SDK** for AI model integration
- **Anthropic Claude Code** SDK

## Getting Started

### Prerequisites
- Node.js (latest LTS recommended)
- npm or yarn

### Development

1. Clone the repository:
```bash
git clone <repository-url>
cd claude-code-ui
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
Create a `.env` file in the project root with your configuration.

4. Start the development server:
```bash
npm run dev
```

This runs both the backend (port 3001) and frontend (port 3000) concurrently.

### Production Deployment

1. Build the application:
```bash
npm run build
```

2. Start the production server:
```bash
npm start
```

The production server runs on port 8000 and is managed by PM2.

### Production Management

The application uses PM2 for process management in production:

```bash
# Restart the application
pm2 restart claude-code-ui

# View logs
pm2 logs claude-code-ui

# List running processes
pm2 list

# Quick redeploy (build + restart)
npm run redeploy:prod
```

## Project Structure

```
├── frontend/           # React frontend application
│   ├── src/
│   │   ├── components/ # Reusable UI components
│   │   ├── pages/      # Route components
│   │   └── App.tsx     # Main application component
├── backend/            # Express backend server
│   ├── src/
│   │   ├── routes/     # API route handlers
│   │   ├── services/   # Business logic
│   │   └── index.ts    # Server entry point
├── package.json        # Project dependencies and scripts
└── CLAUDE.md          # Development instructions
```

## API Endpoints

- `POST /api/auth/login` - User authentication
- `POST /api/auth/logout` - User logout
- `GET /api/auth/check` - Check authentication status
- `/api/chats/*` - Chat management and streaming
- `/api/images/*` - Image upload and management
- `/api/queue/*` - Queue management

## Scripts

- `npm run dev` - Start development servers
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run redeploy:prod` - Build and restart production

## License

[License information]