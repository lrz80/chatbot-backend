import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initFirebase } from './firebase/admin.js'; // 👈 importar Firebase
import fetch from 'node-fetch'; // si estás en Node <18

dotenv.config();
initFirebase();

import authRoutes from './routes/auth.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('✅ Backend activo');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// 👀 Keep-alive para Railway
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(SELF_URL)
    .then(() => console.log('🔁 Ping interno enviado para mantener activo'))
    .catch(err => console.error('⚠️ Error en ping interno:', err.message));
}, 4 * 60 * 1000); // cada 4 minutos
