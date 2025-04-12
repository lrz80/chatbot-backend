import { readFileSync } from 'fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';

export const initFirebase = () => {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(
      readFileSync('/app/firebase-service-account.json', 'utf8')
    );

    initializeApp({
      credential: cert(serviceAccount),
    });
  }
};

