// 📁 src/app.ts
import express from 'express';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings';

dotenv.config();

const app = express();

// ✅ Middleware CORS manual compatible con cookies
const allowedOrigins = [
  'http://localhost:3000',
  'https://www.aamy.ai',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/api/settings', settingsRoutes);

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('✅ Backend activo');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;

setInterval(() => {
  globalThis
    .fetch(SELF_URL)
    .then(() => console.log('🔁 Keep-alive ping enviado'))
    .catch(err => console.error('⚠️ Error al hacer ping interno:', err.message));
}, 1000 * 30); // cada 30 segundos
