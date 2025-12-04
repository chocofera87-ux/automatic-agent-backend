import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

const router = Router();
const prisma = new PrismaClient();

// Get all conversations with pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      active,
      customerId,
      page = '1',
      limit = '20',
    } = req.query;

    const where: any = {};

    if (active !== undefined) {
      where.isActive = active === 'true';
    }

    if (customerId) {
      where.customerId = customerId as string;
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              phoneNumber: true,
              name: true,
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1, // Only get last message
          },
          ride: {
            select: {
              id: true,
              status: true,
            },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take,
      }),
      prisma.conversation.count({ where }),
    ]);

    // Transform for frontend
    const transformed = conversations.map((conv) => ({
      id: conv.id,
      customer: conv.customer,
      state: conv.state,
      isActive: conv.isActive,
      lastMessage: conv.messages[0] || null,
      lastMessageAt: conv.lastMessageAt,
      hasActiveRide: conv.ride !== null,
      rideId: conv.ride?.id,
      rideStatus: conv.ride?.status,
      createdAt: conv.createdAt,
    }));

    res.json({
      success: true,
      data: transformed,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching conversations:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single conversation with all messages
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        customer: true,
        messages: {
          orderBy: { createdAt: 'asc' },
        },
        ride: {
          include: {
            events: {
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });

    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    res.json({ success: true, data: conversation });
  } catch (error: any) {
    logger.error('Error fetching conversation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get messages for a conversation
router.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '50' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
      prisma.message.count({ where: { conversationId: id } }),
    ]);

    res.json({
      success: true,
      data: messages,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get active conversations count
router.get('/stats/active', async (req: Request, res: Response) => {
  try {
    const [activeCount, todayCount, totalMessages] = await Promise.all([
      prisma.conversation.count({ where: { isActive: true } }),
      prisma.conversation.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      prisma.message.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        activeConversations: activeCount,
        conversationsToday: todayCount,
        messagesToday: totalMessages,
      },
    });
  } catch (error: any) {
    logger.error('Error fetching conversation stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
