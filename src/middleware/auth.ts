/**
 * Middleware de autenticação JWT
 * Verifica o token no header Authorization: Bearer <token>
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
  teamId: string;
}

/* Estende o Request do Express com o usuário autenticado */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

/** Gera um token JWT para o usuário */
export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

/** Verifica o token e extrai o payload */
export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

/** Middleware: requer autenticação */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token de autenticação não fornecido.' });
    return;
  }

  try {
    const token = header.slice(7);
    req.auth = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

/** Middleware: requer role admin */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.role !== 'admin') {
    res.status(403).json({ error: 'Acesso restrito a administradores.' });
    return;
  }
  next();
}
