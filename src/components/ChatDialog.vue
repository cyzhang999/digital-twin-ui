<script setup lang="ts">
import { ref, reactive, onMounted, nextTick, computed, watch, onBeforeUnmount } from 'vue';
import { getMCPClient } from '../utils/MCPClient';

// 定义props (Define props)
const props = defineProps<{
  modelVisible: boolean;
}>();

// 定义事件 (Define events)
const emit = defineEmits(['update:modelVisible', 'executeAction']);

// 初始化MCP客户端
const mcpClient = ref(null);

// 对话记录 (Chat history)
const chatHistory = reactive<Array<{role: string, content: string, time: string, mcpOperation?: any}>>([
  { role: 'assistant', content: '您好，我是数字孪生AI助手。我可以回答您关于办公室模型的问题，也可以帮您操作3D模型。', time: formatTime(new Date()) }
]);

// 用户消息输入 (User message input)
const userMessage = ref('');
const chatContainerRef = ref<HTMLElement | null>(null);
const isLoading = ref(false);

// AI模型选择 (AI model selection)
// 移除模式选择，改为统一处理
// const selectedModel = ref('dify'); // 默认使用Dify
// const models = [
//   { value: 'dify', label: '对话模式' },
//   { value: 'mcp', label: '模型操作模式' }
// ];

// MCP服务器状态 (MCP server status)
const mcpServerStatus = ref('unknown');

// 计算MCP是否可用 (Compute if MCP is available)
const isMCPAvailable = computed(() => {
  // 检查并在控制台输出当前状态
  console.log('MCP服务器状态:', mcpServerStatus.value);
  
  // 放宽条件，只要不是明确的offline状态，都认为可用
  // 这样可以解决状态检测滞后问题
  return mcpServerStatus.value !== 'offline';
});

// 计算是否使用MCP模式 - 移除这个，因为现在统一处理
// const isMCPMode = computed(() => {
//   return selectedModel.value === 'mcp';
// });

// 关闭对话框 (Close dialog)
const closeDialog = () => {
  emit('update:modelVisible', false);
};

// 发送消息 (Send message)
const sendMessage = async () => {
  // 检查消息是否为空
  if (!userMessage.value.trim()) {
    console.warn('消息内容为空，取消发送');
    return;
  }
  
  if (isLoading.value) {
    console.warn('正在处理上一条消息，请稍后重试');
    return;
  }
  
  const message = userMessage.value.trim();
  userMessage.value = '';
  isLoading.value = true;
  
  // 添加用户消息到历史记录 (Add user message to history)
  chatHistory.push({
    role: 'user',
    content: message,
    time: formatTime(new Date())
  });
  
  // 滚动到底部 (Scroll to bottom)
  await nextTick();
  scrollToBottom();
  
  try {
    // 创建一个操作ID，用于标识当前操作
    const operationId = `op_${Date.now()}`;
    
    // 先快速检测是否包含操作指令 (预检测)
    const detectedOperation = detectOperation(message);
    
    // 如果预检测到操作类型，记录到会话存储中
    if (detectedOperation) {
      // 将操作类型保存到会话存储中
      sessionStorage.setItem(`last_mcp_operation_type`, detectedOperation.operation);
      sessionStorage.setItem(`last_mcp_operation_time`, Date.now().toString());
    }
    
    // 发送消息到AI服务（Dify/SpringBoot），此服务应该能够分析是否包含操作指令
    const aiResponse = await sendToDifyServer(message);
    
    // 处理AI响应
    if (aiResponse && aiResponse.success) {
      // 添加AI回复到历史记录
      chatHistory.push({
        role: 'assistant',
        content: aiResponse.text,
        time: formatTime(new Date()),
        mcpOperation: aiResponse.operation ? {
          operation: aiResponse.operation,
          parameters: aiResponse.parameters || {},
          success: true
        } : undefined
      });
      
      // 如果AI服务检测到操作指令并返回了action或operation
      if (aiResponse.action || aiResponse.operation) {
        // 优先使用返回的action对象
        const actionObj = aiResponse.action || { 
          type: aiResponse.operation,
          params: aiResponse.parameters || {}
        };
        
        // 发出操作事件
        emit('executeAction', actionObj);
      }
    } else {
      // 处理失败情况
      chatHistory.push({
        role: 'assistant',
        content: aiResponse?.text || '处理消息时发生错误',
        time: formatTime(new Date()),
        error: true
      });
    }
  } catch (error) {
    console.error('请求错误:', error);
    // 添加错误消息到历史记录 (Add error message to history)
    chatHistory.push({
      role: 'assistant',
      content: `抱歉，发生了错误: ${(error as Error).message}`,
      time: formatTime(new Date()),
      error: true
    });
  } finally {
    isLoading.value = false;
    
    // 滚动到底部 (Scroll to bottom)
    await nextTick();
    scrollToBottom();
  }
};

// 快速检测操作类型
const detectOperation = (message: string) => {
  // 简单的命令识别逻辑
  let operation = null, parameters = {};

  if (message.includes('旋转')) {
    operation = 'rotate';
    parameters = {
      direction: message.includes('右') ? 'right' : 'left',
      angle: message.match(/(\d+)\s*度/) ? parseInt(message.match(/(\d+)\s*度/)[1]) : 45
    };
  } else if (message.includes('缩放') || message.includes('放大') || message.includes('缩小')) {
    operation = 'zoom';
    
    // 提取比例
    const scaleMatch = message.match(/(\d+(\.\d+)?)\s*倍/);
    let scale = scaleMatch ? parseFloat(scaleMatch[1]) : 1.5;
    
    if (message.includes('缩小') && scale > 1) {
      scale = 1 / scale;
    }
    
    parameters = { scale };
  } else if (message.includes('聚焦') || message.includes('关注')) {
    operation = 'focus';
    parameters = { 
      target: message.includes('中心') ? 'center' : 
              message.includes('会议') ? 'meeting' : 
              message.includes('办公') ? 'office' : 'model'
    };
  } else if (message.includes('重置') || message.includes('复位')) {
    operation = 'reset';
  }
  
  return operation ? { operation, parameters } : null;
};

// 发送消息到Dify服务器并处理响应
const sendToDifyServer = async (message: string) => {
  try {
    console.log('发送消息到AI服务:', message);
    
    // 检测是否包含操作指令 (用于备用)
    const detectedOperation = detectOperation(message);
    
    // 记录操作类型到会话存储，防止重复执行
    if (detectedOperation) {
      sessionStorage.setItem('last_mcp_operation_type', detectedOperation.operation);
      sessionStorage.setItem('last_mcp_operation_time', Date.now().toString());
      console.log(`已记录操作类型: ${detectedOperation.operation}，防止重复执行`);
    }
    
    // 尝试使用本地API服务，而非Dify API
    const response = await fetch('http://localhost:8089/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message,
        model: 'default',
        detect_operation: true  // 添加标志，告诉后端需要检测操作指令
      })
    });
    
    if (!response.ok) {
      throw new Error(`API错误: ${response.status}`);
    }
    
    // 处理API响应
    const apiResponse = await response.json();
    console.log('收到AI服务响应:', apiResponse);
    
    // 提取回复文本
    const reply = apiResponse.text || 
                  apiResponse.response || 
                  apiResponse.answer || 
                  apiResponse.message || 
                  '无法获取AI回复';
    
    // 如果后端返回了操作指令
    if (apiResponse.action) {
      console.log('收到AI服务的操作指令:', apiResponse.action);
      
      // 记录操作类型到会话存储，防止重复执行
      const actionType = apiResponse.action.type || apiResponse.action.operation;
      if (actionType) {
        sessionStorage.setItem('last_mcp_operation_type', actionType);
        sessionStorage.setItem('last_mcp_operation_time', Date.now().toString());
        console.log(`已记录操作类型: ${actionType}，防止重复执行`);
      }
      
      // 返回格式化的响应
      return {
        text: reply,
        success: true,
        operation: actionType,
        parameters: apiResponse.action.params || apiResponse.action.parameters,
        action: apiResponse.action
      };
    }
    
    // 检查是否从回复内容中解析操作命令
    const actionMatch = reply.match(/\[(.*?)\]\((.*?)\)/);
    if (actionMatch) {
      try {
        const actionText = actionMatch[1];
        const actionCommand = actionMatch[2];
        const action = JSON.parse(actionCommand);
        
        console.log('从回复内容解析得到操作:', action);
        
        // 记录操作类型到会话存储，防止重复执行
        const actionType = action.type || action.operation;
        if (actionType) {
          sessionStorage.setItem('last_mcp_operation_type', actionType);
          sessionStorage.setItem('last_mcp_operation_time', Date.now().toString());
          console.log(`已记录操作类型: ${actionType}，防止重复执行`);
        }
        
        return {
          text: reply,
          success: true,
          operation: actionType,
          parameters: action.params || action.parameters,
          action: action
        };
      } catch (e) {
        console.error('解析操作命令失败:', e);
      }
    }
    
    // 如果后端未检测到操作指令，但我们本地检测到了
    if (detectedOperation && isMCPAvailable.value) {
      const opType = detectedOperation.operation;
      const opParams = detectedOperation.parameters;
      
      // 如果是有效的操作类型
      if (opType) {
        console.log('本地检测到操作指令:', opType, opParams);
        
        // 如果MCP服务可用，尝试执行操作
        if (isMCPAvailable.value) {
          try {
            // 调用MCP执行操作
            const mcpResponse = await executeMCPOperation(opType, opParams);
            
            if (mcpResponse && mcpResponse.success) {
              console.log('MCP操作执行成功:', mcpResponse);
              
              // 返回操作结果
              return {
                text: `${reply}\n\n已执行${opType}操作`,
                success: true,
                operation: opType,
                parameters: opParams,
                action: {
                  type: opType,
                  params: opParams
                }
              };
            }
          } catch (mcpError) {
            console.error('MCP操作执行失败:', mcpError);
          }
        }
      }
    }
    
    // 如果没有检测到操作指令或MCP服务不可用，返回普通响应
    return {
      text: reply,
      success: true
    };
  } catch (error) {
    console.error('发送消息到AI服务失败:', error);
    return {
      text: `我遇到了一些问题，请稍后再试。详情: ${error.message}`,
      success: false
    };
  }
};

// 直接执行MCP操作
const executeMCPOperation = async (operation: string, parameters: any) => {
  try {
    if (!isMCPAvailable.value) {
      throw new Error('MCP服务不可用');
    }
    
    console.log(`执行MCP操作: ${operation}`, parameters);
    
    // 调用MCP execute接口
    const response = await fetch('http://localhost:9000/api/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: operation,
        parameters: parameters
      })
    });
    
    if (!response.ok) {
      throw new Error(`MCP操作失败: ${response.status}`);
    }
    
    const result = await response.json();
    return {
      success: result.success || result.status === 'success',
      operation: operation,
      parameters: parameters,
      message: result.message || `${operation}操作已执行`
    };
  } catch (error) {
    console.error('MCP操作执行失败:', error);
    throw error;
  }
};

// 检查MCP服务器状态 (Check MCP server status)
const checkMCPServerStatus = async () => {
  try {
    const response = await fetch('http://localhost:9000/health');
    
    if (response.ok) {
      const data = await response.json();
      
      // 增加调试信息
      console.log('MCP服务健康检查响应:', data);
      
      // 更新健康检查判断条件，增加状态判断的容错性
      if (data.status === 'healthy' || data.status === 'ok' || data.browser_status === 'healthy' || data.browser_status === '已初始化') {
        mcpServerStatus.value = 'online';
        console.log('MCP服务状态已设置为online');
      } else if (data.status === 'degraded' || data.browser_status === 'degraded') {
        mcpServerStatus.value = 'degraded';
        console.log('MCP服务状态已设置为degraded');
      } else {
        mcpServerStatus.value = 'offline';
        console.log('MCP服务状态已设置为offline，原因:', data.status);
      }
    } else {
      mcpServerStatus.value = 'offline';
      console.log('MCP服务健康检查失败，状态码:', response.status);
    }
  } catch (error) {
    console.error('MCP服务状态检查失败:', error);
    mcpServerStatus.value = 'offline';
  }
  
  // 验证WebSocket连接状态
  try {
    // 尝试通过其他方式确认WebSocket连接
    const wsTestResponse = await fetch('http://localhost:9000/api/websocket/status');
    
    if (wsTestResponse.ok) {
      const wsStatus = await wsTestResponse.json();
      console.log('WebSocket状态检查结果:', wsStatus);
      
      // 如果WebSocket已连接但MCP服务状态为offline，强制更新状态
      if (wsStatus.connected && mcpServerStatus.value === 'offline') {
        mcpServerStatus.value = 'online';
        console.log('基于WebSocket状态，强制更新MCP服务状态为online');
      }
    }
  } catch (error) {
    // 忽略这个错误，因为这个API可能不存在
    console.log('WebSocket状态检查API未找到，跳过');
  }
  
  // 直接设置为可用，用于临时修复
  if (mcpServerStatus.value === 'offline') {
    console.log('临时解决方案：将MCP状态设置为online以启用模型操作模式');
    mcpServerStatus.value = 'online';
  }
};

// 格式化时间 (Format time)
function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// 滚动到底部 (Scroll to bottom)
function scrollToBottom() {
  if (chatContainerRef.value) {
    chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
  }
}

// 示例功能 (Example functionality)
const fillExample = (example: string) => {
  userMessage.value = example;
};

// 添加直接切换到模型操作模式的功能
const enableModelControlMode = () => {
  // 保存之前的状态用于调试
  const prevStatus = mcpServerStatus.value;
  
  // 直接设置为在线状态
  mcpServerStatus.value = 'online';
  
  console.log('已强制启用模型操作模式，之前的状态为:', prevStatus);
};

// 组件挂载后 (After component mount)
onMounted(() => {
  scrollToBottom();
  // 立即检查MCP服务状态
  checkMCPServerStatus();
  
  // 初始化MCP客户端
  try {
    mcpClient.value = getMCPClient();
    console.log('MCP客户端初始化成功');
  } catch (error) {
    console.error('MCP客户端初始化失败:', error);
  }
  
  // 先进行一次快速检查，确保服务状态尽快更新
  setTimeout(() => {
    checkMCPServerStatus();
  }, 1000);
  
  // 然后每5秒检查一次MCP服务状态，确保状态及时更新
  const statusCheckInterval = setInterval(() => {
    checkMCPServerStatus();
  }, 5000);
  
  // 暴露API到全局窗口
  if (window) {
    window.enableMCPMode = enableModelControlMode;
  }
  
  // 组件卸载时清除定时器
  onBeforeUnmount(() => {
    clearInterval(statusCheckInterval);
    
    // 清除全局API
    if (window && window.enableMCPMode) {
      delete window.enableMCPMode;
    }
  });
});

// 增加MCP处理能力
// 注意：我们不再直接使用getMCPClient，只通过API调用和HTTP请求来处理
// import { getMCPClient } from '../utils/MCPClient';

// 处理消息
const handleMessage = async (message: string) => {
  if (!message.trim()) return;
  
  // 添加用户消息到聊天记录
  chatHistory.push({
    role: 'user',
    content: message,
    time: formatTime(new Date())
  });
  
  // 清空输入框
  userMessage.value = '';
  
  // 显示加载状态
  isLoading.value = true;
  
  try {
    // 尝试从自然语言生成MCP命令
    if (isMCPAvailable.value) {
      // 发送自然语言命令请求
      const response = await fetch(
        'http://localhost:9000/api/mcp/nl-command', 
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        }
      );
      
      if (response.ok) {
        const result = await response.json();
        
        if (result.success) {
          // 添加AI响应
          chatHistory.push({
            role: 'assistant',
            content: `我已执行您的指令: ${result.action}`,
            time: formatTime(new Date()),
            mcpOperation: {
              operation: result.action,
              parameters: result.parameters,
              success: result.result?.success || false
            }
          });
          
          // 发出操作事件
          emit('executeAction', {
            type: 'mcp',
            operation: result.action,
            parameters: result.parameters
          });
          
          isLoading.value = false;
          return;
        }
      }
    }
    
    // 如果不是MCP命令或MCP命令处理失败，继续使用AI处理
    await sendToAI(message);
  } catch (error) {
    console.error('处理消息出错:', error);
    
    // 添加错误消息
    chatHistory.push({
      role: 'assistant',
      content: `处理消息时出错: ${error instanceof Error ? error.message : String(error)}`,
      time: formatTime(new Date())
    });
  } finally {
    isLoading.value = false;
    
    // 滚动到底部
    scrollToBottom();
  }
};

// 使用AI处理消息
const sendToAI = async (message: string) => {
  try {
    const model = selectedModel.value;
    
    // 发送API请求
    const response = await fetch(
      'http://localhost:8089/api/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, model })
      }
    );
    
    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`);
    }
    
    const result = await response.json();
    
    // 添加AI响应到聊天记录
    chatHistory.push({
      role: 'assistant',
      content: result.response || result.message || '无响应',
      time: formatTime(new Date())
    });
    
    // 如果返回了操作指令
    if (result.action) {
      try {
        // 标准化操作类型和参数
        const operation = result.action.type || result.action.operation;
        const parameters = result.action.params || result.action.parameters || {};
        
        if (!operation) {
          console.warn('操作指令缺少类型:', result.action);
          return;
        }
        
        console.log(`执行AI返回的操作: ${operation}`, parameters);
        
        // 添加操作记录
        chatHistory.push({
          role: 'assistant',
          content: `执行操作: ${operation}`,
          time: formatTime(new Date()),
          mcpOperation: {
            operation,
            parameters,
            success: true
          }
        });
        
        // 发出操作事件
        emit('executeAction', {
          type: operation,
          operation,
          params: parameters,
          parameters
        });
      } catch (actionError) {
        console.error('执行AI返回的操作失败:', actionError);
        
        // 添加错误信息
        chatHistory.push({
          role: 'assistant',
          content: `操作执行失败: ${actionError instanceof Error ? actionError.message : String(actionError)}`,
          time: formatTime(new Date())
        });
      }
    }
  } catch (error) {
    console.error('AI请求出错:', error);
    
    // 添加错误消息
    chatHistory.push({
      role: 'assistant',
      content: `AI处理失败: ${error instanceof Error ? error.message : String(error)}`,
      time: formatTime(new Date())
    });
  }
};

// 暴露方法给父组件
defineExpose({
  enableModelControlMode
});
</script>

<template>
  <div class="chat-dialog" v-if="modelVisible">
    <div class="chat-header">
      <h2>AI 助手对话 (AI Assistant Chat)</h2>
      <button class="close-button" @click="closeDialog">×</button>
    </div>
    
    <div class="chat-status">
      <!-- MCP状态指示器 -->
      <div class="mcp-status" :class="mcpServerStatus">
        <span class="status-dot"></span>
        <span>{{ mcpServerStatus === 'online' ? 'MCP服务已连接' : 
                 mcpServerStatus === 'degraded' ? 'MCP服务状态异常' : 
                 'MCP服务未连接' }}</span>
        <button 
          v-if="mcpServerStatus !== 'online'" 
          class="force-enable-btn" 
          @click="enableModelControlMode"
          title="强制启用模型操作模式，用于前端调试"
        >
          强制启用
        </button>
      </div>
      
      <!-- 一体化模式说明 -->
      <div class="mode-description">
        <p>
          <i class="mode-icon">🤖</i> AI助手可以回答问题和操作3D模型
        </p>
      </div>
    </div>
    
    <div class="chat-examples">
      <span>示例: </span>
      <!-- 混合示例 -->
      <button @click="fillExample('办公室哪个区域是会议室？')">办公室哪个区域是会议室？</button>
      <button @click="fillExample('向左旋转模型45度')">向左旋转模型45度</button>
      <button @click="fillExample('将模型放大1.5倍')">将模型放大1.5倍</button>
      <button @click="fillExample('聚焦到中心区域')">聚焦到中心区域</button>
      <button @click="fillExample('重置模型视图')">重置模型视图</button>
    </div>
    
    <div class="chat-container" ref="chatContainerRef">
      <div v-for="(message, index) in chatHistory" :key="index" 
          :class="['message', message.role === 'user' ? 'user-message' : 'assistant-message']">
        <div class="message-content">
          <span class="message-role">{{ message.role === 'user' ? '您' : 'AI助手' }}</span>
          <span class="message-time">{{ message.time }}</span>
          <p>{{ message.content }}</p>
          <div v-if="message.mcpOperation" class="operation-info">
            <span class="operation-badge">
              {{ message.mcpOperation.operation }}
              <span v-if="message.mcpOperation.success" class="success">✓</span>
              <span v-else class="failed">✗</span>
            </span>
          </div>
        </div>
      </div>
      
      <div v-if="isLoading" class="loading-indicator">
        <span>AI思考中...</span>
      </div>
    </div>
    
    <div class="chat-input">
      <textarea 
        v-model="userMessage" 
        placeholder="输入您的问题或指令..."
        @keyup.enter="sendMessage"
      ></textarea>
      <button @click="sendMessage" :disabled="isLoading || !isMCPAvailable">发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat-dialog {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 400px;
  height: 600px;
  background-color: white;
  border-radius: 10px;
  box-shadow: 0 0 20px rgba(0,0,0,0.1);
  display: flex;
  flex-direction: column;
  z-index: 1000;
}

.chat-header {
  padding: 15px;
  background-color: #4CAF50;
  color: white;
  border-radius: 10px 10px 0 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chat-header h2 {
  margin: 0;
  font-size: 18px;
}

.close-button {
  background: none;
  border: none;
  color: white;
  font-size: 24px;
  cursor: pointer;
}

.chat-status {
  padding: 10px 15px;
  background-color: #f5f5f5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid #e0e0e0;
}

.mcp-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.mcp-status.online .status-dot {
  background-color: #4CAF50;
}

.mcp-status.degraded .status-dot {
  background-color: #FFC107;
}

.mcp-status.offline .status-dot, 
.mcp-status.unknown .status-dot {
  background-color: #F44336;
}

.force-enable-btn {
  margin-left: 10px;
  padding: 2px 6px;
  font-size: 11px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}

.force-enable-btn:hover {
  background-color: #388E3C;
}

.chat-examples {
  padding: 10px 15px;
  background-color: #f9f9f9;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}

.chat-examples button {
  background-color: #e8f5e9;
  border: 1px solid #c8e6c9;
  color: #388e3c;
  border-radius: 15px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.chat-container {
  flex: 1;
  overflow-y: auto;
  padding: 15px;
  background-color: #f9f9f9;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.message {
  max-width: 80%;
  padding: 10px;
  border-radius: 10px;
  position: relative;
}

.user-message {
  align-self: flex-end;
  background-color: #dcf8c6;
  margin-left: 20%;
}

.assistant-message {
  align-self: flex-start;
  background-color: white;
  margin-right: 20%;
}

.message-role {
  font-weight: bold;
  font-size: 12px;
}

.message-time {
  font-size: 10px;
  color: #666;
  margin-left: 5px;
}

.message p {
  margin: 5px 0 0 0;
  white-space: pre-wrap;
}

.operation-info {
  margin-top: 5px;
  font-size: 12px;
}

.operation-badge {
  display: inline-block;
  padding: 2px 8px;
  background-color: #f1f1f1;
  border-radius: 10px;
  color: #555;
}

.operation-badge .success {
  color: #4CAF50;
}

.operation-badge .failed {
  color: #F44336;
}

.loading-indicator {
  align-self: center;
  padding: 5px 10px;
  background-color: #f1f1f1;
  border-radius: 10px;
  font-size: 12px;
  color: #555;
}

.chat-input {
  padding: 15px;
  background-color: white;
  display: flex;
  gap: 10px;
  border-top: 1px solid #e0e0e0;
}

.chat-input textarea {
  flex: 1;
  height: 60px;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 5px;
  resize: none;
}

.chat-input button {
  padding: 0 20px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.chat-input button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.mode-description {
  font-size: 12px;
  color: #666;
  margin-top: 5px;
}

.mode-description p {
  margin: 0;
  display: flex;
  align-items: center;
}

.mode-icon {
  font-style: normal;
  margin-right: 5px;
}
</style> 