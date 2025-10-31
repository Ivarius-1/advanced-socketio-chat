const socket = io("http://localhost:3000");
const messages = document.querySelector(".messages");
const form = document.querySelector(".form");
const input = document.querySelector(".input");
const nameInput = document.querySelector(".name");
const usersList = document.getElementById("usersList");
const privateChatsList = document.getElementById("privateChatsList");
const groupChatsList = document.getElementById("groupChatsList");
const roomParticipantsList = document.getElementById("roomParticipantsList");
const roomParticipants = document.getElementById("roomParticipants");
const viewers = document.getElementById("viewers");

let userName = null;
let userId = null;
let currentType = 'general';
let currentRoom = null;
let previousRoom = null;

let chatHistories = {};
let unreadCounts = {};

const STORAGE_KEY = 'chat_histories';

function loadHistoriesFromStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      chatHistories = parsed.histories || { general: [] };
      unreadCounts = parsed.unread || { general: 0 };
    } catch (e) {
      console.error("Ошибка парсинга", e);
      resetStorage();
    }
  } else {
    resetStorage();
  }
}

function resetStorage() {
  chatHistories = { general: [] };
  unreadCounts = { general: 0 };
}

function saveHistoriesToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      histories: chatHistories,
      unread: unreadCounts
    }));
  } catch (e) {
    console.error("Ошибка сохранения", e);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const savedUser = localStorage.getItem("chatUsername");
  if (savedUser) {
    loginUser(savedUser);
  }
});

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("usernameInput");
const loginContainer = document.getElementById("loginContainer");
const chatContainer = document.getElementById("chatContainer");
const logoutBtn = document.getElementById("logoutBtn");

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  if (name) loginUser(name);
});

function loginUser(name) {
  userName = name;
  localStorage.setItem("chatUsername", name);

  loadHistoriesFromStorage();

  form.classList.add('disabled');
  input.disabled = true;
  input.placeholder = 'Подключение...';

  socket.emit("user_created", userName);

  loginContainer.style.display = "none";
  chatContainer.style.display = "flex";
  nameInput.textContent = userName;

  switchToGeneralChat();
}

socket.on('user_info', (user) => {
  userId = user.id;
  console.log('User info received, userId:', userId);
  socket.emit('get_private_chats', userId);
  socket.emit('get_group_chats', userId);
  socket.emit('get_unread_counts', userId);
  
  form.classList.remove('disabled');
  input.disabled = false;
  input.placeholder = 'Введите сообщение...';
  input.focus();
});

logoutBtn.addEventListener("click", () => {
  if (userName) {
    socket.emit("logout", userName);
    chatContainer.style.display = "none";
    loginContainer.style.display = "flex";
    messages.innerHTML = "";
    userName = null;
    userId = null;
    currentType = 'general';
    currentRoom = null;
  }
});

function updateUsersList(users) {
  usersList.innerHTML = '';
  users.forEach(user => {
    if (user.name !== userName) {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.innerHTML = `
        <div class="user-info">
          <span class="status-dot"></span>
          <span class="user-name">${user.name}</span>
        </div>
        <button class="create-private-chat-btn" data-user-id="${user.id}">
          Приват
        </button>
      `;
      usersList.appendChild(li);
    }
  });
}

socket.on('users_list', updateUsersList);

document.getElementById('refreshUsersBtn').addEventListener('click', () => {
  const btn = document.getElementById('refreshUsersBtn');
  btn.disabled = true;
  btn.textContent = 'Обновление...';
  socket.emit('request_users_list');
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Обновить список';
  }, 1500);
});

usersList.addEventListener('click', (e) => {
  const createBtn = e.target.closest('.create-private-chat-btn');
  if (createBtn) {
    const toUserId = parseInt(createBtn.dataset.userId);
    createBtn.disabled = true;
    createBtn.innerHTML = 'Создание...';
    socket.emit('request_private_chat', { fromUserId: userId, toUserId });
  }
});

socket.on('private_chat_created', ({ roomId }) => {
  socket.emit('get_private_chats', userId);
  document.querySelectorAll('.create-private-chat-btn').forEach(b => {
    b.disabled = false;
    b.innerHTML = 'Приват';
  });
});

function addPrivateChatToList(roomId, partnerName, partnerId) {
  if (document.querySelector(`[data-room-id="${roomId}"][data-type="private"]`)) return;

  const li = document.createElement('li');
  li.dataset.roomId = roomId;
  li.dataset.type = 'private';
  li.dataset.partnerId = partnerId.toString();
  li.innerHTML = `
    <span>${partnerName}</span>
    <div class="chat-actions">
      <span class="notification-badge" style="display: none;"></span>
      <button class="delete-chat-btn" data-room-id="${roomId}">×</button>
    </div>
  `;
  if (currentType === 'private' && currentRoom == roomId) li.classList.add('active');
  privateChatsList.appendChild(li);

  const chatKey = `private_${roomId}`;
  if (!chatHistories[chatKey]) chatHistories[chatKey] = [];
  if (!unreadCounts[chatKey]) unreadCounts[chatKey] = 0;
  updateNotificationBadge(li, unreadCounts[chatKey]);
  saveHistoriesToStorage();
}

socket.on('group_room_created', (room) => {
  addGroupChatToList(room.id, room.name);
});

socket.on('group_room_joined', (room) => {
  addGroupChatToList(room.id, room.name);
});

function addGroupChatToList(roomId, name) {
  if (document.querySelector(`[data-room-id="${roomId}"][data-type="group"]`)) return;

  const li = document.createElement('li');
  li.dataset.roomId = roomId;
  li.dataset.type = 'group';
  li.innerHTML = `
    <span>${name}</span>
    <div class="chat-actions">
      <span class="notification-badge" style="display: none;"></span>
    </div>
  `;
  if (currentType === 'group' && currentRoom == roomId) li.classList.add('active');
  groupChatsList.appendChild(li);

  const chatKey = `group_${roomId}`;
  if (!chatHistories[chatKey]) chatHistories[chatKey] = [];
  if (!unreadCounts[chatKey]) unreadCounts[chatKey] = 0;
  updateNotificationBadge(li, unreadCounts[chatKey]);
  saveHistoriesToStorage();
}

const chatsLists = document.querySelectorAll('.private-chats-list, .group-chats-list');
chatsLists.forEach(list => {
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;

    const type = li.dataset.type;
    const roomId = parseInt(li.dataset.roomId);

    if (type === 'private') {
      const deleteBtn = e.target.closest('.delete-chat-btn');
      if (deleteBtn) {
        socket.emit('delete_private_chat', roomId);
        return;
      }
      switchToPrivateChat(roomId);
    } else if (type === 'general') {
      switchToGeneralChat();
    } else if (type === 'group') {
      switchToGroupChat(roomId);
    }
  });
});

function getCurrentRoomName() {
  if (currentType === 'general') return 'general';
  return `${currentType}_${currentRoom}`;
}

function switchToGeneralChat() {
  const prevRoom = getCurrentRoomName();
  currentType = 'general';
  currentRoom = null;

  if (prevRoom !== getCurrentRoomName()) socket.emit('user_inactive', { room: prevRoom });

  document.querySelectorAll('li.active').forEach(l => l.classList.remove('active'));
  const generalLi = document.querySelector('[data-type="general"]');
  if (generalLi) generalLi.classList.add('active');

  unreadCounts['general'] = 0;
  updateNotificationBadge(generalLi, 0);
  saveHistoriesToStorage();

  loadGeneralChatHistory();
  showChatHistory('general');

  socket.emit('mark_read', { type: 'general' });
  socket.emit('user_active', { room: 'general' });
  roomParticipants.style.display = 'none';
}

function switchToPrivateChat(roomId) {
  const prevRoom = getCurrentRoomName();
  currentType = 'private';
  currentRoom = roomId;

  if (prevRoom !== getCurrentRoomName()) socket.emit('user_inactive', { room: prevRoom });

  document.querySelectorAll('li.active').forEach(l => l.classList.remove('active'));
  const li = document.querySelector(`[data-room-id="${roomId}"][data-type="private"]`);
  if (li) li.classList.add('active');

  const chatKey = `private_${roomId}`;
  unreadCounts[chatKey] = 0;
  updateNotificationBadge(li, 0);
  saveHistoriesToStorage();

  loadPrivateChatHistory(roomId);
  showChatHistory(chatKey);

  socket.emit('mark_read', { type: 'private', roomId });
  socket.emit('user_active', { room: `private_${roomId}` });
  roomParticipants.style.display = 'none';
}

function switchToGroupChat(roomId) {
  const prevRoom = getCurrentRoomName();
  currentType = 'group';
  currentRoom = roomId;

  if (prevRoom !== getCurrentRoomName()) socket.emit('user_inactive', { room: prevRoom });

  document.querySelectorAll('li.active').forEach(l => l.classList.remove('active'));
  const li = document.querySelector(`[data-room-id="${roomId}"][data-type="group"]`);
  if (li) li.classList.add('active');

  const chatKey = `group_${roomId}`;
  unreadCounts[chatKey] = 0;
  updateNotificationBadge(li, 0);
  saveHistoriesToStorage();

  loadGroupChatHistory(roomId);
  showChatHistory(chatKey);

  socket.emit('mark_read', { type: 'group', roomId });
  socket.emit('user_active', { room: `group_${roomId}` });
  roomParticipants.style.display = 'block';
  socket.emit('get_room_users', roomId);
}

function updateNotificationBadge(li, count) {
  const badge = li.querySelector('.notification-badge');
  if (badge) {
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : count.toString();
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

function showChatHistory(chatKey) {
  messages.innerHTML = '';
  const history = chatHistories[chatKey] || [];
  history.forEach(msg => appendMessage(msg));
  scrollToBottom();
}

function loadGeneralChatHistory() {
  if (!chatHistories.general || chatHistories.general.length === 0) {
    socket.emit('load_general_history');
  } else {
    showChatHistory('general');
  }
}

function loadPrivateChatHistory(roomId) {
  const chatKey = `private_${roomId}`;
  if (!chatHistories[chatKey] || chatHistories[chatKey].length === 0) {
    socket.emit('load_private_history', roomId);
  } else {
    showChatHistory(chatKey);
  }
}

function loadGroupChatHistory(roomId) {
  const chatKey = `group_${roomId}`;
  if (!chatHistories[chatKey] || chatHistories[chatKey].length === 0) {
    socket.emit('load_group_history', roomId);
  } else {
    showChatHistory(chatKey);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg || !userName || !userId) {
    if (!userId) {
      console.error('Cannot send message: userId is null');
      alert('Пожалуйста, подождите подключения к серверу');
    }
    return;
  }

  if (currentType === 'private') {
    const li = document.querySelector(`[data-room-id="${currentRoom}"][data-type="private"]`);
    if (!li) return;
    const receiverId = parseInt(li.dataset.partnerId);
    socket.emit('private_message', {
      roomId: currentRoom,
      senderId: userId,
      receiverId,
      message: msg
    });
  } else if (currentType === 'group') {
    socket.emit('group_message', { roomId: currentRoom, message: msg });
  } else {
    socket.emit('chat message', { message: msg, name: userName });
  }
  input.value = '';
});

socket.on('chat message', (data) => {
  appendMessageToHistory('general', data);
});

socket.on('private_message', (data) => {
  let roomId = data.roomId;
  if (!roomId && currentType === 'private') {
    roomId = currentRoom;
  }
  const chatKey = `private_${roomId}`;
  const messageData = { ...data, roomId };
  appendMessageToHistory(chatKey, messageData);
});

socket.on('group_message', (data) => {
  let roomId = data.groupRoomId || data.roomId;
  if (!roomId && currentType === 'group') {
    roomId = currentRoom;
  }
  const chatKey = `group_${roomId}`;
  const messageData = { ...data, groupRoomId: roomId };
  appendMessageToHistory(chatKey, messageData);
});

socket.on('general_history', (msgs) => {
  chatHistories.general = msgs;
  saveHistoriesToStorage();
  if (currentType === 'general') showChatHistory('general');
});

socket.on('private_history', (msgs) => {
  if (msgs.length === 0) return;
  const firstMsg = msgs[0];
  const roomId = firstMsg.roomId || currentRoom;
  const chatKey = `private_${roomId}`;
  chatHistories[chatKey] = msgs;
  saveHistoriesToStorage();
  if (currentType === 'private' && currentRoom === roomId) showChatHistory(chatKey);
});

socket.on('group_history', (msgs) => {
  if (msgs.length === 0) return;
  const firstMsg = msgs[0];
  const roomId = firstMsg.groupRoomId || currentRoom;
  const chatKey = `group_${roomId}`;
  chatHistories[chatKey] = msgs;
  saveHistoriesToStorage();
  if (currentType === 'group' && currentRoom === roomId) showChatHistory(chatKey);
});

function appendMessageToHistory(chatKey, msg) {
  if (!chatHistories[chatKey]) chatHistories[chatKey] = [];
  chatHistories[chatKey].push(msg);

  if (!isCurrentChat(chatKey)) {
    unreadCounts[chatKey] = (unreadCounts[chatKey] || 0) + 1;
    const type = chatKey.split('_')[0];
    const roomIdStr = chatKey.split('_')[1];
    const roomId = roomIdStr === 'undefined' ? null : parseInt(roomIdStr);
    
    let selector;
    if (type === 'general') {
      selector = `[data-type="general"]`;
    } else {
      selector = `[data-room-id="${roomId}"][data-type="${type}"]`;
    }
    
    const li = document.querySelector(selector);
    if (li) updateNotificationBadge(li, unreadCounts[chatKey]);
  }

  saveHistoriesToStorage();

  if (isCurrentChat(chatKey)) {
    appendMessage(msg);
    scrollToBottom();
  }
}

function isCurrentChat(chatKey) {
  const currentKey = currentType === 'general' ? 'general' : `${currentType}_${currentRoom}`;
  return chatKey === currentKey;
}

socket.on('read_update', (data) => {
  let currentKey;
  if (data.type === 'general') {
    currentKey = 'general';
  } else {
    currentKey = `${data.type}_${data.roomId}`;
  }
  
  if (isCurrentChat(currentKey)) {
    messages.querySelectorAll('li').forEach(li => {
      const createdAtStr = li.dataset.createdAt;
      if (!createdAtStr) return;
      
      const messageTime = new Date(createdAtStr);
      const readStatus = li.querySelector('.read-status');
      if (!readStatus) return;
      
      let readersText = readStatus.textContent.replace('Read by: ', '').trim();
      let readers = readersText ? readersText.split(', ').filter(r => r) : [];
      
      if (messageTime < new Date(data.lastRead) && !readers.includes(data.userName)) {
        readers.push(data.userName);
        readStatus.textContent = 'Read by: ' + readers.join(', ');
      }
    });
  }
});

socket.on('viewers_update', (viewerIds) => {
  viewers.textContent = `Просматривают: ${viewerIds.length} человек`;
});

socket.on('private_chats_list', (rooms) => {
  const generalChat = privateChatsList.querySelector('[data-type="general"]');
  privateChatsList.innerHTML = '';
  if (generalChat) privateChatsList.appendChild(generalChat);
  
  rooms.forEach(room => {
    const partnerId = (room.ownerId === userId ? room.participantId : room.ownerId);
    const partnerName = (room.ownerId === userId ? room.participantName : room.ownerName);
    addPrivateChatToList(room.id, partnerName, partnerId);
  });
});

socket.on('group_chats_list', (rooms) => {
  groupChatsList.innerHTML = '';
  rooms.forEach(room => addGroupChatToList(room.id, room.name));
});

socket.on('room_users', (users) => {
  roomParticipantsList.innerHTML = '';
  const myRole = users.find(u => u.id === userId)?.role;
  users.forEach(u => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${u.name} (${u.role})${u.mutedUntil ? ' (muted)' : ''}</span>
    `;
    if (myRole === 'moderator' && u.id !== userId) {
      const muteBtn = document.createElement('button');
      muteBtn.textContent = 'Mute';
      muteBtn.onclick = () => {
        const duration = prompt('Duration in minutes');
        if (duration) socket.emit('mute_user', { roomId: currentRoom, targetId: u.id, duration: parseInt(duration) });
      };
      li.appendChild(muteBtn);

      const kickBtn = document.createElement('button');
      kickBtn.textContent = 'Kick';
      kickBtn.onclick = () => socket.emit('kick_user', { roomId: currentRoom, targetId: u.id });
      li.appendChild(kickBtn);
    }
    roomParticipantsList.appendChild(li);
  });
});

socket.on('system_notice', (data) => {
  appendSystemMessage(data.message);
});

socket.on('user_muted', (data) => {
  appendSystemMessage(`User ID ${data.targetId} muted for ${data.duration} minutes`);
  if (currentType === 'group' && currentRoom === data.roomId) socket.emit('get_room_users', data.roomId);
});

socket.on('user_kicked', (data) => {
  appendSystemMessage(`User ID ${data.targetId} kicked`);
  if (data.targetId === userId) {
    switchToGeneralChat();
    const li = document.querySelector(`[data-room-id="${data.roomId}"][data-type="group"]`);
    if (li) li.remove();
  } else if (currentType === 'group' && currentRoom === data.roomId) {
    socket.emit('get_room_users', data.roomId);
  }
});

socket.on('password_changed', (data) => {
  appendSystemMessage('Password changed by moderator');
});

socket.on('private_chat_deleted', (roomId) => {
  const el = document.querySelector(`[data-room-id="${roomId}"][data-type="private"]`);
  if (el) el.remove();

  const chatKey = `private_${roomId}`;
  delete chatHistories[chatKey];
  delete unreadCounts[chatKey];
  saveHistoriesToStorage();

  if (currentType === 'private' && currentRoom === roomId) {
    switchToGeneralChat();
  }
});

function appendMessage(msg) {
  const li = document.createElement('li');
  li.dataset.messageId = msg.id;
  
  let createdAt = msg.createdAt;
  if (typeof createdAt === 'string') {
    createdAt = new Date(createdAt);
  }
  li.dataset.createdAt = createdAt.toISOString();
  
  const readers = msg.readers || [];
  const readersText = Array.isArray(readers) ? readers.join(', ') : '';
  
  li.innerHTML = `<strong>${msg.sender}:</strong> ${msg.content} <span class="read-status">Read by: ${readersText}</span>`;
  messages.appendChild(li);
}

function appendSystemMessage(text) {
  const li = document.createElement('li');
  li.className = 'system-message';
  li.textContent = text;
  messages.appendChild(li);
  scrollToBottom();
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

document.getElementById('createGroupBtn').addEventListener('click', () => {
  const name = prompt('Room name');
  if (name) {
    const password = prompt('Password (optional)');
    const systemMessage = prompt('System message (optional)');
    socket.emit('create_group_room', { name, password, systemMessage });
  }
});

document.getElementById('joinGroupBtn').addEventListener('click', () => {
  const roomId = prompt('Room ID');
  if (roomId) {
    const password = prompt('Password (if required)');
    socket.emit('join_group_room', { roomId: parseInt(roomId), password });
  }
});

document.getElementById('changePasswordBtn').addEventListener('click', () => {
  if (currentType === 'group') {
    const newPassword = prompt('New password');
    socket.emit('change_password', { roomId: currentRoom, newPassword });
  }
});

socket.on('connect', () => {
  console.log('Connected to server');
  if (userName) {
    userId = null;
    form.classList.add('disabled');
    input.disabled = true;
    input.placeholder = 'Переподключение...';
    
    socket.emit("user_created", userName);
  }
});