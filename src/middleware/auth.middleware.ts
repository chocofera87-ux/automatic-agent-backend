import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { authService } from '../services/auth.service.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
        role: UserRole;
      };
    }
  }
}

// Authentication middleware - verifies JWT token
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Token de acesso não fornecido',
      });
      return;
    }

    const token = authHeader.split(' ')[1];
    const payload = authService.verifyToken(token);

    if (!payload) {
      res.status(401).json({
        success: false,
        error: 'Token inválido ou expirado',
      });
      return;
    }

    // Attach user to request
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Falha na autenticação',
    });
  }
};

// Authorization middleware - checks user role
export const authorize = (...allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Usuário não autenticado',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: 'Acesso negado. Permissão insuficiente.',
      });
      return;
    }

    next();
  };
};

// Middleware to check if user is admin or super admin
export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Usuário não autenticado',
    });
    return;
  }

  if (req.user.role !== UserRole.ADMIN && req.user.role !== UserRole.SUPER_ADMIN) {
    res.status(403).json({
      success: false,
      error: 'Acesso negado. Apenas administradores podem acessar.',
    });
    return;
  }

  next();
};

// Middleware to check if user is super admin
export const requireSuperAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Usuário não autenticado',
    });
    return;
  }

  if (req.user.role !== UserRole.SUPER_ADMIN) {
    res.status(403).json({
      success: false,
      error: 'Acesso negado. Apenas super administradores podem acessar.',
    });
    return;
  }

  next();
};

// Optional authentication - doesn't fail if no token
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = authService.verifyToken(token);

      if (payload) {
        req.user = payload;
      }
    }

    next();
  } catch (error) {
    next();
  }
};
