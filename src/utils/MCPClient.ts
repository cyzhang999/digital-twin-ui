/**
 * MCP客户端
 * (MCP Client)
 * 
 * 实现WebSocket连接和MCP协议处理
 */

import { ref, reactive } from 'vue';

// MCP消息类型
export interface MCPMessage {
  type: string;
  id?: string;
  timestamp?: string;
  command?: MCPCommand;
  commandId?: string;
  success?: boolean;
  result?: any;
  message?: string;
  code?: number;
  [key: string]: any;
}

// MCP命令类型
export interface MCPCommand {
  id: string;
  action: string;
  target?: string;
  parameters: Record<string, any>;
}

// MCP连接状态
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

// MCP客户端配置
export interface MCPClientConfig {
  serverUrl: string;
  wsUrl: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  pingInterval?: number;
  onMessage?: (message: MCPMessage) => void;
  onStatusChange?: (status: MCPConnectionStatus) => void;
}

// MCP客户端类
export class MCPClient {
  // WebSocket实例
  private ws: WebSocket | null = null;
  
  // 客户端ID
  private clientId: string | null = null;
  
  // 客户端类型
  private clientType: string = 'web_ui';
  
  // 配置
  private config: MCPClientConfig;
  
  // 连接状态
  private _status: MCPConnectionStatus = 'disconnected';
  
  // 消息处理器
  private messageHandlers: Record<string, (message: MCPMessage) => void> = {};
  
  // 命令回调
  private commandCallbacks: Record<string, (result: any) => void> = {};
  
  // 重连尝试次数
  private reconnectAttempts: number = 0;
  
  // 重连定时器
  private reconnectTimer: number | null = null;
  
  // Ping定时器
  private pingTimer: number | null = null;
  
  // 最后一次活动时间
  private lastActivity: number = Date.now();
  
  // 消息历史
  public messageHistory: MCPMessage[] = [];
  
  // 响应式状态
  public status = ref<MCPConnectionStatus>('disconnected');
  public connected = ref(false);
  public lastError = ref<string | null>(null);
  
  constructor(config: MCPClientConfig) {
    // 安全初始化响应式对象
    this.safeInit();
    
    this.config = {
      autoReconnect: true,
      reconnectDelay: 3000,
      maxReconnectAttempts: 5,
      pingInterval: 30000,
      ...config
    };
    
    // 注册默认消息处理器
    this.registerMessageHandler('welcome', this.handleWelcome.bind(this));
    this.registerMessageHandler('connection_established', this.handleConnectionEstablished.bind(this));
    this.registerMessageHandler('pong', this.handlePong.bind(this));
    this.registerMessageHandler('error', this.handleError.bind(this));
    this.registerMessageHandler('response', this.handleResponse.bind(this));
    this.registerMessageHandler('command', this.handleCommand.bind(this));
  }
  
  // 安全初始化响应式对象
  private safeInit(): void {
    try {
      // 确保响应式状态对象被正确初始化
      if (!this.status || typeof this.status !== 'object' || !('value' in this.status)) {
        console.log('初始化状态ref对象');
        this.status = ref<MCPConnectionStatus>('disconnected');
      }
      
      if (!this.connected || typeof this.connected !== 'object' || !('value' in this.connected)) {
        console.log('初始化连接状态ref对象');
        this.connected = ref<boolean>(false);
      }
      
      if (!this.lastError || typeof this.lastError !== 'object' || !('value' in this.lastError)) {
        console.log('初始化错误状态ref对象');
        this.lastError = ref<string | null>(null);
      }
    } catch (error) {
      console.error('初始化响应式对象时出错:', error);
    }
  }
  
  // 连接到服务器
  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('WebSocket已连接或正在连接 (WebSocket already connected or connecting)');
      return;
    }
    
    this.setStatus('connecting');
    
    try {
      console.log(`尝试连接到WebSocket服务器: ${this.config.wsUrl}`);
      this.ws = new WebSocket(this.config.wsUrl);
      
      // 连接建立
      this.ws.onopen = this.handleOpen.bind(this);
      
      // 接收消息
      this.ws.onmessage = this.handleMessage.bind(this);
      
      // 连接关闭
      this.ws.onclose = this.handleClose.bind(this);
      
      // 连接错误
      this.ws.onerror = this.handleWsError.bind(this);
    } catch (error) {
      console.error('WebSocket连接失败 (WebSocket connection failed):', error);
      this.setStatus('error');
      this.lastError.value = error instanceof Error ? error.message : String(error);
      
      // 自动重连
      this.scheduleReconnect();
    }
  }
  
  // 断开连接
  public disconnect(): void {
    this.clearTimers();
    
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('断开WebSocket连接时出错 (Error disconnecting WebSocket):', error);
      }
      
      this.ws = null;
    }
    
    this.setStatus('disconnected');
  }
  
  // 重新连接
  public reconnect(): void {
    this.disconnect();
    this.reconnectAttempts = 0;
    this.connect();
  }
  
  // 发送消息
  public sendMessage(message: MCPMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket未连接，无法发送消息 (WebSocket not connected, cannot send message)');
      return false;
    }
    
    try {
      // 确保消息有ID和时间戳
      if (!message.id) {
        message.id = this.generateId('msg');
      }
      
      if (!message.timestamp) {
        message.timestamp = new Date().toISOString();
      }
      
      this.ws.send(JSON.stringify(message));
      this.lastActivity = Date.now();
      this.messageHistory.push(message);
      
      return true;
    } catch (error) {
      console.error('发送消息时出错 (Error sending message):', error);
      return false;
    }
  }
  
  // 发送初始化消息
  public sendInit(): void {
    this.sendMessage({
      type: 'init',
      clientType: this.clientType
    });
  }
  
  // 发送Ping消息
  public sendPing(): void {
    this.sendMessage({
      type: 'ping',
      timestamp: new Date().toISOString()
    });
  }
  
  // 执行命令
  public executeCommand(
    action: string, 
    parameters: Record<string, any> = {}, 
    target?: string, 
    callback?: (result: any) => void
  ): string {
    const commandId = this.generateId('cmd');
    
    const command: MCPCommand = {
      id: commandId,
      action,
      parameters,
      ...(target ? { target } : {})
    };
    
    const message: MCPMessage = {
      type: 'command',
      command
    };
    
    if (callback) {
      this.commandCallbacks[commandId] = callback;
    }
    
    this.sendMessage(message);
    return commandId;
  }
  
  // 注册消息处理器
  public registerMessageHandler(messageType: string, handler: (message: MCPMessage) => void): void {
    this.messageHandlers[messageType] = handler;
  }
  
  // 生成ID
  private generateId(prefix: string = 'id'): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `${prefix}_${timestamp}_${random}`;
  }
  
  // 设置状态
  private setStatus(status: MCPConnectionStatus): void {
    try {
      // 先更新内部状态
      this._status = status;
      
      // 安全地更新ref对象
      if (this.status && typeof this.status === 'object' && 'value' in this.status) {
        this.status.value = status;
      } else {
        // 如果ref对象不可用，重新创建
        console.warn('状态ref对象不可用，尝试重新创建');
        this.status = ref<MCPConnectionStatus>(status);
      }
      
      // 安全地更新connected状态
      if (this.connected && typeof this.connected === 'object' && 'value' in this.connected) {
        this.connected.value = status === 'connected';
      } else {
        // 如果ref对象不可用，重新创建
        console.warn('连接状态ref对象不可用，尝试重新创建');
        this.connected = ref<boolean>(status === 'connected');
      }
      
      // 触发状态变更回调
      if (this.config.onStatusChange) {
        this.config.onStatusChange(status);
      }
    } catch (error) {
      console.error('设置MCP状态时出错:', error);
    }
  }
  
  // 安排重连
  private scheduleReconnect(): void {
    if (!this.config.autoReconnect || this.reconnectAttempts >= (this.config.maxReconnectAttempts || 5)) {
      console.log('已达到最大重连尝试次数或自动重连已禁用 (Maximum reconnect attempts reached or auto-reconnect disabled)');
      return;
    }
    
    this.clearTimers();
    
    this.reconnectAttempts++;
    this.setStatus('reconnecting');
    
    const delay = this.config.reconnectDelay || 3000;
    console.log(`计划在${delay}毫秒后重新连接 (Scheduling reconnect in ${delay}ms), 尝试次数: ${this.reconnectAttempts}`);
    
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, delay);
  }
  
  // 启动Ping定时器
  private startPingTimer(): void {
    this.clearTimers();
    
    if (this.config.pingInterval && this.config.pingInterval > 0) {
      this.pingTimer = window.setInterval(() => {
        // 检查最后活动时间，如果超过ping间隔的两倍，认为连接已断开
        const inactiveTime = Date.now() - this.lastActivity;
        if (inactiveTime > this.config.pingInterval! * 2) {
          console.warn(`长时间无活动，重新连接 (Long inactivity, reconnecting), 不活动时间: ${inactiveTime}ms`);
          this.reconnect();
          return;
        }
        
        this.sendPing();
      }, this.config.pingInterval);
    }
  }
  
  // 清除定时器
  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
  
  // WebSocket事件处理器
  private handleOpen(event: Event): void {
    console.log('WebSocket连接已建立 (WebSocket connection established)');
    this.reconnectAttempts = 0;
    this.lastActivity = Date.now();
    
    // 这里不立即设置状态为connected，等待welcome或connection_established消息
    
    // 启动Ping定时器
    this.startPingTimer();
  }
  
  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data) as MCPMessage;
      this.lastActivity = Date.now();
      
      // 记录消息
      this.messageHistory.push(message);
      
      // 触发消息回调
      if (this.config.onMessage) {
        this.config.onMessage(message);
      }
      
      // 查找并调用消息处理器
      const handler = this.messageHandlers[message.type];
      if (handler) {
        handler(message);
      } else {
        console.warn(`未知消息类型 (Unknown message type): ${message.type}`);
      }
    } catch (error) {
      console.error('处理WebSocket消息时出错 (Error processing WebSocket message):', error);
    }
  }
  
  private handleClose(event: CloseEvent): void {
    console.log(`WebSocket连接已关闭 (WebSocket connection closed): 代码=${event.code}, 原因=${event.reason}`);
    
    this.ws = null;
    
    if (event.code === 1000 || event.code === 1001) {
      // 正常关闭，不重连
      this.setStatus('disconnected');
    } else if (event.code === 1006) {
      // 非正常关闭（服务器无响应），增加日志，并降低重连频率
      console.warn('WebSocket连接异常关闭 (代码1006)，可能是服务器不可达或网络问题');
      this.setStatus('error');
      this.lastError.value = `连接意外关闭 (代码1006)，可能是服务器未启动或网络问题`;
      
      // 增加重连延迟，避免频繁重试
      const extendedDelay = (this.config.reconnectDelay || 3000) * 2;
      setTimeout(() => {
        this.scheduleReconnect();
      }, 1000); // 先等待1秒再开始重连逻辑
    } else {
      // 其他异常关闭，尝试重连
      this.setStatus('error');
      this.lastError.value = `连接关闭: 代码=${event.code}, 原因=${event.reason}`;
      this.scheduleReconnect();
    }
  }
  
  private handleWsError(event: Event): void {
    console.error('WebSocket错误 (WebSocket error):', event);
    this.setStatus('error');
    this.lastError.value = '连接错误';
    
    // WebSocket会在错误后自动关闭，所以不需要在这里调用scheduleReconnect
  }
  
  // 消息处理器
  private handleWelcome(message: MCPMessage): void {
    console.log('收到欢迎消息 (Welcome message received):', message);
    
    this.clientId = message.clientId || null;
    this.setStatus('connected');
    
    // 发送初始化消息
    this.sendInit();
  }
  
  private handleConnectionEstablished(message: MCPMessage): void {
    console.log('连接已建立 (Connection established):', message);
    
    this.clientId = message.clientId || this.clientId;
    this.setStatus('connected');
  }
  
  private handlePong(message: MCPMessage): void {
    console.log('收到Pong响应 (Pong response received):', message);
    this.lastActivity = Date.now();
  }
  
  private handleError(message: MCPMessage): void {
    console.error('收到错误消息 (Error message received):', message);
    this.lastError.value = message.message || '未知错误';
  }
  
  private handleResponse(message: MCPMessage): void {
    console.log('收到命令响应 (Command response received):', message);
    
    const commandId = message.commandId;
    if (commandId && this.commandCallbacks[commandId]) {
      const callback = this.commandCallbacks[commandId];
      callback(message);
      
      // 移除回调
      delete this.commandCallbacks[commandId];
    }
  }
  
  private handleCommand(message: MCPMessage): void {
    console.log('收到命令消息 (Command message received):', message);
    
    if (message.command && this.config.onMessage) {
      // 通知配置的消息处理函数
      this.config.onMessage(message);
    }
  }
  
  // 便捷命令方法
  public rotate(direction: string, angle: number, target?: string, callback?: (result: any) => void): string {
    return this.executeCommand('rotate', { direction, angle, target }, undefined, callback);
  }
  
  public zoom(scale: number, target?: string, callback?: (result: any) => void): string {
    return this.executeCommand('zoom', { scale, target }, undefined, callback);
  }
  
  public focus(target: string, callback?: (result: any) => void): string {
    return this.executeCommand('focus', { target }, undefined, callback);
  }
  
  public reset(callback?: (result: any) => void): string {
    return this.executeCommand('reset', {}, undefined, callback);
  }
}

// 创建MCP客户端
let mcpClient: MCPClient | null = null;

// 获取MCP客户端实例
export function getMCPClient(config?: MCPClientConfig): MCPClient {
  // 增强对异步导入的支持
  if (typeof window === 'undefined') {
    throw new Error('MCPClient只能在浏览器环境中使用 (MCPClient can only be used in browser environment)');
  }
  
  if (mcpClient) {
    console.log('返回已存在的MCP客户端实例');
    return mcpClient;
  }
  
  if (!config) {
    throw new Error('MCP客户端未初始化，请提供配置信息 (MCP client not initialized, please provide configuration)');
  }
  
  try {
    // 创建新实例
    console.log('创建新的MCP客户端实例');
    mcpClient = new MCPClient(config);
    return mcpClient;
  } catch (error) {
    console.error('创建MCP客户端实例失败:', error);
    throw new Error(`创建MCP客户端失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 创建钩子
export function useMCPClient(): {
  client: MCPClient;
  status: MCPConnectionStatus;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  reconnect: () => void;
} {
  if (!mcpClient) {
    throw new Error('MCP客户端未初始化，请先调用getMCPClient (MCP client not initialized, please call getMCPClient first)');
  }
  
  return {
    client: mcpClient,
    status: mcpClient.status.value,
    connected: mcpClient.connected.value,
    connect: mcpClient.connect.bind(mcpClient),
    disconnect: mcpClient.disconnect.bind(mcpClient),
    reconnect: mcpClient.reconnect.bind(mcpClient)
  };
} 