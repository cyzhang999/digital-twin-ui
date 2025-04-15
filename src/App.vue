<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import ModelViewer from './components/ModelViewer.vue';
import ChatDialog from './components/ChatDialog.vue';

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
  }
};

// 替换HTTP请求为WebSocket连接
const appStatus = ref({ connected: false });
const healthStatus = ref({ status: 'unknown', message: '初始化中' });

// 打开聊天对话框 (Open chat dialog)
const openChatDialog = () => {
  chatDialogVisible.value = true;
};

// 处理聊天操作
const handleChatAction = (action) => {
  console.log('收到聊天操作:', action);
  
  if (!modelViewerRef.value) {
    console.error('模型查看器未初始化，无法执行操作');
    return;
  }
  
  // 获取操作类型
  const operationType = action.type || action.operation;
  const params = action.parameters || action.params || {};
  
  // 检查是否是重复操作
  const lastOperationType = sessionStorage.getItem('last_mcp_operation_type');
  const lastOperationTime = parseInt(sessionStorage.getItem('last_mcp_operation_time') || '0');
  const currentTime = Date.now();
  const timeDifference = currentTime - lastOperationTime;
  
  // 如果是相同类型的操作且时间差小于3秒，认为是重复操作
  if (lastOperationType === operationType && timeDifference < 3000) {
    console.log(`检测到重复操作: ${operationType}，跳过执行`);
    // 清除标记，防止影响后续操作
    sessionStorage.removeItem('last_mcp_operation_type');
    sessionStorage.removeItem('last_mcp_operation_time');
    return;
  }

  // 记录当前操作，防止重复执行
  sessionStorage.setItem('last_mcp_operation_type', operationType);
  sessionStorage.setItem('last_mcp_operation_time', currentTime.toString());
  
  // 检查window全局对象是否有rotateModel等函数
  if (action.type === 'rotate' || action.operation === 'rotate') {
    const direction = params.direction || 'left';
    const angle = params.angle || 45;
    
    console.log(`执行旋转操作: 方向=${direction}, 角度=${angle}`);
    
    // 优先使用全局window.rotateModel函数
    if (typeof window.rotateModel === 'function') {
      window.rotateModel({direction, angle});
    }
    // 其次检查modelViewerRef中的方法
    else if (modelViewerRef.value && typeof modelViewerRef.value.rotateModel === 'function') {
      modelViewerRef.value.rotateModel({direction, angle});
    }
    // 再检查app全局对象中的方法
    else if (window.app && typeof window.app.rotateComponent === 'function') {
      window.app.rotateComponent(null, angle, direction);
    }
    else {
      console.error('找不到可用的旋转方法');
    }
  }
  // 处理缩放操作
  else if (action.type === 'zoom' || action.operation === 'zoom') {
    const scale = params.scale || 1.5;
    
    console.log(`执行缩放操作: 比例=${scale}`);
    
    // 优先使用全局window.zoomModel函数
    if (typeof window.zoomModel === 'function') {
      window.zoomModel({scale});
    }
    // 其次检查modelViewerRef中的方法
    else if (modelViewerRef.value && typeof modelViewerRef.value.zoomModel === 'function') {
      modelViewerRef.value.zoomModel({scale});
    }
    // 再检查全局对象中的其他可能方法
    else if (window.scaleModel && typeof window.scaleModel === 'function') {
      window.scaleModel(scale);
    }
    else if (window.app && typeof window.app.zoomComponent === 'function') {
      window.app.zoomComponent(null, scale);
    }
    else {
      console.error('找不到可用的缩放方法');
    }
  }
  // 处理聚焦操作
  else if (action.type === 'focus' || action.operation === 'focus') {
    const target = params.target || 'center';
    
    console.log(`执行聚焦操作: 目标=${target}`);
    
    // 优先使用全局window.focusModel函数
    if (typeof window.focusModel === 'function') {
      window.focusModel({target});
    }
    // 其次检查modelViewerRef中的方法
    else if (modelViewerRef.value && typeof modelViewerRef.value.focusModel === 'function') {
      modelViewerRef.value.focusModel({target});
    }
    // 再检查其他可能方法
    else if (typeof window.focusOnModel === 'function') {
      window.focusOnModel({target});
    }
    else if (window.app && typeof window.app.focusModel === 'function') {
      window.app.focusModel({target});
    }
    else {
      console.error('找不到可用的聚焦方法');
    }
  }
  // 处理重置操作
  else if (action.type === 'reset' || action.operation === 'reset') {
    console.log('执行重置视图操作');
    
    // 优先使用全局window.resetModel函数
    if (typeof window.resetModel === 'function') {
      window.resetModel();
    }
    // 其次检查modelViewerRef中的方法
    else if (modelViewerRef.value && typeof modelViewerRef.value.resetModel === 'function') {
      modelViewerRef.value.resetModel();
    }
    else {
      console.error('找不到可用的重置方法');
    }
  }
  else {
    console.warn(`未知操作类型: ${action.type || action.operation}`);
  }
};

// 修改生命周期钩子，连接WebSocket
onMounted(async () => {
  // 连接WebSocket
  await wsManager.connectStatus();
  await wsManager.connectHealth();
  
  // 不再使用HTTP请求检查状态
  // checkStatus();
  // setInterval(checkStatus, 30000);
});

// 组件卸载前执行
onBeforeUnmount(() => {
  // 断开WebSocket连接
  wsManager.disconnect();
  
  // 清除定时器
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
  }
  
  // 关闭WebSocket连接
  if (wsConnection.value) {
    wsConnection.value.close();
    wsConnection.value = null;
  }
  
  // 移除测试按钮的事件处理
  document.querySelector('#rotate-left-btn')?.removeEventListener('click', () => {});
  document.querySelector('#rotate-right-btn')?.removeEventListener('click', () => {});
  document.querySelector('#zoom-in-btn')?.removeEventListener('click', () => {});
  document.querySelector('#zoom-out-btn')?.removeEventListener('click', () => {});
  document.querySelector('#reset-btn')?.removeEventListener('click', () => {});
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

// 组件挂载时执行
onMounted(() => {
  // 初始化WebSocket连接
  initWebSocket();
  
  // 添加测试按钮的事件处理
  document.querySelector('#rotate-left-btn')?.addEventListener('click', () => rotateThroughMCP('left', 15));
  document.querySelector('#rotate-right-btn')?.addEventListener('click', () => rotateThroughMCP('right', 15));
  document.querySelector('#zoom-in-btn')?.addEventListener('click', () => zoomThroughMCP(1.2));
  document.querySelector('#zoom-out-btn')?.addEventListener('click', () => zoomThroughMCP(0.8));
  document.querySelector('#reset-btn')?.addEventListener('click', () => resetThroughMCP());
});
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
      @executeAction="handleChatAction"
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
