/**
 * Rotas de autenticação — /api/auth
 * POST /api/auth/login    — login com email/senha
 * POST /api/auth/register — criar primeiro admin (setup)
 * GET  /api/auth/me       — dados do usuário logado
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db.js';
import { generateToken, requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

/* ── Login ── */
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { login, senha } = req.body;
    if (!login || !senha) {
      res.status(400).json({ error: 'Login e senha são obrigatórios.' });
      return;
    }

    /* Buscar por login ou email */
    const user = await queryOne<any>(
      `SELECT * FROM users WHERE login = $1 OR email = $1 LIMIT 1`,
      [login]
    );

    if (!user) {
      res.status(401).json({ error: 'Usuário não encontrado.' });
      return;
    }

    /* Verificar senha */
    const senhaOk = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaOk) {
      res.status(401).json({ error: 'Senha incorreta.' });
      return;
    }

    /* Atualizar último acesso */
    await query(`UPDATE users SET ultimo_acesso = NOW() WHERE id = $1`, [user.id]);

    /* Gerar token */
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      teamId: user.team_id || '',
    });

    const { senha_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err: any) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno no login.' });
  }
});

/* ── Registro (primeiro admin ou via convite) ── */
authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { nome, email, login, senha, role } = req.body;

    if (!nome || !email || !login || !senha) {
      res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
      return;
    }

    /* Verificar se já existe */
    const existing = await queryOne<any>(
      `SELECT id FROM users WHERE email = $1 OR login = $2 LIMIT 1`,
      [email, login]
    );
    if (existing) {
      res.status(409).json({ error: 'E-mail ou login já cadastrado.' });
      return;
    }

    /* Verificar se é o primeiro usuário (auto-admin) */
    const countResult = await queryOne<any>(`SELECT COUNT(*) as total FROM users`);
    const isFirst = parseInt(countResult?.total || '0') === 0;
    const userRole = isFirst ? 'admin' : (role || 'inspetor');

    /* Hash da senha */
    const senha_hash = await bcrypt.hash(senha, 12);
    const userId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    /* Criar team se é o primeiro */
    let teamId = '';
    if (isFirst) {
      teamId = `team-${Date.now()}`;
      await query(
        `INSERT INTO teams (id, nome, owner_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
        [teamId, `Equipe de ${nome}`, userId, now]
      );
    }

    /* Inserir usuário */
    await query(
      `INSERT INTO users (id, nome, email, login, senha_hash, role, status, team_id, deve_trocar_senha, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ativo', $7, FALSE, $8, $8)`,
      [userId, nome, email, login, senha_hash, userRole, teamId, now]
    );

    /* Token */
    const token = generateToken({
      userId,
      email,
      role: userRole,
      teamId,
    });

    res.status(201).json({
      token,
      user: { id: userId, nome, email, login, role: userRole, status: 'ativo', team_id: teamId },
    });
  } catch (err: any) {
    console.error('Erro no registro:', err);
    res.status(500).json({ error: 'Erro interno no registro.' });
  }
});

/* ── Dados do usuário logado ── */
authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await queryOne<any>(
      `SELECT id, nome, email, login, role, status, team_id, avatar_url, ultimo_acesso, created_at
       FROM users WHERE id = $1`,
      [req.auth!.userId]
    );
    if (!user) {
      res.status(404).json({ error: 'Usuário não encontrado.' });
      return;
    }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar usuário.' });
  }
});
