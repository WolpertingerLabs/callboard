import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { chatsRouter } from './routes/chats.js';
import { streamRouter } from './routes/stream.js';
import { loginHandler, logoutHandler, checkAuthHandler, requireAuth } from './auth.js';

const app = express();
const PORT = process.env.PORT || 3001;

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

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
