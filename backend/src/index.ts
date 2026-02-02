import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root
const __rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(__rootDir, '.env') });
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { chatsRouter } from './routes/chats.js';
import { streamRouter } from './routes/stream.js';
import { loginHandler, logoutHandler, checkAuthHandler, requireAuth } from './auth.js';

const app = express();
const PORT = process.env.PORT || 27568;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Auth routes (public)
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/logout', logoutHandler);
app.get('/api/auth/check', checkAuthHandler);

// All /api routes require auth
app.use('/api', requireAuth);

app.use('/api/chats', chatsRouter);
app.use('/api/chats', streamRouter);

// Serve frontend static files in production
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
