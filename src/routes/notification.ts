import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { catchAsync } from '../middleware/errorHandler';
import { authenticateToken } from '../middleware/auth';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';

export const notificationRouter = Router();

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

notificationRouter.post(
  '/subscriptions',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const { regionName, latitude, longitude, radiusKm } = req.body;
    const userId = (req as any).user.userId;

    if (!regionName || latitude == null || longitude == null || radiusKm == null) {
      throw new ValidationError('regionName, latitude, longitude, and radiusKm are required');
    }

    const subscription = await prisma.subscription.create({
      data: { userId, regionName, latitude, longitude, radiusKm },
    });

    res.status(201).json(subscription);
  })
);

notificationRouter.get(
  '/subscriptions',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;

    const subscriptions = await prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(subscriptions);
  })
);

notificationRouter.delete(
  '/subscriptions/:id',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const id = req.params.id as string;

    const subscription = await prisma.subscription.findUnique({ where: { id } });

    if (!subscription) {
      throw new NotFoundError('Subscription not found');
    }

    if (subscription.userId !== userId) {
      throw new NotFoundError('Subscription not found');
    }

    await prisma.subscription.delete({ where: { id } });

    res.status(204).send();
  })
);

notificationRouter.get(
  '/',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const { type, isRead, page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { userId };
    if (type) where.type = type as string;
    if (isRead !== undefined) where.isRead = isRead === 'true';

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({
      notifications,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  })
);

notificationRouter.patch(
  '/:id/read',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const id = req.params.id as string;

    const notification = await prisma.notification.findUnique({ where: { id } });

    if (!notification || notification.userId !== userId) {
      throw new NotFoundError('Notification not found');
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });

    res.json(updated);
  })
);

notificationRouter.patch(
  '/read-all',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;

    const result = await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    res.json({ count: result.count });
  })
);

notificationRouter.get(
  '/check-alerts',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;

    const subscriptions = await prisma.subscription.findMany({ where: { userId } });

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentObservations = await prisma.observation.findMany({
      where: { createdAt: { gte: twentyFourHoursAgo } },
    });

    let alertsCreated = 0;

    for (const sub of subscriptions) {
      const matchingObservations = recentObservations.filter((obs) => {
        const distance = haversineKm(sub.latitude, sub.longitude, obs.latitude, obs.longitude);
        return distance <= sub.radiusKm;
      });

      for (const obs of matchingObservations) {
        const existing = await prisma.notification.findFirst({
          where: { userId, relatedId: obs.id },
        });

        if (!existing) {
          await prisma.notification.create({
            data: {
              userId,
              type: 'REGIONAL_ALERT',
              title: `New observation near ${sub.regionName}`,
              content: `Observation "${obs.title}" was reported within ${sub.radiusKm}km of your subscribed region "${sub.regionName}".`,
              relatedId: obs.id,
            },
          });
          alertsCreated++;
        }
      }
    }

    res.json({ alertsCreated });
  })
);
