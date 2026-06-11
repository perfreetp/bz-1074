import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { catchAsync, NotFoundError, ValidationError } from '../middleware/errorHandler';
import { authenticateToken, requireRole, optionalAuth } from '../middleware/auth';

export const eventRouter = Router();

eventRouter.post(
  '/',
  authenticateToken,
  requireRole('RESEARCHER', 'EXPERT', 'ADMIN'),
  catchAsync(async (req, res) => {
    const { name, description, latitude, longitude, radiusKm, startDate, endDate } = req.body;

    if (!name || latitude == null || longitude == null || !startDate) {
      throw new ValidationError('name, latitude, longitude, and startDate are required');
    }

    const event = await prisma.event.create({
      data: {
        name,
        description: description ?? '',
        latitude,
        longitude,
        radiusKm: radiusKm ?? 10,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        status: 'ACTIVE',
      },
    });

    res.status(201).json(event);
  })
);

eventRouter.get(
  '/',
  optionalAuth,
  catchAsync(async (req, res) => {
    const { status, page = '1', limit = '10' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit as string, 10) || 10);

    const where: any = {};
    if (status) {
      where.status = status as string;
    }

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { observations: true },
          },
        },
      }),
      prisma.event.count({ where }),
    ]);

    res.json({ data: events, total, page: pageNum, limit: limitNum });
  })
);

eventRouter.get(
  '/:id',
  optionalAuth,
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const user = (req as any).user;
    const isResearcher = user && ['RESEARCHER', 'EXPERT', 'ADMIN'].includes(user.role);

    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        observations: {
          where: isResearcher ? {} : { isPublic: true },
        },
        _count: {
          select: { observations: true },
        },
      },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    res.json(event);
  })
);

eventRouter.post(
  '/:id/observations/:observationId',
  authenticateToken,
  requireRole('RESEARCHER', 'EXPERT', 'ADMIN'),
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const observationId = req.params.observationId as string;

    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) {
      throw new NotFoundError('Event not found');
    }

    const observation = await prisma.observation.findUnique({ where: { id: observationId } });
    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    const updated = await prisma.observation.update({
      where: { id: observationId },
      data: { eventId: id },
    });

    res.json(updated);
  })
);

eventRouter.delete(
  '/:id/observations/:observationId',
  authenticateToken,
  requireRole('RESEARCHER', 'EXPERT', 'ADMIN'),
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const observationId = req.params.observationId as string;

    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) {
      throw new NotFoundError('Event not found');
    }

    const observation = await prisma.observation.findUnique({ where: { id: observationId } });
    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    await prisma.observation.update({
      where: { id: observationId },
      data: { eventId: null },
    });

    res.status(204).send();
  })
);

eventRouter.post(
  '/:id/summary',
  authenticateToken,
  requireRole('RESEARCHER', 'EXPERT', 'ADMIN'),
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const event = await prisma.event.findUnique({
      where: { id },
      include: { observations: true },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    const observations = event.observations;
    const count = observations.length;

    if (count === 0) {
      const updated = await prisma.event.update({
        where: { id },
        data: { summary: 'No observations linked to this event.' },
      });
      res.json(updated);
      return;
    }

    const dates = observations.map((o: any) => new Date(o.observedAt).getTime());
    const minDate = new Date(Math.min(...dates)).toISOString().split('T')[0];
    const maxDate = new Date(Math.max(...dates)).toISOString().split('T')[0];

    const categoryDist: Record<string, number> = {};
    for (const o of observations) {
      const cat = (o as any).category as string;
      categoryDist[cat] = (categoryDist[cat] || 0) + 1;
    }

    const avgCredibility =
      observations.reduce((sum: number, o: any) => sum + o.credibilityScore, 0) / count;

    const categoryLines = Object.entries(categoryDist)
      .map(([cat, num]) => `${cat}: ${num}`)
      .join(', ');

    const summaryText = [
      `Observation count: ${count}`,
      `Date range: ${minDate} to ${maxDate}`,
      `Category distribution: ${categoryLines}`,
      `Average credibility: ${avgCredibility.toFixed(2)}`,
    ].join('\n');

    const updated = await prisma.event.update({
      where: { id },
      data: { summary: summaryText },
    });

    res.json(updated);
  })
);

eventRouter.put(
  '/:id',
  authenticateToken,
  requireRole('RESEARCHER', 'EXPERT', 'ADMIN'),
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const { name, description, status, endDate } = req.body;

    const existing = await prisma.event.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Event not found');
    }

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;

    const updated = await prisma.event.update({
      where: { id },
      data,
    });

    res.json(updated);
  })
);

eventRouter.delete(
  '/:id',
  authenticateToken,
  requireRole('ADMIN'),
  catchAsync(async (req, res) => {
    const id = req.params.id as string;
    const existing = await prisma.event.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('Event not found');
    }

    await prisma.observation.updateMany({
      where: { eventId: id },
      data: { eventId: null },
    });

    await prisma.event.delete({ where: { id } });

    res.status(204).send();
  })
);
