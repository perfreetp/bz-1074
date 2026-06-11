import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken, optionalAuth } from '../middleware/auth';
import { catchAsync, NotFoundError, ForbiddenError, ValidationError } from '../middleware/errorHandler';

export const observationRouter = Router();

observationRouter.post(
  '/',
  authenticateToken,
  catchAsync(async (req, res) => {
    const { title, description, latitude, longitude, altitude, observedAt, category, isPublic } = req.body;

    if (!title || !description || latitude == null || longitude == null || !observedAt || !category) {
      throw new ValidationError('Missing required fields: title, description, latitude, longitude, observedAt, category');
    }

    const validCategories = ['UFO', 'CELEBRITY_SIGNAL', 'ANOMALY', 'TRACE', 'OTHER'];
    if (!validCategories.includes(category)) {
      throw new ValidationError(`Invalid category. Must be one of: ${validCategories.join(', ')}`);
    }

    const observation = await prisma.observation.create({
      data: {
        title,
        description,
        latitude,
        longitude,
        altitude,
        observedAt: new Date(observedAt),
        category,
        isPublic: isPublic ?? true,
        userId: (req as any).user.userId,
        status: 'PENDING',
        credibilityScore: 0,
      },
    });

    res.status(201).json(observation);
  })
);

observationRouter.get(
  '/nearby',
  optionalAuth,
  catchAsync(async (req, res) => {
    const latitude = parseFloat(req.query.latitude as string);
    const longitude = parseFloat(req.query.longitude as string);
    const radiusKm = parseFloat((req.query.radiusKm as string) || '50');
    const category = req.query.category as string | undefined;
    const status = req.query.status as string | undefined;
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '20', 10);

    if (isNaN(latitude) || isNaN(longitude)) {
      throw new ValidationError('latitude and longitude are required and must be valid numbers');
    }

    const userId = (req as any).user?.userId;
    const latOffset = radiusKm / 111;
    const lngOffset = radiusKm / (111 * Math.cos((latitude * Math.PI) / 180));

    const minLat = latitude - latOffset;
    const maxLat = latitude + latOffset;
    const minLng = longitude - lngOffset;
    const maxLng = longitude + lngOffset;

    const where: any = {
      latitude: { gte: minLat, lte: maxLat },
      longitude: { gte: minLng, lte: maxLng },
      ...(category && { category }),
      ...(status && { status }),
      ...(userId
        ? { OR: [{ isPublic: true }, { userId }] }
        : { isPublic: true }),
    };

    const total = await prisma.observation.count({ where });
    const observations = await prisma.observation.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { observedAt: 'desc' },
    });

    res.json({
      data: observations,
      pagination: { page, limit, total },
    });
  })
);

observationRouter.get(
  '/filter',
  optionalAuth,
  catchAsync(async (req, res) => {
    const { startDate, endDate, minLat, maxLat, minLng, maxLng, category, status, isPublic } = req.query;
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const userId = (req as any).user?.userId;

    const where: any = {};

    if (startDate) where.observedAt = { ...where.observedAt, gte: new Date(startDate as string) };
    if (endDate) where.observedAt = { ...where.observedAt, lte: new Date(endDate as string) };
    if (minLat) where.latitude = { ...where.latitude, gte: parseFloat(minLat as string) };
    if (maxLat) where.latitude = { ...where.latitude, lte: parseFloat(maxLat as string) };
    if (minLng) where.longitude = { ...where.longitude, gte: parseFloat(minLng as string) };
    if (maxLng) where.longitude = { ...where.longitude, lte: parseFloat(maxLng as string) };
    if (category) where.category = category;
    if (status) where.status = status;
    if (isPublic !== undefined) {
      where.isPublic = isPublic === 'true';
    } else {
      where.OR = userId
        ? [{ isPublic: true }, { userId }]
        : undefined;
      if (!userId) where.isPublic = true;
    }

    const total = await prisma.observation.count({ where });
    const observations = await prisma.observation.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { observedAt: 'desc' },
    });

    res.json({
      data: observations,
      pagination: { page, limit, total },
    });
  })
);

observationRouter.get(
  '/:id',
  optionalAuth,
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const observation = await prisma.observation.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, displayName: true, reputation: true } },
        media: true,
        analyses: true,
        reviews: true,
      },
    });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    const userId = (req as any).user?.userId;
    if (!observation.isPublic && observation.userId !== userId) {
      throw new ForbiddenError('You do not have access to this observation');
    }

    res.json(observation);
  })
);

observationRouter.put(
  '/:id',
  authenticateToken,
  catchAsync(async (req, res) => {
    const userId = (req as any).user.userId;
    const id = req.params.id as string;
    const observation = await prisma.observation.findUnique({ where: { id } });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (observation.userId !== userId) {
      throw new ForbiddenError('Only the owner can update this observation');
    }

    const { title, description, category, isPublic, status } = req.body;
    const updated = await prisma.observation.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(category !== undefined && { category }),
        ...(isPublic !== undefined && { isPublic }),
        ...(status !== undefined && { status }),
      },
    });

    res.json(updated);
  })
);

observationRouter.delete(
  '/:id',
  authenticateToken,
  catchAsync(async (req, res) => {
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;
    const id = req.params.id as string;
    const observation = await prisma.observation.findUnique({ where: { id } });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (observation.userId !== userId && userRole !== 'ADMIN') {
      throw new ForbiddenError('Only the owner or an admin can delete this observation');
    }

    await prisma.observation.delete({ where: { id } });

    res.status(204).send();
  })
);

observationRouter.patch(
  '/:id/false-positive',
  authenticateToken,
  catchAsync(async (req, res) => {
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;
    const id = req.params.id as string;
    const observation = await prisma.observation.findUnique({ where: { id } });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (observation.userId !== userId && !['EXPERT', 'ADMIN'].includes(userRole)) {
      throw new ForbiddenError('Only the owner or an EXPERT/ADMIN can mark this as false positive');
    }

    const updated = await prisma.observation.update({
      where: { id },
      data: { status: 'FALSE_POSITIVE' },
    });

    res.json(updated);
  })
);
