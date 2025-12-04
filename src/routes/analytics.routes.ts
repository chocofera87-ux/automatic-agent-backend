import { Router, Request, Response } from 'express';
import { PrismaClient, RideStatus } from '@prisma/client';
import { logger } from '../utils/logger.js';

const router = Router();
const prisma = new PrismaClient();

// Get dashboard overview stats
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const thisWeek = new Date(today);
    thisWeek.setDate(thisWeek.getDate() - 7);

    const thisMonth = new Date(today);
    thisMonth.setDate(1);

    // Run all queries in parallel
    const [
      totalRides,
      todayRides,
      weekRides,
      monthRides,
      completedRides,
      cancelledRides,
      activeRides,
      totalCustomers,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      activeConversations,
    ] = await Promise.all([
      prisma.ride.count(),
      prisma.ride.count({ where: { requestedAt: { gte: today } } }),
      prisma.ride.count({ where: { requestedAt: { gte: thisWeek } } }),
      prisma.ride.count({ where: { requestedAt: { gte: thisMonth } } }),
      prisma.ride.count({ where: { status: RideStatus.COMPLETED } }),
      prisma.ride.count({ where: { status: RideStatus.CANCELLED } }),
      prisma.ride.count({
        where: {
          status: {
            in: [
              RideStatus.REQUESTED,
              RideStatus.DISTRIBUTING,
              RideStatus.AWAITING_ACCEPT,
              RideStatus.ACCEPTED,
              RideStatus.DRIVER_ARRIVING,
              RideStatus.DRIVER_ARRIVED,
              RideStatus.IN_PROGRESS,
            ],
          },
        },
      }),
      prisma.customer.count(),
      prisma.ride.aggregate({
        where: {
          requestedAt: { gte: today },
          status: RideStatus.COMPLETED,
        },
        _sum: { finalPrice: true },
      }),
      prisma.ride.aggregate({
        where: {
          requestedAt: { gte: thisWeek },
          status: RideStatus.COMPLETED,
        },
        _sum: { finalPrice: true },
      }),
      prisma.ride.aggregate({
        where: {
          requestedAt: { gte: thisMonth },
          status: RideStatus.COMPLETED,
        },
        _sum: { finalPrice: true },
      }),
      prisma.conversation.count({ where: { isActive: true } }),
    ]);

    const completionRate = totalRides > 0 ? (completedRides / totalRides) * 100 : 0;
    const cancellationRate = totalRides > 0 ? (cancelledRides / totalRides) * 100 : 0;

    res.json({
      success: true,
      data: {
        rides: {
          total: totalRides,
          today: todayRides,
          week: weekRides,
          month: monthRides,
          active: activeRides,
          completed: completedRides,
          cancelled: cancelledRides,
          completionRate: completionRate.toFixed(1),
          cancellationRate: cancellationRate.toFixed(1),
        },
        revenue: {
          today: todayRevenue._sum.finalPrice || 0,
          week: weekRevenue._sum.finalPrice || 0,
          month: monthRevenue._sum.finalPrice || 0,
        },
        customers: {
          total: totalCustomers,
        },
        conversations: {
          active: activeConversations,
        },
      },
    });
  } catch (error: any) {
    logger.error('Error fetching analytics overview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get rides by day for chart
router.get('/rides-by-day', async (req: Request, res: Response) => {
  try {
    const { days = '7' } = req.query;
    const numDays = parseInt(days as string);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - numDays);
    startDate.setHours(0, 0, 0, 0);

    const rides = await prisma.ride.findMany({
      where: {
        requestedAt: { gte: startDate },
      },
      select: {
        requestedAt: true,
        status: true,
        finalPrice: true,
        estimatedPrice: true,
      },
    });

    // Group by day
    const dayData: Record<string, { date: string; rides: number; completed: number; revenue: number }> = {};

    for (let i = 0; i < numDays; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      dayData[dateStr] = { date: dateStr, rides: 0, completed: 0, revenue: 0 };
    }

    for (const ride of rides) {
      const dateStr = ride.requestedAt.toISOString().split('T')[0];
      if (dayData[dateStr]) {
        dayData[dateStr].rides++;
        if (ride.status === RideStatus.COMPLETED) {
          dayData[dateStr].completed++;
          dayData[dateStr].revenue += ride.finalPrice || ride.estimatedPrice || 0;
        }
      }
    }

    const chartData = Object.values(dayData).reverse();

    res.json({
      success: true,
      data: chartData,
    });
  } catch (error: any) {
    logger.error('Error fetching rides by day:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get rides by status distribution
router.get('/rides-by-status', async (req: Request, res: Response) => {
  try {
    const statusCounts = await prisma.ride.groupBy({
      by: ['status'],
      _count: true,
    });

    const data = statusCounts.map((item) => ({
      status: item.status,
      count: item._count,
    }));

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Error fetching rides by status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get rides by category distribution
router.get('/rides-by-category', async (req: Request, res: Response) => {
  try {
    const categoryCounts = await prisma.ride.groupBy({
      by: ['category'],
      _count: true,
    });

    const data = categoryCounts.map((item) => ({
      category: item.category,
      count: item._count,
    }));

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Error fetching rides by category:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get hourly distribution
router.get('/rides-by-hour', async (req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rides = await prisma.ride.findMany({
      where: {
        requestedAt: { gte: today },
      },
      select: {
        requestedAt: true,
      },
    });

    // Initialize hours
    const hourData: Record<number, number> = {};
    for (let i = 0; i < 24; i++) {
      hourData[i] = 0;
    }

    // Count rides per hour
    for (const ride of rides) {
      const hour = ride.requestedAt.getHours();
      hourData[hour]++;
    }

    const data = Object.entries(hourData).map(([hour, count]) => ({
      hour: parseInt(hour),
      label: `${hour.padStart(2, '0')}:00`,
      count,
    }));

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Error fetching rides by hour:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent events
router.get('/recent-events', async (req: Request, res: Response) => {
  try {
    const { limit = '20' } = req.query;

    const events = await prisma.rideEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      include: {
        ride: {
          select: {
            id: true,
            customer: {
              select: {
                phoneNumber: true,
                name: true,
              },
            },
          },
        },
      },
    });

    const transformed = events.map((event) => ({
      id: event.id,
      rideId: event.rideId,
      type: event.eventType.toLowerCase(),
      title: event.title,
      description: event.description,
      timestamp: event.createdAt,
      metadata: event.metadata,
      customerPhone: event.ride?.customer?.phoneNumber,
      customerName: event.ride?.customer?.name,
    }));

    res.json({ success: true, data: transformed });
  } catch (error: any) {
    logger.error('Error fetching recent events:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
