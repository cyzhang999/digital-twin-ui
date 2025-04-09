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
  
  // 检查window全局对象是否有rotateModel等函数
  if (action.type === 'rotate' || action.operation === 'rotate') {
    const params = action.parameters || action.params || {};
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
  } else if (action.type === 'zoom' || action.operation === 'zoom') {
    const params = action.parameters || action.params || {};
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
    // 再检查app全局对象中的方法
    else if (window.app && typeof window.app.zoomComponent === 'function') {
      window.app.zoomComponent(null, scale);
    }
    else {
      console.error('找不到可用的缩放方法');
    }
  } else if (action.type === 'focus' || action.operation === 'focus') {
    const params = action.parameters || action.params || {};
    const target = params.target || 'center';
    
    console.log(`执行聚焦操作: 目标=${target}`);
    
    // 优先使用全局window.focusOnModel函数
    if (typeof window.focusOnModel === 'function') {
      window.focusOnModel({target});
    }
    // 其次检查modelViewerRef中的方法
    else if (modelViewerRef.value && typeof modelViewerRef.value.focusOnModel === 'function') {
      modelViewerRef.value.focusOnModel({target});
    }
    // 再检查app全局对象中的方法
    else if (window.app && typeof window.app.focusOnComponent === 'function') {
      window.app.focusOnComponent(target);
    }
    else {
      console.error('找不到可用的聚焦方法');
    }
  } else if (action.type === 'reset' || action.operation === 'reset') {
    console.log('执行重置操作');
    
    // 优先使用全局window.resetModel函数
    if (typeof window.resetModel === 'function') {
      window.resetModel();
    }
    // 其次检查modelViewerRef中的方法
    else if (modelViewerRef.value && typeof modelViewerRef.value.resetModel === 'function') {
      modelViewerRef.value.resetModel();
    }
    // 再检查app全局对象中的方法
    else if (window.app && typeof window.app.resetModel === 'function') {
      window.app.resetModel();
    }
    else {
      console.error('找不到可用的重置方法');
    }
  } else {
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

// 修改组件卸载前的清理
onBeforeUnmount(() => {
  // 断开WebSocket连接
  wsManager.disconnect();
  
  // 清除定时器
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
  }
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
