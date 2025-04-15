// 📁 src/app.ts
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings';

dotenv.config();

const app = express();

// Lista blanca de dominios permitidos (local + producción)
const allowedOrigins = [
  'http://localhost:3000',
  'https://www.aamy.ai',
];

// CORS Middleware seguro con credentials
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`❌ Not allowed by CORS: ${origin}`));
    }
  },
  credentials: true,
}));

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

// Ping para mantener Railway activo
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;

setInterval(() => {
  globalThis
    .fetch(SELF_URL)
    .then(() => console.log('🔁 Keep-alive ping enviado'))
    .catch(err => console.error('⚠️ Error al hacer ping interno:', err.message));
}, 1000 * 30);
