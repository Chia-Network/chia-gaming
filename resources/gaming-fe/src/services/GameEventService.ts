import type { Socket } from 'socket.io-client';
import { AppError, ErrorCodes } from '../types/errors';
import { GameType } from '../types/lobby';

interface GameEvent {
  type: string;
  data: any;
  timestamp: Date;
}

interface GameEventHandlers {
  [key: string]: ((data: any) => void)[];
}

interface GameEventSubscription {
  eventType: string;
  handler: (data: any) => void;
}

export class GameEventService {
  private static instance: GameEventService;
  private socket: Socket | null = null;
  private eventHandlers: GameEventHandlers = {};
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private readonly reconnectDelay: number = 1000;
  private readonly eventQueue: GameEvent[] = [];
  private readonly maxQueueSize: number = 100;

  private constructor() {}

  public static getInstance(): GameEventService {
    if (!GameEventService.instance) {
      GameEventService.instance = new GameEventService();
    }
    return GameEventService.instance;
  }

  public connect(url: string, options: any = {}): void {
    if (this.socket?.connected) {
      return;
    }

    const { io } = require('socket.io-client');
    this.socket = io(url, {
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
      ...options
    });

    this.setupSocketListeners();
  }

  private setupSocketListeners(): void {
    if (!this.socket) {
      return;
    }

    this.socket.on('connect', () => {
      console.log('Connected to game server');
      this.reconnectAttempts = 0;
      this.processEventQueue();
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('Disconnected from game server:', reason);
      if (reason === 'io server disconnect') {
        this.socket?.connect();
      }
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('Connection error:', error);
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        throw new AppError(
          ErrorCodes.SYSTEM.SERVICE_UNAVAILABLE,
          'Failed to connect to game server',
          503
        );
      }
    });

    this.socket.on('game_event', (event: GameEvent) => {
      this.handleGameEvent(event);
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  public subscribe(eventType: string, handler: (data: any) => void): GameEventSubscription {
    if (!this.eventHandlers[eventType]) {
      this.eventHandlers[eventType] = [];
    }
    this.eventHandlers[eventType].push(handler);

    return {
      eventType,
      handler
    };
  }

  public unsubscribe(subscription: GameEventSubscription): void {
    const handlers = this.eventHandlers[subscription.eventType];
    if (handlers) {
      const index = handlers.indexOf(subscription.handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  public emit(eventType: string, data: any): void {
    if (!this.socket?.connected) {
      this.queueEvent(eventType, data);
      return;
    }

    this.socket.emit('game_event', {
      type: eventType,
      data,
      timestamp: new Date()
    });
  }

  private queueEvent(eventType: string, data: any): void {
    const event: GameEvent = {
      type: eventType,
      data,
      timestamp: new Date()
    };

    this.eventQueue.push(event);
    if (this.eventQueue.length > this.maxQueueSize) {
      this.eventQueue.shift();
    }
  }

  private processEventQueue(): void {
    while (this.eventQueue.length > 0 && this.socket?.connected) {
      const event = this.eventQueue.shift();
      if (event) {
        this.emit(event.type, event.data);
      }
    }
  }

  private handleGameEvent(event: GameEvent): void {
    const handlers = this.eventHandlers[event.type];
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(event.data);
        } catch (error) {
          console.error('Error handling game event:', error);
        }
      });
    }
  }

  public joinGameRoom(gameId: string): void {
    if (!this.socket?.connected) {
      throw new AppError(
        ErrorCodes.SYSTEM.SERVICE_UNAVAILABLE,
        'Not connected to game server',
        503
      );
    }

    this.socket.emit('join_game_room', { gameId });
  }

  public leaveGameRoom(gameId: string): void {
    if (!this.socket?.connected) {
      return;
    }

    this.socket.emit('leave_game_room', { gameId });
  }

  public joinLobby(gameType: GameType): void {
    if (!this.socket?.connected) {
      throw new AppError(
        ErrorCodes.SYSTEM.SERVICE_UNAVAILABLE,
        'Not connected to game server',
        503
      );
    }

    this.socket.emit('join_lobby', { gameType });
  }

  public leaveLobby(gameType: GameType): void {
    if (!this.socket?.connected) {
      return;
    }

    this.socket.emit('leave_lobby', { gameType });
  }

  public sendChatMessage(roomId: string, message: string): void {
    if (!this.socket?.connected) {
      throw new AppError(
        ErrorCodes.SYSTEM.SERVICE_UNAVAILABLE,
        'Not connected to game server',
        503
      );
    }

    this.socket.emit('chat_message', {
      roomId,
      message,
      timestamp: new Date()
    });
  }

  public sendGameAction(gameId: string, action: string, data: any): void {
    if (!this.socket?.connected) {
      throw new AppError(
        ErrorCodes.SYSTEM.SERVICE_UNAVAILABLE,
        'Not connected to game server',
        503
      );
    }

    this.socket.emit('game_action', {
      gameId,
      action,
      data,
      timestamp: new Date()
    });
  }

  public requestGameState(gameId: string): void {
    if (!this.socket?.connected) {
      throw new AppError(
        ErrorCodes.SYSTEM.SERVICE_UNAVAILABLE,
        'Not connected to game server',
        503
      );
    }

    this.socket.emit('request_game_state', { gameId });
  }

  public isConnected(): boolean {
    return this.socket?.connected || false;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  public getEventQueueSize(): number {
    return this.eventQueue.length;
  }

  public clearEventQueue(): void {
    this.eventQueue.length = 0;
  }
} 
