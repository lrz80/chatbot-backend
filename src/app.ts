// 📁 src/app.ts
import express from 'express';
const cors = require('cors'); // ✅ compatible con TypeScript sin errores
import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/api/settings', settingsRoutes);

const PORT = process.env.PORT as string;

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
}, 1000 * 30); // Cada 30 segundos
