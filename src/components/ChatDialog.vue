<script setup lang="ts">
import { ref, reactive, onMounted, nextTick, computed, watch, onBeforeUnmount } from 'vue';
import { getMCPClient } from '../utils/MCPClient';

// 定义props (Define props)
const props = defineProps<{
  modelVisible: boolean;
}>();

// 定义事件 (Define events)
const emit = defineEmits(['update:modelVisible', 'executeAction']);

// 对话记录 (Chat history)
const chatHistory = reactive<Array<{role: string, content: string, time: string, mcpOperation?: any}>>([
  { role: 'assistant', content: '您好，我是数字孪生AI助手。我可以回答您关于办公室模型的问题，也可以帮您操作3D模型。', time: formatTime(new Date()) }
]);

// 用户消息输入 (User message input)
const userMessage = ref('');
const chatContainerRef = ref<HTMLElement | null>(null);
const isLoading = ref(false);

// AI模型选择 (AI model selection)
const selectedModel = ref('dify'); // 默认使用Dify
const models = [
  { value: 'dify', label: '对话模式' },
  { value: 'mcp', label: '模型操作模式' }
];

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

// 计算是否使用MCP模式 (Compute if using MCP mode)
const isMCPMode = computed(() => {
  return selectedModel.value === 'mcp';
});

// 关闭对话框 (Close dialog)
const closeDialog = () => {
  emit('update:modelVisible', false);
};

// 发送消息 (Send message)
const sendMessage = async () => {
  if (!userMessage.value.trim() || isLoading.value) return;
  
  const message = userMessage.value;
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
    // 不管选择什么模式，都先发送到后端处理
    await sendToDifyServer(message);
    
    // 如果是MCP模式，再发送到MCP服务处理模型操作
    if (isMCPMode.value && isMCPAvailable.value) {
      await sendToMCPServer(message);
    }
  } catch (error) {
    console.error('请求错误:', error);
    // 添加错误消息到历史记录 (Add error message to history)
    chatHistory.push({
      role: 'assistant',
      content: `抱歉，发生了错误: ${(error as Error).message}`,
      time: formatTime(new Date())
    });
  } finally {
    isLoading.value = false;
    
    // 滚动到底部 (Scroll to bottom)
    await nextTick();
    scrollToBottom();
  }
};

// 发送消息到Dify服务器 (Send message to Dify server)
const sendToDifyServer = async (message: string) => {
  try {
    // 调用API (Call API)
    const response = await fetch('http://localhost:8089/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    });
    
    if (!response.ok) {
      throw new Error(`服务器错误: ${response.status}`);
    }
    
    const data = await response.json();
    
    // 处理AI回复 (Process AI response)
    let responseText = '';
    
    // 如果响应是JSON字符串，尝试解析提取answer字段
    // (If the response is a JSON string, try to parse to extract the answer field)
    if (typeof data.text === 'string' && (data.text.startsWith('{') || data.text.startsWith('data: {'))) {
      try {
        if (data.text.startsWith('data: {')) {
          // 处理流式响应格式 (Handle streaming response format)
          const messages = data.text.split('data: ').filter(msg => msg.trim());
          let combinedAnswer = '';
          
          for (const msg of messages) {
            try {
              const msgObj = JSON.parse(msg.trim());
              if (msgObj.answer && typeof msgObj.answer === 'string') {
                combinedAnswer += msgObj.answer;
              }
            } catch (e) {
              console.warn('无法解析消息片段', msg);
            }
          }
          
          responseText = combinedAnswer || '收到响应，但无法解析具体内容';
        } else {
          // 处理单个JSON响应 (Handle single JSON response)
          const jsonResponse = JSON.parse(data.text);
          responseText = jsonResponse.answer || '收到响应，但无法解析具体内容';
        }
      } catch (e) {
        console.warn('解析响应失败', e);
        responseText = data.text || '操作已执行';
      }
    } else {
      // 如果不是JSON格式，直接使用text字段或默认消息
      // (If not JSON format, directly use the text field or default message)
      responseText = data.text || '操作已执行';
    }
    
    // 添加AI回复到历史记录 (Add AI response to history)
    chatHistory.push({
      role: 'assistant',
      content: responseText,
      time: formatTime(new Date())
    });
    
    // 如果有操作指令，通知父组件执行 (If there's an action command, notify parent component to execute)
    if (data.action) {
      console.log('收到操作指令:', data.action);
      
      try {
        // 发出操作事件
        emit('executeAction', data.action);
        
        // 添加操作记录到聊天记录
        chatHistory.push({
          role: 'assistant',
          content: `执行操作: ${data.action.type || data.action.operation || '未知操作'}`,
          time: formatTime(new Date()),
          mcpOperation: {
            operation: data.action.type || data.action.operation || '未知操作',
            parameters: data.action.params || data.action.parameters || {},
            success: true
          }
        });
      } catch (actionError) {
        console.error('执行操作指令失败:', actionError);
        
        // 添加错误消息
        chatHistory.push({
          role: 'assistant',
          content: `执行操作失败: ${actionError instanceof Error ? actionError.message : String(actionError)}`,
          time: formatTime(new Date()),
          mcpOperation: {
            operation: data.action.type || data.action.operation || '未知操作',
            parameters: data.action.params || data.action.parameters || {},
            success: false
          }
        });
      }
    }
  } catch (error) {
    console.error('发送消息到Dify服务器失败:', error);
    chatHistory.push({
      role: 'assistant',
      content: `抱歉，发送消息失败: ${(error as Error).message}`,
      time: formatTime(new Date())
    });
  }
};

// 发送消息到MCP服务器 (Send message to MCP server)
const sendToMCPServer = async (message: string) => {
  try {
    // 检查MCP服务是否可用
    if (!isMCPAvailable.value) {
      throw new Error('MCP服务不可用，请切换到对话模式或稍后再试');
    }
    
    // 检查消息是否为空
    if (!message || !message.trim()) {
      throw new Error('消息不能为空');
    }
    
    console.log("发送消息到MCP服务:", message);
    
    // 尝试调用MCP服务的API
    let apiResponse;
    let useFallback = false;
    
    try {
      // 首先尝试调用/api/llm/process接口
      const response = await fetch('http://localhost:9000/api/llm/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          model: 'claude' // 指定使用的模型
        }),
      });
      
      if (response.ok) {
        apiResponse = await response.json();
      } else {
        // 如果返回404，可能是新API尚未部署，尝试使用旧的API
        console.warn('新的/api/llm/process接口不可用，尝试备用API');
        useFallback = true;
      }
    } catch (error) {
      console.warn('调用/api/llm/process接口失败，尝试备用API:', error);
      useFallback = true;
    }
    
    // 如果需要，使用备用方法 - 直接发送到execute接口
    if (useFallback) {
      // 简单的命令识别逻辑
      let operation, parameters = {};
      
      if (message.includes('旋转')) {
        operation = 'rotate';
        parameters.direction = message.includes('右') ? 'right' : 'left';
        
        // 提取角度
        const angleMatch = message.match(/(\d+)\s*度/);
        parameters.angle = angleMatch ? parseInt(angleMatch[1]) : 45;
      } else if (message.includes('缩放') || message.includes('放大') || message.includes('缩小')) {
        operation = 'zoom';
        
        // 提取比例
        const scaleMatch = message.match(/(\d+(\.\d+)?)\s*倍/);
        parameters.scale = scaleMatch ? parseFloat(scaleMatch[1]) : 1.5;
        
        if (message.includes('缩小') && parameters.scale > 1) {
          parameters.scale = 1 / parameters.scale;
        }
      } else if (message.includes('聚焦') || message.includes('关注')) {
        operation = 'focus';
        parameters.target = message.includes('中心') ? 'center' : 'model';
      } else if (message.includes('重置') || message.includes('复位')) {
        operation = 'reset';
      } else {
        throw new Error('无法识别的模型操作命令');
      }
      
      // 直接调用执行接口
      const executeResponse = await fetch('http://localhost:9000/api/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: operation,
          parameters
        })
      });
      
      if (executeResponse.ok) {
        const result = await executeResponse.json();
        
        // 构建与新API格式一致的响应
        apiResponse = {
          success: result.success,
          message: result.message || `已执行${operation}操作`,
          operation,
          parameters,
          operation_result: {
            operation,
            parameters,
            success: result.success
          }
        };
      } else {
        throw new Error(`执行操作失败: ${await executeResponse.text()}`);
      }
    }
    
    console.log("收到MCP服务响应:", apiResponse);
    
    if (apiResponse.success) {
      // 添加AI回复到历史记录 (Add AI response to history)
      const responseMessage = {
        role: 'assistant',
        content: apiResponse.message || '已执行您的操作指令',
        time: formatTime(new Date())
      };
      
      // 如果有操作结果，添加到消息中
      if (apiResponse.operation_result) {
        responseMessage.mcpOperation = {
          operation: apiResponse.operation_result.operation,
          parameters: apiResponse.operation_result.parameters,
          success: apiResponse.operation_result.success
        };
        
        // 通知父组件执行MCP操作
        emit('executeAction', {
          type: 'mcp',
          operation: apiResponse.operation_result.operation,
          parameters: apiResponse.operation_result.parameters
        });
      }
      
      chatHistory.push(responseMessage);
      
      // 根据操作类型添加成功消息
      const operationType = apiResponse.operation || apiResponse.operation_result?.operation || 'unknown';
      chatHistory.push({
        role: 'assistant',
        content: `成功执行${operationType}操作`,
        time: formatTime(new Date()),
        type: 'success'
      });
    } else {
      // 添加错误消息到历史记录 (Add error message to history)
      chatHistory.push({
        role: 'assistant',
        content: `操作执行失败: ${apiResponse.error || apiResponse.message || '未知错误'}`,
        time: formatTime(new Date()),
        type: 'error'
      });
    }
  } catch (error) {
    console.error('MCP服务请求错误:', error);
    // 添加错误消息到历史记录
    chatHistory.push({
      role: 'assistant',
      content: `操作失败: ${(error as Error).message}`,
      time: formatTime(new Date())
    });
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
  
  // 切换到模型操作模式
  selectedModel.value = 'mcp';
  
  console.log('已强制启用模型操作模式，之前的状态为:', prevStatus);
};

// 监听选择的模型变化 (Watch for selected model changes)
watch(selectedModel, () => {
  if (isMCPMode.value && mcpServerStatus.value === 'unknown') {
    checkMCPServerStatus();
  }
  
  // 如果选择了MCP模式但状态是offline，尝试强制启用
  if (isMCPMode.value && mcpServerStatus.value === 'offline') {
    console.log('尝试强制启用MCP模式');
    mcpServerStatus.value = 'online';
  }
});

// 组件挂载后 (After component mount)
onMounted(() => {
  scrollToBottom();
  // 立即检查MCP服务状态
  checkMCPServerStatus();
  
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
    
    <div class="model-selector">
      <label for="ai-model-select">选择模式:</label>
      <select id="ai-model-select" v-model="selectedModel">
        <option v-for="model in models" :key="model.value" :value="model.value" 
                :disabled="model.value === 'mcp' && !isMCPAvailable">
          {{ model.label }} {{ model.value === 'mcp' && !isMCPAvailable ? '(服务不可用)' : '' }}
        </option>
      </select>
      
      <!-- MCP状态指示器 -->
      <div class="mcp-status" v-if="isMCPMode" :class="mcpServerStatus">
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
      
      <!-- 模式说明 -->
      <div class="mode-description">
        <p v-if="isMCPMode">
          <i class="mode-icon">🤖</i> 模型操作模式：可以通过自然语言直接控制3D模型
        </p>
        <p v-else>
          <i class="mode-icon">💬</i> 对话模式：与AI助手对话，获取模型信息
        </p>
      </div>
    </div>
    
    <div class="chat-examples">
      <span>示例: </span>
      <!-- 对话模式示例 -->
      <template v-if="!isMCPMode">
        <button @click="fillExample('办公室哪个区域是会议室？')">办公室哪个区域是会议室？</button>
        <button @click="fillExample('介绍一下这个数字孪生模型')">介绍一下数字孪生模型</button>
        <button @click="fillExample('这个模型有哪些功能？')">这个模型有哪些功能？</button>
      </template>
      
      <!-- 模型操作模式示例 -->
      <template v-else>
        <button @click="fillExample('向左旋转模型45度')">向左旋转模型45度</button>
        <button @click="fillExample('将模型放大1.5倍')">将模型放大1.5倍</button>
        <button @click="fillExample('聚焦到中心区域')">聚焦到中心区域</button>
        <button @click="fillExample('重置模型视图')">重置模型视图</button>
      </template>
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
      <button @click="sendMessage" :disabled="isLoading || (isMCPMode && !isMCPAvailable)">发送</button>
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

.model-selector {
  padding: 10px 15px;
  background-color: #f5f5f5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid #e0e0e0;
}

.model-selector select {
  padding: 5px;
  border-radius: 4px;
  border: 1px solid #ddd;
  width: 100%;
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