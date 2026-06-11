import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { observationRouter } from './routes/observation';
import { mediaRouter } from './routes/media';
import { dedupRouter } from './routes/dedup';
import { credibilityRouter } from './routes/credibility';
import { eventRouter } from './routes/event';
import { collaborationRouter } from './routes/collaboration';
import { notificationRouter } from './routes/notification';
import { statsRouter } from './routes/stats';
import { AppError } from './middleware/errorHandler';

dotenv.config();

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

app.use('/api/observations', observationRouter);
app.use('/api/media', mediaRouter);
app.use('/api/dedup', dedupRouter);
app.use('/api/credibility', credibilityRouter);
app.use('/api/events', eventRouter);
app.use('/api/collaboration', collaborationRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/stats', statsRouter);

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'alien-discovery-backend',
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, _res, next) => {
  next(new AppError(404, 'Route not found'));
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message, status: err.status });
  }

  const statusCode = 500;
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  return res.status(statusCode).json({ error: message, status: 'error' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export { app };
