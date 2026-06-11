import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken, optionalAuth, requireRole } from '../middleware/auth';
import { catchAsync, NotFoundError, ForbiddenError, ValidationError } from '../middleware/errorHandler';

export const collaborationRouter = Router();

collaborationRouter.post(
  '/reviews/request/:observationId',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const observation = await prisma.observation.findUnique({ where: { id: observationId } });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (!['PENDING', 'REVIEWING'].includes(observation.status)) {
      throw new ValidationError('Observation must be in PENDING or REVIEWING status to request review');
    }

    const updated = await prisma.observation.update({
      where: { id: observationId },
      data: { status: 'REVIEWING' },
    });

    const experts = await prisma.user.findMany({ where: { role: 'EXPERT' } });

    if (experts.length > 0) {
      await prisma.notification.createMany({
        data: experts.map((expert) => ({
          userId: expert.id,
          type: 'REVIEW_REQUEST',
          title: 'Review Requested',
          content: `A review has been requested for observation: ${observation.title}`,
          relatedId: observationId,
        })),
      });
    }

    res.json(updated);
  })
);

collaborationRouter.post(
  '/reviews/:observationId',
  authenticateToken,
  requireRole('EXPERT', 'ADMIN'),
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const user = (req as any).user;
    const { opinion, comment } = req.body;

    if (!['CONFIRMED', 'REJECTED', 'NEEDS_MORE_INFO'].includes(opinion)) {
      throw new ValidationError('Invalid opinion value');
    }

    const observation = await prisma.observation.findUnique({ where: { id: observationId } });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    const review = await prisma.review.create({
      data: {
        observationId,
        reviewerId: user.userId,
        opinion,
        comment,
      },
    });

    let newStatus: string | null = null;
    if (opinion === 'CONFIRMED') {
      newStatus = 'CONFIRMED';
    } else if (opinion === 'REJECTED') {
      newStatus = 'FALSE_POSITIVE';
    }

    if (newStatus) {
      await prisma.observation.update({
        where: { id: observationId },
        data: { status: newStatus },
      });

      await prisma.notification.create({
        data: {
          userId: observation.userId,
          type: 'STATUS_CHANGE',
          title: 'Observation Status Updated',
          content: `Your observation "${observation.title}" has been updated to ${newStatus}`,
          relatedId: observationId,
        },
      });
    }

    res.json(review);
  })
);

collaborationRouter.get(
  '/reviews/:observationId',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const user = (req as any).user;

    const observation = await prisma.observation.findUnique({ where: { id: observationId } });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (!observation.isPublic && (!user || (user.userId !== observation.userId && user.role !== 'EXPERT' && user.role !== 'ADMIN'))) {
      throw new ForbiddenError('You do not have access to this observation');
    }

    const reviews = await prisma.review.findMany({
      where: { observationId },
      include: {
        reviewer: {
          select: { id: true, displayName: true, role: true },
        },
      },
    });

    res.json(reviews);
  })
);

collaborationRouter.post(
  '/groups',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const user = (req as any).user;
    const { name, description } = req.body;

    if (!name) {
      throw new ValidationError('Group name is required');
    }

    const group = await prisma.group.create({
      data: {
        name,
        description: description || '',
        members: {
          create: {
            userId: user.userId,
            role: 'LEADER',
          },
        },
      },
    });

    res.status(201).json(group);
  })
);

collaborationRouter.get(
  '/groups',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const [groups, total] = await Promise.all([
      prisma.group.findMany({
        skip,
        take: limit,
        include: {
          _count: {
            select: { members: true },
          },
        },
      }),
      prisma.group.count(),
    ]);

    res.json({
      data: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        createdAt: g.createdAt,
        memberCount: g._count.members,
      })),
      page,
      limit,
      total,
    });
  })
);

collaborationRouter.post(
  '/groups/:groupId/join',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const user = (req as any).user;

    const group = await prisma.group.findUnique({ where: { id: groupId } });

    if (!group) {
      throw new NotFoundError('Group not found');
    }

    await prisma.groupMember.create({
      data: {
        groupId,
        userId: user.userId,
        role: 'MEMBER',
      },
    });

    res.status(201).json({ message: 'Joined group successfully' });
  })
);

collaborationRouter.delete(
  '/groups/:groupId/leave',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const user = (req as any).user;

    await prisma.groupMember.deleteMany({
      where: {
        groupId,
        userId: user.userId,
      },
    });

    res.status(204).send();
  })
);

collaborationRouter.post(
  '/groups/:groupId/tasks',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const user = (req as any).user;
    const { title, description, assigneeId, dueDate } = req.body;

    if (!title) {
      throw new ValidationError('Task title is required');
    }

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: user.userId } },
    });

    if (!membership) {
      throw new ForbiddenError('You are not a member of this group');
    }

    const task = await prisma.task.create({
      data: {
        groupId,
        title,
        description: description || '',
        assigneeId: assigneeId || null,
        status: 'PENDING',
        dueDate: dueDate ? new Date(dueDate) : null,
      },
    });

    if (assigneeId) {
      await prisma.notification.create({
        data: {
          userId: assigneeId,
          type: 'TASK_ASSIGNED',
          title: 'Task Assigned',
          content: `You have been assigned a new task: ${title}`,
          relatedId: task.id,
        },
      });
    }

    res.status(201).json(task);
  })
);

collaborationRouter.get(
  '/groups/:groupId/tasks',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const user = (req as any).user;
    const { status, assigneeId } = req.query;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: user.userId } },
    });

    if (!membership) {
      throw new ForbiddenError('You are not a member of this group');
    }

    const where: any = { groupId };
    if (status) where.status = status as string;
    if (assigneeId) where.assigneeId = assigneeId as string;

    const tasks = await prisma.task.findMany({ where });

    res.json(tasks);
  })
);

collaborationRouter.patch(
  '/groups/:groupId/tasks/:taskId',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const groupId = req.params.groupId as string;
    const taskId = req.params.taskId as string;
    const user = (req as any).user;
    const { status, assigneeId } = req.body;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: user.userId } },
    });

    if (!membership) {
      throw new ForbiddenError('You are not a member of this group');
    }

    const task = await prisma.task.findFirst({ where: { id: taskId, groupId } });

    if (!task) {
      throw new NotFoundError('Task not found');
    }

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        ...(status !== undefined && { status }),
        ...(assigneeId !== undefined && { assigneeId }),
      },
    });

    res.json(updated);
  })
);
