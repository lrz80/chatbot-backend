// 📁 src/lib/twilioClient.ts

import twilio from 'twilio';

export function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('❌ Error: Faltan variables de Twilio (TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN)');
    throw new Error('Twilio no configurado correctamente');
  }

  return twilio(accountSid, authToken);
}
