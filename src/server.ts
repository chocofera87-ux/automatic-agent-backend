import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { logger } from './utils/logger.js';

// Routes
import webhookRoutes from './routes/webhook.routes.js';
import rideRoutes from './routes/ride.routes.js';
import conversationRoutes from './routes/conversation.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import credentialsRoutes from './routes/credentials.routes.js';
import authRoutes from './routes/auth.routes.js';

// Services
import { authService } from './services/auth.service.js';

// Load environment variables
dotenv.config();

// Initialize Prisma
export const prisma = new PrismaClient();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());

// CORS configuration - remove trailing slash from origin
const allowedOrigin = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
app.use(cors({
  origin: allowedOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Mi Chame Backend'
  });
});

// API Routes
app.use('/webhook', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/credentials', credentialsRoutes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    path: req.path,
  });
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down server...');
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
async function main() {
  try {
    // Connect to database
    await prisma.$connect();
    logger.info('Database connected');

    // Create initial admin if not exists
    await authService.createInitialAdmin();

    // Clean expired sessions periodically
    setInterval(async () => {
      const count = await authService.cleanExpiredSessions();
      if (count > 0) {
        logger.info(`Cleaned ${count} expired sessions`);
      }
    }, 60 * 60 * 1000); // Every hour

    // Start listening
    app.listen(PORT, () => {
      logger.info(`Mi Chame Backend running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
