import EventEmitter from "events"
import TypedEmitter from "typed-emitter"

import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCodes } from '../types/errors';
import { SignClient } from '@walletconnect/sign-client';
import { SessionTypes, ISignClient } from '@walletconnect/types';
// @ts-ignore
import { verifyMessage } from 'chia-utils';

declare global {
  namespace Express {
    interface Request {
      walletAddress?: string;
      session?: SessionTypes.Struct;
    }
  }
}

interface SessionDelete { id: number, topic: string; }

type SignClientEvents = {
    session_delete: (t: SessionDelete) => void,
};

let signClient: ISignClient;
function emitter(sc: ISignClient): TypedEmitter<SignClientEvents> {
    return (sc as any);
}

export const initWalletConnect = async () => {
  signClient = await SignClient.init({
    projectId: process.env.WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: 'Chia Gaming',
      description: 'Chia Gaming Platform',
      url: process.env.CLIENT_URL || 'http://localhost:3000',
      icons: [`${process.env.CLIENT_URL}/logo.png`]
    }
  });

  emitter(signClient).on('session_delete', async (t: SessionDelete) => {
    const session = await signClient.session.get(t.topic);
    if (session) {
      await signClient.session.delete(t.topic, {
        code: 6000,
        message: 'Session expired'
      });
    }
  });
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(
        ErrorCodes.AUTH.UNAUTHORIZED,
        'Missing or invalid authorization header',
        401
      );
    }

    const token = authHeader.split(' ')[1];
    const session = await signClient.session.get(token);

    if (!session) {
      throw new AppError(
        ErrorCodes.AUTH.INVALID_TOKEN,
        'Invalid session token',
        401
      );
    }

    const walletAddress = session.namespaces.chia.accounts[0].split(':')[2];
    if (!walletAddress) {
      throw new AppError(
        ErrorCodes.AUTH.WALLET_NOT_CONNECTED,
        'Wallet not connected',
        401
      );
    }

    req.walletAddress = walletAddress;
    req.session = session;
    next();
  } catch (error) {
    next(error);
  }
};

export const verifySignature = async (
  message: string,
  signature: string,
  walletAddress: string
): Promise<boolean> => {
  try {
    const isValid = await verifyMessage(message, signature, walletAddress);
    if (!isValid) {
      throw new AppError(
        ErrorCodes.AUTH.INVALID_SIGNATURE,
        'Invalid signature',
        401
      );
    }
    return true;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      ErrorCodes.AUTH.INVALID_SIGNATURE,
      'Failed to verify signature',
      401
    );
  }
};

export const createSession = async (
  walletAddress: string,
  message: string,
  signature: string
): Promise<string> => {
  try {
    const isValid = await verifySignature(message, signature, walletAddress);
    if (!isValid) {
      throw new AppError(
        ErrorCodes.AUTH.INVALID_SIGNATURE,
        'Invalid signature',
        401
      );
    }

    const session = await (signClient.session as any).create({
      requiredNamespaces: {
        chia: {
          methods: ['chia_signMessage'],
          chains: ['chia:mainnet'],
          events: []
        }
      },
      metadata: {
        name: 'Chia Gaming',
        description: 'Chia Gaming Platform',
        url: process.env.CLIENT_URL || 'http://localhost:3000',
        icons: [`${process.env.CLIENT_URL}/logo.png`]
      }
    });

    return session.topic;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      ErrorCodes.AUTH.INVALID_SIGNATURE,
      'Failed to create session',
      401
    );
  }
};

export const deleteSession = async (topic: string): Promise<void> => {
  try {
    await signClient.session.delete(topic, {
      code: 6000,
      message: 'User disconnected'
    });
  } catch (error) {
    throw new AppError(
      ErrorCodes.AUTH.INVALID_TOKEN,
      'Failed to delete session',
      401
    );
  }
};

export const refreshSession = async (topic: string): Promise<void> => {
  try {
    const session = await signClient.session.get(topic);
    if (!session) {
      throw new AppError(
        ErrorCodes.AUTH.INVALID_TOKEN,
        'Session not found',
        401
      );
    }

    await signClient.session.update(topic, {
      metadata: {
        name: 'Chia Gaming',
        description: 'Chia Gaming Platform',
        url: process.env.CLIENT_URL || 'http://localhost:3000',
        icons: [`${process.env.CLIENT_URL}/logo.png`]
      }
    } as any);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      ErrorCodes.AUTH.INVALID_TOKEN,
      'Failed to refresh session',
      401
    );
  }
};
