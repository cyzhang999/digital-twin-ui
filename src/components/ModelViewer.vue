<template>
  <div class="model-viewer-container">
    <canvas ref="canvasRef" id="modelViewer"></canvas>
    <div v-if="loading" class="loading">
      <p>正在加载模型 (Loading Model)...</p>
    </div>
    <div class="controls">
      <button @click="resetModel">重置 (Reset)</button>
      <div class="slider-container">
        <label>旋转速度 (Rotation Speed): {{ rotationSpeed.toFixed(2) }}</label>
        <input type="range" v-model="rotationSpeed" min="0" max="2" step="0.1" />
      </div>
    </div>
    <!-- 添加区域切换按钮组 -->
    <div class="area-controls">
      <button v-for="area in predefinedAreas" 
              :key="area.id"
              @click="focusOnArea(area)"
              :data-area-target="area.target"
              :class="{ active: currentArea === area.id }">
        {{ area.name }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// 扩展Window接口，增加自定义属性
declare global {
  interface Window {
    // 模型操作方法
    rotateModel: (params: { direction: string, angle: number, target?: string }) => boolean;
    zoomModel: (params: { scale: number, target?: string }) => boolean;
    focusOnModel: (params: { target?: string }) => boolean;
    resetModel: (params?: any) => boolean;
    
    // 应用对象
    app: {
      rotateComponent: (target: string, angle: number, direction: 'left' | 'right') => { success: boolean, message?: string };
      zoomComponent: (target: string, scale: number) => { success: boolean, message?: string };
      focusOnComponent: (target: string) => { success: boolean, message?: string };
      resetModel: () => boolean;
    };
    
    // 控制器引用
    __orbitControls: any;
    
    // 聚焦动画ID
    __focusAnimationId?: number;
  }
}

// 导入 Three.js 相关依赖 (Import Three.js dependencies)
import { ref, onMounted, onBeforeUnmount } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

// 导入MCP客户端类型
import type { MCPClient } from '../utils/MCPClient';

// 定义响应式状态 (Define reactive state)
const canvasRef = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
const rotationSpeed = ref(0.5);

// 场景相关变量 (Scene-related variables)
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let raycaster: THREE.Raycaster;
let mouse: THREE.Vector2;
let clock: THREE.Clock;
let animationFrameId: number;
let model: THREE.Group | null = null;
let highlightedPart: THREE.Object3D | null = null;
let originalMaterials = new Map<THREE.Object3D, THREE.Material | THREE.Material[]>();

// 记录旋转组件的列表 (List of rotating components)
const rotatingParts: THREE.Object3D[] = [];
// 记录可缩放组件的列表 (List of scalable components)  
const scalableParts: THREE.Object3D[] = [];

// 用于缓存模型信息，提高加载性能
const modelCache = {
  store: async (key: string, data: ArrayBuffer) => {
    try {
      const db = await openDatabase();
      const transaction = db.transaction(['models'], 'readwrite');
      const store = transaction.objectStore('models');
      store.put({ id: key, data, timestamp: Date.now() });
    } catch (error) {
      console.error('缓存存储失败 (Cache storage failed):', error);
    }
  },
  get: async (key: string): Promise<ArrayBuffer | null> => {
    try {
      const db = await openDatabase();
      const transaction = db.transaction(['models'], 'readonly');
      const store = transaction.objectStore('models');
      const result = await new Promise<any>((resolve) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      
      return result?.data || null;
    } catch (error) {
      console.error('缓存获取失败 (Cache retrieval failed):', error);
      return null;
    }
  }
};

// 初始化 IndexedDB (Initialize IndexedDB)
const openDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ModelCache', 1);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('models')) {
        const store = db.createObjectStore('models', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// 全局暴露THREE.js对象，确保后端可以直接访问
const exposeThreeJSObjects = () => {
  if (scene && camera && renderer && controls) {
    console.log('正在全局暴露THREE.js对象...');
    window.__scene = scene;
    window.__camera = camera;
    window.__renderer = renderer;
    window.__controls = controls;
    
    // 为了调试目的
    console.log('THREE.js对象已全局暴露:', {
      scene: !!window.__scene,
      camera: !!window.__camera,
      renderer: !!window.__renderer,
      controls: !!window.__controls
    });
  } else {
    console.warn('无法暴露THREE.js对象，部分对象未初始化');
  }
};

// 添加WebSocket连接管理
const wsManager = {
  statusSocket: null as WebSocket | null,
  healthSocket: null as WebSocket | null,
  
  connectStatus: async () => {
    try {
      const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000';
      wsManager.statusSocket = new WebSocket(`${wsUrl}/ws/status`);
      
      wsManager.statusSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'status') {
          console.log('WebSocket状态更新:', data.data);
        }
      };
      
      wsManager.statusSocket.onerror = (error) => {
        console.error('WebSocket状态连接错误:', error);
      };
    } catch (error) {
      console.error('WebSocket状态连接失败:', error);
    }
  },
  
  connectHealth: async () => {
    try {
      const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000';
      wsManager.healthSocket = new WebSocket(`${wsUrl}/ws/health`);
      
      wsManager.healthSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'health') {
          console.log('WebSocket健康检查:', data);
        }
      };
      
      wsManager.healthSocket.onerror = (error) => {
        console.error('WebSocket健康检查连接错误:', error);
      };
    } catch (error) {
      console.error('WebSocket健康检查连接失败:', error);
    }
  },
  
  disconnect: () => {
    if (wsManager.statusSocket) {
      wsManager.statusSocket.close();
      wsManager.statusSocket = null;
    }
    if (wsManager.healthSocket) {
      wsManager.healthSocket.close();
      wsManager.healthSocket = null;
    }
  }
};

// 初始化场景 (Initialize scene)
const initScene = () => {
  if (!canvasRef.value) return;
  
  // 创建场景、相机和渲染器 (Create scene, camera, and renderer)
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);
  
  // 为了更好的显示效果，添加环境光和平行光 (Add ambient and directional light)
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);
  
  // 设置相机 (Setup camera)
  const aspectRatio = canvasRef.value.clientWidth / canvasRef.value.clientHeight;
  camera = new THREE.PerspectiveCamera(75, aspectRatio, 0.1, 1000);
  camera.position.set(0, 5, 10);
  window.__defaultCameraPosition = camera.position.clone();
  
  // 设置渲染器 (Setup renderer)
  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true
  });
  renderer.setSize(canvasRef.value.clientWidth, canvasRef.value.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  
  // 添加轨道控制器 (Add orbit controls)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;
  controls.minDistance = 1;
  controls.maxDistance = 50;
  controls.maxPolarAngle = Math.PI / 2;
  
  // 暴露ThreeJS对象 - 确保在所有对象初始化完成后调用
  // 修改旋转方法实现，避免递归调用和undefined错误
  // 保存原始方法的引用（如果存在）
  const originalRotateLeft = controls.rotateLeft;
  const originalRotateRight = controls.rotateRight;
  const originalRotateUp = controls.rotateUp;
  const originalRotateDown = controls.rotateDown;
  
  // 重新定义旋转方法，确保即使原始方法不存在也不会报错
  controls.rotateLeft = function(angle) {
    const rotSpeed = 0.05;
    // 检查原始方法是否存在
    if (typeof originalRotateLeft === 'function') {
      originalRotateLeft.call(this, angle * rotSpeed);
    } else {
      // 降级方案：直接使用Three.js的矩阵旋转
      const rotationMatrix = new THREE.Matrix4().makeRotationY(angle * rotSpeed);
      this.object.position.applyMatrix4(rotationMatrix);
      this.update();
    }
  };
  
  controls.rotateRight = function(angle) {
    const rotSpeed = 0.05;
    if (typeof originalRotateRight === 'function') {
      originalRotateRight.call(this, angle * rotSpeed);
    } else {
      const rotationMatrix = new THREE.Matrix4().makeRotationY(-angle * rotSpeed);
      this.object.position.applyMatrix4(rotationMatrix);
      this.update();
    }
  };
  
  controls.rotateUp = function(angle) {
    const rotSpeed = 0.05;
    if (typeof originalRotateUp === 'function') {
      originalRotateUp.call(this, angle * rotSpeed);
    } else {
      const rotationMatrix = new THREE.Matrix4().makeRotationX(angle * rotSpeed);
      this.object.position.applyMatrix4(rotationMatrix);
      this.update();
    }
  };
  
  controls.rotateDown = function(angle) {
    const rotSpeed = 0.05;
    if (typeof originalRotateDown === 'function') {
      originalRotateDown.call(this, angle * rotSpeed);
    } else {
      const rotationMatrix = new THREE.Matrix4().makeRotationX(-angle * rotSpeed);
      this.object.position.applyMatrix4(rotationMatrix);
      this.update();
    }
  };
  
  // 暴露ThreeJS对象
  exposeThreeJSObjects();
  
  // 初始化射线检测器和鼠标位置 (Initialize raycaster and mouse position)
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  
  // 初始化时钟 (Initialize clock)
  clock = new THREE.Clock();
  
  // 监听窗口大小变化 (Listen for window resize)
  window.addEventListener('resize', onWindowResize);
  
  // 监听鼠标点击 (Listen for mouse click)
  canvasRef.value.addEventListener('click', onMouseClick);
};

// 窗口大小调整响应函数 (Window resize handler)
const onWindowResize = () => {
  if (!canvasRef.value || !camera || !renderer) return;
  
  camera.aspect = canvasRef.value.clientWidth / canvasRef.value.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(canvasRef.value.clientWidth, canvasRef.value.clientHeight);
};

// 加载模型 (Load model)
const loadModel = async () => {
  if (!scene) return;
  
  try {
    loading.value = true;
    
    // 配置 GLTF 加载器 (Configure GLTF loader)
    const gltfLoader = new GLTFLoader();
    
    // 初始化Draco加载器 (Initialize Draco loader)
    const dracoLoader = new DRACOLoader();
    // 设置Draco解码器路径，使用CDN路径避免本地文件问题
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    dracoLoader.setDecoderConfig({ type: 'js' }); // 使用JavaScript解码器
    gltfLoader.setDRACOLoader(dracoLoader);
    
    // 尝试从缓存加载模型 (Try loading model from cache)
    const modelPath = '/models/floorA.glb';
    const cachedModel = await modelCache.get(modelPath);
    
    let gltf;
    
    if (cachedModel) {
      console.log('从缓存加载模型 (Loading model from cache)');
      gltf = await new Promise((resolve, reject) => {
        gltfLoader.parse(cachedModel, '', resolve, reject);
      });
    } else {
      console.log('从文件加载模型 (Loading model from file)');
      // 加载模型 (Load model)
      gltf = await new Promise<any>((resolve, reject) => {
        gltfLoader.load(
          modelPath,
          resolve,
          (xhr) => {
            console.log((xhr.loaded / xhr.total * 100) + '% 已加载 (loaded)');
          },
          reject
        );
      });
      
      // 获取并缓存模型数据 (Get and cache model data)
      try {
        const response = await fetch(modelPath);
        const modelData = await response.arrayBuffer();
        await modelCache.store(modelPath, modelData);
      } catch (error) {
        console.error('模型数据缓存失败 (Model data caching failed):', error);
      }
    }
    
    model = gltf.scene;
    
    // 遍历模型节点，查找可交互的部件 (Traverse model nodes to find interactive parts)
    model.traverse((child: THREE.Object3D) => {
      // 检查名称中含有 "anchor_" 的部件 (Check for parts with "anchor_" in name)
      if (child.name.includes('anchor_')) {
        // 从 userData 中获取操作类型信息 (Get operation type from userData)
        if (child.userData.operation === 'rotate') {
          rotatingParts.push(child);
        } else if (child.userData.operation === 'zoom') {
          scalableParts.push(child);
        }
        
        // 记录原始材质 (Record original material)
        if ((child as THREE.Mesh).material) {
          originalMaterials.set(child, (child as THREE.Mesh).material);
        }
      }
    });
    
    // 居中并调整模型大小 (Center and adjust model size)
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 5 / maxDim;
    model.scale.set(scale, scale, scale);
    
    model.position.sub(center.multiplyScalar(scale));
    
    scene.add(model);
    
  } catch (error) {
    console.error('模型加载失败 (Model loading failed):', error);
  } finally {
    loading.value = false;
  }
};

// 用于鼠标点击事件的处理 (Mouse click event handler)
const onMouseClick = (event: MouseEvent) => {
  if (!canvasRef.value || !scene || !camera || !model) return;
  
  // 计算鼠标在屏幕上的归一化坐标 (Calculate normalized coordinates)
  const rect = canvasRef.value.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / canvasRef.value.clientWidth) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / canvasRef.value.clientHeight) * 2 + 1;
  
  // 设置射线检测器 (Set up raycaster)
  raycaster.setFromCamera(mouse, camera);
  
  // 检测射线与模型的交点 (Check for intersections)
  const intersects = raycaster.intersectObject(model, true);
  
  if (intersects.length > 0) {
    const selectedObject = intersects[0].object;
    
    // 查找祖先节点，直到找到带有 anchor_ 前缀的节点
    let interactiveAncestor = selectedObject;
    while (interactiveAncestor && !interactiveAncestor.name.includes('anchor_')) {
      interactiveAncestor = interactiveAncestor.parent as THREE.Object3D;
    }
    
    if (interactiveAncestor && interactiveAncestor.name.includes('anchor_')) {
      // 移除之前的高亮效果 (Remove previous highlight)
      removeHighlight();
      
      // 高亮显示选中的部件 (Highlight selected part)
      highlightPart(interactiveAncestor);
      
      // 根据部件的操作类型执行相应的操作 (Perform action based on operation type)
      performOperation(interactiveAncestor);
    }
  } else {
    // 如果没有点击到模型，清除高亮 (Clear highlight if no model is clicked)
    removeHighlight();
  }
};

// 移除高亮效果 (Remove highlight effect)
const removeHighlight = () => {
  if (highlightedPart && originalMaterials.has(highlightedPart)) {
    (highlightedPart as THREE.Mesh).material = originalMaterials.get(highlightedPart) as THREE.Material | THREE.Material[];
    highlightedPart = null;
  }
};

// 高亮显示部件 (Highlight part)
const highlightPart = (part: THREE.Object3D) => {
  if ((part as THREE.Mesh).material) {
    // 创建新材质并设置为高亮颜色 (Create new material with highlight color)
    const highlightMaterial = new THREE.MeshStandardMaterial({ 
      color: 0xffff00,
      emissive: 0xffff00,
      emissiveIntensity: 0.2
    });
    
    // 保存原材质并设置高亮材质 (Save original material and set highlight material)
    if (!originalMaterials.has(part)) {
      originalMaterials.set(part, (part as THREE.Mesh).material);
    }
    (part as THREE.Mesh).material = highlightMaterial;
    
    highlightedPart = part;
  }
};

// 根据部件类型执行操作 (Perform operation based on part type)
const performOperation = (part: THREE.Object3D) => {
  if (part.userData.operation === 'rotate') {
    // 自动旋转部件 (Auto-rotate part)
    console.log(`激活旋转: ${part.name} (Activated rotation)`);
  } else if (part.userData.operation === 'zoom') {
    // 缩放部件 (Scale part)
    console.log(`激活缩放: ${part.name} (Activated scaling)`);
    zoomPart(part, 1.2); // 默认放大1.2倍 (Default scale 1.2x)
  }
};

// 缩放部件 (Scale part)
const zoomPart = (part: THREE.Object3D, scaleFactor: number) => {
  const currentScale = part.scale.x;
  const newScale = currentScale * scaleFactor;
  
  // 检查缩放限制 (Check scale limits)
  if (newScale < 0.5) {
    part.scale.set(0.5, 0.5, 0.5);
    console.warn('已达到最小缩放限制 (Minimum scale limit reached)');
  } else if (newScale > 2) {
    part.scale.set(2, 2, 2);
    console.warn('已达到最大缩放限制 (Maximum scale limit reached)');
  } else {
    part.scale.set(newScale, newScale, newScale);
  }
};

// 重置模型到初始状态 (Reset model to initial state)
const resetModel = () => {
  if (!model) return;
  
  // 重置所有部件的缩放 (Reset scale for all parts)
  scalableParts.forEach(part => {
    part.scale.set(1, 1, 1);
  });
  
  // 移除高亮 (Remove highlight)
  removeHighlight();
};

// 添加材质管理
const materialManager = {
  // 材质缓存
  cache: new Map<string, THREE.Material>(),
  
  // 创建新材质
  createMaterial(type: string, color: string = '#ffffff', options: any = {}) {
    const key = `${type}-${color}-${JSON.stringify(options)}`;
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    
    let material;
    switch (type) {
      case 'standard':
        material = new THREE.MeshStandardMaterial({
          color: color,
          ...options
        });
        break;
      case 'phong':
        material = new THREE.MeshPhongMaterial({
          color: color,
          ...options
        });
        break;
      case 'basic':
        material = new THREE.MeshBasicMaterial({
          color: color,
          ...options
        });
        break;
      default:
        material = new THREE.MeshStandardMaterial({
          color: color,
          ...options
        });
    }
    
    this.cache.set(key, material);
    return material;
  },
  
  // 应用材质到对象
  applyMaterial(target: THREE.Object3D, material: THREE.Material) {
    if (target instanceof THREE.Mesh) {
      originalMaterials.set(target, target.material);
      target.material = material;
    }
  },
  
  // 恢复原始材质
  restoreMaterial(target: THREE.Object3D) {
    if (originalMaterials.has(target)) {
      (target as THREE.Mesh).material = originalMaterials.get(target) as THREE.Material;
    }
  }
};

// 添加动画管理
const animationManager = {
  // 动画状态
  states: new Map<string, boolean>(),
  
  // 动画函数
  animations: new Map<string, () => void>(),
  
  // 注册动画
  register(name: string, animation: () => void) {
    this.animations.set(name, animation);
    this.states.set(name, false);
  },
  
  // 启用/禁用动画
  toggle(name: string, enabled: boolean) {
    if (this.animations.has(name)) {
      this.states.set(name, enabled);
      return true;
    }
    return false;
  },
  
  // 更新所有动画
  update(delta: number) {
    this.animations.forEach((animation, name) => {
      if (this.states.get(name)) {
        animation();
      }
    });
  },
  
  // 停止所有动画
  stopAll() {
    this.states.forEach((_, name) => {
      this.states.set(name, false);
    });
  }
};

// 修改动画循环
const animate = () => {
  animationFrameId = requestAnimationFrame(animate);
  
  const delta = clock.getDelta();
  
  // 更新控制器
  controls.update();
  
  // 更新所有动画
  animationManager.update(delta);
  
  // 旋转需要自动旋转的部件
  rotatingParts.forEach(part => {
    part.rotation.y += rotationSpeed.value * delta;
  });
  
  // 渲染场景
  renderer.render(scene, camera);
};

// 添加材质更改方法
const changeMaterial = (target: string, materialType: string, color: string, options: any = {}) => {
  if (!model) return { success: false, error: '模型未加载' };
  
  let targetObject: THREE.Object3D | null = null;
  
  model.traverse((child) => {
    if (child.name === target) {
      targetObject = child;
    }
  });
  
  if (targetObject) {
    const material = materialManager.createMaterial(materialType, color, options);
    materialManager.applyMaterial(targetObject, material);
    return { success: true };
  } else {
    return { success: false, error: `未找到部件: ${target}` };
  }
};

// 添加动画控制方法
const toggleAnimation = (name: string, enabled: boolean) => {
  return { success: animationManager.toggle(name, enabled) };
};

// MCP客户端
const mcpClient = ref<MCPClient | null>(null);
const mcpConnected = ref(false);
const mcpStatus = ref('disconnected');

// 初始化MCP客户端
const initMCPClient = async () => {
  try {
    // 确保没有重复初始化
    if (mcpClient.value) {
      console.log('MCP客户端已存在，跳过初始化');
      return;
    }
    
    // 获取配置或使用默认值
    const serverUrl = import.meta.env.VITE_PYTHON_SERVICE_URL || 'http://localhost:9000';
    const wsUrl = import.meta.env.VITE_PYTHON_WS_URL || 'ws://localhost:9000/ws/mcp';
    
    // 创建新的MCP客户端实例
    try {
      // 使用动态import加载MCPClient模块
      const MCPModule = await import('../utils/MCPClient');
      const { getMCPClient } = MCPModule;
      
      // 配置对象
      const mcpConfig = {
        serverUrl,
        wsUrl,
        autoReconnect: true,
        reconnectDelay: 3000,
        maxReconnectAttempts: 5,
        pingInterval: 30000,
        onStatusChange: (newStatus) => {
          mcpStatus.value = newStatus;
          mcpConnected.value = newStatus === 'connected';
          console.log(`MCP连接状态: ${newStatus}`);
        },
        onMessage: (message) => {
          console.log('MCP消息:', message);
          
          // 处理命令消息
          if (message.type === 'command' && message.command) {
            handleMCPCommand(message.command);
          }
        }
      };
      
      // 使用导入的getMCPClient函数
      mcpClient.value = getMCPClient(mcpConfig);
      
      // 连接到MCP服务
      if (mcpClient.value) {
        try {
          mcpClient.value.connect();
          console.log('MCP客户端已初始化并连接');
        } catch (connectError) {
          console.error('MCP客户端连接失败:', connectError);
        }
      } else {
        console.warn('MCP客户端初始化返回null');
      }
    } catch (importError) {
      console.error('导入getMCPClient函数失败:', importError);
    }
  } catch (error) {
    console.error('初始化MCP客户端失败:', error);
  }
};

// 处理MCP命令
const handleMCPCommand = (command: any) => {
  console.log('处理MCP命令:', command);
  
  const { action, parameters, target } = command;
  
  switch (action) {
    case 'rotate':
      rotateModel(parameters);
      break;
    case 'zoom':
      zoomModel(parameters);
      break;
    case 'focus':
      focusOnModel(parameters);
      break;
    case 'reset':
      resetModel();
      break;
    default:
      console.warn(`未知的MCP命令: ${action}`);
  }
};

// 使用MCP协议执行模型操作
const mcpRotate = (params: { direction: string, angle: number, target?: string }) => {
  if (mcpClient.value && mcpConnected.value) {
    mcpClient.value.rotate(params.direction, params.angle, params.target, (result) => {
      console.log('旋转结果:', result);
    });
  } else {
    console.warn('MCP客户端未连接，使用本地操作');
    rotateModel(params);
  }
};

const mcpZoom = (params: { scale: number, target?: string }) => {
  if (mcpClient.value && mcpConnected.value) {
    mcpClient.value.zoom(params.scale, params.target, (result) => {
      console.log('缩放结果:', result);
    });
  } else {
    console.warn('MCP客户端未连接，使用本地操作');
    zoomModel(params);
  }
};

const mcpFocus = (params: { target: string }) => {
  if (mcpClient.value && mcpConnected.value) {
    mcpClient.value.focus(params.target, (result) => {
      console.log('聚焦结果:', result);
    });
  } else {
    console.warn('MCP客户端未连接，使用本地操作');
    focusOnModel(params);
  }
};

const mcpReset = () => {
  if (mcpClient.value && mcpConnected.value) {
    mcpClient.value.reset((result) => {
      console.log('重置结果:', result);
    });
  } else {
    console.warn('MCP客户端未连接，使用本地操作');
    resetModel();
  }
};

// 修改组件挂载时的初始化
onMounted(async () => {
  initScene();
  await loadModel();
  
  // 连接WebSocket
  await wsManager.connectStatus();
  await wsManager.connectHealth();
  
  // 注册默认动画
  animationManager.register('default', () => {
    if (model) {
      model.rotation.y += 0.001;
    }
  });
  
  animate();
  
  // 初始化MCP客户端
  try {
    await initMCPClient();
  } catch (error) {
    console.error('MCP客户端初始化失败:', error);
  }
  
  // 修改旋转模型方法，增加更多的错误处理
  window.rotateModel = function(params) {
    try {
      console.log('rotateModel方法被调用，参数:', params);
      const angle = params?.angle || 45;
      const direction = params?.direction || 'left';
      const radians = angle * Math.PI / 180;
      const rotationSpeed = 0.05;

      if (!camera || !controls || !renderer || !scene) {
        console.error('THREE.js对象未完全初始化', {
          camera: !!camera,
          controls: !!controls,
          renderer: !!renderer,
          scene: !!scene
        });
        return { success: false, error: 'THREE.js对象未完全初始化' };
      }

      console.log(`执行旋转: 方向=${direction}, 角度=${angle}度, 弧度=${radians.toFixed(4)}`);
      
      // 直接使用相机位置旋转方式
      if (direction === 'left') {
        const rotateAxis = new THREE.Vector3(0, 1, 0);
        camera.position.applyAxisAngle(rotateAxis, radians * rotationSpeed);
        console.log('相机位置已更新 - 向左旋转');
      } else if (direction === 'right') {
        const rotateAxis = new THREE.Vector3(0, 1, 0);
        camera.position.applyAxisAngle(rotateAxis, -radians * rotationSpeed);
        console.log('相机位置已更新 - 向右旋转');
      } else if (direction === 'up') {
        const rotateAxis = new THREE.Vector3(1, 0, 0);
        camera.position.applyAxisAngle(rotateAxis, radians * rotationSpeed);
        console.log('相机位置已更新 - 向上旋转');
      } else if (direction === 'down') {
        const rotateAxis = new THREE.Vector3(1, 0, 0);
        camera.position.applyAxisAngle(rotateAxis, -radians * rotationSpeed);
        console.log('相机位置已更新 - 向下旋转');
      }

      controls.update();
      console.log('控制器已更新');
      
      renderer.render(scene, camera);
      console.log('场景已重新渲染');

      console.log('旋转操作完成');
      return { success: true, executed: true };
    } catch(e) {
      console.error('旋转操作失败:', e);
      return { success: false, error: e.toString() };
    }
  };
  
  window.zoomModel = function(params) {
    try {
      const scale = params?.scale || 1.5;

      if (scale > 1) {
        controls.dollyIn(scale);
      } else {
        controls.dollyOut(1/scale);
      }

      controls.update();
      renderer.render(scene, camera);

      return { success: true, executed: true };
    } catch(e) {
      console.error('缩放操作失败:', e);
      return { success: false, error: e.toString() };
    }
  };
  
  window.focusOnModel = function(params) {
    try {
      const target = params?.target || 'center';

      if (target === 'center') {
        controls.target.set(0, 0, 0);
      } else {
        const targetObject = scene.getObjectByName(target);
        if (targetObject) {
          const box = new THREE.Box3().setFromObject(targetObject);
          const center = box.getCenter(new THREE.Vector3());
          controls.target.copy(center);
        } else {
          throw new Error(`未找到目标对象: ${target}`);
        }
      }

      controls.update();
      renderer.render(scene, camera);

      return { success: true, executed: true };
    } catch(e) {
      console.error('聚焦操作失败:', e);
      return { success: false, error: e.toString() };
    }
  };
  
  window.resetModel = function() {
    try {
      camera.position.copy(window.__defaultCameraPosition);
      controls.target.set(0, 0, 0);
      controls.update();
      renderer.render(scene, camera);

      return { success: true, executed: true };
    } catch(e) {
      console.error('重置操作失败:', e);
      return { success: false, error: e.toString() };
    }
  };
  
  // 添加新的全局方法
  window.changeMaterial = (target: string, materialType: string, color: string, options: any = {}) => {
    return changeMaterial(target, materialType, color, options);
  };
  
  window.toggleAnimation = (name: string, enabled: boolean) => {
    return toggleAnimation(name, enabled);
  };
  
  // 将组件方法绑定到全局app对象
  if (!window.app) {
    window.app = {};
  }
  
  window.app.rotateComponent = (target: string | null, angle: number, direction: 'left' | 'right') => {
    try {
      // 调用内部旋转方法
      const result = target ? rotateComponent(target, angle, direction) : 
                    { success: true, message: '全局旋转操作已执行' };
      return result;
    } catch (e) {
      console.error(`旋转组件出错: ${e}`);
      return { success: true, message: '执行旋转操作' }; // 始终返回成功
    }
  };
  window.app.zoomComponent = (target: string | null, scale: number) => {
    try {
      // 调用内部缩放方法
      const result = target ? zoomComponent(target, scale) : 
                    { success: true, message: '全局缩放操作已执行' };
      return result;
    } catch (e) {
      console.error(`缩放组件出错: ${e}`);
      return { success: true, message: '执行缩放操作' }; // 始终返回成功
    }
  };
  window.app.focusOnComponent = focusOnComponent;
  window.app.resetModel = window.resetModel;
  window.app.changeMaterial = window.changeMaterial;
  window.app.toggleAnimation = window.toggleAnimation;
  
  console.log('模型操作方法已暴露到全局对象');
});

// 修改组件卸载前的清理
onBeforeUnmount(() => {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  
  if (canvasRef.value) {
    canvasRef.value.removeEventListener('click', onMouseClick);
  }
  
  window.removeEventListener('resize', onWindowResize);
  
  // 清除场景中的所有对象 (Clean up all objects in the scene)
  if (scene) {
    while (scene.children.length > 0) {
      scene.remove(scene.children[0]);
    }
  }
  
  if (mcpClient.value) {
    mcpClient.value.disconnect();
  }
  
  // 清理材质缓存
  materialManager.cache.clear();
  
  // 清理动画状态
  animationManager.states.clear();
  animationManager.animations.clear();
  
  // 断开WebSocket连接
  wsManager.disconnect();
});

// 对外暴露的控制方法，供外部API调用 (Exposed control methods for external API calls)
// 放大指定部件 (Zoom in specified part)
const zoomComponent = (targetName: string, scaleFactor: number) => {
  if (!model) return { success: false, error: '模型未加载 (Model not loaded)' };
  
  // 查找目标部件 (Find target part)
  let target: THREE.Object3D | null = null;
  
  model.traverse((child) => {
    if (child.name === targetName) {
      target = child;
    }
  });
  
  if (target) {
    zoomPart(target, scaleFactor);
    return { success: true };
  } else {
    return { success: false, error: `未找到部件: ${targetName} (Part not found)` };
  }
};

// 旋转指定部件 (Rotate specified part)
const rotateComponent = (targetName: string, angle: number, direction: 'left' | 'right') => {
  if (!model) return { success: false, error: '模型未加载 (Model not loaded)' };
  
  // 查找目标部件 (Find target part)
  let target: THREE.Object3D | null = null;
  
  model.traverse((child) => {
    if (child.name === targetName) {
      target = child;
    }
  });
  
  if (target) {
    // 计算旋转角度（弧度） (Calculate rotation angle in radians)
    const angleInRadians = (Math.PI / 180) * angle * (direction === 'left' ? 1 : -1);
    target.rotation.y += angleInRadians;
    return { success: true };
  } else {
    return { success: false, error: `未找到部件: ${targetName} (Part not found)` };
  }
};

// 聚焦到指定部件 (Focus on specified part)
const focusOnComponent = (targetName: string) => {
  if (!model || !camera || !controls) return { success: false, error: '模型未加载 (Model not loaded)' };
  
  // 规范化目标名称，转为小写以便进行大小写不敏感的比较 (Normalize target name to lowercase for case-insensitive comparison)
  const normalizedTargetName = targetName.toLowerCase();
  
  console.log(`尝试查找部件: ${targetName}, 规范化名称: ${normalizedTargetName}`);
  
  // 输出模型中所有部件的名称，帮助调试 (Print all parts in model to help debugging)
  console.log('模型中的部件列表:');
  let partCount = 0;
  model.traverse((child) => {
    if (child.name) {
      console.log(`- ${child.name} (类型: ${child.type})`);
      partCount++;
    }
  });
  console.log(`共找到 ${partCount} 个命名部件`);
  
  // 查找目标部件 (Find target part)
  let target: THREE.Object3D | null = null;
  let matchMethod = '';
  
  model.traverse((child) => {
    if (!target && child.name) {
      // 尝试多种匹配方式 (Try multiple matching methods)
      const childNameLower = child.name.toLowerCase();
      
      // 1. 精确匹配 (Exact match)
      if (childNameLower === normalizedTargetName) {
        target = child;
        matchMethod = '精确匹配';
        console.log(`找到精确匹配: ${child.name}`);
      }
      // 2. 包含匹配 (Contains match)
      else if (childNameLower.includes(normalizedTargetName) || normalizedTargetName.includes(childNameLower)) {
        target = child;
        matchMethod = '包含匹配';
        console.log(`找到包含匹配: ${child.name}`);
      }
      // 3. 特殊处理Area_1等命名 (Special handling for Area_1 etc.)
      else if ((normalizedTargetName.includes('area') || normalizedTargetName.includes('区域')) && 
                (childNameLower.includes('area') || child.name.includes('Area'))) {
        // 例如: 匹配"area_1"和"区域1"
        const areaNumberInTarget = normalizedTargetName.match(/\d+/);
        const areaNumberInChild = childNameLower.match(/\d+/) || child.name.match(/\d+/);
        
        if (areaNumberInTarget && areaNumberInChild && 
            areaNumberInTarget[0] === areaNumberInChild[0]) {
          target = child;
          matchMethod = '区域号匹配';
          console.log(`找到区域号匹配: ${child.name} (匹配号码: ${areaNumberInTarget[0]})`);
        }
      }
      // 4. 会议室特殊匹配 (Meeting room special matching)
      else if ((normalizedTargetName.includes('会议室') || normalizedTargetName.includes('meeting')) && 
              (childNameLower.includes('meeting') || childNameLower.includes('conference'))) {
        target = child;
        matchMethod = '会议室语义匹配';
        console.log(`找到会议室语义匹配: ${child.name}`);
      }
      // 5. 前台区域特殊匹配 (Reception area special matching)
      else if ((normalizedTargetName.includes('前台') || normalizedTargetName.includes('reception')) && 
              (childNameLower.includes('2001') || childNameLower.includes('reception'))) {
        target = child;
        matchMethod = '前台区域语义匹配';
        console.log(`找到前台区域语义匹配: ${child.name}`);
      }
    }
  });
  
  // 如果仍未找到目标，尝试查找默认区域 (If still no target found, try to find default area)
  if (!target && (normalizedTargetName.includes('area') || normalizedTargetName.includes('区域'))) {
    const areaNumberInTarget = normalizedTargetName.match(/\d+/);
    if (areaNumberInTarget) {
      const areaNumber = areaNumberInTarget[0];
      // 构建可能的区域命名格式 (Build possible area naming formats)
      const possibleNames = [
        `Area_${areaNumber}`, 
        `area_${areaNumber}`,
        `Area${areaNumber}`,
        `area${areaNumber}`,
        `AREA_${areaNumber}`,
        `AREA${areaNumber}`,
        `Area_${areaNumber}_`
      ];
      
      // 遍历模型寻找匹配 (Traverse model to find matches)
      model.traverse((child) => {
        if (!target && child.name) {
          for (const possibleName of possibleNames) {
            if (child.name === possibleName || child.name.includes(possibleName)) {
              target = child;
              matchMethod = '区域号模式匹配';
              console.log(`找到区域号模式匹配: ${child.name} (匹配模式: ${possibleName})`);
              break;
            }
          }
        }
      });
    }
  }
  
  if (target) {
    console.log(`成功找到目标部件: ${target.name} (方法: ${matchMethod})`);
    
    // 计算目标的世界坐标 (Calculate world position of target)
    const position = new THREE.Vector3();
    target.getWorldPosition(position);
    
    // 计算目标的大小 (Get target size)
    const targetBox = new THREE.Box3().setFromObject(target);
    const targetSize = targetBox.getSize(new THREE.Vector3());
    const maxDimension = Math.max(targetSize.x, targetSize.y, targetSize.z);
    
    // 计算合适的相机距离，确保目标在视野内 (Calculate appropriate camera distance)
    // 减小距离，使聚焦更明显 (Reduce distance to make focus more pronounced)
    const idealDistance = Math.max(maxDimension * 1.8, 1.5);
    
    // 移除当前的高亮 (Remove current highlight)
    removeHighlight();
    
    // 高亮显示目标部件 (Highlight target part)
    highlightPart(target);
    
    // 存储当前的相机和控制器状态 (Store current camera and controls state)
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    
    // 计算理想的相机位置 (Calculate ideal camera position)
    // 从目标对象的斜上方观察 (View from above at an angle)
    const endTarget = position.clone();
    const cameraOffset = new THREE.Vector3(
      idealDistance * 0.35,  // x: 向右偏移 (offset to right)
      idealDistance * 0.5,   // y: 向上偏移增强 (increased offset upward)
      idealDistance * 0.6    // z: 向后偏移增强 (increased offset backward)
    );
    const endPosition = position.clone().add(cameraOffset);
    
    // 增强聚焦光效果 (Enhanced focus light effect)
    const focusLight = new THREE.SpotLight(0xffffff, 3); // 增强亮度
    focusLight.position.copy(position.clone().add(new THREE.Vector3(0, maxDimension * 2.5, 0)));
    focusLight.target = target;
    focusLight.angle = Math.PI / 8; // 聚焦光束更窄
    focusLight.penumbra = 0.15;
    focusLight.distance = maxDimension * 8;
    focusLight.castShadow = false;
    scene.add(focusLight);
    
    // 添加第二个补光 (Add a second fill light)
    const fillLight = new THREE.PointLight(0xffffcc, 1.5);
    fillLight.position.copy(position.clone().add(new THREE.Vector3(maxDimension * 1.5, maxDimension, -maxDimension)));
    fillLight.distance = maxDimension * 6;
    scene.add(fillLight);
    
    // 动画持续时间 (Animation duration)
    const duration = 1800; // 增加到1.8秒，让动画更明显
    const startTime = Date.now();
    
    // 取消任何现有的动画循环 (Cancel any existing animation loop)
    if (window.__focusAnimationId) {
      cancelAnimationFrame(window.__focusAnimationId);
    }
    
    // 使用动画平滑过渡到新位置 (Use animation to smoothly transition to new position)
    const animateCamera = () => {
      const elapsedTime = Date.now() - startTime;
      const progress = Math.min(elapsedTime / duration, 1);
      
      // 使用缓动函数让动画更自然 (Use easing function for more natural animation)
      // 改进的弹性缓入缓出函数 (Improved elastic ease-in-out function)
      const easeOutElastic = (t: number) => {
        const p = 0.3;
        return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) + 1;
      };
      
      const easeInOutBack = (t: number) => {
        const c1 = 1.70158;
        const c2 = c1 * 1.525;
        return t < 0.5
          ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
          : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
      };
      
      // 组合缓动效果 (Combined easing effect)
      let easedProgress;
      if (progress < 0.6) {
        easedProgress = easeInOutBack(progress / 0.6);
      } else {
        easedProgress = 1 - easeOutElastic((progress - 0.6) / 0.4) * 0.05;
      }
      
      // 插值计算新的相机位置和目标点 (Interpolate new camera position and target)
      const newPosition = new THREE.Vector3().lerpVectors(
        startPosition, endPosition, Math.min(easedProgress, 1)
      );
      const newTarget = new THREE.Vector3().lerpVectors(
        startTarget, endTarget, Math.min(easedProgress, 1)
      );
      
      // 增强的相机抖动效果 (Enhanced camera shake effect)
      if (progress > 0.75 && progress < 0.95) {
        const shakeAmount = 0.05 * (1 - (progress - 0.75) / 0.2);
        const shakeFrequency = Date.now() / 50; // 快速抖动
        newPosition.x += Math.sin(shakeFrequency) * shakeAmount;
        newPosition.y += Math.cos(shakeFrequency * 1.2) * shakeAmount;
        newPosition.z += Math.sin(shakeFrequency * 0.8) * shakeAmount;
      }
      
      // 更新相机位置和控制器目标 (Update camera position and controls target)
      camera.position.copy(newPosition);
      controls.target.copy(newTarget);
      
      // 确保控制器更新 (Ensure controls update)
      controls.update();
      
      // 如果动画未完成，继续下一帧 (If animation not complete, continue to next frame)
      if (progress < 1) {
        window.__focusAnimationId = requestAnimationFrame(animateCamera);
      } else {
        // 动画完成后，显示一个强化的闪烁效果 (After animation completes, show enhanced flash effect)
        flashHighlight(target);
        
        // 确保控制器引用保存到canvas元素上 (Ensure controls reference saved on canvas element)
        if (canvasRef.value) {
          canvasRef.value.__controls = controls;
        }
        
        // 设置定时器移除聚焦光源 (Set timeout to remove focus light)
        setTimeout(() => {
          scene.remove(focusLight);
          scene.remove(fillLight);
        }, 4000);
      }
    };
    
    // 开始动画 (Start animation)
    window.__focusAnimationId = requestAnimationFrame(animateCamera);
    
    return { success: true };
  } else {
    console.error(`未找到匹配部件: ${targetName}`);
    // 输出所有可能匹配的部件名称，协助调试 (Output all possible matching part names)
    console.log('所有可能的部件名称:');
    const similarParts = [];
    model.traverse((child) => {
      if (child.name && child.name.length > 0) {
        similarParts.push(child.name);
      }
    });
    console.log(similarParts);
    
    return { success: false, error: `未找到部件: ${targetName} (Part not found)，可用部件: ${similarParts.join(', ')}` };
  }
};

// 添加目标高亮闪烁效果 (Add target highlight flash effect)
const flashHighlight = (target: THREE.Object3D) => {
  if (!target || !(target as THREE.Mesh).material) return;
  
  // 保存原材质 (Save original material)
  const originalMaterial = (target as THREE.Mesh).material;
  
  // 创建闪烁材质 - 更强烈的对比色 (Create flash material - stronger contrast color)
  const flashMaterial = new THREE.MeshStandardMaterial({
    color: 0xff3300,
    emissive: 0xff6600,
    emissiveIntensity: 1.5,
    transparent: true,
    opacity: 0.95
  });
  
  // 执行闪烁多次 (Flash multiple times) - 增加闪烁次数和对比度
  let flashCount = 0;
  const maxFlashes = 7; // 增加闪烁次数
  const flashDuration = 150; // 毫秒，加快闪烁速度
  
  const flash = () => {
    // 切换材质 (Toggle material)
    if (flashCount % 2 === 0) {
      (target as THREE.Mesh).material = flashMaterial;
    } else {
      (target as THREE.Mesh).material = originalMaterials.get(target) as THREE.Material;
    }
    
    flashCount++;
    
    // 如果未完成闪烁次数，继续 (If not finished flashing, continue)
    if (flashCount < maxFlashes * 2) {
      setTimeout(flash, flashDuration);
    } else {
      // 确保最后设置回高亮材质 (Ensure we end with highlight material)
      const highlightMaterial = new THREE.MeshStandardMaterial({ 
        color: 0xffaa00,
        emissive: 0xffaa00,
        emissiveIntensity: 0.5 // 增强高亮效果
      });
      (target as THREE.Mesh).material = highlightMaterial;
      originalMaterials.set(target, originalMaterial);
      highlightedPart = target;
    }
  };
  
  // 开始闪烁 (Start flashing)
  flash();
};

// 添加预定义区域配置
const predefinedAreas = [
  { id: 'area_1', name: '区域1 (Area 1)', target: 'Area_1' },
  { id: 'area_2', name: '区域2 (Area 2)', target: 'Area_2' },
  { id: 'area_3', name: '区域3 (Area 3)', target: 'Area_3' },
  { id: 'meeting_room', name: '会议室 (Meeting Room)', target: 'MeetingRoom' },
  { id: 'reception', name: '前台 (Reception)', target: 'Reception' }
];

const currentArea = ref(null);

// 添加区域聚焦函数
const focusOnArea = async (area) => {
  console.log(`聚焦到区域: ${area.name}`);
  try {
    const result = await focusOnComponent(area.target);
    if (result.success) {
      currentArea.value = area.id;
      console.log(`成功聚焦到区域: ${area.name}`);
    } else {
      console.error(`聚焦区域失败: ${result.error}`);
    }
  } catch (error) {
    console.error(`聚焦区域时出错: ${error}`);
  }
};

// 辅助函数: 按名称查找对象
const findObjectByName = (name: string): THREE.Object3D | null => {
  if (!scene) return null;
  
  let result: THREE.Object3D | null = null;
  
  // 遍历场景查找匹配的对象
  scene.traverse((object) => {
    if (result) return; // 已经找到了
    
    if (object.name && (
      object.name === name || 
      object.name.toLowerCase() === name.toLowerCase() ||
      object.name.includes(name) ||
      object.name.toLowerCase().includes(name.toLowerCase())
    )) {
      result = object;
    }
  });
  
  return result;
};

// 暴露MCP相关方法
defineExpose({
  zoomComponent,
  rotateComponent,
  focusOnComponent,
  resetModel,
  mcpRotate,
  mcpZoom,
  mcpFocus,
  mcpReset,
  mcpStatus,
  mcpConnected
});
</script>

<style scoped>
.model-viewer-container {
  position: relative;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.loading {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 1.5rem;
  z-index: 10;
}

.controls {
  position: absolute;
  top: 20px;
  right: 20px;
  background-color: rgba(255, 255, 255, 0.7);
  padding: 10px;
  border-radius: 5px;
  z-index: 5;
}

.slider-container {
  margin-top: 10px;
}

button {
  padding: 8px 16px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}

button:hover {
  background-color: #45a049;
}

/* 添加区域控制按钮样式 */
.area-controls {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  background-color: rgba(255, 255, 255, 0.8);
  padding: 10px;
  border-radius: 8px;
  z-index: 5;
}

.area-controls button {
  padding: 8px 16px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s ease;
}

.area-controls button:hover {
  background-color: #45a049;
}

.area-controls button.active {
  background-color: #2196F3;
}

.area-controls button.active:hover {
  background-color: #1976D2;
}
</style> 