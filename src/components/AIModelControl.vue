<template>
  <div class="ai-assistant-container">
    <div class="controls-panel">
      <div class="model-selector">
        <label for="modelSelect">AI模型选择</label>
        <select id="modelSelect" v-model="selectedModel">
          <option value="claude">Claude</option>
          <option value="gpt4o">GPT-4o</option>
          <option value="deepseek">DeepSeek</option>
        </select>
      </div>
      
      <div class="server-status" :class="serverStatus">
        <span class="status-icon"></span>
        <span class="status-text">{{ serverStatusText }}</span>
        <button @click="checkServerStatus" title="刷新服务器状态">
          <i class="reload-icon">↻</i>
        </button>
      </div>
    </div>
    
    <div class="chat-container">
      <div class="messages" ref="messagesContainer">
        <div v-for="(message, index) in messages" :key="index" 
             :class="['message', message.sender]">
          <div class="message-content">
            <div v-if="message.sender === 'ai'" class="ai-icon">🤖</div>
            <div v-else class="user-icon">👤</div>
            <div class="text">{{ message.text }}</div>
          </div>
          <div v-if="message.operation" class="operation-info">
            <div class="operation-badge">
              {{ message.operation.operation }} 
              <span v-if="message.operation.success" class="success">✓</span>
              <span v-else class="failed">✗</span>
            </div>
          </div>
        </div>
        
        <div v-if="isLoading" class="loading-indicator">
          <div class="dot-flashing"></div>
        </div>
      </div>
      
      <div class="input-container">
        <textarea 
          v-model="userInput" 
          @keydown.enter.prevent="sendMessage"
          placeholder="输入指令，例如：向左旋转模型45度" 
          :disabled="isLoading || !isServerConnected"
        ></textarea>
        <button 
          @click="sendMessage" 
          :disabled="isLoading || !userInput || !isServerConnected"
          class="send-button"
        >
          发送
        </button>
      </div>
    </div>
    
    <div class="examples-panel">
      <h4>示例指令</h4>
      <div class="example-list">
        <button 
          v-for="example in examples" 
          :key="example" 
          @click="useExample(example)"
          :disabled="isLoading || !isServerConnected"
        >
          {{ example }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, nextTick, computed } from 'vue';

// 定义消息接口
interface Message {
  text: string;
  sender: 'user' | 'ai';
  operation?: {
    operation: string;
    parameters?: Record<string, any>;
    success: boolean;
  };
}

// 响应式状态
const userInput = ref('');
const messages = ref<Message[]>([]);
const isLoading = ref(false);
const selectedModel = ref('claude');
const serverStatus = ref('unknown');
const isServerConnected = ref(false);
const messagesContainer = ref<HTMLElement | null>(null);

// 示例指令
const examples = [
  '向左旋转模型45度',
  '将模型放大1.5倍',
  '将模型缩小到原来的0.8倍',
  '聚焦到模型中心',
  '重置模型视图',
  '将模型材质变为金属质感'
];

// 计算属性：服务器状态文本
const serverStatusText = computed(() => {
  switch (serverStatus.value) {
    case 'online':
      return 'MCP服务已连接';
    case 'offline':
      return 'MCP服务未连接';
    case 'degraded':
      return 'MCP服务状态异常';
    default:
      return '正在检查MCP服务...';
  }
});

// 服务器地址
const MCP_SERVER_URL = import.meta.env.VITE_MCP_SERVER_URL || 'http://localhost:9000';

// 检查服务器状态
const checkServerStatus = async () => {
  try {
    serverStatus.value = 'unknown';
    const response = await fetch(`${MCP_SERVER_URL}/health`);
    const data = await response.json();
    
    if (data.status === 'healthy') {
      serverStatus.value = 'online';
      isServerConnected.value = true;
    } else if (data.status === 'degraded') {
      serverStatus.value = 'degraded';
      isServerConnected.value = true;
    } else {
      serverStatus.value = 'offline';
      isServerConnected.value = false;
    }
    
    return data;
  } catch (error) {
    console.error('服务器状态检查失败:', error);
    serverStatus.value = 'offline';
    isServerConnected.value = false;
    return null;
  }
};

// 发送消息到MCP服务器
const sendToMCPServer = async (text: string) => {
  try {
    const response = await fetch(`${MCP_SERVER_URL}/api/llm/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: text,
        model: selectedModel.value
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`服务器错误: ${response.status} - ${errorText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('发送消息失败:', error);
    throw error;
  }
};

// 发送消息
const sendMessage = async () => {
  if (!userInput.value.trim() || isLoading.value || !isServerConnected.value) return;
  
  const userMessage = userInput.value.trim();
  messages.value.push({
    text: userMessage,
    sender: 'user'
  });
  
  userInput.value = '';
  isLoading.value = true;
  
  try {
    // 滚动到底部
    await scrollToBottom();
    
    // 发送消息到MCP服务器
    const response = await sendToMCPServer(userMessage);
    
    if (response.success) {
      // 添加AI回复
      const responseMessage: Message = {
        text: '已执行您的指令',
        sender: 'ai'
      };
      
      // 如果有操作结果，添加到消息中
      if (response.operation_result) {
        responseMessage.operation = {
          operation: response.operation_result.operation,
          parameters: response.operation_result.parameters,
          success: response.operation_result.success
        };
      }
      
      messages.value.push(responseMessage);
    } else {
      // 处理错误
      messages.value.push({
        text: `无法执行指令: ${response.error || '未知错误'}`,
        sender: 'ai'
      });
    }
  } catch (error) {
    console.error('处理消息时出错:', error);
    messages.value.push({
      text: `发生错误: ${error instanceof Error ? error.message : '未知错误'}`,
      sender: 'ai'
    });
  } finally {
    isLoading.value = false;
    // 滚动到底部
    await scrollToBottom();
  }
};

// 使用示例指令
const useExample = (example: string) => {
  userInput.value = example;
};

// 滚动到底部
const scrollToBottom = async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
};

// 监听消息变化，自动滚动到底部
watch(messages, async () => {
  await scrollToBottom();
}, { deep: true });

// 监听服务器状态变化
watch(serverStatus, (newStatus) => {
  if (newStatus === 'offline' && messages.value.length === 0) {
    messages.value.push({
      text: 'MCP服务未连接，请检查服务器状态后再试。',
      sender: 'ai'
    });
  }
});

// 组件挂载时检查服务器状态
onMounted(async () => {
  await checkServerStatus();
  
  // 如果服务器在线，显示欢迎消息
  if (isServerConnected.value) {
    messages.value.push({
      text: '您好！我是3D模型操作助手，请输入您想要执行的操作指令。',
      sender: 'ai'
    });
  }
  
  // 每60秒检查一次服务器状态
  setInterval(checkServerStatus, 60000);
});
</script>

<style scoped>
.ai-assistant-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background-color: #f8f9fa;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

.controls-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 15px;
  background-color: #fff;
  border-bottom: 1px solid #e9ecef;
}

.model-selector {
  display: flex;
  align-items: center;
  gap: 10px;
}

.model-selector select {
  padding: 5px 10px;
  border-radius: 4px;
  border: 1px solid #ced4da;
  background-color: #fff;
  font-size: 14px;
}

.server-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.server-status .status-icon {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.server-status.online .status-icon {
  background-color: #28a745;
}

.server-status.offline .status-icon {
  background-color: #dc3545;
}

.server-status.degraded .status-icon {
  background-color: #ffc107;
}

.server-status.unknown .status-icon {
  background-color: #6c757d;
}

.server-status button {
  background: none;
  border: none;
  cursor: pointer;
  color: #6c757d;
  font-size: 16px;
  transition: transform 0.3s;
}

.server-status button:hover {
  transform: rotate(180deg);
  color: #495057;
}

.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 15px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.message {
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.message.user {
  align-self: flex-end;
}

.message.ai {
  align-self: flex-start;
}

.message-content {
  display: flex;
  gap: 10px;
  padding: 10px 15px;
  border-radius: 18px;
  line-height: 1.5;
}

.user .message-content {
  background-color: #007bff;
  color: white;
  border-top-right-radius: 4px;
}

.ai .message-content {
  background-color: #e9ecef;
  color: #212529;
  border-top-left-radius: 4px;
}

.ai-icon, .user-icon {
  font-size: 16px;
}

.operation-info {
  font-size: 12px;
  padding: 0 5px;
}

.operation-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  background-color: #e9ecef;
  color: #495057;
}

.operation-badge .success {
  color: #28a745;
}

.operation-badge .failed {
  color: #dc3545;
}

.input-container {
  display: flex;
  gap: 10px;
  padding: 15px;
  background-color: #fff;
  border-top: 1px solid #e9ecef;
}

textarea {
  flex: 1;
  height: 60px;
  padding: 10px 15px;
  border-radius: 4px;
  border: 1px solid #ced4da;
  resize: none;
  font-family: inherit;
  font-size: 14px;
}

textarea:focus {
  outline: none;
  border-color: #80bdff;
  box-shadow: 0 0 0 0.2rem rgba(0, 123, 255, 0.25);
}

.send-button {
  padding: 10px 20px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.send-button:hover:not(:disabled) {
  background-color: #0069d9;
}

.send-button:disabled {
  background-color: #6c757d;
  cursor: not-allowed;
}

.examples-panel {
  padding: 10px 15px;
  background-color: #fff;
  border-top: 1px solid #e9ecef;
}

.examples-panel h4 {
  margin: 0 0 10px 0;
  font-size: 14px;
  color: #495057;
}

.example-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.example-list button {
  padding: 5px 10px;
  background-color: #e9ecef;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.example-list button:hover:not(:disabled) {
  background-color: #dee2e6;
}

.example-list button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-indicator {
  display: flex;
  justify-content: center;
  padding: 10px 0;
}

.dot-flashing {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background-color: #6c757d;
  color: #6c757d;
  animation: dot-flashing 1s infinite linear alternate;
  animation-delay: 0.5s;
}

.dot-flashing::before, .dot-flashing::after {
  content: '';
  display: inline-block;
  position: absolute;
  top: 0;
}

.dot-flashing::before {
  left: -15px;
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background-color: #6c757d;
  color: #6c757d;
  animation: dot-flashing 1s infinite alternate;
  animation-delay: 0s;
}

.dot-flashing::after {
  left: 15px;
  width: 10px;
  height: 10px;
  border-radius: 5px;
  background-color: #6c757d;
  color: #6c757d;
  animation: dot-flashing 1s infinite alternate;
  animation-delay: 1s;
}

@keyframes dot-flashing {
  0% {
    background-color: #6c757d;
  }
  50%, 100% {
    background-color: rgba(108, 117, 125, 0.2);
  }
}
</style> 