/**
 * 全局类型声明
 * (Global type declarations)
 */

// 扩展Window接口 (Extend Window interface)
interface Window {
  // 模型操作方法 (Model operation methods)
  rotateModel: (params: { target?: string, direction: string, angle: number }) => boolean;
  zoomModel: (params: { target?: string, scale: number }) => boolean;
  focusOnModel: (params: { target?: string }) => boolean;
  resetModel: (params?: any) => boolean;
  
  // 应用对象 (Application object)
  app: {
    rotateComponent: (target: string | null, angle: number, direction: 'left' | 'right') => { success: boolean, message?: string };
    zoomComponent: (target: string | null, scale: number) => { success: boolean, message?: string };
    focusOnComponent: (target: string) => { success: boolean, message?: string };
    resetModel: () => boolean;
  };
  
  // 控制器引用 (Controller reference)
  __orbitControls: any;
  
  // 聚焦动画ID (Focus animation ID)
  __focusAnimationId?: number;
  
  // MCP使能函数 (MCP enable function)
  enableMCPMode?: () => void;
} 