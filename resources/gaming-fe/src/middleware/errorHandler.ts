import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCodes } from '../types/errors';
import { ZodError } from 'zod';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      code: ErrorCodes.VALIDATION.INVALID_INPUT,
      message: 'Validation error',
      details: err.errors,
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      code: ErrorCodes.AUTH.UNAUTHORIZED,
      message: 'Unauthorized',
    });
  }

  return res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  });
};
