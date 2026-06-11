import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { catchAsync } from '../middleware/errorHandler';
import { authenticateToken, optionalAuth, requireRole } from '../middleware/auth';
import { NotFoundError, ForbiddenError, ValidationError } from '../middleware/errorHandler';

export const dedupRouter = Router();

dedupRouter.post('/check', catchAsync(async (req, res) => {
  const { latitude, longitude, observedAt, category } = req.body;

  if (latitude == null || longitude == null || !observedAt || !category) {
    throw new ValidationError('latitude, longitude, observedAt, and category are required');
  }

  const observedDate = new Date(observedAt);
  const radiusKm = 5;
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((latitude * Math.PI) / 180));

  const startTime = new Date(observedDate.getTime() - 24 * 60 * 60 * 1000);
  const endTime = new Date(observedDate.getTime() + 24 * 60 * 60 * 1000);

  const observations = await prisma.observation.findMany({
    where: {
      latitude: { gte: latitude - latDelta, lte: latitude + latDelta },
      longitude: { gte: longitude - lngDelta, lte: longitude + lngDelta },
      observedAt: { gte: startTime, lte: endTime },
      category,
      isPublic: true,
    },
    include: { user: { select: { id: true, displayName: true } } },
  });

  res.json({ duplicates: observations, count: observations.length });
}));

dedupRouter.post('/merge', authenticateToken, catchAsync(async (req, res) => {
  const { sourceId, targetId, reason } = req.body;
  const user = (req as any).user;

  if (!sourceId || !targetId || !reason) {
    throw new ValidationError('sourceId, targetId, and reason are required');
  }

  const source = await prisma.observation.findUnique({ where: { id: sourceId } });
  const target = await prisma.observation.findUnique({ where: { id: targetId } });

  if (!source) throw new NotFoundError('Source observation not found');
  if (!target) throw new NotFoundError('Target observation not found');

  const isOwner = source.userId === user.userId && target.userId === user.userId;
  const isPrivileged = user.role === 'EXPERT' || user.role === 'ADMIN';

  if (!isOwner && !isPrivileged) {
    throw new ForbiddenError('You must own both observations or have EXPERT/ADMIN role');
  }

  const mergeLog = await prisma.$transaction(async (tx) => {
    const log = await tx.mergeLog.create({
      data: {
        sourceObservationId: sourceId,
        targetObservationId: targetId,
        mergedBy: user.userId,
        reason,
      },
    });

    if (target.eventId) {
      await tx.observation.update({
        where: { id: sourceId },
        data: { eventId: target.eventId },
      });
    }

    await tx.media.updateMany({
      where: { observationId: sourceId },
      data: { observationId: targetId },
    });

    await tx.analysis.updateMany({
      where: { observationId: sourceId },
      data: { observationId: targetId },
    });

    await tx.review.updateMany({
      where: { observationId: sourceId },
      data: { observationId: targetId },
    });

    await tx.observation.delete({ where: { id: sourceId } });

    return log;
  });

  const mergedTarget = await prisma.observation.findUnique({
    where: { id: targetId },
    include: { user: { select: { id: true, displayName: true } } },
  });

  res.json({ merged: mergedTarget, mergeLog });
}));

dedupRouter.get('/merge-logs', optionalAuth, catchAsync(async (req, res) => {
  const { observationId } = req.query;

  const where: any = {};
  if (observationId) {
    where.targetObservationId = observationId as string;
  }

  const mergeLogs = await prisma.mergeLog.findMany({
    where,
    include: {
      mergedByUser: { select: { id: true, displayName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(mergeLogs);
}));
