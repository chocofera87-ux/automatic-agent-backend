import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { machineGlobalService } from '../services/machineGlobal.service.js';
import { whatsappService } from '../services/whatsapp.service.js';

const router = Router();
const prisma = new PrismaClient();

// Get system health/status
router.get('/health', async (req: Request, res: Response) => {
  try {
    // Check database connection
    let dbStatus = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = true;
    } catch (e) {
      dbStatus = false;
    }

    // Check Machine Global connection
    const machineStatus = await machineGlobalService.verifyConnection();

    // WhatsApp status (assume OK if credentials are configured)
    const whatsappStatus = !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;

    // Twilio status
    const twilioStatus = !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;

    // OpenAI status
    const openaiStatus = !!process.env.OPENAI_API_KEY;

    res.json({
      success: true,
      data: {
        status: dbStatus && machineStatus ? 'healthy' : 'degraded',
        services: {
          database: { status: dbStatus ? 'connected' : 'disconnected' },
          machineGlobal: { status: machineStatus ? 'connected' : 'disconnected' },
          whatsapp: { status: whatsappStatus ? 'configured' : 'not_configured' },
          twilio: { status: twilioStatus ? 'configured' : 'not_configured' },
          openai: { status: openaiStatus ? 'configured' : 'not_configured' },
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    logger.error('Error checking health:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get webhooks list
router.get('/webhooks', async (req: Request, res: Response) => {
  try {
    // Get webhooks from Machine Global
    const machineWebhooks = await machineGlobalService.listWebhooks();

    // Get webhooks from local database
    const localWebhooks = await prisma.webhook.findMany();

    res.json({
      success: true,
      data: {
        machineGlobal: machineWebhooks.success ? machineWebhooks.response?.webhooks : [],
        local: localWebhooks,
      },
    });
  } catch (error: any) {
    logger.error('Error fetching webhooks:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register webhook with Machine Global
router.post('/webhooks', async (req: Request, res: Response) => {
  try {
    const { url, type } = req.body;

    if (!url || !type) {
      return res.status(400).json({ success: false, error: 'URL and type are required' });
    }

    // Register with Machine Global
    const result = await machineGlobalService.registerWebhook(url, type);

    if (result.success) {
      // Save locally
      await prisma.webhook.create({
        data: {
          url,
          type,
          isActive: true,
        },
      });
    }

    res.json(result);
  } catch (error: any) {
    logger.error('Error registering webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete webhook
router.delete('/webhooks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Delete from Machine Global
    const result = await machineGlobalService.deleteWebhook(id);

    // Delete from local database if exists
    try {
      await prisma.webhook.delete({ where: { id } });
    } catch (e) {
      // Might not exist locally
    }

    res.json(result);
  } catch (error: any) {
    logger.error('Error deleting webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get system logs
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const {
      level,
      source,
      page = '1',
      limit = '50',
    } = req.query;

    const where: any = {};
    if (level) where.level = level;
    if (source) where.source = source;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [logs, total] = await Promise.all([
      prisma.systemLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.systemLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test WhatsApp connection
router.post('/test/whatsapp', async (req: Request, res: Response) => {
  try {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    const result = await whatsappService.sendTextMessage(
      phoneNumber,
      message || 'Teste de conexão da Mi Chame!'
    );

    res.json({
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    });
  } catch (error: any) {
    logger.error('Error testing WhatsApp:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test Machine Global connection
router.post('/test/machine', async (req: Request, res: Response) => {
  try {
    const result = await machineGlobalService.verifyConnection();
    res.json({
      success: result,
      message: result ? 'Machine Global connection OK' : 'Machine Global connection failed',
    });
  } catch (error: any) {
    logger.error('Error testing Machine Global:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get environment info (sanitized)
router.get('/env', async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 3001,
      frontendUrl: process.env.FRONTEND_URL,
      hasWhatsappToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
      hasWhatsappPhoneId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      hasMachineKey: !!process.env.MACHINE_GLOBAL_API_KEY,
      hasOpenaiKey: !!process.env.OPENAI_API_KEY,
      hasTwilioCredentials: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN,
    },
  });
});

export default router;
