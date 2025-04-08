<script setup lang="ts">
import { ref } from 'vue';
import ModelViewer from './components/ModelViewer.vue';
import ChatDialog from './components/ChatDialog.vue';

// 引用模型查看器组件 (Reference to model viewer component)
const modelViewerRef = ref<InstanceType<typeof ModelViewer> | null>(null);

// 聊天对话框显示状态 (Chat dialog display state)
const chatDialogVisible = ref(false);

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
