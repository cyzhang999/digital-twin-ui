<template>
  <div class="test-component">
    <h2>Playwright 测试组件</h2>
    <div
        id="test-box"
        :style="{ backgroundColor: testBoxColor }"
        :class="{'test-active': testActive}"
        @click="toggleTestBox">
      点击切换状态 (Click to toggle status)
    </div>
    <div class="test-controls">
      <button id="test-button-red" @click="changeTestBoxColor('red')">红色 (Red)</button>
      <button id="test-button-blue" @click="changeTestBoxColor('blue')">蓝色 (Blue)</button>
      <button id="test-button-green" @click="changeTestBoxColor('green')">绿色 (Green)</button>
      <div id="test-status">
        当前状态: {{ testActive ? '已激活' : '未激活' }}
        (Current status: {{ testActive ? 'Active' : 'Inactive' }})
      </div>
      <div id="test-color-status">
        当前颜色: {{ testBoxColor }}
        (Current color: {{ testBoxColor }})
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

// 声明全局接口
declare global {
  interface Window {
    playwrightTest?: {
      toggleTestBox: () => void;
      changeTestBoxColor: (color: string) => void;
      getTestStatus: () => boolean;
      getTestColor: () => string;
    };
  }
}

// 定义响应式状态
const testActive = ref(false);
const testBoxColor = ref('gray');

// 切换测试盒子状态
const toggleTestBox = () => {
  testActive.value = !testActive.value;
  console.log('测试盒子状态切换为:', testActive.value ? '已激活' : '未激活');
};

// 改变测试盒子颜色
const changeTestBoxColor = (color: string) => {
  testBoxColor.value = color;
  console.log('测试盒子颜色改变为:', color);
};

// 在组件挂载后暴露方法到全局
onMounted(() => {
  // 暴露测试函数到全局作用域，方便Playwright调用
  window.playwrightTest = {
    toggleTestBox,
    changeTestBoxColor,
    getTestStatus: () => testActive.value,
    getTestColor: () => testBoxColor.value
  };

  console.log('测试组件已挂载，全局方法已注册');
});
</script>

<style scoped>
.test-component {
  width: 400px;
  margin: 40px auto;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  background-color: white;
}

h2 {
  margin-top: 0;
  color: #333;
  text-align: center;
  margin-bottom: 20px;
}

#test-box {
  width: 100%;
  height: 100px;
  display: flex;
  justify-content: center;
  align-items: center;
  color: white;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.3s ease;
  margin-bottom: 20px;
  border-radius: 8px;
  text-align: center;
}

.test-active {
  transform: scale(1.05);
  box-shadow: 0 0 15px rgba(0, 0, 0, 0.3);
}

.test-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.test-controls button {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  font-weight: bold;
}

#test-button-red {
  background-color: #f44336;
  color: white;
}

#test-button-blue {
  background-color: #2196F3;
  color: white;
}

#test-button-green {
  background-color: #4CAF50;
  color: white;
}

#test-status, #test-color-status {
  width: 100%;
  margin: 10px 0;
  padding: 10px;
  border-radius: 4px;
  background-color: #f5f5f5;
  text-align: center;
}
</style>