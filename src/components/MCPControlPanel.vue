<template>
  <div class="mcp-control-panel">
    <div class="panel-header">
      <h3>MCP控制面板 (MCP Control Panel)</h3>
      <div class="connection-status" :class="mcpStatus">
        <span class="status-icon"></span>
        <span class="status-text">{{ connectionStatusText }}</span>
      </div>
    </div>
    
    <div class="panel-body">
      <div class="connection-controls">
        <button @click="connectMCP" :disabled="isConnected" class="connect-btn">
          连接 (Connect)
        </button>
        <button @click="disconnectMCP" :disabled="!isConnected" class="disconnect-btn">
          断开 (Disconnect)
        </button>
        <button @click="reconnectMCP" class="reconnect-btn">
          重连 (Reconnect)
        </button>
      </div>
      
      <div class="command-section">
        <h4>模型操作 (Model Operations)</h4>
        
        <div class="command-group">
          <div class="command-label">旋转 (Rotate)</div>
          <div class="command-controls">
            <div class="control-row">
              <span>方向 (Direction):</span>
              <select v-model="rotateDirection">
                <option value="left">左 (Left)</option>
                <option value="right">右 (Right)</option>
              </select>
            </div>
            <div class="control-row">
              <span>角度 (Angle):</span>
              <input type="range" v-model.number="rotateAngle" min="5" max="180" step="5" />
              <span>{{ rotateAngle }}°</span>
            </div>
            <div class="control-row">
              <button @click="executeRotate" :disabled="!isConnected">
                执行旋转 (Execute Rotate)
              </button>
            </div>
          </div>
        </div>
        
        <div class="command-group">
          <div class="command-label">缩放 (Zoom)</div>
          <div class="command-controls">
            <div class="control-row">
              <span>比例 (Scale):</span>
              <input type="range" v-model.number="zoomScale" min="0.1" max="3" step="0.1" />
              <span>{{ zoomScale }}x</span>
            </div>
            <div class="control-row">
              <button @click="executeZoom" :disabled="!isConnected">
                执行缩放 (Execute Zoom)
              </button>
            </div>
          </div>
        </div>
        
        <div class="command-group">
          <div class="command-label">聚焦 (Focus)</div>
          <div class="command-controls">
            <div class="control-row">
              <span>目标 (Target):</span>
              <select v-model="focusTarget">
                <option value="center">中心 (Center)</option>
                <option value="meeting_room">会议室 (Meeting Room)</option>
                <option value="office_area">办公区 (Office Area)</option>
                <option value="reception">前台 (Reception)</option>
              </select>
            </div>
            <div class="control-row">
              <button @click="executeFocus" :disabled="!isConnected">
                执行聚焦 (Execute Focus)
              </button>
            </div>
          </div>
        </div>
        
        <div class="command-group">
          <div class="command-label">重置 (Reset)</div>
          <div class="command-controls">
            <div class="control-row">
              <button @click="executeReset" :disabled="!isConnected">
                重置视图 (Reset View)
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <div class="message-log">
        <h4>消息日志 (Message Log)</h4>
        <div class="log-container">
          <div v-for="(message, index) in messageLog" :key="index" class="log-entry" :class="message.type">
            <span class="log-time">{{ message.time }}</span>
            <span class="log-content">{{ message.content }}</span>
          </div>
        </div>
        <button @click="clearLog" class="clear-log-btn">清除日志 (Clear Log)</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { getMCPClient, useMCPClient, MCPMessage } from '../utils/MCPClient';

// 定义属性
const props = defineProps<{
  modelViewerRef?: any;
}>();

// 定义事件
const emit = defineEmits<{
  (e: 'command-executed', command: string, result: any): void;
}>();

// MCP状态
const mcpStatus = ref('disconnected');
const isConnected = ref(false);

// 命令参数
const rotateDirection = ref('left');
const rotateAngle = ref(45);
const zoomScale = ref(1.5);
const focusTarget = ref('center');

// 消息日志
interface LogMessage {
  time: string;
  content: string;
  type: 'info' | 'error' | 'success' | 'warning';
}

const messageLog = ref<LogMessage[]>([]);
const maxLogEntries = 100;

// MCP客户端
let mcpClient: any = null;

// 计算属性：连接状态文本
const connectionStatusText = computed(() => {
  switch (mcpStatus.value) {
    case 'connected':
      return '已连接 (Connected)';
    case 'connecting':
      return '连接中 (Connecting)';
    case 'disconnected':
      return '未连接 (Disconnected)';
    case 'reconnecting':
      return '重连中 (Reconnecting)';
    case 'error':
      return '连接错误 (Error)';
    default:
      return '未知 (Unknown)';
  }
});

// 添加日志
const addLog = (content: string, type: 'info' | 'error' | 'success' | 'warning' = 'info') => {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  
  messageLog.value.unshift({
    time: timeStr,
    content,
    type
  });
  
  // 限制日志条目数
  if (messageLog.value.length > maxLogEntries) {
    messageLog.value = messageLog.value.slice(0, maxLogEntries);
  }
};

// 清除日志
const clearLog = () => {
  messageLog.value = [];
};

// 连接MCP
const connectMCP = () => {
  if (!mcpClient) {
    initMCPClient();
  } else {
    mcpClient.connect();
  }
  
  addLog('正在连接到MCP服务...', 'info');
};

// 断开MCP连接
const disconnectMCP = () => {
  if (mcpClient) {
    mcpClient.disconnect();
    addLog('已断开与MCP服务的连接', 'warning');
  }
};

// 重连MCP
const reconnectMCP = async () => {
  if (mcpClient) {
    mcpClient.reconnect();
    addLog('正在重新连接到MCP服务...', 'info');
  } else {
    try {
      await initMCPClient();
      addLog('MCP客户端已初始化', 'info');
    } catch (error) {
      addLog(`MCP客户端初始化失败: ${error}`, 'error');
    }
  }
};

// 初始化MCP客户端
const initMCPClient = async () => {
  try {
    const serverUrl = import.meta.env.VITE_PYTHON_SERVICE_URL || 'http://localhost:9000';
    const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000/ws/mcp';
    
    // 动态导入MCPClient模块
    const MCPModule = await import('../utils/MCPClient');
    const { getMCPClient } = MCPModule;
    
    mcpClient = getMCPClient({
      serverUrl,
      wsUrl,
      onStatusChange: (status) => {
        mcpStatus.value = status;
        isConnected.value = status === 'connected';
        
        if (status === 'connected') {
          addLog('已连接到MCP服务', 'success');
        } else if (status === 'error') {
          addLog('连接MCP服务时出错', 'error');
        }
      },
      onMessage: (message) => {
        handleMCPMessage(message);
      }
    });
    
    mcpClient.connect();
    
    addLog('MCP客户端已初始化', 'info');
  } catch (error) {
    addLog(`初始化MCP客户端失败: ${error}`, 'error');
  }
};

// 处理MCP消息
const handleMCPMessage = (message: MCPMessage) => {
  let logType: 'info' | 'error' | 'success' | 'warning' = 'info';
  let logContent = `收到消息: ${message.type}`;
  
  if (message.type === 'error') {
    logType = 'error';
    logContent = `错误: ${message.message || '未知错误'}`;
  } else if (message.type === 'response') {
    logType = message.success ? 'success' : 'error';
    logContent = `命令结果: ${message.success ? '成功' : '失败'}${message.result ? ' - ' + JSON.stringify(message.result) : ''}`;
  } else if (message.type === 'command') {
    logContent = `命令: ${message.command?.action} ${JSON.stringify(message.command?.parameters || {})}`;
  }
  
  addLog(logContent, logType);
};

// 执行旋转命令
const executeRotate = () => {
  if (!mcpClient || !isConnected.value) {
    addLog('无法执行旋转命令: 未连接到MCP服务', 'error');
    return;
  }
  
  mcpClient.rotate(rotateDirection.value, rotateAngle.value, null, (result) => {
    addLog(`旋转命令执行结果: ${result.success ? '成功' : '失败'}`, result.success ? 'success' : 'error');
    emit('command-executed', 'rotate', result);
    
    // 如果有modelViewerRef，也在本地执行
    if (props.modelViewerRef && !result.success) {
      props.modelViewerRef.rotateModel(null, rotateDirection.value, rotateAngle.value);
    }
  });
  
  addLog(`执行旋转命令: 方向=${rotateDirection.value}, 角度=${rotateAngle.value}°`, 'info');
};

// 执行缩放命令
const executeZoom = () => {
  if (!mcpClient || !isConnected.value) {
    addLog('无法执行缩放命令: 未连接到MCP服务', 'error');
    return;
  }
  
  mcpClient.zoom(zoomScale.value, null, (result) => {
    addLog(`缩放命令执行结果: ${result.success ? '成功' : '失败'}`, result.success ? 'success' : 'error');
    emit('command-executed', 'zoom', result);
    
    // 如果有modelViewerRef，也在本地执行
    if (props.modelViewerRef && !result.success) {
      props.modelViewerRef.zoomModel(null, zoomScale.value);
    }
  });
  
  addLog(`执行缩放命令: 比例=${zoomScale.value}x`, 'info');
};

// 执行聚焦命令
const executeFocus = () => {
  if (!mcpClient || !isConnected.value) {
    addLog('无法执行聚焦命令: 未连接到MCP服务', 'error');
    return;
  }
  
  mcpClient.focus(focusTarget.value, (result) => {
    addLog(`聚焦命令执行结果: ${result.success ? '成功' : '失败'}`, result.success ? 'success' : 'error');
    emit('command-executed', 'focus', result);
    
    // 如果有modelViewerRef，也在本地执行
    if (props.modelViewerRef && !result.success) {
      props.modelViewerRef.focusOnModel(focusTarget.value);
    }
  });
  
  addLog(`执行聚焦命令: 目标=${focusTarget.value}`, 'info');
};

// 执行重置命令
const executeReset = () => {
  if (!mcpClient || !isConnected.value) {
    addLog('无法执行重置命令: 未连接到MCP服务', 'error');
    return;
  }
  
  mcpClient.reset((result) => {
    addLog(`重置命令执行结果: ${result.success ? '成功' : '失败'}`, result.success ? 'success' : 'error');
    emit('command-executed', 'reset', result);
    
    // 如果有modelViewerRef，也在本地执行
    if (props.modelViewerRef && !result.success) {
      props.modelViewerRef.resetModel();
    }
  });
  
  addLog('执行重置命令', 'info');
};

// 组件初始化
onMounted(async () => {
  try {
    await initMCPClient();
  } catch (error) {
    console.error('MCP客户端初始化失败:', error);
    addLog('MCP客户端初始化失败', 'error');
  }
});

onUnmounted(() => {
  // 断开连接
  if (mcpClient) {
    mcpClient.disconnect();
  }
});

// 暴露方法
defineExpose({
  connectMCP,
  disconnectMCP,
  reconnectMCP,
  executeRotate,
  executeZoom,
  executeFocus,
  executeReset,
  mcpStatus,
  isConnected
});
</script>

<style scoped>
.mcp-control-panel {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  background-color: #f8f9fa;
  margin-bottom: 20px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid #ddd;
}

.panel-header h3 {
  margin: 0;
  font-size: 18px;
  color: #333;
}

.connection-status {
  display: flex;
  align-items: center;
  font-size: 14px;
}

.status-icon {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-right: 8px;
}

.connection-status.connected .status-icon {
  background-color: #28a745;
}

.connection-status.connecting .status-icon,
.connection-status.reconnecting .status-icon {
  background-color: #ffc107;
  animation: pulse 1s infinite;
}

.connection-status.disconnected .status-icon {
  background-color: #dc3545;
}

.connection-status.error .status-icon {
  background-color: #dc3545;
}

@keyframes pulse {
  0% { opacity: 0.5; }
  50% { opacity: 1; }
  100% { opacity: 0.5; }
}

.connection-controls {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.connect-btn {
  background-color: #28a745;
  color: white;
}

.disconnect-btn {
  background-color: #dc3545;
  color: white;
}

.reconnect-btn {
  background-color: #17a2b8;
  color: white;
}

.command-section {
  margin-bottom: 20px;
}

.command-section h4 {
  margin-top: 0;
  margin-bottom: 12px;
  font-size: 16px;
  color: #333;
}

.command-group {
  display: flex;
  margin-bottom: 16px;
  padding: 12px;
  background-color: white;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.command-label {
  width: 100px;
  font-weight: 600;
  padding-top: 4px;
}

.command-controls {
  flex: 1;
}

.control-row {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.control-row span {
  min-width: 100px;
}

.control-row input[type="range"] {
  flex: 1;
  margin: 0 10px;
}

.control-row select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid #ddd;
}

button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  background-color: #0d6efd;
  color: white;
  transition: background-color 0.2s;
}

button:hover {
  background-color: #0b5ed7;
}

button:disabled {
  background-color: #6c757d;
  cursor: not-allowed;
}

.message-log {
  margin-top: 20px;
}

.message-log h4 {
  margin-top: 0;
  margin-bottom: 8px;
  font-size: 16px;
  color: #333;
}

.log-container {
  max-height: 200px;
  overflow-y: auto;
  padding: 8px;
  background-color: #1e1e1e;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  margin-bottom: 8px;
}

.log-entry {
  margin-bottom: 4px;
  padding: 4px;
  border-radius: 2px;
  color: #d4d4d4;
}

.log-entry.info {
  color: #d4d4d4;
}

.log-entry.success {
  color: #4caf50;
}

.log-entry.error {
  color: #ff5252;
}

.log-entry.warning {
  color: #ffb86c;
}

.log-time {
  color: #777;
  margin-right: 8px;
}

.clear-log-btn {
  background-color: #6c757d;
  font-size: 12px;
  padding: 4px 8px;
}
</style> 