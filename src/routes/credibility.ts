import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { catchAsync, NotFoundError, ForbiddenError } from '../middleware/errorHandler';
import { authenticateToken, optionalAuth, requireRole } from '../middleware/auth';

export const credibilityRouter = Router();

credibilityRouter.get('/:observationId', optionalAuth, catchAsync(async (req, res) => {
  const observationId = req.params.observationId as string;
  const user = (req as any).user;

  const observation = await prisma.observation.findUnique({
    where: { id: observationId },
    include: {
      user: { select: { id: true, displayName: true, reputation: true } },
      media: true,
      analyses: true,
    },
  });

  if (!observation) throw new NotFoundError('Observation not found');

  if (!observation.isPublic && (!user || (user.role === 'PUBLIC' && observation.userId !== user.userId))) {
    throw new ForbiddenError('You do not have access to this observation');
  }

  res.json({ observation, credibilityScore: observation.credibilityScore });
}));

credibilityRouter.post('/:observationId/calculate', authenticateToken, requireRole('EXPERT', 'ADMIN'), catchAsync(async (req, res) => {
  const observationId = req.params.observationId as string;

  const observation = await prisma.observation.findUnique({
    where: { id: observationId },
    include: {
      user: { select: { reputation: true } },
      media: true,
      analyses: true,
    },
  });

  if (!observation) throw new NotFoundError('Observation not found');

  const breakdown = {
    base: 30,
    media: 0,
    expertAnalysis: 0,
    multipleWitness: 0,
    reputation: 0,
    detail: 0,
    category: 0,
  };

  if (observation.media.length > 0) {
    breakdown.media = 20;
  }

  if (observation.analyses.some((a: any) => a.type === 'EXPERT')) {
    breakdown.expertAnalysis = 15;
  }

  const radiusKm = 5;
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((observation.latitude * Math.PI) / 180));
  const startTime = new Date(observation.observedAt.getTime() - 24 * 60 * 60 * 1000);
  const endTime = new Date(observation.observedAt.getTime() + 24 * 60 * 60 * 1000);

  const nearbyCount = await prisma.observation.count({
    where: {
      id: { not: observationId as string },
      latitude: { gte: observation.latitude - latDelta, lte: observation.latitude + latDelta },
      longitude: { gte: observation.longitude - lngDelta, lte: observation.longitude + lngDelta },
      observedAt: { gte: startTime, lte: endTime },
    },
  });

  if (nearbyCount > 0) {
    breakdown.multipleWitness = 10;
  }

  if ((observation as any).user.reputation > 50) {
    breakdown.reputation = 10;
  }

  if (observation.description.length > 200) {
    breakdown.detail = 10;
  }

  if (observation.category !== 'OTHER') {
    breakdown.category = 5;
  }

  const rawScore = breakdown.base + breakdown.media + breakdown.expertAnalysis + breakdown.multipleWitness + breakdown.reputation + breakdown.detail + breakdown.category;
  const score = Math.min(rawScore, 100);

  await prisma.observation.update({
    where: { id: observationId },
    data: { credibilityScore: score },
  });

  res.json({ score, breakdown });
}));

credibilityRouter.get('/ranking', optionalAuth, catchAsync(async (req, res) => {
  const { category, limit: limitStr } = req.query;
  const user = (req as any).user;
  const limit = Math.min(parseInt(limitStr as string) || 20, 100);

  const where: any = {};

  if (category) {
    where.category = category as string;
  }

  if (!user || user.role === 'PUBLIC') {
    where.isPublic = true;
  }

  const observations = await prisma.observation.findMany({
    where,
    orderBy: { credibilityScore: 'desc' },
    take: limit,
    include: {
      user: { select: { id: true, displayName: true, reputation: true } },
    },
  });

  res.json(observations);
}));
