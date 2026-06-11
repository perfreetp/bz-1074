import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { catchAsync } from '../middleware/errorHandler';
import { optionalAuth } from '../middleware/auth';

export const statsRouter = Router();

function isResearcher(role: string): boolean {
  return ['RESEARCHER', 'EXPERT', 'ADMIN'].includes(role);
}

function getStartDate(period: string): Date | null {
  const now = new Date();
  switch (period) {
    case 'weekly':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case 'monthly':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

statsRouter.get(
  '/heatmap',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const { category, startDate, endDate, gridSize: gridSizeParam } = req.query;
    const gridSize = parseFloat(gridSizeParam as string) || 1;
    const user = (req as any).user;
    const researcher = user && isResearcher(user.role);

    const where: any = {};
    if (!researcher) where.isPublic = true;
    if (category) where.category = category as string;
    if (startDate || endDate) {
      where.observedAt = {};
      if (startDate) where.observedAt.gte = new Date(startDate as string);
      if (endDate) where.observedAt.lte = new Date(endDate as string);
    }

    const observations = await prisma.observation.findMany({
      where,
      select: { latitude: true, longitude: true },
    });

    const gridMap = new Map<string, { lat: number; lng: number; count: number }>();

    for (const obs of observations) {
      const lat = Math.round(obs.latitude / gridSize) * gridSize;
      const lng = Math.round(obs.longitude / gridSize) * gridSize;
      const key = `${lat},${lng}`;
      const existing = gridMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        gridMap.set(key, { lat, lng, count: 1 });
      }
    }

    res.json({
      grid: Array.from(gridMap.values()),
      metadata: {
        totalObservations: observations.length,
        gridSize,
      },
    });
  })
);

statsRouter.get(
  '/contributions',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const { period = 'alltime', limit: limitParam } = req.query;
    const limit = Math.max(1, Math.min(100, parseInt(limitParam as string, 10) || 20));
    const user = (req as any).user;
    const researcher = user && isResearcher(user.role);
    const startDate = getStartDate(period as string);

    const where: any = {};
    if (!researcher) where.isPublic = true;
    if (startDate) where.observedAt = { gte: startDate };

    const rankings = await prisma.observation.groupBy({
      by: ['userId'],
      where,
      _count: { id: true },
      _sum: { credibilityScore: true },
      orderBy: { _count: { id: 'desc' } },
      take: limit,
    });

    const userIds = rankings.map((r) => r.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, displayName: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u.displayName]));

    const result = rankings.map((r) => ({
      userId: r.userId,
      displayName: userMap.get(r.userId) || 'Unknown',
      observationCount: r._count.id,
      totalCredibility: r._sum.credibilityScore || 0,
    }));

    res.json({ rankings: result, period: period as string });
  })
);

statsRouter.get(
  '/overview',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const researcher = user && isResearcher(user.role);
    const obsWhere = researcher ? {} : { isPublic: true };

    const [totalObservations, totalEvents, activeGroups, totalReviews, byCategory, byStatus, aggCredibility] =
      await Promise.all([
        prisma.observation.count({ where: obsWhere }),
        prisma.event.count({ where: { status: 'ACTIVE' } }),
        prisma.group.count(),
        prisma.review.count(),
        prisma.observation.groupBy({
          by: ['category'],
          where: obsWhere,
          _count: { category: true },
        }),
        prisma.observation.groupBy({
          by: ['status'],
          where: obsWhere,
          _count: { status: true },
        }),
        prisma.observation.aggregate({
          where: obsWhere,
          _avg: { credibilityScore: true },
        }),
      ]);

    const categoryCounts: Record<string, number> = {};
    for (const c of byCategory) {
      categoryCounts[c.category] = c._count.category;
    }

    const statusCounts: Record<string, number> = {};
    for (const s of byStatus) {
      statusCounts[s.status] = s._count.status;
    }

    res.json({
      totalObservations,
      totalEvents,
      activeGroups,
      totalReviews,
      byCategory: categoryCounts,
      byStatus: statusCounts,
      averageCredibility: aggCredibility._avg.credibilityScore || 0,
    });
  })
);

statsRouter.get(
  '/timeline',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const { startDate, endDate, interval = 'day' } = req.query;
    const user = (req as any).user;
    const researcher = user && isResearcher(user.role);

    const where: any = {};
    if (!researcher) where.isPublic = true;
    if (startDate || endDate) {
      where.observedAt = {};
      if (startDate) where.observedAt.gte = new Date(startDate as string);
      if (endDate) where.observedAt.lte = new Date(endDate as string);
    }

    const observations = await prisma.observation.findMany({
      where,
      select: { observedAt: true },
    });

    const grouped = new Map<string, number>();

    for (const obs of observations) {
      const d = obs.observedAt;
      let key: string;
      if (interval === 'month') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      } else if (interval === 'week') {
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
        key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      } else {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }

    const timeline = Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    res.json({ timeline });
  })
);
