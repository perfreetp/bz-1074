import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError, ForbiddenError } from './errorHandler';

interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export function authenticateToken(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return next(new UnauthorizedError('Access token is required'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
    (req as any).user = decoded;
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    if (!roles.includes(user.role)) {
      return next(new ForbiddenError(`Role '${user.role}' is not authorized`));
    }

    next();
  };
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
      (req as any).user = decoded;
    } catch {
      // token invalid, proceed without user
    }
  }

  next();
}
