import express, { Application } from "express";
import http, { Server } from "http";
import { Server as IOServer, Socket } from "socket.io";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

export class Pool {
  static conn = new PrismaClient();
}

class SocketServer {
  private app: Application;
  private httpServer: Server;
  private io: IOServer;
  private readonly port: number = 3000;
  private roomTimers: Map<number, NodeJS.Timer> = new Map();
  private activeViewers: Map<string, Set<number>> = new Map();

  constructor(port?: number) {
    this.port = port || 3000;
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.io = new IOServer(this.httpServer, {
      cors: { origin: "*", methods: ["GET", "POST"] }
    });

    this.app.use(cors());
    this.app.use(express.static(__dirname + '/assets'));
    this.app.get("/", (_, res) => res.sendFile(__dirname + "/frontend/index.html"));

    this.configureSocket();
  }

  private configureSocket() {
    this.io.on('connection', (socket: Socket) => {
      console.log('Подключён:', socket.id);
      socket.data.userId = null;

      socket.on('user_created', async (userName: string) => {
        try {
          let user = await Pool.conn.user.findUnique({ where: { name: userName } });

          if (!user) {
            user = await Pool.conn.user.create({
              data: { name: userName, online: true, generalLastRead: new Date() }
            });
          } else {
            user = await Pool.conn.user.update({
              where: { id: user.id },
              data: { online: true }
            });
          }

          socket.data.userId = user.id;
          socket.join('general');

          const privateRooms = await Pool.conn.privateRoom.findMany({
            where: {
              OR: [{ ownerId: user.id }, { participantId: user.id }],
              active: true
            }
          });
          privateRooms.forEach(room => socket.join(`private_${room.id}`));

          const groupRoomUsers = await Pool.conn.groupRoomUser.findMany({ where: { userId: user.id } });
          groupRoomUsers.forEach(gru => socket.join(`group_${gru.groupRoomId}`));

          const onlineUsers = await Pool.conn.user.findMany({
            where: { online: true },
            select: { id: true, name: true, online: true }
          });

          socket.emit('user_info', user);
          this.io.emit('users_list', onlineUsers);
          this.io.emit('new_user', { message: `${userName} вошёл в чат` });

         const privateChats = await Promise.all(privateRooms.map(async (room) => ({
          id: room.id,
          ownerId: room.ownerId,
          ownerName: room.ownerId === user.id ? userName : (await Pool.conn.user.findUnique({where: {id: room.participantId}}))?.name ?? '',
          participantId: room.participantId,
          participantName: room.participantId === user.id ? userName : (await Pool.conn.user.findUnique({where: {id: room.ownerId}}))?.name ?? ''
        })));
        socket.emit('private_chats_list', privateChats);

          const groupRooms = await Pool.conn.groupRoom.findMany({
            where: { users: { some: { userId: user.id } } }
          });
          socket.emit('group_chats_list', groupRooms);

        } catch (error) {
          console.error('user_created error:', error);
        }
      });

      socket.on('get_private_chats', async (userId: number) => {
        try {
          const privateRooms = await Pool.conn.privateRoom.findMany({
            where: {
              OR: [{ ownerId: userId }, { participantId: userId }],
              active: true
            }
          });
          const privateChats = await Promise.all(privateRooms.map(async (room) => ({
            id: room.id,
            ownerId: room.ownerId,
            ownerName: (await Pool.conn.user.findUnique({where: {id: room.ownerId}}))?.name ?? '',
            participantId: room.participantId,
            participantName: (await Pool.conn.user.findUnique({where: {id: room.participantId}}))?.name ?? ''
          })));
          socket.emit('private_chats_list', privateChats);
        } catch (error) {
          console.error('get_private_chats error:', error);
        }
      });

      socket.on('mark_read', async (data: { type: string; roomId?: number }) => {
        try {
          const userId = socket.data.userId;
          if (!userId) {
            console.error('mark_read: userId is null');
            return;
          }
          
          const now = new Date();
          let userName = (await Pool.conn.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? '';

          if (data.type === 'general') {
            await Pool.conn.user.update({
              where: { id: userId },
              data: { generalLastRead: now }
            });
            this.io.to('general').emit('read_update', { userId, userName, lastRead: now, type: data.type });
          } else if (data.type === 'private' && data.roomId) {
            const room = await Pool.conn.privateRoom.findUnique({ where: { id: data.roomId } });
            if (!room) return;

            if (room.ownerId === userId) {
              await Pool.conn.privateRoom.update({
                where: { id: data.roomId },
                data: { ownerLastRead: now }
              });
            } else {
              await Pool.conn.privateRoom.update({
                where: { id: data.roomId },
                data: { participantLastRead: now }
              });
            }
            this.io.to(`private_${data.roomId}`).emit('read_update', { userId, userName, lastRead: now, type: data.type, roomId: data.roomId });
          } else if (data.type === 'group' && data.roomId) {
            await Pool.conn.groupRoomUser.update({
              where: { groupRoomId_userId: { groupRoomId: data.roomId, userId } },
              data: { lastRead: now }
            });
            this.io.to(`group_${data.roomId}`).emit('read_update', { userId, userName, lastRead: now, type: data.type, roomId: data.roomId });
          }
        } catch (error) {
          console.error('mark_read error:', error);
        }
      });

      socket.on('get_unread_counts', async (userId: number) => {
        try {
          const counts: { [key: string]: number } = {};

          const generalLastRead = (await Pool.conn.user.findUnique({ where: { id: userId }, select: { generalLastRead: true } }))?.generalLastRead || new Date(0);
          counts['general'] = await Pool.conn.generalMessage.count({
            where: { createdAt: { gt: generalLastRead } }
          });

          const privateRooms = await Pool.conn.privateRoom.findMany({
            where: {
              OR: [{ ownerId: userId }, { participantId: userId }],
              active: true
            }
          });

          for (const room of privateRooms) {
            const lastRead = room.ownerId === userId ? room.ownerLastRead : room.participantLastRead;
            const effectiveLastRead = lastRead || new Date(0);
            const count = await Pool.conn.message.count({
              where: { roomId: room.id, createdAt: { gt: effectiveLastRead } }
            });
            counts[`private_${room.id}`] = count;
          }

          const groupRoomUsers = await Pool.conn.groupRoomUser.findMany({
            where: { userId }
          });
          for (const gru of groupRoomUsers) {
            const lastRead = gru.lastRead || new Date(0);
            const count = await Pool.conn.groupMessage.count({
              where: { groupRoomId: gru.groupRoomId, createdAt: { gt: lastRead } }
            });
            counts[`group_${gru.groupRoomId}`] = count;
          }

          socket.emit('unread_counts', counts);
        } catch (error) {
          console.error('get_unread_counts error:', error);
        }
      });

      socket.on('create_group_room', async (data: { name: string; password?: string; systemMessage?: string }) => {
        try {
          const userId = socket.data.userId;
          if (!userId) return;
          
          const room = await Pool.conn.groupRoom.create({
            data: {
              name: data.name,
              password: data.password,
              systemMessage: data.systemMessage,
            }
          });
          await Pool.conn.groupRoomUser.create({
            data: {
              groupRoomId: room.id,
              userId,
              role: 'moderator',
              lastRead: new Date(),
            }
          });
          const roomName = `group_${room.id}`;
          socket.join(roomName);
          socket.emit('group_room_created', room);
          const allGroupRooms = await Pool.conn.groupRoom.findMany({
            where: { users: { some: { userId } } }
          });
          socket.emit('group_chats_list', allGroupRooms);

          if (room.systemMessage) {
            const interval = setInterval(() => {
              this.io.to(roomName).emit('system_notice', { message: room.systemMessage });
            }, 60000);
            this.roomTimers.set(room.id, interval);
          }
        } catch (error) {
          console.error('create_group_room error:', error);
        }
      });

      socket.on('join_group_room', async (data: { roomId: number; password?: string }) => {
        try {
          const userId = socket.data.userId;
          if (!userId || !data.roomId || isNaN(data.roomId)) {
            socket.emit('join_error', 'Invalid parameters');
            return;
          }
          
          const room = await Pool.conn.groupRoom.findUnique({ where: { id: data.roomId } });
          const existing = await Pool.conn.groupRoomUser.findUnique({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId } }
          });
          if (existing) return;
          
          await Pool.conn.groupRoomUser.create({
            data: {
              groupRoomId: data.roomId,
              userId,
              role: 'participant',
              lastRead: new Date(),
            }
          });
          const roomName = `group_${data.roomId}`;
          socket.join(roomName);
          this.io.to(roomName).emit('user_joined', { userId, roomId: data.roomId });
          socket.emit('group_room_joined', room);
          const allGroupRooms = await Pool.conn.groupRoom.findMany({
            where: { users: { some: { userId } } }
          });
          socket.emit('group_chats_list', allGroupRooms);
        } catch (error) {
          console.error('join_group_room error:', error);
        }
      });

      socket.on('get_group_chats', async (userId: number) => {
        try {
          const rooms = await Pool.conn.groupRoom.findMany({
            where: { users: { some: { userId } } }
          });
          socket.emit('group_chats_list', rooms);
        } catch (error) {
          console.error('get_group_chats error:', error);
        }
      });

      socket.on('get_room_users', async (roomId: number) => {
        try {
          const users = await Pool.conn.groupRoomUser.findMany({
            where: { groupRoomId: roomId },
            include: { user: true }
          });
          socket.emit('room_users', users.map(u => ({
            id: u.userId,
            name: u.user.name,
            role: u.role,
            mutedUntil: u.mutedUntil
          })));
        } catch (error) {
          console.error('get_room_users error:', error);
        }
      });

      socket.on('mute_user', async (data: { roomId: number; targetId: number; duration: number }) => {
        try {
          const userId = socket.data.userId;
          if (!userId) return;
          
          const roomUser = await Pool.conn.groupRoomUser.findUnique({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId } }
          });
          if (!roomUser || roomUser.role !== 'moderator') return;
          const mutedUntil = new Date(Date.now() + data.duration * 60000);
          await Pool.conn.groupRoomUser.update({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId: data.targetId } },
            data: { mutedUntil }
          });
          this.io.to(`group_${data.roomId}`).emit('user_muted', { targetId: data.targetId, duration: data.duration, roomId: data.roomId });
        } catch (error) {
          console.error('mute_user error:', error);
        }
      });

      socket.on('kick_user', async (data: { roomId: number; targetId: number }) => {
        try {
          const userId = socket.data.userId;
          if (!userId) return;
          
          const roomUser = await Pool.conn.groupRoomUser.findUnique({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId } }
          });
          if (!roomUser || roomUser.role !== 'moderator') return;
          await Pool.conn.groupRoomUser.delete({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId: data.targetId } }
          });
          const targetSocket = Array.from(this.io.sockets.sockets.values()).find((s: any) => s.data.userId === data.targetId);
          if (targetSocket) targetSocket.leave(`group_${data.roomId}`);
          this.io.to(`group_${data.roomId}`).emit('user_kicked', { targetId: data.targetId, roomId: data.roomId });
        } catch (error) {
          console.error('kick_user error:', error);
        }
      });

      socket.on('change_password', async (data: { roomId: number; newPassword: string }) => {
        try {
          const userId = socket.data.userId;
          if (!userId) return;
          
          const roomUser = await Pool.conn.groupRoomUser.findUnique({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId } }
          });
          if (!roomUser || roomUser.role !== 'moderator') return;
          await Pool.conn.groupRoom.update({
            where: { id: data.roomId },
            data: { password: data.newPassword }
          });
          this.io.to(`group_${data.roomId}`).emit('password_changed', { roomId: data.roomId });
        } catch (error) {
          console.error('change_password error:', error);
        }
      });

      socket.on('request_private_chat', async (data: { fromUserId: number; toUserId: number }) => {
        try {
          const existing = await Pool.conn.privateRoom.findFirst({
            where: {
              OR: [
                { ownerId: data.fromUserId, participantId: data.toUserId },
                { ownerId: data.toUserId, participantId: data.fromUserId }
              ],
              active: true
            }
          });

          let room = existing;
          if (!room) {
            room = await Pool.conn.privateRoom.create({
              data: {
                ownerId: data.fromUserId,
                participantId: data.toUserId,
              }
            });
          }

          const roomName = `private_${room.id}`;
          socket.join(roomName);

          const targetSocket = Array.from(this.io.sockets.sockets.values()).find(
            (s: any) => s.data.userId === data.toUserId
          );
          if (targetSocket) targetSocket.join(roomName);

          this.io.to(roomName).emit('private_chat_created', { roomId: room.id, users: [data.fromUserId, data.toUserId] });

        } catch (error) {
          console.error('request_private_chat error:', error);
        }
      });

      socket.on('private_message', async (data: { roomId: number; senderId: number; receiverId: number; message: string }) => {
        try {
          const message = await Pool.conn.message.create({
            data: {
              content: data.message,
              senderId: data.senderId,
              receiverId: data.receiverId,
              roomId: data.roomId
            },
            include: { sender: true }
          });

          const room = await Pool.conn.privateRoom.findUnique({ where: { id: data.roomId }, include: { owner: true, participant: true } });

          const readers = [];
          if (room && message.createdAt < (room.ownerLastRead ?? new Date(0))) readers.push(room.owner.name);
          if (room && message.createdAt < (room.participantLastRead ?? new Date(0))) readers.push(room.participant.name);

          this.io.to(`private_${data.roomId}`).emit('private_message', {
            id: message.id,
            sender: message.sender.name,
            content: message.content,
            createdAt: message.createdAt,
            roomId: data.roomId,
            readers
          });
        } catch (error) {
          console.error('private_message error:', error);
        }
      });

      socket.on('group_message', async (data: { roomId: number; message: string }) => {
        try {
          const userId = socket.data.userId;
          if (!userId) {
            console.error('group_message: userId is null');
            return;
          }
          
          const roomUser = await Pool.conn.groupRoomUser.findUnique({
            where: { groupRoomId_userId: { groupRoomId: data.roomId, userId } }
          });
          if (!roomUser || (roomUser.mutedUntil && roomUser.mutedUntil > new Date())) return;

          const message = await Pool.conn.groupMessage.create({
            data: {
              content: data.message,
              senderId: userId,
              groupRoomId: data.roomId
            },
            include: { sender: true }
          });

          const groupRoomUsers = await Pool.conn.groupRoomUser.findMany({
            where: { groupRoomId: data.roomId },
            include: { user: true }
          });

          const readers = groupRoomUsers.filter(gru => (gru.lastRead ?? new Date(0)) > message.createdAt).map(gru => gru.user.name);

          this.io.to(`group_${data.roomId}`).emit('group_message', {
            id: message.id,
            sender: message.sender.name,
            content: message.content,
            createdAt: message.createdAt,
            groupRoomId: data.roomId,
            readers
          });
        } catch (error) {
          console.error('group_message error:', error);
        }
      });

      socket.on('chat message', async (data) => {
        try {
          const message = await Pool.conn.generalMessage.create({
            data: {
              content: data.message,
              senderName: data.name
            }
          });
          const users = await Pool.conn.user.findMany({ select: { name: true, generalLastRead: true } });
          const readers = users.filter(u => (u.generalLastRead ?? new Date(0)) > message.createdAt).map(u => u.name);
          this.io.to('general').emit('chat message', {
            id: message.id,
            sender: data.name,
            content: data.message,
            createdAt: message.createdAt,
            readers
          });
        } catch (error) {
          console.error('chat message error:', error);
        }
      });

      socket.on('load_general_history', async () => {
        try {
          const history = await Pool.conn.generalMessage.findMany({
            orderBy: { createdAt: 'asc' },
            take: 50
          });
          const users = await Pool.conn.user.findMany({ select: { name: true, generalLastRead: true } });
          const enrichedHistory = history.map(m => ({
            id: m.id,
            sender: m.senderName,
            content: m.content,
            createdAt: m.createdAt,
            readers: users.filter(u => (u.generalLastRead ?? new Date(0)) > m.createdAt).map(u => u.name)
          }));
          socket.emit('general_history', enrichedHistory);
        } catch (error) {
          console.error('load_general_history error:', error);
        }
      });

      socket.on('load_private_history', async (roomId: number) => {
        try {
          const history = await Pool.conn.message.findMany({
            where: { roomId },
            orderBy: { createdAt: 'asc' },
            include: { sender: true },
            take: 50
          });
          const room = await Pool.conn.privateRoom.findUnique({ where: { id: roomId }, include: { owner: true, participant: true } });
          const enrichedHistory = history.map(m => ({
            id: m.id,
            sender: m.sender.name,
            content: m.content,
            createdAt: m.createdAt,
            roomId: roomId,
            readers: [
              ...(room && m.createdAt < (room.ownerLastRead ?? new Date(0)) ? [room.owner.name] : []),
              ...(room && m.createdAt < (room.participantLastRead ?? new Date(0)) ? [room.participant.name] : [])
            ]
          }));
          socket.emit('private_history', enrichedHistory);
        } catch (error) {
          console.error('load_private_history error:', error);
        }
      });

      socket.on('load_group_history', async (roomId: number) => {
        try {
          const history = await Pool.conn.groupMessage.findMany({
            where: { groupRoomId: roomId },
            orderBy: { createdAt: 'asc' },
            include: { sender: true },
            take: 50
          });
          const groupRoomUsers = await Pool.conn.groupRoomUser.findMany({
            where: { groupRoomId: roomId },
            include: { user: true }
          });
          const enrichedHistory = history.map(m => ({
            id: m.id,
            sender: m.sender.name,
            content: m.content,
            createdAt: m.createdAt,
            groupRoomId: roomId,
            readers: groupRoomUsers.filter(gru => (gru.lastRead ?? new Date(0)) > m.createdAt).map(gru => gru.user.name)
          }));
          socket.emit('group_history', enrichedHistory);
        } catch (error) {
          console.error('load_group_history error:', error);
        }
      });

      socket.on('user_active', (data: { room: string }) => {
        const userId = socket.data.userId;
        if (!userId) return;
        
        if (!this.activeViewers.has(data.room)) this.activeViewers.set(data.room, new Set());
        this.activeViewers.get(data.room)?.add(userId);
        this.io.to(data.room).emit('viewers_update', Array.from(this.activeViewers.get(data.room) ?? []));
      });

      socket.on('user_inactive', (data: { room: string }) => {
        const userId = socket.data.userId;
        if (!userId) return;
        
        if (this.activeViewers.has(data.room)) {
          this.activeViewers.get(data.room)?.delete(userId);
          this.io.to(data.room).emit('viewers_update', Array.from(this.activeViewers.get(data.room) ?? []));
        }
      });

      socket.on('logout', async (userName: string) => {
        try {
          const user = await Pool.conn.user.update({
            where: { name: userName },
            data: { online: false }
          });
          this.io.emit('user_update', user);
          const onlineUsers = await Pool.conn.user.findMany({
            where: { online: true },
            select: { id: true, name: true, online: true }
          });
          this.io.emit('users_list', onlineUsers);
        } catch (error) {
          console.error('logout error:', error);
        }
      });

      socket.on('disconnect', () => {
        console.log('Отключён:', socket.id);
        const userId = socket.data.userId;
        if (userId) {
          this.activeViewers.forEach((set, key) => {
            if (set.has(userId)) {
              set.delete(userId);
              this.io.to(key).emit('viewers_update', Array.from(set));
            }
          });
        }
      });
    });
  }

  public start() {
    this.httpServer.listen(this.port, () => {
      console.log(`Сервер запущен на http://localhost:${this.port}`);
    });
  }
}

new SocketServer(3000).start();