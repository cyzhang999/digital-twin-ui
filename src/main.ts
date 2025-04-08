import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

// 添加全局声明，使TypeScript能识别window上的自定义属性
declare global {
  interface Window {
    rotateModel: (target: string | null, direction: string, angle: number) => boolean;
    zoomModel: (target: string | null, scale: number) => boolean;
    focusOnModel: (target: string) => boolean;
    resetModel: () => boolean;
    app: any;
  }
}

const app = createApp(App);
app.mount('#app');

// 将app实例暴露给全局对象
window.app = app;
