import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import settingsRoutes from './routes/settings.js';
import authRoutes from './routes/auth.js';

dotenv.config();

const app = express(); // 👈 Primero defines app

app.use(cors());
app.use(express.json());

app.use('/api/settings', settingsRoutes); // 👈 Ahora sí puedes montar la ruta
app.use('/auth', authRoutes);

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
}, 1000 * 60 * 4); // Cada 4 minutos
