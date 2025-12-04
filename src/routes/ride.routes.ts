import { Router, Request, Response } from 'express';
import { PrismaClient, RideStatus } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { machineGlobalService } from '../services/machineGlobal.service.js';

const router = Router();
const prisma = new PrismaClient();

// Get all rides with optional filters
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      status,
      customerId,
      dateFrom,
      dateTo,
      page = '1',
      limit = '20',
    } = req.query;

    const where: any = {};

    if (status && status !== 'all') {
      where.status = status as RideStatus;
    }

    if (customerId) {
      where.customerId = customerId as string;
    }

    if (dateFrom || dateTo) {
      where.requestedAt = {};
      if (dateFrom) {
        where.requestedAt.gte = new Date(dateFrom as string);
      }
      if (dateTo) {
        where.requestedAt.lte = new Date(dateTo as string);
      }
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [rides, total] = await Promise.all([
      prisma.ride.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              phoneNumber: true,
              name: true,
            },
          },
          events: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { requestedAt: 'desc' },
        skip,
        take,
      }),
      prisma.ride.count({ where }),
    ]);

    // Transform rides to match frontend format
    const transformedRides = rides.map((ride) => ({
      id: ride.id,
      pickupLocation: ride.originAddress,
      dropoffLocation: ride.destinationAddress,
      estimatedPrice: ride.estimatedPrice,
      finalPrice: ride.finalPrice,
      status: mapRideStatus(ride.status),
      timestamp: ride.requestedAt,
      phoneNumber: ride.customer.phoneNumber,
      customerName: ride.customer.name,
      driverName: ride.driverName,
      driverPhone: ride.driverPhone,
      driverVehicle: ride.driverVehicle,
      driverPlate: ride.driverPlate,
      category: ride.category,
      machineRideId: ride.machineRideId,
      events: ride.events,
    }));

    res.json({
      success: true,
      data: transformedRides,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching rides:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single ride by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        customer: true,
        conversation: {
          include: {
            messages: {
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!ride) {
      return res.status(404).json({ success: false, error: 'Ride not found' });
    }

    res.json({ success: true, data: ride });
  } catch (error: any) {
    logger.error('Error fetching ride:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get ride logs (messages + events)
router.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({
      where: { id },
      include: {
        conversation: {
          include: {
            messages: {
              orderBy: { createdAt: 'asc' },
            },
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!ride) {
      return res.status(404).json({ success: false, error: 'Ride not found' });
    }

    // Combine messages and events into unified log format
    const logs: Array<{
      id: string;
      rideId: string;
      type: 'message' | 'api' | 'error';
      content: string;
      timestamp: Date;
      direction?: string;
      severity?: string;
    }> = [];

    // Add messages
    if (ride.conversation) {
      for (const msg of ride.conversation.messages) {
        logs.push({
          id: msg.id,
          rideId: ride.id,
          type: 'message',
          content: msg.content,
          timestamp: msg.createdAt,
          direction: msg.direction.toLowerCase(),
        });
      }
    }

    // Add events
    for (const event of ride.events) {
      logs.push({
        id: event.id,
        rideId: ride.id,
        type: event.eventType === 'ERROR' ? 'error' : 'api',
        content: `${event.title}${event.description ? ': ' + event.description : ''}`,
        timestamp: event.createdAt,
        severity: event.eventType.toLowerCase(),
      });
    }

    // Sort by timestamp
    logs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    res.json({ success: true, data: logs });
  } catch (error: any) {
    logger.error('Error fetching ride logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh ride status from Machine Global
router.post('/:id/refresh', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const ride = await prisma.ride.findUnique({ where: { id } });

    if (!ride) {
      return res.status(404).json({ success: false, error: 'Ride not found' });
    }

    if (!ride.machineRideId) {
      return res.status(400).json({ success: false, error: 'No Machine Global ID' });
    }

    // Fetch status from Machine Global
    const machineStatus = await machineGlobalService.getRideStatus(ride.machineRideId);

    if (machineStatus.success && machineStatus.corrida) {
      const updatedRide = await prisma.ride.update({
        where: { id },
        data: {
          status: mapMachineStatus(machineStatus.corrida.status) as RideStatus,
          driverName: machineStatus.corrida.motorista?.nome || ride.driverName,
          driverPhone: machineStatus.corrida.motorista?.telefone || ride.driverPhone,
        },
      });

      res.json({ success: true, data: updatedRide });
    } else {
      res.json({ success: false, error: 'Failed to fetch status from Machine Global' });
    }
  } catch (error: any) {
    logger.error('Error refreshing ride:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel a ride
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const ride = await prisma.ride.findUnique({ where: { id } });

    if (!ride) {
      return res.status(404).json({ success: false, error: 'Ride not found' });
    }

    // Cancel in Machine Global if we have an ID
    if (ride.machineRideId) {
      await machineGlobalService.cancelRide(ride.machineRideId, reason || 'Cancelado pelo operador');
    }

    // Update local status
    const updatedRide = await prisma.ride.update({
      where: { id },
      data: {
        status: RideStatus.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    // Log event
    await prisma.rideEvent.create({
      data: {
        rideId: id,
        eventType: 'WARNING',
        title: 'Corrida cancelada',
        description: reason || 'Cancelado pelo operador',
      },
    });

    res.json({ success: true, data: updatedRide });
  } catch (error: any) {
    logger.error('Error cancelling ride:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper: Map internal status to frontend format
function mapRideStatus(status: RideStatus): string {
  const statusMap: Record<RideStatus, string> = {
    REQUESTED: 'requested',
    DISTRIBUTING: 'requested',
    AWAITING_ACCEPT: 'requested',
    PENDING: 'requested',
    NO_DRIVER: 'no-driver',
    ACCEPTED: 'accepted',
    DRIVER_ARRIVING: 'accepted',
    DRIVER_ARRIVED: 'accepted',
    IN_PROGRESS: 'accepted',
    COMPLETED: 'accepted',
    CANCELLED: 'failed',
    AWAITING_PAYMENT: 'accepted',
    FAILED: 'failed',
  };
  return statusMap[status] || 'requested';
}

// Helper: Map Machine Global status to our status
function mapMachineStatus(status: string): string {
  const statusMap: Record<string, string> = {
    'D': 'DISTRIBUTING',
    'G': 'AWAITING_ACCEPT',
    'P': 'PENDING',
    'N': 'NO_DRIVER',
    'A': 'ACCEPTED',
    'E': 'IN_PROGRESS',
    'F': 'COMPLETED',
    'C': 'CANCELLED',
    'R': 'AWAITING_PAYMENT',
  };
  return statusMap[status] || 'REQUESTED';
}

export default router;
