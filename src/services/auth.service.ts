import { PrismaClient, User, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'mi-chame-jwt-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// Token payload interface
interface TokenPayload {
  userId: string;
  email: string;
  role: UserRole;
}

// Auth response interface
interface AuthResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  };
  accessToken: string;
  refreshToken: string;
}

class AuthService {
  // Hash password
  private async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  // Verify password
  private async verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
    return bcrypt.compare(password, hashedPassword);
  }

  // Generate access token
  private generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  // Generate refresh token
  private generateRefreshToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
  }

  // Verify token
  verifyToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch (error) {
      return null;
    }
  }

  // Create initial super admin (first user)
  async createInitialAdmin(): Promise<User | null> {
    try {
      // Check if any user exists
      const existingUser = await prisma.user.findFirst();
      if (existingUser) {
        return null; // Admin already exists
      }

      // Create default super admin
      const hashedPassword = await this.hashPassword('admin123');
      const admin = await prisma.user.create({
        data: {
          email: 'admin@michame.com',
          password: hashedPassword,
          name: 'Administrador',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
        },
      });

      logger.info('Initial super admin created: admin@michame.com');
      return admin;
    } catch (error: any) {
      logger.error('Error creating initial admin:', error);
      return null;
    }
  }

  // Register new user (only admins can do this)
  async register(
    email: string,
    password: string,
    name: string,
    role: UserRole = UserRole.OPERATOR,
    createdById?: string
  ): Promise<{ success: boolean; user?: User; error?: string }> {
    try {
      // Check if email already exists
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return { success: false, error: 'Email já está em uso' };
      }

      // Validate password
      if (password.length < 6) {
        return { success: false, error: 'Senha deve ter pelo menos 6 caracteres' };
      }

      // Hash password and create user
      const hashedPassword = await this.hashPassword(password);
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role,
          createdById,
          isActive: true,
        },
      });

      logger.info(`User registered: ${email} with role ${role}`);
      return { success: true, user };
    } catch (error: any) {
      logger.error('Error registering user:', error);
      return { success: false, error: 'Erro ao criar usuário' };
    }
  }

  // Login
  async login(
    email: string,
    password: string,
    userAgent?: string,
    ipAddress?: string
  ): Promise<{ success: boolean; data?: AuthResponse; error?: string }> {
    try {
      // Find user
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return { success: false, error: 'Email ou senha inválidos' };
      }

      // Check if user is active
      if (!user.isActive) {
        return { success: false, error: 'Usuário desativado. Contate o administrador.' };
      }

      // Verify password
      const isPasswordValid = await this.verifyPassword(password, user.password);
      if (!isPasswordValid) {
        return { success: false, error: 'Email ou senha inválidos' };
      }

      // Generate tokens
      const tokenPayload: TokenPayload = {
        userId: user.id,
        email: user.email,
        role: user.role,
      };

      const accessToken = this.generateAccessToken(tokenPayload);
      const refreshToken = this.generateRefreshToken(tokenPayload);

      // Calculate refresh token expiry
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

      // Save session
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken,
          userAgent,
          ipAddress,
          expiresAt,
        },
      });

      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      logger.info(`User logged in: ${email}`);

      return {
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          },
          accessToken,
          refreshToken,
        },
      };
    } catch (error: any) {
      logger.error('Error logging in:', error);
      return { success: false, error: 'Erro ao fazer login' };
    }
  }

  // Logout
  async logout(refreshToken: string): Promise<boolean> {
    try {
      await prisma.session.delete({
        where: { refreshToken },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  // Logout all sessions for a user
  async logoutAll(userId: string): Promise<boolean> {
    try {
      await prisma.session.deleteMany({
        where: { userId },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  // Refresh access token
  async refreshAccessToken(
    refreshToken: string
  ): Promise<{ success: boolean; accessToken?: string; error?: string }> {
    try {
      // Verify refresh token
      const payload = this.verifyToken(refreshToken);
      if (!payload) {
        return { success: false, error: 'Token de atualização inválido' };
      }

      // Check if session exists
      const session = await prisma.session.findUnique({
        where: { refreshToken },
        include: { user: true },
      });

      if (!session) {
        return { success: false, error: 'Sessão não encontrada' };
      }

      // Check if session expired
      if (session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: session.id } });
        return { success: false, error: 'Sessão expirada' };
      }

      // Check if user is still active
      if (!session.user.isActive) {
        return { success: false, error: 'Usuário desativado' };
      }

      // Generate new access token
      const newAccessToken = this.generateAccessToken({
        userId: session.user.id,
        email: session.user.email,
        role: session.user.role,
      });

      return { success: true, accessToken: newAccessToken };
    } catch (error: any) {
      logger.error('Error refreshing token:', error);
      return { success: false, error: 'Erro ao atualizar token' };
    }
  }

  // Get user by ID
  async getUserById(userId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  // Get all users (for admin)
  async getAllUsers(): Promise<User[]> {
    return prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  // Update user
  async updateUser(
    userId: string,
    data: { name?: string; email?: string; role?: UserRole; isActive?: boolean }
  ): Promise<{ success: boolean; user?: User; error?: string }> {
    try {
      // Check if email is taken by another user
      if (data.email) {
        const existing = await prisma.user.findFirst({
          where: { email: data.email, NOT: { id: userId } },
        });
        if (existing) {
          return { success: false, error: 'Email já está em uso' };
        }
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data,
      });

      return { success: true, user };
    } catch (error: any) {
      logger.error('Error updating user:', error);
      return { success: false, error: 'Erro ao atualizar usuário' };
    }
  }

  // Change password
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return { success: false, error: 'Usuário não encontrado' };
      }

      // Verify current password
      const isPasswordValid = await this.verifyPassword(currentPassword, user.password);
      if (!isPasswordValid) {
        return { success: false, error: 'Senha atual incorreta' };
      }

      // Validate new password
      if (newPassword.length < 6) {
        return { success: false, error: 'Nova senha deve ter pelo menos 6 caracteres' };
      }

      // Update password
      const hashedPassword = await this.hashPassword(newPassword);
      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // Invalidate all sessions (force re-login)
      await this.logoutAll(userId);

      return { success: true };
    } catch (error: any) {
      logger.error('Error changing password:', error);
      return { success: false, error: 'Erro ao alterar senha' };
    }
  }

  // Reset password (admin action)
  async resetPassword(
    userId: string,
    newPassword: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (newPassword.length < 6) {
        return { success: false, error: 'Senha deve ter pelo menos 6 caracteres' };
      }

      const hashedPassword = await this.hashPassword(newPassword);
      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // Invalidate all sessions
      await this.logoutAll(userId);

      return { success: true };
    } catch (error: any) {
      logger.error('Error resetting password:', error);
      return { success: false, error: 'Erro ao redefinir senha' };
    }
  }

  // Delete user
  async deleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Delete all sessions first
      await prisma.session.deleteMany({ where: { userId } });

      // Delete user
      await prisma.user.delete({ where: { id: userId } });

      return { success: true };
    } catch (error: any) {
      logger.error('Error deleting user:', error);
      return { success: false, error: 'Erro ao excluir usuário' };
    }
  }

  // Check if user has permission
  hasPermission(userRole: UserRole, requiredRole: UserRole): boolean {
    const roleHierarchy: Record<UserRole, number> = {
      [UserRole.SUPER_ADMIN]: 4,
      [UserRole.ADMIN]: 3,
      [UserRole.OPERATOR]: 2,
      [UserRole.VIEWER]: 1,
    };

    return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
  }

  // Clean expired sessions
  async cleanExpiredSessions(): Promise<number> {
    const result = await prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }
}

// Export singleton instance
export const authService = new AuthService();
