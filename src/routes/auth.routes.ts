import { Router, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { authService } from '../services/auth.service.js';
import { authenticate, requireAdmin, requireSuperAdmin } from '../middleware/auth.middleware.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /api/auth/login - User login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email e senha são obrigatórios',
      });
    }

    const result = await authService.login(
      email,
      password,
      req.headers['user-agent'],
      req.ip
    );

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: result.data,
    });
  } catch (error: any) {
    logger.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/logout - User logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    res.json({
      success: true,
      message: 'Logout realizado com sucesso',
    });
  } catch (error: any) {
    logger.error('Logout error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/refresh - Refresh access token
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Token de atualização é obrigatório',
      });
    }

    const result = await authService.refreshAccessToken(refreshToken);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: { accessToken: result.accessToken },
    });
  } catch (error: any) {
    logger.error('Token refresh error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// GET /api/auth/me - Get current user info
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const user = await authService.getUserById(req.user!.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado',
      });
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    logger.error('Get user error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/change-password - Change own password
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Senha atual e nova senha são obrigatórias',
      });
    }

    const result = await authService.changePassword(
      req.user!.userId,
      currentPassword,
      newPassword
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: 'Senha alterada com sucesso. Faça login novamente.',
    });
  } catch (error: any) {
    logger.error('Change password error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// =====================================================
// Admin Routes - User Management
// =====================================================

// GET /api/auth/users - Get all users (admin only)
router.get('/users', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await authService.getAllUsers();

    res.json({
      success: true,
      data: users.map(user => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
    });
  } catch (error: any) {
    logger.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/users - Create new user (admin only)
router.post('/users', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email, senha e nome são obrigatórios',
      });
    }

    // Validate role
    const validRoles = Object.values(UserRole);
    const userRole = role && validRoles.includes(role) ? role : UserRole.OPERATOR;

    // Only super admin can create admin users
    if (
      (userRole === UserRole.ADMIN || userRole === UserRole.SUPER_ADMIN) &&
      req.user!.role !== UserRole.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        error: 'Apenas super administradores podem criar administradores',
      });
    }

    const result = await authService.register(
      email,
      password,
      name,
      userRole,
      req.user!.userId
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.status(201).json({
      success: true,
      data: {
        id: result.user!.id,
        email: result.user!.email,
        name: result.user!.name,
        role: result.user!.role,
      },
      message: 'Usuário criado com sucesso',
    });
  } catch (error: any) {
    logger.error('Create user error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// PUT /api/auth/users/:id - Update user (admin only)
router.put('/users/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, email, role, isActive } = req.body;

    // Prevent editing super admin by non-super admin
    const targetUser = await authService.getUserById(id);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado',
      });
    }

    if (
      targetUser.role === UserRole.SUPER_ADMIN &&
      req.user!.role !== UserRole.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        error: 'Não é possível editar super administrador',
      });
    }

    // Only super admin can change role to admin/super admin
    if (
      role &&
      (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) &&
      req.user!.role !== UserRole.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        error: 'Apenas super administradores podem promover a administrador',
      });
    }

    const result = await authService.updateUser(id, { name, email, role, isActive });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: {
        id: result.user!.id,
        email: result.user!.email,
        name: result.user!.name,
        role: result.user!.role,
        isActive: result.user!.isActive,
      },
      message: 'Usuário atualizado com sucesso',
    });
  } catch (error: any) {
    logger.error('Update user error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/users/:id/reset-password - Reset user password (admin only)
router.post('/users/:id/reset-password', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Nova senha é obrigatória',
      });
    }

    // Prevent resetting super admin password by non-super admin
    const targetUser = await authService.getUserById(id);
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Usuário não encontrado',
      });
    }

    if (
      targetUser.role === UserRole.SUPER_ADMIN &&
      req.user!.role !== UserRole.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        error: 'Não é possível redefinir senha de super administrador',
      });
    }

    const result = await authService.resetPassword(id, newPassword);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: 'Senha redefinida com sucesso',
    });
  } catch (error: any) {
    logger.error('Reset password error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// DELETE /api/auth/users/:id - Delete user (super admin only)
router.delete('/users/:id', authenticate, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Prevent self-deletion
    if (id === req.user!.userId) {
      return res.status(400).json({
        success: false,
        error: 'Não é possível excluir seu próprio usuário',
      });
    }

    const result = await authService.deleteUser(id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: 'Usuário excluído com sucesso',
    });
  } catch (error: any) {
    logger.error('Delete user error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/setup - Initial setup (create first admin)
router.post('/setup', async (req: Request, res: Response) => {
  try {
    const admin = await authService.createInitialAdmin();

    if (!admin) {
      return res.status(400).json({
        success: false,
        error: 'Configuração inicial já foi realizada',
      });
    }

    res.status(201).json({
      success: true,
      message: 'Administrador inicial criado com sucesso',
      data: {
        email: 'admin@michame.com',
        password: 'admin123',
        note: 'IMPORTANTE: Altere a senha após o primeiro login!',
      },
    });
  } catch (error: any) {
    logger.error('Setup error:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

export default router;
