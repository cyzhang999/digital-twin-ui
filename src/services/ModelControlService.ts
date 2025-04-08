/**
 * 模型控制服务
 * (Model Control Service)
 * 
 * 提供WebSocket连接和模型操作功能，实现MCP通信协议
 */
import { ref } from 'vue';

// WebSocket服务器地址
const WS_SERVER_URL = 'ws://localhost:9000/ws';

// 连接状态
export const connectionStatus = ref<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
export const connectionError = ref<string | null>(null);

// WebSocket实例
let wsConnection: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * 初始化WebSocket连接
 * @returns 返回WebSocket连接实例
 */
export function initWebSocketConnection() {
  if (wsConnection && (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING)) {
    console.log('WebSocket连接已存在');
    return wsConnection;
  }
  
  try {
    connectionStatus.value = 'connecting';
    console.log(`正在连接MCP服务: ${WS_SERVER_URL}`);
    
    // 创建新的WebSocket连接
    wsConnection = new WebSocket(WS_SERVER_URL);
    
    // 连接打开时
    wsConnection.onopen = () => {
      console.log('MCP服务连接成功');
      connectionStatus.value = 'connected';
      connectionError.value = null;
      reconnectAttempts = 0;
      
      // 发送初始化消息
      sendMessage({
        type: 'init',
        clientId: 'model-viewer-' + Date.now(),
        clientType: 'frontend'
      });
    };
    
    // 接收消息时
    wsConnection.onmessage = (event) => {
      handleIncomingMessage(event.data);
    };
    
    // 连接关闭时
    wsConnection.onclose = () => {
      console.log('MCP服务连接已关闭');
      connectionStatus.value = 'disconnected';
      wsConnection = null;
      
      // 尝试重连
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        console.log(`将在${delay}毫秒后尝试重连(第${reconnectAttempts + 1}次)`);
        
        if (reconnectTimer) {
          window.clearTimeout(reconnectTimer);
        }
        
        reconnectTimer = window.setTimeout(() => {
          reconnectAttempts++;
          initWebSocketConnection();
        }, delay);
      } else {
        console.error('达到最大重连次数，停止重连');
        connectionError.value = '连接服务失败，请刷新页面重试';
      }
    };
    
    // 连接错误时
    wsConnection.onerror = (error) => {
      console.error('WebSocket连接错误:', error);
      connectionStatus.value = 'error';
      connectionError.value = '连接出错，请检查服务是否启动';
    };
    
    return wsConnection;
  } catch (error) {
    console.error('初始化WebSocket连接失败:', error);
    connectionStatus.value = 'error';
    connectionError.value = `连接初始化失败: ${error}`;
    return null;
  }
}

/**
 * 发送消息到MCP服务
 * @param message 要发送的消息对象
 * @returns 是否发送成功
 */
export function sendMessage(message: any): boolean {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
    console.error('WebSocket未连接，无法发送消息');
    // 尝试重连并发送
    initWebSocketConnection();
    return false;
  }
  
  try {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    wsConnection.send(messageStr);
    return true;
  } catch (error) {
    console.error('发送WebSocket消息失败:', error);
    return false;
  }
}

/**
 * 处理来自MCP服务的消息
 * @param data 接收到的消息数据
 */
function handleIncomingMessage(data: string) {
  try {
    const message = JSON.parse(data);
    console.log('收到MCP服务消息:', message);
    
    // 根据消息类型处理
    switch (message.type) {
      case 'command':
        executeModelCommand(message.command);
        break;
      case 'ping':
        // 响应心跳包
        sendMessage({ type: 'pong', timestamp: Date.now() });
        break;
      case 'connection_established':
        console.log('MCP服务确认连接已建立:', message);
        break;
      default:
        console.log('收到其他类型消息:', message);
    }
  } catch (error) {
    console.error('处理WebSocket消息失败:', error);
  }
}

/**
 * 执行模型操作命令
 * @param command 操作命令对象
 */
export function executeModelCommand(command: any) {
  if (!command || !command.action) {
    console.error('无效的模型操作命令:', command);
    return { success: false, error: '无效的命令' };
  }
  
  console.log(`执行模型操作: ${command.action}`, command);
  let result = { success: false, error: '未知错误' };
  
  try {
    // 根据操作类型调用对应的全局函数
    switch (command.action) {
      case 'rotate':
        if (typeof window.rotateModel === 'function') {
          result = window.rotateModel(command.target, command.direction, command.angle) || { success: false };
        } else {
          result = { success: false, error: 'rotateModel函数未定义' };
        }
        break;
        
      case 'zoom':
        if (typeof window.zoomModel === 'function') {
          result = window.zoomModel(command.target, command.scale) || { success: false };
        } else {
          result = { success: false, error: 'zoomModel函数未定义' };
        }
        break;
        
      case 'focus':
        if (typeof window.focusOnModel === 'function') {
          result = window.focusOnModel(command.target) || { success: false };
        } else {
          result = { success: false, error: 'focusOnModel函数未定义' };
        }
        break;
        
      case 'reset':
        if (typeof window.resetModel === 'function') {
          result = window.resetModel() || { success: false };
        } else {
          result = { success: false, error: 'resetModel函数未定义' };
        }
        break;
        
      default:
        result = { success: false, error: `不支持的操作: ${command.action}` };
    }
  } catch (error) {
    console.error(`执行${command.action}操作出错:`, error);
    result = { success: false, error: `操作执行出错: ${error}` };
  }
  
  // 发送执行结果回MCP服务
  sendMessage({
    type: 'commandResult',
    commandId: command.id,
    action: command.action,
    result
  });
  
  return result;
}

/**
 * 关闭WebSocket连接
 */
export function closeConnection() {
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }
  
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  connectionStatus.value = 'disconnected';
}

// 提供模型操作辅助方法
export const ModelOperations = {
  /**
   * 旋转模型
   * @param direction 方向（'left'或'right'）
   * @param angle 角度（度数）
   * @param target 目标对象名称（可选）
   */
  rotate(direction: 'left' | 'right', angle: number, target?: string) {
    return executeModelCommand({
      action: 'rotate',
      direction,
      angle,
      target: target || null
    });
  },
  
  /**
   * 缩放模型
   * @param scale 缩放比例（>1为放大，<1为缩小）
   * @param target 目标对象名称（可选）
   */
  zoom(scale: number, target?: string) {
    return executeModelCommand({
      action: 'zoom',
      scale,
      target: target || null
    });
  },
  
  /**
   * 聚焦到模型某部分
   * @param target 目标对象名称
   */
  focus(target: string) {
    return executeModelCommand({
      action: 'focus',
      target
    });
  },
  
  /**
   * 重置模型视图
   */
  reset() {
    return executeModelCommand({
      action: 'reset'
    });
  }
}; 