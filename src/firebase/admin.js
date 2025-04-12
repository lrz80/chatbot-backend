import { readFileSync } from 'fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';

export const initFirebase = () => {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

    initializeApp({
      credential: cert(serviceAccount),
    });
  }
};

