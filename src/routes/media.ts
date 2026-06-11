import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { authenticateToken, optionalAuth } from '../middleware/auth';
import { catchAsync, NotFoundError, ForbiddenError, ValidationError } from '../middleware/errorHandler';

export const mediaRouter = Router();

const uploadDir = path.resolve(config.uploadDir);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({ storage });

mediaRouter.post(
  '/upload/:observationId',
  authenticateToken,
  upload.array('files', 5),
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const userId = (req as any).user.userId;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      throw new ValidationError('No files uploaded');
    }

    const mediaRecords = await Promise.all(
      files.map((file) =>
        prisma.media.create({
          data: {
            filename: file.filename,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
            path: file.path,
            observationId,
            userId,
          },
        })
      )
    );

    res.status(201).json(mediaRecords);
  })
);

mediaRouter.get(
  '/observation/:observationId',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const user = (req as any).user;

    const observation = await prisma.observation.findUnique({
      where: { id: observationId },
    });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (!observation.isPublic && (!user || user.userId !== observation.userId)) {
      throw new ForbiddenError('You do not have access to this observation');
    }

    const media = await prisma.media.findMany({
      where: { observationId },
    });

    res.json(media);
  })
);

mediaRouter.delete(
  '/:id',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = (req as any).user;

    const media = await prisma.media.findUnique({
      where: { id },
    });

    if (!media) {
      throw new NotFoundError('Media not found');
    }

    if (media.userId !== user.userId && user.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to delete this media');
    }

    try {
      fs.unlinkSync(media.path);
    } catch {
      // file may already be deleted
    }

    await prisma.media.delete({
      where: { id },
    });

    res.status(204).send();
  })
);

mediaRouter.post(
  '/:observationId/analysis',
  authenticateToken,
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const userId = (req as any).user.userId;
    const { content, type } = req.body;

    if (!content || !type) {
      throw new ValidationError('Content and type are required');
    }

    if (!['PRELIMINARY', 'DETAILED', 'EXPERT'].includes(type)) {
      throw new ValidationError('Invalid analysis type');
    }

    if (type === 'EXPERT') {
      const user = (req as any).user;
      if (user.role !== 'EXPERT' && user.role !== 'ADMIN') {
        throw new ForbiddenError('Only EXPERT or ADMIN users can create EXPERT analyses');
      }
    }

    const analysis = await prisma.analysis.create({
      data: {
        content,
        type,
        observationId,
        userId,
      },
    });

    res.status(201).json(analysis);
  })
);

mediaRouter.get(
  '/:observationId/analyses',
  optionalAuth,
  catchAsync(async (req: Request, res: Response) => {
    const observationId = req.params.observationId as string;
    const user = (req as any).user;

    const observation = await prisma.observation.findUnique({
      where: { id: observationId },
    });

    if (!observation) {
      throw new NotFoundError('Observation not found');
    }

    if (!observation.isPublic && (!user || user.userId !== observation.userId)) {
      throw new ForbiddenError('You do not have access to this observation');
    }

    const analyses = await prisma.analysis.findMany({
      where: { observationId },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            role: true,
          },
        },
      },
    });

    res.json(analyses);
  })
);
