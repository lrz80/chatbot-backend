import { initializeApp, cert } from 'firebase-admin/app';
import serviceAccount from './firebase-service-account.json' assert { type: 'json' };

try {
  initializeApp({
    credential: cert(serviceAccount),
  });

  console.log("✅ Clave válida. Firebase inicializado.");
} catch (err) {
  console.error("❌ Error al inicializar Firebase:");
  console.error(err);
}
