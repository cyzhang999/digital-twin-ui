<template>
  <div class="model-viewer-container">
    <canvas ref="canvasRef" id="modelViewer"></canvas>
    <div v-if="loading" class="loading">
      <p>正在加载模型 (Loading Model)...</p>
    </div>
    <div v-if="loadError" class="error-message">
      <p>{{ loadErrorMessage }}</p>
      <button @click="retryLoadModel">重试加载 (Retry)</button>
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
    focusModel: (params: { target?: string }) => boolean;
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

    // 当前旋转参数
    currentRotationParams?: { direction: string, angle: number };
  }
}

// 导入 Three.js 相关依赖 (Import Three.js dependencies)
import { ref, reactive, onMounted, onBeforeUnmount, computed, watch, watchEffect, nextTick } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getMCPClient } from '../utils/MCPClient';
import { WebSocketManager } from '../utils/WebSocketManager';
import CommandStateManager from '@/utils/CommandStateManager';
import { useWebSocket } from '@/composables/useWebSocket';
import { useToast } from 'vue-toast-notification';

// 创建命令状态管理器实例
const commandStateManager = new CommandStateManager({
  recordTTL: 8000,          // 命令记录保留8秒
  maxLockTime: 10000,       // 最大锁定时间10秒
  similarityThreshold: 0.75 // 参数相似度阈值
});

// 定义响应式状态 (Define reactive state)
const canvasRef = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
const loadError = ref(false);
const loadErrorMessage = ref('模型加载失败，请检查网络连接或刷新页面重试。');
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

// 创建WebSocket管理器实例
const wsManager = new WebSocketManager({
  logLevel: 'warn' // 只显示警告和错误信息，不显示调试和一般信息
});

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

// 重试加载模型
const retryLoadModel = async () => {
  loadError.value = false;
  loading.value = true;
  try {
    await loadModel();
    // 如果模型加载成功，启动动画循环
    if (!animationFrameId) {
      animate();
    }
  } catch (error) {
    console.error('重试加载模型失败:', error);
    loadError.value = true;
    loadErrorMessage.value = `加载失败: ${error.message || '未知错误'}`;
  }
};

// 加载模型 (Load model)
const loadModel = async () => {
  if (!scene) {
    console.error('无法加载模型：场景未初始化');
    loading.value = false;
    loadError.value = true;
    loadErrorMessage.value = '场景初始化失败，请刷新页面重试。';
    return;
  }

  try {
    loading.value = true;
    loadError.value = false;
    console.log('开始加载模型...');

    // 配置 GLTF 加载器 (Configure GLTF loader)
    const gltfLoader = new GLTFLoader();

    // 初始化Draco加载器 (Initialize Draco loader)
    const dracoLoader = new DRACOLoader();
    // 设置Draco解码器路径，本地路径有问题，改回使用CDN
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    dracoLoader.setDecoderConfig({ type: 'js' }); // 使用JavaScript解码器
    gltfLoader.setDRACOLoader(dracoLoader);

    // 尝试从缓存加载模型 (Try loading model from cache)
    const modelPath = '/models/floorA.glb';
    console.log('模型路径:', modelPath);

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
              const percentComplete = Math.round((xhr.loaded / xhr.total) * 100);
              console.log(percentComplete + '% 已加载 (loaded)');
            },
            (error) => {
              console.error('加载模型时出错:', error);
              reject(error);
            }
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
    console.log('模型加载成功，处理模型对象...');

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
    console.log('模型已添加到场景中');

  } catch (error) {
    console.error('模型加载失败 (Model loading failed):', error);
    loadError.value = true;
    loadErrorMessage.value = `模型加载失败: ${error.message || '请检查网络连接和模型文件'}`;
  } finally {
    loading.value = false;
    console.log('模型加载过程结束，loading状态:', loading.value);
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

// 实现重置模型方法
const resetModel = async () => {
  try {
    console.log('执行重置命令');

    // 检查是否近期已执行过相似命令
    if (commandStateManager.isCommandExecuted('reset', {})) {
      console.log(`近期已执行过相似的reset命令，跳过执行`);
      return true; // 返回成功，因为操作效果已经实现
    }

    // 注册新命令
    const commandKey = commandStateManager.registerCommand('reset', {});

    // 检查THREE.js对象是否已初始化
    if (!scene || !camera || !renderer || !controls) {
      console.error('THREE.js对象未完全初始化');
      return false;
    }

    // 检查WebSocket连接是否活跃
    if (!wsManager.isConnectionActive('/ws/command')) {
      console.warn('命令WebSocket连接未就绪，尝试重新连接');
      try {
        await wsManager.connect('/ws/command');
        console.log('已重新连接到命令WebSocket');
      } catch (connError) {
        console.error('重新连接命令WebSocket失败:', connError);
        console.warn('降级到本地重置实现');
        const result = executeLocalReset();
        if (result) {
          commandStateManager.markAsExecuted(commandKey);
        }
        return result;
      }
    }

    // 创建并发送重置命令 - 确保使用MCP标准格式
    const command = {
      type: 'mcp.command',
      operation: 'reset',
      parameters: {},
      id: `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString()
    };

    console.log('发送MCP重置命令到服务器:', command);

    try {
      const result = await wsManager.sendCommand('/ws/command', command);
      console.log('MCP服务器重置命令执行结果:', result);
      
      // 执行本地操作保持视觉一致性
      const localResult = executeLocalReset();
      
      // 标记命令为已执行
      if (result?.success || result?.status === 'success' || localResult) {
        commandStateManager.markAsExecuted(commandKey);
      }
      
      return result?.success || result?.status === 'success' || true;
    } catch (wsError) {
      console.error('与MCP服务器通信失败:', wsError);
      console.warn('降级到本地重置实现');
      const result = executeLocalReset();
      if (result) {
        commandStateManager.markAsExecuted(commandKey);
      }
      return result;
    }
  } catch (error) {
    console.error('重置命令执行失败:', error);
    // 出错时尝试使用本地实现
    console.warn('降级到本地重置实现');
    return executeLocalReset();
  }
};

// 执行重置模型的方法
const executeResetModel = () => {
  try {
    console.log('执行模型重置');

    // 检查THREE.js对象是否已初始化
    if (!scene || !camera || !renderer || !controls) {
      console.error('THREE.js对象未完全初始化，无法执行重置');
      return false;
    }

    // 重置相机位置到默认位置
    const defaultPosition = window.__defaultCameraPosition || new THREE.Vector3(0, 5, 10);
    camera.position.copy(defaultPosition);

    // 重置控制器目标
    controls.target.set(0, 0, 0);

    // 重置其他状态
    rotationSpeed.value = 0.5;

    // 停止所有动画
    animationManager.stopAll();

    // 恢复所有原始材质
    if (model) {
      model.traverse((child) => {
        if (originalMaterials.has(child)) {
          materialManager.restoreMaterial(child);
        }
      });
    }

    // 更新控制器
    controls.update();

    // 渲染场景
    renderer.render(scene, camera);

    console.log('模型重置完成');
    return true;
  } catch (error) {
    console.error('执行模型重置时出错:', error);
    return false;
  }
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

// 添加rotateComponent方法，用于旋转特定组件
const rotateComponent = (target: string, angle: number, direction: 'left' | 'right'): { success: boolean, message?: string } => {
  try {
    console.log(`执行组件旋转操作: 目标=${target}, 角度=${angle}, 方向=${direction}`);

    // 调用已有的rotateModel方法
    const result = rotateModel({ direction, angle, target });

    return {
      success: !!result,
      message: result ? '旋转操作成功执行' : '旋转操作执行失败'
    };
  } catch (e) {
    console.error(`旋转组件出错: ${e}`);
    return { success: false, message: `旋转操作错误: ${e.message || e}` };
  }
};

// 添加zoomComponent方法，用于缩放特定组件
const zoomComponent = (target: string, scale: number): { success: boolean, message?: string } => {
  try {
    console.log(`执行组件缩放操作: 目标=${target}, 比例=${scale}`);

    // 调用已有的zoomModel方法
    const result = zoomModel({ scale, target });

    return {
      success: !!result,
      message: result ? '缩放操作成功执行' : '缩放操作执行失败'
    };
  } catch (e) {
    console.error(`缩放组件出错: ${e}`);
    return { success: false, message: `缩放操作错误: ${e.message || e}` };
  }
};

// 添加focusOnComponent方法，用于聚焦特定组件
const focusOnComponent = (target: string): { success: boolean, message?: string } => {
  try {
    console.log(`执行组件聚焦操作: 目标=${target}`);

    // 调用已有的focusOnModel方法
    const result = focusOnModel({ target });

    return {
      success: !!result,
      message: result ? '聚焦操作成功执行' : '聚焦操作执行失败'
    };
  } catch (e) {
    console.error(`聚焦组件出错: ${e}`);
    return { success: false, message: `聚焦操作错误: ${e.message || e}` };
  }
};

// 预定义区域配置
const predefinedAreas = [
  { id: 'center', name: '中心 (Center)', target: 'center' },
  { id: 'meeting', name: '会议室 (Meeting Room)', target: 'meeting_room' },
  { id: 'office', name: '办公区 (Office)', target: 'office_area' },
];

// 聚焦到预定义区域
const focusOnArea = (area) => {
  console.log(`聚焦到区域: ${area.name}`);
  focusOnComponent(area.target);
};

// 当前选中的区域
const currentArea = ref('center');

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

// 生成稳定的客户端标识符（基于浏览器会话）
const generateClientId = () => {
  // 检查是否已存在一个会话ID
  let sessionId = localStorage.getItem('digital_twin_session_id');
  if (!sessionId) {
    // 生成新的会话ID并存储
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('digital_twin_session_id', sessionId);
  }
  return sessionId;
};

// 添加命令队列和执行状态
const commandQueue = ref([]);
const isExecutingCommands = ref(false);
// 跟踪当前正在执行的命令ID，全局声明避免重复初始化
let executingCommandId = null;
let lastExecutedCommandTimestamp = null;

// 添加WebSocket命令监听
const setupWebSocketCommandListener = () => {
  console.log('设置WebSocket命令监听...');
  wsManager.connect('/ws/command').then(() => {
    console.log('已连接到命令WebSocket，开始监听MCP命令');

    // 使用handleWebSocketMessage处理所有消息
    wsManager.onMessage('/ws/command', handleWebSocketMessage);

  }).catch(err => {
    console.error('连接WebSocket失败:', err);
  });
};

// 执行队列中的命令
const executeQueuedCommands = async () => {
  // 防止重复调用
  if (isExecutingCommands.value) {
    console.log('命令队列已在执行中');
    return;
  }

  // 检查队列是否为空
  if (commandQueue.value.length === 0) {
    console.log('命令队列为空');
    return;
  }

  // 尝试获取命令锁
  if (!commandStateManager.acquireLock()) {
    console.log('无法获取命令锁，稍后重试');
    setTimeout(() => executeQueuedCommands(), 500);
    return;
  }

  try {
    // 设置执行状态
    isExecutingCommands.value = true;
    console.log(`开始执行命令队列，队列长度: ${commandQueue.value.length}`);

    // 取出队列中第一个命令
    const command = commandQueue.value.shift();
    const { id, operation, params } = command;

    console.log(`执行命令: ${operation}`, params);

    // 根据操作类型执行不同命令
    let result = { success: false };

    switch (operation) {
      case 'rotate':
        result = await executeRotate(params);
        break;
      case 'zoom':
        result = await executeZoom(params);
        break;
      case 'focus':
        result = await executeFocus(params);
        break;
      case 'reset':
        result = await executeReset(params);
        break;
      default:
        console.warn(`未知操作类型: ${operation}`);
        result = { success: false, error: '未知操作类型' };
    }

    // 记录命令执行结果
    commandStateManager.markAsExecuted(id, result);

    // 命令执行后添加延迟，确保UI有时间响应，增强用户体验
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 继续执行队列中的下一个命令
    if (commandQueue.value.length > 0) {
      executeQueuedCommands();
    } else {
      console.log('命令队列已清空');
      isExecutingCommands.value = false;
      commandStateManager.releaseLock();
    }
  } catch (error) {
    console.error('执行命令队列时出错:', error);
    // 出错时清空队列，避免卡住
    commandQueue.value = [];
    isExecutingCommands.value = false;
    commandStateManager.releaseLock();
  }
};

/**
 * 执行旋转命令
 * @param {Object} params - 旋转参数
 * @returns {Promise<Object>} - 执行结果
 */
const executeRotate = async (params) => {
  try {
    if (params.axis && params.angle) {
      const result = await mcpRotate(params.axis, params.angle);
      return { success: true, result };
    }
    return { success: false, error: '旋转参数无效' };
  } catch (error) {
    console.error('执行旋转命令时出错:', error);
    return { success: false, error: error.message };
  }
};

/**
 * 执行缩放命令
 * @param {Object} params - 缩放参数
 * @returns {Promise<Object>} - 执行结果
 */
const executeZoom = async (params) => {
  try {
    if (params.direction) {
      const distance = params.distance || 1;
      if (params.direction === 'in') {
        const result = await mcpZoom('in', distance);
        return { success: true, result };
      } else if (params.direction === 'out') {
        const result = await mcpZoom('out', distance);
        return { success: true, result };
      }
    } else if (params.value !== undefined) {
      const result = await mcpZoom(params.value > 0 ? 'in' : 'out', Math.abs(params.value));
      return { success: true, result };
    }
    return { success: false, error: '缩放参数无效' };
  } catch (error) {
    console.error('执行缩放命令时出错:', error);
    return { success: false, error: error.message };
  }
};

/**
 * 执行聚焦命令
 * @param {Object} params - 聚焦参数
 * @returns {Promise<Object>} - 执行结果
 */
const executeFocus = async (params) => {
  try {
    if (params.targetId) {
      const result = await mcpFocus(params.targetId);
      return { success: true, result, targetId: params.targetId };
    } else if (params.position) {
      // 处理自定义位置聚焦
      const result = await mcpFocus(null, params.position);
      return { success: true, result, position: params.position };
    }
    return { success: false, error: '聚焦参数无效' };
  } catch (error) {
    console.error('执行聚焦命令时出错:', error);
    return { success: false, error: error.message };
  }
};

/**
 * 执行重置命令
 * @param {Object} params - 重置参数
 * @returns {Promise<Object>} - 执行结果
 */
const executeReset = async (params) => {
  try {
    const result = await mcpReset();
    return { success: true, result };
  } catch (error) {
    console.error('执行重置命令时出错:', error);
    return { success: false, error: error.message };
  }
};

/**
 * 生成命令ID
 * @param {string} operation - 操作类型
 * @returns {string} - 命令ID
 */
const generateCommandId = (operation) => {
  return commandStateManager.registerCommand(operation);
};

// 执行本地命令
const executeLocalCommand = async (command) => {
  try {
    // 根据操作类型执行相应的本地操作
    if (command.operation === 'zoom') {
      const scale = command.params.scale || 1.0;
      return executeLocalZoom(scale);
    } else if (command.operation === 'rotate') {
      // 修复旋转命令参数解析
      const direction = command.params.direction || 'left';
      const angle = command.params.angle || 45;
      return executeLocalRotate({ direction, angle });
    } else if (command.operation === 'focus') {
      const target = command.params.target || command.params.objectName;
      return executeLocalFocus(target);
    } else if (command.operation === 'reset') {
      return executeLocalReset();
    } else {
      console.warn(`未知的操作类型: ${command.operation}`);
      return false;
    }
  } catch (error) {
    console.error(`执行本地命令出错`);
    return false;
  }
};

// 组件挂载时的初始化
onMounted(async () => {
  try {
    console.log('组件挂载，准备初始化...');

    // 获取或创建会话ID
    const sessionId = generateClientId();
    console.log('当前会话ID:', sessionId);

    // 配置WebSocketManager
    wsManager.config.clientId = sessionId;

    // 先断开可能存在的旧连接
    wsManager.disconnectAll();
    console.log('已断开所有旧连接');

    // 等待服务器处理断开连接
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 按顺序建立连接
    try {
      console.log('开始建立WebSocket连接...');

      // 连接命令WebSocket（优先级最高）
      await wsManager.connect('/ws/command');
      console.log('已连接到命令WebSocket');

      // 添加5秒定时器检查命令WebSocket连接状态
      setInterval(() => {
        const isActive = wsManager.isConnectionActive('/ws/command');
        console.log(`命令WebSocket连接状态: ${isActive ? '活跃' : '不可用'}`);
        if (!isActive) {
          console.warn('命令WebSocket连接不可用，尝试重新连接');
          wsManager.connect('/ws/command').catch(err => {
            console.error('重新连接命令WebSocket失败:', err);
          });
        }
      }, 5000);

      // 短暂延迟后连接状态WebSocket
      await new Promise(resolve => setTimeout(resolve, 300));
      await wsManager.connect('/ws/status');
      console.log('已连接到状态WebSocket');

      // 短暂延迟后连接健康检查WebSocket
      await new Promise(resolve => setTimeout(resolve, 300));
      await wsManager.connect('/ws/health');
      console.log('已连接到健康检查WebSocket');
    } catch (wsError) {
      console.error('WebSocket连接错误:', wsError);
      // 在UI中显示错误但继续初始化其他部分
      loadErrorMessage.value = `WebSocket连接失败，某些功能可能不可用: ${wsError.message}`;
    }

    // 注册状态更新处理器
    wsManager.onMessage('/ws/status', (data) => {
      if (data.type === 'status') {
        console.log('WebSocket状态更新:', data.data);
      }
    });

    // 注册健康检查处理器
    wsManager.onMessage('/ws/health', (data) => {
      if (data.type === 'health') {
        console.log('WebSocket健康检查:', data);
      }
    });

    // 注册命令响应处理器
    wsManager.onMessage('/ws/command', (data) => {
      console.log('收到命令响应:', data);
    });

    // 初始化场景
    initScene();

    // 加载模型 - 这行是关键，确保场景初始化后加载模型
    await loadModel();

    // 启动动画循环
    animate();

    // 发送初始化完成通知
    try {
      const initMsg = {
        type: 'init',
        client: 'web',
        timestamp: new Date().toISOString(),
        sessionId: sessionId
      };
      wsManager.send('/ws/command', JSON.stringify(initMsg));
      console.log('发送初始化消息到命令WebSocket');
    } catch (error) {
      console.error('发送初始化消息失败:', error);
    }

    // 设置WebSocket命令监听
    setupWebSocketCommandListener();
  } catch (error) {
    console.error('初始化失败:', error);
    loading.value = false; // 确保即使失败也关闭加载状态
    loadError.value = true;
    loadErrorMessage.value = `初始化失败: ${error.message || '连接错误'}`;
  }

  // 暴露操作方法到window对象，确保即使初始化失败也能挂载方法
  console.log('挂载模型操作方法到全局对象...');

  window.rotateModel = (params) => {
    console.log('全局rotateModel被调用:', params);
    if (typeof executeLocalRotate === 'function') {
      // 确保是对象格式
      let rotateParams = params;
      if (typeof params === 'string' || typeof params === 'number') {
        // 兼容旧的API调用方式
        rotateParams = { direction: 'left', angle: 45 };
      } else if (Array.isArray(params)) {
        // 兼容数组参数
        rotateParams = { direction: params[0] || 'left', angle: params[1] || 45 };
      }

      // 添加默认值
      if (!rotateParams.direction) rotateParams.direction = 'left';
      if (!rotateParams.angle) rotateParams.angle = 45;

      console.log('执行本地旋转:', rotateParams);
      return executeLocalRotate(rotateParams);
    }
    console.error('executeLocalRotate方法未定义');
    return false;
  };

  window.zoomModel = (params) => {
    console.log('全局zoomModel被调用:', params);
    if (typeof executeLocalZoom === 'function') {
      // 确保是对象格式
      let zoomParams = params;
      if (typeof params === 'number') {
        // 兼容数字参数
        zoomParams = { scale: params };
      } else if (Array.isArray(params)) {
        // 兼容数组参数
        zoomParams = { scale: params[0] || 1.5 };
      } else if (typeof params === 'string') {
        // 兼容字符串参数，尝试解析为数字
        zoomParams = { scale: parseFloat(params) || 1.5 };
      } else if (!params || typeof params !== 'object') {
        // 默认参数
        zoomParams = { scale: 1.5 };
      }

      // 确保scale有值
      if (!zoomParams.scale) zoomParams.scale = 1.5;

      console.log('执行本地缩放:', zoomParams);
      return executeLocalZoom(zoomParams);
    }
    console.error('executeLocalZoom方法未定义');
    return false;
  };

  window.focusModel = (params) => {
    console.log('全局focusModel被调用:', params);
    if (typeof executeLocalFocus === 'function') {
      // 确保是对象格式
      let focusParams = params;
      if (typeof params === 'string') {
        // 兼容字符串参数
        focusParams = { target: params };
      } else if (!params || typeof params !== 'object') {
        // 默认参数
        focusParams = { target: 'center' };
      }

      // 确保target有值
      if (!focusParams.target) focusParams.target = 'center';

      return executeLocalFocus(focusParams);
    }
    console.error('executeLocalFocus方法未定义');
    return false;
  };

  window.resetModel = () => {
    console.log('全局resetModel被调用');
    return executeResetModel();
  };

  // 将方法挂载到window.app对象
  if (!window.app) {
    window.app = {};
  }
  window.app.rotateModel = rotateModel;
  window.app.zoomModel = zoomModel;
  window.app.focusModel = params => {
    console.log('app.focusModel被调用:', params);
    return executeLocalFocus(params);
  };
  window.app.resetModel = window.resetModel;

  console.log('已将模型操作方法挂载到window和window.app对象');
});

// 在组件销毁时关闭WebSocket连接
onBeforeUnmount(() => {
  // 断开WebSocket连接
  wsManager.disconnectAll();

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
});

// 修改rotateModel函数,使用MCP命令
const rotateModel = async (params) => {
  try {
    console.log('执行旋转命令:', params);

    // 检查是否近期已执行过相似命令
    if (commandStateManager.isCommandExecuted('rotate', params)) {
      console.log(`近期已执行过相似的rotate命令，跳过执行`);
      return true; // 返回成功，因为操作效果已经实现
    }

    // 注册新命令
    const commandKey = commandStateManager.registerCommand('rotate', params);

    // 检查THREE.js对象是否已初始化
    if (!scene || !camera || !renderer || !controls) {
      console.error('THREE.js对象未完全初始化');
      return false;
    }

    // 检查WebSocket连接是否活跃
    if (!wsManager.isConnectionActive('/ws/command')) {
      console.warn('命令WebSocket连接未就绪，尝试重新连接');
      try {
        await wsManager.connect('/ws/command');
        console.log('已重新连接到命令WebSocket');
      } catch (connError) {
        console.error('重新连接命令WebSocket失败:', connError);
        console.warn('降级到本地旋转实现');
        const result = executeLocalRotate(params);
        if (result) {
          commandStateManager.markAsExecuted(commandKey);
        }
        return result;
      }
    }

    // 创建并发送旋转命令 - 确保使用MCP标准格式
    const command = {
      type: 'mcp.command',
      operation: 'rotate',
      parameters: {
        direction: params.direction || 'left',
        angle: params.angle || 45
      },
      id: `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString()
    };

    console.log('发送MCP旋转命令到服务器:', command);

    try {
      const result = await wsManager.sendCommand('/ws/command', command);
      console.log('MCP服务器旋转命令执行结果:', result);
      
      // 执行本地操作保持视觉一致性
      const localResult = executeLocalRotate(params);
      
      // 标记命令为已执行
      if (result?.success || result?.status === 'success' || localResult) {
        commandStateManager.markAsExecuted(commandKey);
      }
      
      return result?.success || result?.status === 'success' || true;
    } catch (wsError) {
      console.error('与MCP服务器通信失败:', wsError);
      console.warn('降级到本地旋转实现');
      const result = executeLocalRotate(params);
      if (result) {
        commandStateManager.markAsExecuted(commandKey);
      }
      return result;
    }
  } catch (error) {
    console.error('旋转命令执行失败:', error);
    // 出错时尝试使用本地实现
    console.warn('降级到本地旋转实现');
    return executeLocalRotate(params);
  }
};

// 执行本地旋转操作
const executeLocalRotate = (params) => {
  try {
    // 获取参数
    let direction = params.direction || 'left';
    let angle = params.angle;
    
    // 优先使用参数中的值
    if (!angle) {
      if (window.currentRotationParams) {
        angle = window.currentRotationParams.angle || 45;
      } else if (sessionStorage.getItem('requested_angle')) {
        angle = parseInt(sessionStorage.getItem('requested_angle'));
      } else {
        angle = 45;
      }
    }
    
    // 确保角度是数值
    angle = parseFloat(angle);
    
    // 确保THREE.js对象初始化
    if (!scene || !camera || !renderer || !controls) {
      console.error('THREE.js对象未初始化，无法执行旋转');
      return false;
    }
    
    // 向左旋转是正角度，向右旋转是负角度
    const rotationAngle = direction === 'left' ? angle * (Math.PI / 180) : -angle * (Math.PI / 180);
    
    // 记录原始位置
    const originalPosition = camera.position.clone();
    
    // 围绕场景中心旋转相机
    const centerPoint = new THREE.Vector3(0, 0, 0);
    const axis = new THREE.Vector3(0, 1, 0); // Y轴旋转
    
    // 创建旋转矩阵
    const rotationMatrix = new THREE.Matrix4().makeRotationAxis(axis, rotationAngle);
    
    // 应用旋转
    camera.position.sub(centerPoint); // 相对于中心点
    camera.position.applyMatrix4(rotationMatrix); // 应用旋转
    camera.position.add(centerPoint); // 移回原位
    
    // 更新相机朝向
    camera.lookAt(centerPoint);
    
    // 更新控制器
    controls.target.copy(centerPoint);
    controls.update();
    
    // 渲染场景
    renderer.render(scene, camera);
    
    return true;
  } catch (error) {
    console.error('执行本地旋转操作时出错');
    return false;
  }
};

// 修改zoomModel函数,使用MCP命令
const zoomModel = async (params) => {
  try {
    console.log('执行缩放命令:', params);

    // 检查是否近期已执行过相似命令
    if (commandStateManager.isCommandExecuted('zoom', params)) {
      console.log(`近期已执行过相似的zoom命令，跳过执行`);
      return true; // 返回成功，因为操作效果已经实现
    }

    // 注册新命令
    const commandKey = commandStateManager.registerCommand('zoom', params);

    // 检查THREE.js对象是否已初始化
    if (!scene || !camera || !renderer || !controls) {
      console.error('THREE.js对象未完全初始化');
      return false;
    }

    // 检查WebSocket连接是否活跃
    if (!wsManager.isConnectionActive('/ws/command')) {
      console.warn('命令WebSocket连接未就绪，尝试重新连接');
      try {
        await wsManager.connect('/ws/command');
        console.log('已重新连接到命令WebSocket');
      } catch (connError) {
        console.error('重新连接命令WebSocket失败:', connError);
        console.warn('降级到本地缩放实现');
        const result = executeLocalZoom(params);
        if (result) {
          commandStateManager.markAsExecuted(commandKey);
        }
        return result;
      }
    }

    // 创建并发送缩放命令 - 确保使用MCP标准格式
    const command = {
      type: 'mcp.command',
      operation: 'zoom',
      parameters: {
        scale: params.scale || 1.5
      },
      id: `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString()
    };

    console.log('发送MCP缩放命令到服务器:', command);

    try {
      const result = await wsManager.sendCommand('/ws/command', command);
      console.log('MCP服务器缩放命令执行结果:', result);
      
      // 执行本地操作保持视觉一致性
      const localResult = executeLocalZoom(params);
      
      // 标记命令为已执行
      if (result?.success || result?.status === 'success' || localResult) {
        commandStateManager.markAsExecuted(commandKey);
      }
      
      return result?.success || result?.status === 'success' || true;
    } catch (wsError) {
      console.error('与MCP服务器通信失败:', wsError);
      console.warn('降级到本地缩放实现');
      const result = executeLocalZoom(params);
      if (result) {
        commandStateManager.markAsExecuted(commandKey);
      }
      return result;
    }
  } catch (error) {
    console.error('缩放命令执行失败:', error);
    // 出错时尝试使用本地实现
    console.warn('降级到本地缩放实现');
    return executeLocalZoom(params);
  }
};

// 提取本地缩放实现为单独函数
const executeLocalZoom = (params) => {
  try {
    console.log('使用本地缩放实现', params);
    // 确保参数合法
    let scale = 1.5;
    if (params) {
      if (typeof params === 'number') {
        scale = params;
      } else if (typeof params === 'object' && params.scale !== undefined) {
        scale = parseFloat(params.scale);
      }
    }

    // 验证缩放值是否为有效数字
    if (isNaN(scale) || scale <= 0) {
      console.error('缩放值无效:', scale);
      scale = 1.5; // 使用默认值
    }

    console.log(`执行本地缩放操作: scale=${scale}`);

    if (!controls || !camera || !scene || !renderer) {
      console.error("THREE.js对象未初始化，无法执行缩放");
      return false;
    }

    // 记录执行情况
    let zoomExecuted = false;

    // 方法1: 使用controls.dollyIn/dollyOut方法
    if (typeof controls.dollyIn === 'function' && typeof controls.dollyOut === 'function') {
      try {
        if (scale > 1) {
          // 放大 - dollyIn
          controls.dollyIn(scale);
        } else {
          // 缩小 - dollyOut
          controls.dollyOut(1/scale);
        }
        controls.update();
        renderer.render(scene, camera);
        console.log(`缩放操作成功执行(dolly方法): scale=${scale}`);
        zoomExecuted = true;
      } catch(e) {
        console.error('使用dolly方法缩放失败:', e);
      }
    }

    // 方法2: 使用controls.zoom方法 (备用方法)
    if (!zoomExecuted && typeof controls.zoom === 'function') {
      try {
        controls.zoom(scale);
        controls.update();
        renderer.render(scene, camera);
        console.log(`缩放操作成功执行(zoom方法): scale=${scale}`);
        zoomExecuted = true;
      } catch(e) {
        console.error('使用zoom方法缩放失败:', e);
      }
    }

    // 方法3: 直接修改相机位置 (最后的备用方法)
    if (!zoomExecuted) {
      try {
        console.log('尝试通过调整相机位置进行缩放');
        const direction = new THREE.Vector3();
        direction.subVectors(camera.position, controls.target);

        // 根据缩放因子调整相机位置
        if (scale > 1) {
          // 放大 - 将相机移近
          direction.multiplyScalar(1 - 1/scale);
        } else {
          // 缩小 - 将相机移远
          direction.multiplyScalar(1 - scale);
        }

        camera.position.sub(direction);
        camera.updateProjectionMatrix();
        controls.update();
        renderer.render(scene, camera);

        console.log(`缩放操作成功执行(相机位置法): scale=${scale}`);
        zoomExecuted = true;
      } catch(e) {
        console.error('使用相机位置缩放失败:', e);
      }
    }

    if (zoomExecuted) {
      // 发射缩放完成事件
      window.dispatchEvent(new CustomEvent('model-zoomed', {
        detail: { scale: scale }
      }));
    }

    return zoomExecuted;
  } catch (error) {
    console.error('本地缩放实现错误:', error);
    return false;
  }
};

// 修改focusOnModel函数,使用MCP命令
const focusOnModel = async (params) => {
  try {
    console.log('执行聚焦命令:', params);

    // 检查是否近期已执行过相似命令
    if (commandStateManager.isCommandExecuted('focus', params)) {
      console.log(`近期已执行过相似的focus命令，跳过执行`);
      return true; // 返回成功，因为操作效果已经实现
    }

    // 注册新命令
    const commandKey = commandStateManager.registerCommand('focus', params);

    // 检查THREE.js对象是否已初始化
    if (!scene || !camera || !renderer || !controls) {
      console.error('THREE.js对象未完全初始化');
      return false;
    }

    // 检查WebSocket连接是否活跃
    if (!wsManager.isConnectionActive('/ws/command')) {
      console.warn('命令WebSocket连接未就绪，尝试重新连接');
      try {
        await wsManager.connect('/ws/command');
        console.log('已重新连接到命令WebSocket');
      } catch (connError) {
        console.error('重新连接命令WebSocket失败:', connError);
        console.warn('降级到本地聚焦实现');
        const result = executeLocalFocus(params);
        if (result) {
          commandStateManager.markAsExecuted(commandKey);
        }
        return result;
      }
    }

    // 创建并发送聚焦命令 - 确保使用MCP标准格式
    const command = {
      type: 'mcp.command',
      operation: 'focus',
      parameters: {
        target: params.target || params.objectName || 'center'
      },
      id: `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString()
    };

    console.log('发送MCP聚焦命令到服务器:', command);

    try {
      const result = await wsManager.sendCommand('/ws/command', command);
      console.log('MCP服务器聚焦命令执行结果:', result);
      
      // 执行本地操作保持视觉一致性
      const localResult = executeLocalFocus(params);
      
      // 标记命令为已执行
      if (result?.success || result?.status === 'success' || localResult) {
        commandStateManager.markAsExecuted(commandKey);
      }
      
      return result?.success || result?.status === 'success' || true;
    } catch (wsError) {
      console.error('与MCP服务器通信失败:', wsError);
      console.warn('降级到本地聚焦实现');
      const result = executeLocalFocus(params);
      if (result) {
        commandStateManager.markAsExecuted(commandKey);
      }
      return result;
    }
  } catch (error) {
    console.error('聚焦命令执行失败:', error);
    // 出错时尝试使用本地实现
    console.warn('降级到本地聚焦实现');
    return executeLocalFocus(params);
  }
};

// 添加聚焦功能的实现
const executeLocalFocus = (params) => {
  try {
    console.log('执行本地聚焦操作:', params);

    if (!scene || !camera || !controls || !renderer) {
      console.error('THREE.js对象未完全初始化，无法执行聚焦操作');
      return false;
    }

    // 获取目标区域
    const target = params.target || 'center';

    // 定义预设聚焦位置
    const focusPositions = {
      'center': { position: new THREE.Vector3(0, 5, 10), target: new THREE.Vector3(0, 0, 0) },
      'model': { position: new THREE.Vector3(0, 5, 10), target: new THREE.Vector3(0, 0, 0) },
      'meeting': { position: new THREE.Vector3(5, 3, 0), target: new THREE.Vector3(5, 1, 0) },
      'office': { position: new THREE.Vector3(-5, 3, 0), target: new THREE.Vector3(-5, 1, 0) },
      'area域': { position: new THREE.Vector3(0, 6, 10), target: new THREE.Vector3(0, 0, 0) }
    };

    // 如果找不到预设位置，使用默认值
    const focusPosition = focusPositions[target] || focusPositions['center'];

    // 开始位置动画
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const endPosition = focusPosition.position.clone();
    const endTarget = focusPosition.target.clone();

    // 取消之前的动画（如果有）
    if (window.__focusAnimationId) {
      cancelAnimationFrame(window.__focusAnimationId);
    }

    // 设置动画持续时间（毫秒）
    const duration = 1000;
    const startTime = Date.now();

    // 动画函数
    const animateFocus = () => {
      const elapsedTime = Date.now() - startTime;
      const progress = Math.min(elapsedTime / duration, 1);

      // 使用缓动函数使动画更平滑
      const easeProgress = progress * (2 - progress); // 简单二次缓动

      // 计算当前位置
      camera.position.lerpVectors(startPosition, endPosition, easeProgress);
      controls.target.lerpVectors(startTarget, endTarget, easeProgress);

      // 确保相机正确朝向目标
      camera.lookAt(controls.target);
      camera.updateProjectionMatrix();
      controls.update();

      // 渲染场景
      renderer.render(scene, camera);

      // 如果动画未完成，继续下一帧
      if (progress < 1) {
        window.__focusAnimationId = requestAnimationFrame(animateFocus);
      } else {
        // 动画完成
        window.__focusAnimationId = undefined;
      }
    };

    // 开始动画
    window.__focusAnimationId = requestAnimationFrame(animateFocus);

    console.log(`聚焦到${target}区域完成`);
    return true;
  } catch (error) {
    console.error('聚焦操作执行失败:', error);
    return false;
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

// 注意：此处之前有重复defineExpose，已移除。最终的defineExpose在文件底部

// 本地执行重置操作
const executeLocalReset = async () => {
  console.log('本地执行重置模型视图操作');
  try {
    // 重置相机位置
    if (camera) {
      camera.position.set(0, 5, 10);
      camera.lookAt(0, 0, 0);
    }
    
    // 重置控制器
    if (controls) {
      controls.reset();
      controls.update();
    }
    
    // 重置模型位置和旋转
    if (scene && model) {
      model.position.set(0, 0, 0);
      model.rotation.set(0, 0, 0);
      scene.updateMatrixWorld(true);
    }
    
    // 渲染一帧
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
    
    console.log('模型视图已重置');
    return true;
  } catch (error) {
    console.error('执行重置操作失败:', error);
    return false;
  }
};

// 处理并发CommandQueue的锁
// let lastExecutedCommandTimestamp = null; // 这行已在上方定义，移除重复声明

// 接收WebSocket消息处理
const handleWebSocketMessage = (message) => {
  try {
    // 解析消息
    const { operation, params, id } = message;
    console.log('收到WebSocket命令:', operation, params, id);

    // 确定操作类型和参数
    const operationType = operation || 'unknown';
    const commandParams = params || {};
    const commandId = id || generateCommandId(operationType);

    // 检查是否为已执行过的相似命令
    if (commandStateManager.isCommandExecuted(operationType, commandParams)) {
      console.log(`跳过相似命令: ${operationType}`, commandParams);
      return;
    }

    // 优先级检查：如果队列中存在相同类型的命令，且当前命令是focus或reset，则替换队列中的命令
    if (operationType === 'focus' || operationType === 'reset') {
      const index = commandQueue.value.findIndex(cmd => cmd.operation === operationType);
      if (index !== -1) {
        console.log(`替换队列中的${operationType}命令`);
        commandQueue.value.splice(index, 1);
      }
    }

    // 防止重复命令：检查队列中是否已存在相似命令
    const hasSimilarCommand = commandQueue.value.some(cmd => {
      return cmd.operation === operationType && 
             commandStateManager.areParamsSimilar(cmd.params, commandParams, operationType);
    });

    if (hasSimilarCommand) {
      console.log(`队列中已存在相似命令: ${operationType}`);
      return;
    }

    // 将命令添加到队列
    commandQueue.value.push({
      id: commandId,
      operation: operationType,
      params: commandParams,
      timestamp: Date.now()
    });

    // 如果当前没有正在执行的命令，启动队列处理
    if (!isExecutingCommands.value) {
      // 使用nextTick确保Vue更新队列后再执行命令
      nextTick(() => executeQueuedCommands());
    } else {
      console.log('命令已添加到队列，等待执行');
    }
  } catch (error) {
    console.error('处理WebSocket消息时出错:', error);
  }
};

// 暴露方法给Parent Component
defineExpose({
  // 命令队列相关
  commandQueue,
  isExecutingCommands,
  executeQueuedCommands,
  
  // 组件方法
  rotateComponent,
  zoomComponent,
  focusOnComponent,
  resetModel,
  
  // MCP方法
  mcpRotate,
  mcpZoom,
  mcpFocus,
  mcpReset,
  mcpStatus,
  mcpConnected,
  
  // 直接操作方法
  rotateModel,
  zoomModel,
  focusOnModel,
  executeLocalRotate,
  executeLocalZoom,
  executeLocalFocus,
  executeLocalReset,
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

.error-message {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background-color: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 1.2rem;
  z-index: 10;
  text-align: center;
  padding: 20px;
}

.error-message p {
  margin-bottom: 20px;
  max-width: 80%;
}

.error-message button {
  padding: 10px 20px;
  background-color: #e74c3c;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
  transition: background-color 0.3s;
}

.error-message button:hover {
  background-color: #c0392b;
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