// WebSocketManager.js
// WebSocket 连接管理器类

import { MCPCommandBuilder } from './MCPCommandBuilder';

export class WebSocketManager {
  constructor(config = {}) {
    this.config = {
      wsUrl: import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000',
      reconnectDelay: 5000,
      maxReconnectAttempts: 5,
      ...config
    };

    this.commandBuilder = new MCPCommandBuilder();
    this.connections = new Map();
    this.reconnectAttempts = new Map();
    this.messageHandlers = new Map();
    this.pendingCommands = new Map();
  }

  // 初始化连接
  async connect(endpoint) {
    try {
      // 如果已经有活跃连接，先断开
      if (this.connections.has(endpoint)) {
        const existingWs = this.connections.get(endpoint);
        if (existingWs && existingWs.readyState === WebSocket.OPEN) {
          console.log(`WebSocket连接 ${endpoint} 已存在且活跃，复用现有连接`);
          return existingWs;
        } else if (existingWs) {
          console.log(`WebSocket连接 ${endpoint} 已存在但不活跃，断开旧连接`);
          this.disconnect(endpoint);
        }
      }

      console.log(`正在创建新WebSocket连接: ${endpoint}`);
      const ws = new WebSocket(`${this.config.wsUrl}${endpoint}`);
      
      // 设置连接超时
      const connectionTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.error(`WebSocket连接超时: ${endpoint}`);
          ws.close();
        }
      }, 5000);

      this.setupWebSocketHandlers(ws, endpoint);
      this.connections.set(endpoint, ws);

      return new Promise((resolve, reject) => {
        ws.onopen = () => {
          console.log(`WebSocket连接成功: ${endpoint}`);
          this.reconnectAttempts.set(endpoint, 0);
          clearTimeout(connectionTimeout); // 清除连接超时
          
          // 设置定期发送心跳消息
          const heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() }));
              } catch (error) {
                console.warn(`发送心跳消息失败: ${endpoint}`, error);
              }
            } else {
              clearInterval(heartbeatInterval);
            }
          }, 30000); // 每30秒发送一次心跳
          
          // 保存心跳间隔以便清理
          ws.heartbeatInterval = heartbeatInterval;
          
          resolve(ws);
        };
        ws.onerror = (error) => {
          console.error(`WebSocket连接失败: ${endpoint}`, error);
          clearTimeout(connectionTimeout); // 清除连接超时
          reject(error);
        };
      });
    } catch (error) {
      console.error(`WebSocket连接错误: ${endpoint}`, error);
      this.handleReconnect(endpoint);
      throw error;
    }
  }

  // 设置WebSocket事件处理器
  setupWebSocketHandlers(ws, endpoint) {
    ws.onmessage = (event) => this.handleMessage(event, endpoint);
    ws.onclose = () => this.handleClose(endpoint);
    ws.onerror = (error) => this.handleError(error, endpoint);
  }

  // 处理接收到的消息
  handleMessage(event, endpoint) {
    try {
      const data = JSON.parse(event.data);
      console.log(`收到WebSocket消息 (${endpoint}):`, data);
      
      // 调用所有消息处理器，首先进行广播
      const handlers = this.messageHandlers.get(endpoint) || [];
      handlers.forEach(handler => handler(data));
      
      // 处理心跳响应 - 不作为命令处理
      if (data.type === 'heartbeat_response') {
        return;
      }
      
      // 寻找命令ID，检查不同格式的响应
      const commandId = 
        data.command_id || // MCP响应格式
        data.commandId ||  // 标准命令ID格式
        (data.command && data.command.id) || // 嵌套命令格式
        (data.result && data.result.command_id) || // 嵌套在结果中的格式
        data.id;         // 标准ID格式
      
      // 如果找到命令ID，并且有对应的待响应命令
      if (commandId && this.pendingCommands.has(commandId)) {
        console.log(`找到命令响应 (ID: ${commandId})`, data);
        
        const pendingCommand = this.pendingCommands.get(commandId);
        const { resolve } = pendingCommand;
        
        // 判断响应是否成功 - 检查多种可能的成功状态表示
        // 注意: MCP服务器可能在各种情况下都返回status=success
        const isSuccess = 
          data.success === true || 
          data.status === 'success' || 
          (data.result && data.result.success === true) ||
          (data.type === 'mcp.response' && data.status === 'success');
        
        // 计算响应时间
        const responseTime = Date.now() - pendingCommand.timestamp;
        console.log(`命令响应 (ID: ${commandId}, 耗时: ${responseTime}ms, 状态: ${isSuccess ? '成功' : '失败'})`, data);
        
        // 无论成功失败都调用resolve，让应用层自行处理结果
        // MCP服务设计是即使命令执行有问题也返回成功，前端需要自行处理显示
        resolve(data);
        this.pendingCommands.delete(commandId);
      } else if (data.type === 'mcp.command' || data.type === 'mcp.response') {
        // 还没有相应的pending命令，但是命令响应类型，可能是广播或者异步响应
        const msgId = data.id || data.command_id || '未知ID';
        console.log(`收到MCP命令或响应，但没有对应的pending命令 (ID: ${msgId})`, data);
        // 不做特殊处理，让应用层自己处理
      }
    } catch (error) {
      console.error(`消息处理错误 (${endpoint})`, error);
      console.log('原始消息:', event.data);
      try {
        // 尝试作为纯文本消息处理
        const handlers = this.messageHandlers.get(endpoint) || [];
        handlers.forEach(handler => handler(event.data));
      } catch (e) {
        // 忽略二次错误
      }
    }
  }

  // 处理连接关闭
  handleClose(endpoint) {
    console.log(`WebSocket连接关闭: ${endpoint}`);
    this.connections.delete(endpoint);
    this.handleReconnect(endpoint);
  }

  // 处理连接错误
  handleError(error, endpoint) {
    console.error(`WebSocket错误: ${endpoint}`, error);
  }

  // 处理重连
  async handleReconnect(endpoint) {
    const attempts = this.reconnectAttempts.get(endpoint) || 0;
    if (attempts >= this.config.maxReconnectAttempts) {
      console.error(`WebSocket重连失败: ${endpoint} - 已达到最大重试次数`);
      return;
    }

    this.reconnectAttempts.set(endpoint, attempts + 1);
    console.log(`尝试重连 WebSocket: ${endpoint} - 第 ${attempts + 1} 次`);

    setTimeout(() => {
      this.connect(endpoint).catch(() => {
        this.handleReconnect(endpoint);
      });
    }, this.config.reconnectDelay);
  }

  // 注册消息处理器
  onMessage(endpoint, handler) {
    if (!this.messageHandlers.has(endpoint)) {
      this.messageHandlers.set(endpoint, []);
    }
    this.messageHandlers.get(endpoint).push(handler);
  }

  // 发送普通消息
  send(endpoint, message) {
    const ws = this.connections.get(endpoint);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket连接未就绪: ${endpoint}`);
    }
    
    try {
      if (typeof message === 'string') {
        ws.send(message);
      } else {
        ws.send(JSON.stringify(message));
      }
      return true;
    } catch (error) {
      console.error(`发送消息失败: ${endpoint}`, error);
      throw error;
    }
  }

  // 检查连接是否活跃
  isConnectionActive(endpoint) {
    const ws = this.connections.get(endpoint);
    return ws && ws.readyState === WebSocket.OPEN;
  }

  // 获取活跃连接列表
  getActiveConnections() {
    const active = [];
    for (const [endpoint, ws] of this.connections.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        active.push(endpoint);
      }
    }
    return active;
  }

  // 发送MCP命令
  async sendCommand(endpoint, command) {
    const ws = this.connections.get(endpoint);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`WebSocket连接未就绪 (${endpoint}): readyState=${ws ? ws.readyState : 'undefined'}`);
      throw new Error(`WebSocket连接未就绪: ${endpoint}`);
    }

    // 生成一个唯一的命令ID
    const generateCommandId = () => {
      return `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    };

    return new Promise((resolve, reject) => {
      try {
        // 确保命令有一个ID
        let commandObj = command;
        
        // 检查command是否为字符串
        if (typeof command === 'string') {
          try {
            commandObj = JSON.parse(command);
          } catch (e) {
            console.warn('命令不是有效的JSON字符串，将尝试作为普通消息发送');
            ws.send(command);
            return resolve({ success: true, message: '消息已发送' });
          }
        }
        
        // 确保命令对象有ID和type
        if (!commandObj.type) {
          commandObj.type = 'mcp.command';
        }
        
        let commandId;
        
        // 确保命令对象有ID
        if (!commandObj.id && commandObj.command) {
          // 如果有嵌套的command对象，且该对象没有ID
          if (!commandObj.command.id) {
            commandObj.command.id = generateCommandId();
          }
          commandId = commandObj.command.id;
        } else {
          // 直接给顶层对象添加ID
          if (!commandObj.id) {
            commandObj.id = generateCommandId();
          }
          commandId = commandObj.id;
        }
        
        console.log(`准备发送WebSocket命令 (ID: ${commandId}, 类型: ${commandObj.type || 'unknown'})`, commandObj);
        
        // 存储待响应的命令
        this.pendingCommands.set(commandId, { 
          resolve,
          reject,
          timestamp: Date.now(),
          command: commandObj
        });
        
        // 转换为JSON并发送
        const jsonString = JSON.stringify(commandObj);
        console.log(`发送WebSocket命令 (${endpoint}, 长度: ${jsonString.length}字节)`);
        ws.send(jsonString);
        
        // 设置超时处理
        setTimeout(() => {
          if (this.pendingCommands.has(commandId)) {
            console.warn(`WebSocket命令超时 (ID: ${commandId})`, commandObj);
            // 不删除命令，允许晚到的响应仍然处理
            // 但仍然返回超时结果
            resolve({ 
              success: false, 
              status: 'timeout', 
              message: '命令发送成功但响应超时，可能仍在后台处理',
              command_id: commandId
            });
          }
        }, 5000); // 5秒超时
      } catch (error) {
        console.error('发送命令失败:', error);
        reject(error);
      }
    });
  }

  // 关闭指定连接
  disconnect(endpoint) {
    const ws = this.connections.get(endpoint);
    if (ws) {
      // 清除心跳定时器
      if (ws.heartbeatInterval) {
        clearInterval(ws.heartbeatInterval);
        ws.heartbeatInterval = null;
      }
      
      try {
        // 发送关闭消息
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'disconnect', timestamp: new Date().toISOString() }));
        }
        ws.close();
      } catch (e) {
        console.warn(`关闭WebSocket连接出错: ${endpoint}`, e);
      }
      
      this.connections.delete(endpoint);
      this.messageHandlers.delete(endpoint);
      console.log(`已断开WebSocket连接: ${endpoint}`);
    }
  }

  // 关闭所有连接
  disconnectAll() {
    for (const endpoint of this.connections.keys()) {
      this.disconnect(endpoint);
    }
  }

  // 获取连接状态
  getConnectionStatus(endpoint) {
    const ws = this.connections.get(endpoint);
    return ws ? ws.readyState : WebSocket.CLOSED;
  }

  // 创建新的命令构建器实例
  createCommand() {
    return new MCPCommandBuilder();
  }
} 