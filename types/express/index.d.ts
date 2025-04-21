// chatbot-backend/types/express/index.d.ts

import { Request } from "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      uid: string;
      tenant_id: string;
      email?: string;
    };
  }
}
