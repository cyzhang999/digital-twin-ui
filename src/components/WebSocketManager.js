class WebSocketManager {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000; // 3秒
    this.messageQueue = [];
    this.callbacks = {};
    this.pendingCommands = new Map(); // 存储待响应的MCP命令
    this.pingInterval = null; // ping定时器
    
    // 绑定方法
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.reconnect = this.reconnect.bind(this);
    this.send = this.send.bind(this);
    this.sendMCPCommand = this.sendMCPCommand.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this.handleOpen = this.handleOpen.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleError = this.handleError.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.unsubscribe = this.unsubscribe.bind(this);
    this.startPingInterval = this.startPingInterval.bind(this);
    this.stopPingInterval = this.stopPingInterval.bind(this);
    this.sendPing = this.sendPing.bind(this);
  }

  // 连接WebSocket
  connect() {
    if (this.socket && this.isConnected) {
      console.log('WebSocket已连接，无需重复连接');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        console.log(`正在连接WebSocket: ${this.url}`);
        this.socket = new WebSocket(this.url);

        this.socket.onopen = (event) => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          console.log('WebSocket连接成功');
          this.processMessageQueue();
          this.startPingInterval();
          
          if (this.callbacks['open']) {
            this.callbacks['open'].forEach(callback => callback(event));
          }
          
          resolve(event);
        };

        this.socket.onmessage = this.handleMessage;

        this.socket.onclose = (event) => {
          this.isConnected = false;
          this.stopPingInterval();
          this.handleClose(event);
          
          // 如果此时已经是手动关闭，则不重连
          if (!this.isManualDisconnect) {
            this.reconnect();
          }
        };

        this.socket.onerror = (error) => {
          console.error('WebSocket连接错误:', error);
          this.handleError(error);
          reject(error);
        };
      } catch (error) {
        console.error('创建WebSocket连接失败:', error);
        reject(error);
        this.reconnect();
      }
    });
  }

  // 断开WebSocket连接
  disconnect() {
    this.isManualDisconnect = true;
    this.stopPingInterval();
    
    if (this.socket) {
      console.log('正在断开WebSocket连接');
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
      this.socket = null;
      this.isConnected = false;
    }
  }

  // 开始定时发送ping消息
  startPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // 每30秒发送一次ping消息
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 30000);
    
    console.log('启动ping消息定时器');
  }
  
  // 停止ping定时器
  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
      console.log('停止ping消息定时器');
    }
  }
  
  // 发送ping消息
  sendPing() {
    if (!this.isConnected || !this.socket) {
      console.warn('WebSocket未连接，无法发送ping消息');
      return;
    }
    
    const pingMessage = {
      type: 'ping',
      id: `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString()
    };
    
    try {
      this.socket.send(JSON.stringify(pingMessage));
      console.log('发送ping消息:', pingMessage);
    } catch (error) {
      console.error('发送ping消息失败:', error);
    }
  }

  // 发送MCP命令并等待响应
  sendMCPCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        console.error('WebSocket未连接，无法发送MCP命令');
        reject(new Error('WebSocket未连接'));
        return;
      }

      // 确保命令有唯一ID
      if (!command.id) {
        command.id = this.generateCommandId();
      }

      // 存储命令到待响应列表
      this.pendingCommands.set(command.id, { 
        command,
        resolve,
        reject,
        timestamp: Date.now(),
        timeout: setTimeout(() => {
          if (this.pendingCommands.has(command.id)) {
            const pendingCommand = this.pendingCommands.get(command.id);
            this.pendingCommands.delete(command.id);
            console.warn(`MCP命令超时 (ID: ${command.id})`, command);
            pendingCommand.reject(new Error('命令执行超时'));
          }
        }, 10000) // 10秒超时
      });

      // 发送命令
      try {
        console.log(`发送MCP命令: ${JSON.stringify(command)}`);
        this.socket.send(JSON.stringify(command));
      } catch (error) {
        console.error('发送MCP命令失败:', error);
        clearTimeout(this.pendingCommands.get(command.id).timeout);
        this.pendingCommands.delete(command.id);
        reject(error);
      }
    });
  }

  // 处理MCP命令响应
  handleMCPResponse(response) {
    // 查找对应的待响应命令
    if (response.id && this.pendingCommands.has(response.id)) {
      const pendingCommand = this.pendingCommands.get(response.id);
      clearTimeout(pendingCommand.timeout);
      this.pendingCommands.delete(response.id);

      if (response.success) {
        console.log(`MCP命令成功执行 (ID: ${response.id})`, response);
        pendingCommand.resolve(response);
      } else {
        console.error(`MCP命令执行失败 (ID: ${response.id})`, response);
        pendingCommand.reject(new Error(response.error || '命令执行失败'));
      }
    } else {
      // 可能是服务器主动发送的命令
      console.log('收到未请求的MCP响应或通知:', response);
      // 触发相关回调
      if (this.callbacks['mcp']) {
        this.callbacks['mcp'].forEach(callback => callback(response));
      }
    }
  }

  // 处理websocket消息
  handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      
      // 处理pong响应
      if (data.type === 'pong') {
        console.log('收到pong响应:', data);
        return;
      }
      
      // 检查是否是MCP协议消息
      if (data.protocol === 'mcp' || data.type === 'mcp_response') {
        this.handleMCPResponse(data);
        return;
      }
      
      // 处理常规消息
      console.log('WebSocket收到消息:', data);
      
      // 如果消息有类型，触发对应类型的回调
      if (data.type && this.callbacks[data.type]) {
        this.callbacks[data.type].forEach(callback => callback(data));
      }
      
      // 触发通用消息回调
      if (this.callbacks['message']) {
        this.callbacks['message'].forEach(callback => callback(data));
      }
    } catch (error) {
      console.error('处理WebSocket消息时出错:', error, event.data);
    }
  }

  // 生成唯一的命令ID
  generateCommandId() {
    return `cmd_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }
} 