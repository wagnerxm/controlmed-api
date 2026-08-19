/**
 * Rotas de upload de fotos — /api/upload
 * POST /api/upload/photo   — upload de foto de registro de campo
 * GET  /api/upload/:filename — servir foto
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { requireAuth } from '../middleware/auth.js';

export const uploadRouter = Router();

/* Configurar storage do multer */
const storage = multer.diskStorage({
  destination: '/app/uploads',
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, /* 20 MB max */
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato não suportado. Use JPG, PNG ou WebP.'));
    }
  },
});

/* ── Upload de foto ── */
uploadRouter.post('/photo', requireAuth, upload.single('foto'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    return;
  }

  res.json({
    ok: true,
    filename: req.file.filename,
    path: `/api/upload/${req.file.filename}`,
    size: req.file.size,
  });
});

/* ── Servir foto ── */
uploadRouter.get('/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename as string;
  /* Sanitizar filename pra evitar path traversal */
  const safe = path.basename(filename);
  const filePath = path.join('/app/uploads', safe);
  res.sendFile(filePath);
});
