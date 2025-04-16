<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import ModelViewer from './components/ModelViewer.vue';
import ChatDialog from './components/ChatDialog.vue';
import CommandStateManager from './utils/CommandStateManager';

// 创建命令状态管理器实例
const commandStateManager = new CommandStateManager({
  commandTTL: 5000,  // 5秒内相似命令被视为重复
  lockTimeout: 8000  // 命令锁超时8秒
});

// 引用模型查看器组件 (Reference to model viewer component)
const modelViewerRef = ref<InstanceType<typeof ModelViewer> | null>(null);

// 聊天对话框显示状态 (Chat dialog display state)
const chatDialogVisible = ref(false);

// 添加WebSocket连接管理
const wsManager = {
  statusSocket: null,
  healthSocket: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,
  reconnectDelay: 3000, // 3秒
  
  connectStatus: async () => {
    try {
      const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000';
      
      // 如果已经有连接，先关闭
      if (wsManager.statusSocket) {
        try {
          wsManager.statusSocket.close();
        } catch (e) {
          console.warn('关闭旧WebSocket连接时出错:', e);
        }
      }
      
      // 创建新的WebSocket连接
      console.log('正在连接状态WebSocket:', `${wsUrl}/ws/status`);
      wsManager.statusSocket = new WebSocket(`${wsUrl}/ws/status`);
      
      wsManager.statusSocket.onopen = () => {
        console.log('WebSocket状态连接成功');
        wsManager.reconnectAttempts = 0; // 重置尝试次数
      };
      
      wsManager.statusSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'status') {
            console.log('WebSocket状态更新:', data.data);
            // 更新应用状态
            appStatus.value = data.data;
          }
        } catch (e) {
          console.error('解析WebSocket状态消息失败:', e);
        }
      };
      
      wsManager.statusSocket.onerror = (error) => {
        console.error('WebSocket状态连接错误:', error);
        appStatus.value = { connected: false };
      };
      
      wsManager.statusSocket.onclose = () => {
        console.warn('WebSocket状态连接已关闭');
        appStatus.value = { connected: false };
        
        // 尝试重连
        if (wsManager.reconnectAttempts < wsManager.maxReconnectAttempts) {
          wsManager.reconnectAttempts++;
          console.log(`尝试重新连接状态WebSocket (${wsManager.reconnectAttempts}/${wsManager.maxReconnectAttempts})...`);
          setTimeout(() => wsManager.connectStatus(), wsManager.reconnectDelay);
        } else {
          console.error('达到最大重连次数，停止尝试连接WebSocket状态');
        }
      };
    } catch (error) {
      console.error('WebSocket状态连接失败:', error);
      appStatus.value = { connected: false };
    }
  },
  
  connectHealth: async () => {
    try {
      const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000';
      
      // 如果已经有连接，先关闭
      if (wsManager.healthSocket) {
        try {
          wsManager.healthSocket.close();
        } catch (e) {
          console.warn('关闭旧WebSocket连接时出错:', e);
        }
      }
      
      // 创建新的WebSocket连接
      console.log('正在连接健康检查WebSocket:', `${wsUrl}/ws/health`);
      wsManager.healthSocket = new WebSocket(`${wsUrl}/ws/health`);
      
      wsManager.healthSocket.onopen = () => {
        console.log('WebSocket健康检查连接成功');
      };
      
      wsManager.healthSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'health') {
            console.log('WebSocket健康检查:', data);
            // 更新健康状态
            healthStatus.value = data;
          }
        } catch (e) {
          console.error('解析WebSocket健康检查消息失败:', e);
        }
      };
      
      wsManager.healthSocket.onerror = (error) => {
        console.error('WebSocket健康检查连接错误:', error);
        healthStatus.value = { status: 'error', message: '连接失败' };
      };
      
      wsManager.healthSocket.onclose = () => {
        console.warn('WebSocket健康检查连接已关闭');
        healthStatus.value = { status: 'error', message: '连接已关闭' };
        
        // 这里可以添加健康检查的重连逻辑，或者仅在状态连接被关闭时重连
      };
    } catch (error) {
      console.error('WebSocket健康检查连接失败:', error);
      healthStatus.value = { status: 'error', message: '连接失败' };
    }
  },
  
  disconnect: () => {
    if (wsManager.statusSocket) {
      try {
        wsManager.statusSocket.close();
      } catch (e) {
        console.warn('关闭状态WebSocket时出错:', e);
      }
      wsManager.statusSocket = null;
    }
    
    if (wsManager.healthSocket) {
      try {
        wsManager.healthSocket.close();
      } catch (e) {
        console.warn('关闭健康检查WebSocket时出错:', e);
      }
      wsManager.healthSocket = null;
    }
    
    console.log('已断开所有WebSocket连接');
  },
  
  sendCommand: async (url, command) => {
    try {
      const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000';
      const fullUrl = `${wsUrl}${url}`;
      
      // 创建新的WebSocket连接
      const ws = new WebSocket(fullUrl);
      
      // 连接打开时的处理
      ws.onopen = () => {
        console.log('WebSocket连接已建立');
        
        // 发送命令
        const commandStr = JSON.stringify(command);
        ws.send(commandStr);
      };
      
      // 接收消息时的处理
      const result = await new Promise<any>((resolve, reject) => {
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('收到WebSocket消息:', data);
            resolve(data);
          } catch (error) {
            console.error('处理WebSocket消息时出错:', error);
            reject(error);
          }
        };
      });
      
      // 连接关闭时的处理
      ws.onclose = () => {
        console.log('WebSocket连接已关闭');
      };
      
      // 连接错误时的处理
      ws.onerror = (error) => {
        console.error('WebSocket连接错误:', error);
        reject(error);
      };
    } catch (error) {
      console.error('发送WebSocket消息时出错:', error);
      return false;
    }
  }
};

// 替换HTTP请求为WebSocket连接
const appStatus = ref({ connected: false });
const healthStatus = ref({ status: 'unknown', message: '初始化中' });

// 添加statusCheckInterval变量声明
let statusCheckInterval: number | null = null;

// 打开聊天对话框 (Open chat dialog)
const openChatDialog = () => {
  chatDialogVisible.value = true;
};

// 处理AI聊天窗口触发的执行动作
const handleExecuteAction = (action) => {
  console.log('收到执行操作请求:', action);
  
  // 确保action对象格式统一
  const operationType = action.type || action.operation;
  const params = action.params || action.parameters || {};

  // 如果操作类型不存在，无法执行
  if (!operationType) {
    console.error('无法执行操作: 未指定操作类型');
    return;
  }
  
  // 支持的操作类型
  const validOperations = ['rotate', 'zoom', 'focus', 'reset'];
  if (!validOperations.includes(operationType)) {
    console.error(`不支持的操作类型: ${operationType}`);
    return;
  }
  
  // 检查是否近期已执行过相似命令
  if (commandStateManager.isCommandExecuted(operationType, params)) {
    console.log(`近期已执行过相似的${operationType}命令，跳过执行`);
    return;
  }
  
  // 尝试获取执行锁，最多重试2次
  executeWithRetry(action, 0, 2);
};

// 带有重试限制的执行函数
const executeWithRetry = (action, retryCount, maxRetries) => {
  const operationType = action.type || action.operation;
  const params = action.params || action.parameters || {};
  
  if (retryCount > maxRetries) {
    console.error(`已达到最大重试次数(${maxRetries})，放弃执行操作: ${operationType}`);
    return;
  }
  
  // 尝试获取执行锁
  if (!commandStateManager.acquireLock()) {
    console.log(`无法获取命令执行锁，这是第${retryCount}次尝试，稍后重试...`);
    // 延迟重试，每次增加延迟时间
    setTimeout(() => {
      executeWithRetry(action, retryCount + 1, maxRetries);
    }, 1000 * (retryCount + 1)); // 延迟时间随重试次数增加
    return;
  }
  
  try {
    // 注册新命令
    const commandKey = commandStateManager.registerCommand(
      operationType,
      params
    );
    
    // 根据操作类型执行相应的方法
    const modelViewer = modelViewerRef.value;
    if (modelViewer) {
      let result = false;
      
      switch(operationType) {
        case 'rotate':
          result = modelViewer.rotateComponent(
            null, 
            params.angle || 45, 
            params.direction || 'left'
          );
          break;
          
        case 'zoom':
          result = modelViewer.zoomComponent(null, params.scale || 1.5);
          break;
          
        case 'focus':
          result = modelViewer.focusOnComponent(
            params.target || params.objectName || 'center'
          );
          break;
          
        case 'reset':
          result = modelViewer.resetModel();
          break;
      }
      
      // 如果执行成功，标记命令为已执行
      if (result) {
        commandStateManager.markAsExecuted(commandKey);
        console.log(`操作${operationType}执行完成`);
      } else {
        console.warn(`操作${operationType}执行失败，尝试使用全局方法`);
        // 尝试全局方法
        const globalResult = executeGlobalMethod(operationType, params);
        if (globalResult) {
          commandStateManager.markAsExecuted(commandKey);
        }
      }
    } else {
      console.warn('找不到模型查看器引用，尝试使用全局方法');
      // 尝试使用全局方法
      const globalResult = executeGlobalMethod(operationType, params);
      if (globalResult) {
        commandStateManager.markAsExecuted(commandKey);
      }
    }
  } finally {
    // 确保释放执行锁
    commandStateManager.releaseLock();
  }
};

// 使用全局方法执行操作
const executeGlobalMethod = (operationType, params) => {
  let executed = false;
  
  switch(operationType) {
    case 'rotate':
      if (typeof window.rotateModel === 'function') {
        window.rotateModel(params);
        executed = true;
      }
      break;
      
    case 'zoom':
      if (typeof window.zoomModel === 'function') {
        window.zoomModel(params);
        executed = true;
      }
      break;
      
    case 'focus':
      if (typeof window.focusModel === 'function') {
        window.focusModel(params);
        executed = true;
      }
      break;
      
    case 'reset':
      if (typeof window.resetModel === 'function') {
        window.resetModel();
        executed = true;
      }
      break;
  }
  
  return executed;
};

// 获取ModelViewer引用
const getModelViewerReference = () => {
  // 方法1: 从refs获取
  if (modelViewerRef.value) {
    console.log('从refs获取到ModelViewer引用');
    return modelViewerRef.value;
  }
  
  // 方法2: 从全局对象获取
  if (window.modelViewer) {
    console.log('从全局对象获取到ModelViewer引用');
    return window.modelViewer;
  }
  
  // 方法3: 从DOM中查找
  return findModelViewerInDOM();
};

// 从DOM中查找ModelViewer
const findModelViewerInDOM = () => {
  try {
    // 尝试直接从组件容器获取
    const modelContainer = document.querySelector('.model-container');
    if (modelContainer && modelContainer.firstElementChild && modelContainer.firstElementChild.__vue__) {
      console.log('从DOM中找到ModelViewer组件');
      return modelContainer.firstElementChild.__vue__;
    }
    
    // 尝试从父元素获取
    const appContainer = document.querySelector('.app-container');
    if (appContainer && appContainer.__vue__) {
      const modelViewer = appContainer.__vue__.refs?.modelViewer || 
                          appContainer.__vue__.setupState?.modelViewerRef?.value;
      
      if (modelViewer) {
        console.log('从App组件获取到ModelViewer引用');
        return modelViewer;
      }
    }
  } catch (error) {
    console.error('从DOM查找ModelViewer时出错:', error);
  }
  
  console.warn('无法在DOM中找到ModelViewer组件');
  return null;
};

// 直接执行具体操作
const executeDirectOperation = (modelViewer, action) => {
  const operation = action.operation || action.type || action.action;
  const parameters = action.parameters || action.params || {};
  
  console.log(`直接执行${operation}操作，参数:`, parameters);
  
  if (!operation) {
    console.error('操作类型未定义');
    return;
  }
  
  switch (operation.toLowerCase()) {
    case 'rotate':
      if (typeof modelViewer.rotateModel === 'function') {
        const angle = parseInt(parameters?.angle || 45);
        const direction = parameters?.direction || 'left';
        console.log(`执行旋转: 角度=${angle}, 方向=${direction}`);
        modelViewer.rotateModel({ angle, direction });
      } else if (typeof modelViewer.rotateComponent === 'function') {
        modelViewer.rotateComponent(null, parameters?.angle, parameters?.direction);
      } else {
        console.error('ModelViewer不支持旋转操作');
      }
      break;
      
    case 'zoom':
      if (typeof modelViewer.zoomModel === 'function') {
        const scale = parseFloat(parameters?.scale || 1.5);
        console.log(`执行缩放: 比例=${scale}`);
        modelViewer.zoomModel({ scale });
      } else if (typeof modelViewer.zoomComponent === 'function') {
        modelViewer.zoomComponent(null, parameters?.scale);
      } else {
        console.error('ModelViewer不支持缩放操作');
      }
      break;
      
    case 'focus':
      if (typeof modelViewer.focusModel === 'function') {
        const target = parameters?.target || 'center';
        console.log(`执行聚焦: 目标=${target}`);
        modelViewer.focusModel({ target });
      } else if (typeof modelViewer.focusOnComponent === 'function') {
        modelViewer.focusOnComponent(parameters?.target);
      } else {
        console.error('ModelViewer不支持聚焦操作');
      }
      break;
      
    case 'reset':
      if (typeof modelViewer.resetModel === 'function') {
        console.log('执行重置');
        modelViewer.resetModel();
      } else if (typeof modelViewer.executeLocalReset === 'function') {
        modelViewer.executeLocalReset();
      } else {
        console.error('ModelViewer不支持重置操作');
      }
      break;
      
    default:
      console.error(`未知操作类型: ${operation}`);
  }
};

// 组件挂载时执行
onMounted(async () => {
  // 连接WebSocket
  await wsManager.connectStatus();
  await wsManager.connectHealth();
  
  // 初始化MCP WebSocket连接
  initWebSocket();
  
  // 创建事件处理函数引用，以便能正确移除它们
  const executeQueuedCommandsHandler = () => {
    if (modelViewerRef.value && typeof modelViewerRef.value.executeQueuedCommands === 'function') {
      console.log('App.vue: 响应execute-queued-commands事件，执行队列命令');
      modelViewerRef.value.executeQueuedCommands();
    }
  };
  
  // 为测试按钮创建处理函数引用
  const rotateLeftHandler = () => rotateThroughMCP('left', 15);
  const rotateRightHandler = () => rotateThroughMCP('right', 15);
  const zoomInHandler = () => zoomThroughMCP(1.2);
  const zoomOutHandler = () => zoomThroughMCP(0.8);
  const resetHandler = () => resetThroughMCP();
  
  // 添加事件监听器，执行队列中的命令
  window.addEventListener('execute-queued-commands', executeQueuedCommandsHandler);
  
  // 添加测试按钮的事件处理
  document.querySelector('#rotate-left-btn')?.addEventListener('click', rotateLeftHandler);
  document.querySelector('#rotate-right-btn')?.addEventListener('click', rotateRightHandler);
  document.querySelector('#zoom-in-btn')?.addEventListener('click', zoomInHandler);
  document.querySelector('#zoom-out-btn')?.addEventListener('click', zoomOutHandler);
  document.querySelector('#reset-btn')?.addEventListener('click', resetHandler);
  
  // 将事件处理函数存储在window对象上，以便在卸载时能访问到它们
  window.__appEventHandlers = {
    executeQueuedCommandsHandler,
    rotateLeftHandler,
    rotateRightHandler,
    zoomInHandler,
    zoomOutHandler,
    resetHandler
  };
});

// 组件卸载前执行
onBeforeUnmount(() => {
  // 断开WebSocket连接
  wsManager.disconnect();
  
  // 获取之前保存的事件处理函数引用
  const handlers = window.__appEventHandlers || {};
  
  // 移除事件监听器
  window.removeEventListener('execute-queued-commands', handlers.executeQueuedCommandsHandler);
  
  // 安全地清除定时器
  if (typeof statusCheckInterval === 'number') {
    window.clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
  
  // 安全地关闭WebSocket连接
  if (wsConnection.value) {
    try {
      wsConnection.value.close();
    } catch (e) {
      console.error('关闭WebSocket连接时出错:', e);
    }
    wsConnection.value = null;
  }
  
  // 移除测试按钮的事件处理
  document.querySelector('#rotate-left-btn')?.removeEventListener('click', handlers.rotateLeftHandler);
  document.querySelector('#rotate-right-btn')?.removeEventListener('click', handlers.rotateRightHandler);
  document.querySelector('#zoom-in-btn')?.removeEventListener('click', handlers.zoomInHandler);
  document.querySelector('#zoom-out-btn')?.removeEventListener('click', handlers.zoomOutHandler);
  document.querySelector('#reset-btn')?.removeEventListener('click', handlers.resetHandler);
  
  // 清除引用
  delete window.__appEventHandlers;
});

// 移除或注释掉checkStatus函数
/*
const checkStatus = async () => {
  try {
    const pythonServiceUrl = import.meta.env.VITE_PYTHON_SERVICE_URL || 'http://localhost:9000';
    const response = await fetch(`${pythonServiceUrl}/api/websocket/status`);
    const data = await response.json();
    appStatus.value = data;
  } catch (error) {
    console.error('获取状态失败:', error);
    appStatus.value = { connected: false };
  }
};
*/

// 添加WebSocket连接状态
const wsStatus = ref('disconnected');
const serverStatus = ref({});
const wsConnection = ref(null);

// 初始化WebSocket连接
const initWebSocket = () => {
  try {
    // 获取WebSocket URL，优先使用环境变量，否则使用默认值
    const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000';
    const fullUrl = `${wsUrl}/ws/mcp`;
    
    // 关闭已有连接
    if (wsConnection.value && wsConnection.value.readyState !== WebSocket.CLOSED) {
      wsConnection.value.close();
    }
    
    console.log(`正在连接到WebSocket: ${fullUrl}`);
    wsStatus.value = 'connecting';
    
    // 创建新的WebSocket连接
    wsConnection.value = new WebSocket(fullUrl);
    
    // 连接打开时的处理
    wsConnection.value.onopen = () => {
      console.log('WebSocket连接已建立');
      wsStatus.value = 'connected';
      
      // 发送初始化消息
      sendCommand({
        type: 'init',
        clientType: 'web_ui',
        clientVersion: '1.0.0'
      });
      
      // 请求服务器状态
      requestServerStatus();
    };
    
    // 接收消息时的处理
    wsConnection.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('收到WebSocket消息:', data);
        
        // 处理不同类型的消息
        if (data.type === 'status') {
          serverStatus.value = data.data || {};
        } else if (data.type === 'mcp.response') {
          handleMCPResponse(data);
        }
      } catch (error) {
        console.error('处理WebSocket消息时出错:', error);
      }
    };
    
    // 连接关闭时的处理
    wsConnection.value.onclose = (event) => {
      console.log(`WebSocket连接已关闭: code=${event.code}, reason=${event.reason}`);
      wsStatus.value = 'disconnected';
      
      // 5秒后自动重连
      setTimeout(() => {
        if (wsStatus.value === 'disconnected') {
          console.log('尝试重新连接WebSocket...');
          initWebSocket();
        }
      }, 5000);
    };
    
    // 连接错误时的处理
    wsConnection.value.onerror = (error) => {
      console.error('WebSocket连接错误:', error);
      wsStatus.value = 'error';
    };
  } catch (error) {
    console.error('初始化WebSocket时出错:', error);
    wsStatus.value = 'error';
  }
};

// 发送WebSocket消息
const sendCommand = (command) => {
  if (wsConnection.value && wsConnection.value.readyState === WebSocket.OPEN) {
    try {
      const commandStr = JSON.stringify(command);
      wsConnection.value.send(commandStr);
      console.log('已发送命令:', command);
      return true;
    } catch (error) {
      console.error('发送命令时出错:', error);
      return false;
    }
  } else {
    console.warn('WebSocket未连接，无法发送命令');
    return false;
  }
};

// 请求服务器状态
const requestServerStatus = () => {
  sendCommand({
    type: 'status.request',
    timestamp: new Date().toISOString()
  });
};

// 处理MCP响应
const handleMCPResponse = (response) => {
  console.log('处理MCP响应:', response);
  
  // 可以根据commandId、status等处理具体的响应
  if (response.status === 'success') {
    console.log('MCP命令执行成功:', response.data);
  } else if (response.status === 'error') {
    console.error('MCP命令执行失败:', response.message);
  }
};

// 使用MCP协议旋转模型
const rotateThroughMCP = (direction, angle) => {
  console.log(`通过MCP协议旋转模型: 方向=${direction}, 角度=${angle}`);
  
  // 优先使用全局window.rotateModel函数
  if (typeof window.rotateModel === 'function') {
    console.log('使用全局rotateModel函数');
    const result = window.rotateModel({direction, angle});
    console.log('旋转结果:', result);
    return result.success;
  }
  // 其次，通过模型组件调用
  else if (modelViewerRef.value && typeof modelViewerRef.value.rotateModel === 'function') {
    console.log('使用组件rotateModel方法');
    const result = modelViewerRef.value.rotateModel({direction, angle});
    console.log('旋转结果:', result);
    return result.success;
  }
  // 使用 WebSocket 发送简单的命令
  else {
    console.log('使用WebSocket发送旋转命令');
    const command = {
      action: 'rotate',
      parameters: {
        direction: direction,
        angle: angle
      }
    };
    
    // 添加类型和时间戳，转换为合适的消息格式
    const message = {
      type: 'mcp.command',
      command: command,
      timestamp: new Date().toISOString()
    };
    
    return sendCommand(message);
  }
};

// 使用MCP协议缩放模型
const zoomThroughMCP = (scale) => {
  console.log(`通过MCP协议缩放模型: 比例=${scale}`);
  
  // 创建缩放命令
  const command = {
    action: 'zoom',
    parameters: {
      scale: scale
    }
  };
  
  // 添加类型和时间戳，转换为合适的消息格式
  const message = {
    type: 'mcp.command',
    command: command,
    timestamp: new Date().toISOString()
  };
  
  return sendCommand(message);
};

// 重置模型视图
const resetThroughMCP = () => {
  console.log('通过MCP协议重置模型视图');
  
  // 创建重置命令
  const command = {
    action: 'reset'
  };
  
  // 添加类型和时间戳，转换为合适的消息格式
  const message = {
    type: 'mcp.command',
    command: command,
    timestamp: new Date().toISOString()
  };
  
  return sendCommand(message);
};
</script>

<template>
  <div class="app-container">
    <header class="app-header">
      <h1>数字孪生系统 (Digital Twin System)</h1>
      <div class="header-controls">
        <button @click="openChatDialog" class="control-btn chat-btn">
          AI助手 (AI Assistant)
        </button>
      </div>
    </header>
    
    <div class="main-content">
      <div class="model-container">
        <ModelViewer ref="modelViewerRef" />
      </div>
    </div>
    
    <ChatDialog 
      v-model:modelVisible="chatDialogVisible"
      @executeAction="handleExecuteAction"
    />
  </div>
</template>

<style>
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  background-color: #f5f5f5;
  color: #333;
  line-height: 1.6;
}

.app-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  background-color: #2c3e50;
  color: white;
  padding: 1rem 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-controls {
  display: flex;
  gap: 10px;
}

.control-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  background-color: #3498db;
  color: white;
  transition: background-color 0.2s;
}

.control-btn:hover {
  background-color: #2980b9;
}

.chat-btn {
  background-color: #e74c3c;
}

.chat-btn:hover {
  background-color: #c0392b;
}

.main-content {
  display: flex;
  flex: 1;
  padding: 1rem;
  gap: 1rem;
}

.model-container {
  flex: 1;
  min-height: 500px;
  background-color: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

@media (max-width: 1024px) {
  .main-content {
    flex-direction: column;
  }
}
</style>
