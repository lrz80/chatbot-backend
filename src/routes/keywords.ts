import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../lib/db';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get(
    '/',
    async (
      req: Request<Record<string, any>, any, any, any>,
      res: Response
    ): Promise<void> => {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) {
        res.status(401).json({ error: 'Token requerido' });
        return;
      }
  
      try {
        const decoded: any = jwt.verify(token, JWT_SECRET);
  
        const result = await pool.query(
          `SELECT word, count FROM keywords WHERE uid = $1 ORDER BY count DESC LIMIT 10`,
          [decoded.uid]
        );
  
        res.status(200).json({
          keywords: result.rows.map((row: any) => [row.word, row.count]),
        });
      } catch (error) {
        console.error('❌ Error en /keywords:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
      }
    }
  );  

export default router;

