import { v4 as uuidv4 } from 'uuid';
import { AppError, ErrorCodes } from '../types/errors';
import { Player } from '../types/lobby';

interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string;
  playerName: string;
  content: string;
  timestamp: Date;
  type: 'system' | 'player' | 'whisper';
  targetPlayerId?: string;
}

interface ChatRoom {
  id: string;
  name: string;
  type: 'lobby' | 'game';
  players: Set<string>;
  messages: ChatMessage[];
  maxMessages: number;
}

export class ChatService {
  private static instance: ChatService;
  private chatRooms: Map<string, ChatRoom>;
  private playerRooms: Map<string, Set<string>>;
  private readonly MAX_MESSAGES = 100;
  private readonly MESSAGE_RATE_LIMIT = 2000;
  private lastMessageTime: Map<string, number>;

  private constructor() {
    this.chatRooms = new Map();
    this.playerRooms = new Map();
    this.lastMessageTime = new Map();
  }

  public static getInstance(): ChatService {
    if (!ChatService.instance) {
      ChatService.instance = new ChatService();
    }
    return ChatService.instance;
  }

  public createChatRoom(id: string, name: string, type: 'lobby' | 'game'): ChatRoom {
    if (this.chatRooms.has(id)) {
      throw new AppError(
        ErrorCodes.LOBBY.ROOM_EXISTS,
        'Chat room already exists',
        400
      );
    }

    const room: ChatRoom = {
      id,
      name,
      type,
      players: new Set(),
      messages: [],
      maxMessages: this.MAX_MESSAGES
    };

    this.chatRooms.set(id, room);
    return room;
  }

  public joinChatRoom(roomId: string, player: Player): void {
    const room = this.chatRooms.get(roomId);
    if (!room) {
      throw new AppError(
        ErrorCodes.LOBBY.ROOM_NOT_FOUND,
        'Chat room not found',
        404
      );
    }

    room.players.add(player.id);

    let playerRooms = this.playerRooms.get(player.id);
    if (!playerRooms) {
      playerRooms = new Set();
      this.playerRooms.set(player.id, playerRooms);
    }
    playerRooms.add(roomId);

    this.addSystemMessage(roomId, `${player.alias} has joined the chat`);
  }

  public leaveChatRoom(roomId: string, player: Player): void {
    const room = this.chatRooms.get(roomId);
    if (!room) {
      throw new AppError(
        ErrorCodes.LOBBY.ROOM_NOT_FOUND,
        'Chat room not found',
        404
      );
    }

    room.players.delete(player.id);
    
    const playerRooms = this.playerRooms.get(player.id);
    if (playerRooms) {
      playerRooms.delete(roomId);
    }

    this.addSystemMessage(roomId, `${player.alias} has left the chat`);
  }

  public async sendMessage(
    roomId: string,
    player: Player,
    content: string,
    type: 'player' | 'whisper' = 'player',
    targetPlayerId?: string
  ): Promise<ChatMessage> {
    const room = this.chatRooms.get(roomId);
    if (!room) {
      throw new AppError(
        ErrorCodes.LOBBY.ROOM_NOT_FOUND,
        'Chat room not found',
        404
      );
    }

    if (!room.players.has(player.id)) {
      throw new AppError(
        ErrorCodes.LOBBY.PLAYER_NOT_IN_ROOM,
        'Player is not in this chat room',
        403
      );
    }

    const lastMessage = this.lastMessageTime.get(player.id) || 0;
    const now = Date.now();
    if (now - lastMessage < this.MESSAGE_RATE_LIMIT) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Message rate limit exceeded',
        429
      );
    }

    if (!content || content.trim().length === 0) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Message cannot be empty',
        400
      );
    }

    if (content.length > 500) {
      throw new AppError(
        ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
        'Message too long (max 500 characters)',
        400
      );
    }

    if (type === 'whisper') {
      if (!targetPlayerId) {
        throw new AppError(
          ErrorCodes.LOBBY.INVALID_GAME_PARAMS,
          'Target player ID required for whisper',
          400
        );
      }

      if (!room.players.has(targetPlayerId)) {
        throw new AppError(
          ErrorCodes.LOBBY.PLAYER_NOT_FOUND,
          'Target player not in room',
          404
        );
      }
    }

    const message: ChatMessage = {
      id: uuidv4(),
      roomId,
      playerId: player.id,
      playerName: player.alias,
      content: content.trim(),
      timestamp: new Date(),
      type,
      targetPlayerId
    };

    room.messages.push(message);
    if (room.messages.length > room.maxMessages) {
      room.messages.shift();
    }

    this.lastMessageTime.set(player.id, now);

    return message;
  }

  private addSystemMessage(roomId: string, content: string): void {
    const room = this.chatRooms.get(roomId);
    if (!room) return;

    const message: ChatMessage = {
      id: uuidv4(),
      roomId,
      playerId: 'system',
      playerName: 'System',
      content,
      timestamp: new Date(),
      type: 'system'
    };

    room.messages.push(message);
    if (room.messages.length > room.maxMessages) {
      room.messages.shift();
    }
  }

  public getRoomMessages(roomId: string, limit: number = 50): ChatMessage[] {
    const room = this.chatRooms.get(roomId);
    if (!room) {
      throw new AppError(
        ErrorCodes.LOBBY.ROOM_NOT_FOUND,
        'Chat room not found',
        404
      );
    }

    return room.messages.slice(-limit);
  }

  public getPlayerRooms(playerId: string): string[] {
    const rooms = this.playerRooms.get(playerId);
    return rooms ? Array.from(rooms) : [];
  }

  public getRoomPlayers(roomId: string): string[] {
    const room = this.chatRooms.get(roomId);
    if (!room) {
      throw new AppError(
        ErrorCodes.LOBBY.ROOM_NOT_FOUND,
        'Chat room not found',
        404
      );
    }

    return Array.from(room.players);
  }

  public deleteChatRoom(roomId: string): void {
    const room = this.chatRooms.get(roomId);
    if (!room) return;

    for (const playerId of room.players) {
      const playerRooms = this.playerRooms.get(playerId);
      if (playerRooms) {
        playerRooms.delete(roomId);
      }
    }

    this.chatRooms.delete(roomId);
  }

  public clearPlayerMessages(playerId: string): void {
    this.lastMessageTime.delete(playerId);
  }
}
