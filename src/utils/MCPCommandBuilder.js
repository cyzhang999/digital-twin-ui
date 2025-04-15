/**
 * MCP命令构建器
 * (MCP Command Builder)
 * 
 * 提供标准化的MCP命令构建方法
 */

export class MCPCommandBuilder {
  constructor() {
    this._reset();
  }

  /**
   * 重置命令对象
   * (Reset command object)
   * @private
   */
  _reset() {
    // 生成唯一ID
    const generateCommandId = () => {
      return `cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    };
    
    this._command = {
      id: generateCommandId(),
      action: '',
      parameters: {},
      timestamp: new Date().toISOString()
    };
    return this;
  }

  /**
   * 构建旋转命令
   * (Build rotate command)
   * @param {string} direction - 旋转方向(left, right, up, down)
   * @param {number} angle - 旋转角度
   * @param {string} [target] - 目标对象(可选)
   * @returns {Object} MCP命令对象
   */
  rotate(direction, angle, target = null) {
    this._reset();
    this._command.action = 'rotate';
    this._command.parameters = { direction, angle };
    if (target) this._command.target = target;
    return this.wrap();
  }

  /**
   * 构建缩放命令
   * (Build zoom command)
   * @param {number} scale - 缩放比例
   * @param {string} [target] - 目标对象(可选)
   * @returns {Object} MCP命令对象
   */
  zoom(scale, target = null) {
    this._reset();
    this._command.action = 'zoom';
    this._command.parameters = { scale };
    if (target) this._command.target = target;
    return this.wrap();
  }

  /**
   * 构建聚焦命令
   * (Build focus command)
   * @param {string} target - 目标对象
   * @returns {Object} MCP命令对象
   */
  focus(target) {
    this._reset();
    this._command.action = 'focus';
    this._command.parameters = { target };
    return this.wrap();
  }

  /**
   * 构建重置命令
   * (Build reset command)
   * @returns {Object} MCP命令对象
   */
  reset() {
    this._reset();
    this._command.action = 'reset';
    this._command.parameters = {};
    return this.wrap();
  }

  /**
   * 构建高亮命令
   * (Build highlight command)
   * @param {string} target - 目标对象
   * @param {string} [color] - 高亮颜色
   * @returns {Object} MCP命令对象
   */
  highlight(target, color = '#FF0000') {
    this._reset();
    this._command.action = 'highlight';
    this._command.parameters = { target, color };
    return this.wrap();
  }

  /**
   * 构建执行JavaScript命令
   * (Build execute JavaScript command)
   * @param {string} script - 要执行的JavaScript代码
   * @returns {Object} MCP命令对象
   */
  executeJS(script) {
    this._reset();
    this._command.action = 'execute_js';
    this._command.parameters = { script };
    return this.wrap();
  }

  /**
   * 构建批量命令
   * (Build batch command)
   * @param {Array} commands - 命令列表
   * @returns {Object} MCP命令对象
   */
  batch(commands) {
    this._reset();
    this._command.action = 'batch';
    this._command.parameters = { commands };
    return this.wrap();
  }

  /**
   * 构建移动命令
   * (Build move command)
   * @param {string} target - 目标对象
   * @param {Object} position - 新位置{x, y, z}
   * @returns {Object} MCP命令对象
   */
  move(target, position) {
    this._reset();
    this._command.action = 'move';
    this._command.parameters = { position };
    this._command.target = target;
    return this.wrap();
  }

  /**
   * 构建快照命令
   * (Build snapshot command)
   * @param {string} [filename] - 文件名(可选)
   * @returns {Object} MCP命令对象
   */
  snapshot(filename = null) {
    this._reset();
    this._command.action = 'snapshot';
    if (filename) this._command.parameters = { filename };
    return this.wrap();
  }

  /**
   * 构建加载模型命令
   * (Build load model command)
   * @param {string} modelPath - 模型路径
   * @param {Object} [options] - 加载选项
   * @returns {Object} MCP命令对象
   */
  loadModel(modelPath, options = {}) {
    this._reset();
    this._command.action = 'load_model';
    this._command.parameters = { modelPath, ...options };
    return this.wrap();
  }

  /**
   * 构建设置命令
   * (Build settings command)
   * @param {Object} settings - 设置对象
   * @returns {Object} MCP命令对象
   */
  settings(settings) {
    this._reset();
    this._command.action = 'settings';
    this._command.parameters = settings;
    return this.wrap();
  }

  /**
   * 构建显示/隐藏命令
   * (Build toggle visibility command)
   * @param {string} target - 目标对象
   * @param {boolean} visible - 可见性
   * @returns {Object} MCP命令对象
   */
  toggleVisibility(target, visible) {
    this._reset();
    this._command.action = 'toggle_visibility';
    this._command.parameters = { visible };
    this._command.target = target;
    return this.wrap();
  }

  /**
   * 构建动画命令
   * (Build animate command)
   * @param {string} target - 目标对象
   * @param {string} animation - 动画名称
   * @returns {Object} MCP命令对象
   */
  animate(target, animation) {
    this._reset();
    this._command.action = 'animate';
    this._command.parameters = { animation };
    this._command.target = target;
    return this.wrap();
  }

  /**
   * 构建状态查询命令
   * (Build state query command)
   * @param {string} [target] - 目标对象(可选)
   * @returns {Object} MCP命令对象
   */
  queryState(target = null) {
    this._reset();
    this._command.action = 'query_state';
    if (target) this._command.target = target;
    return this.wrap();
  }

  /**
   * 将命令包装为标准MCP协议消息
   * @returns {Object} MCP协议消息
   */
  wrap() {
    return {
      type: 'mcp.command',
      id: this._command.id || `cmd_${Date.now()}`,
      action: this._command.action,
      parameters: this._command.parameters || {},
      target: this._command.target,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 与WebSocketManager一起使用，发送命令
   * (Use with WebSocketManager to send command)
   * @param {WebSocketManager} wsManager - WebSocket管理器实例
   * @returns {Promise} 发送命令的Promise
   */
  sendWith(wsManager) {
    if (!wsManager || typeof wsManager.sendMCPCommand !== 'function') {
      throw new Error('无效的WebSocketManager实例');
    }
    return wsManager.sendMCPCommand(this.wrap());
  }
}

/**
 * 创建并返回MCPCommandBuilder实例
 * (Create and return MCPCommandBuilder instance)
 * @returns {MCPCommandBuilder} 命令构建器实例
 */
export function createMCPCommandBuilder() {
  return new MCPCommandBuilder();
}

// 创建一个单例实例，便于导入使用
export const mcpCommandBuilder = new MCPCommandBuilder();

// 默认导出
export default MCPCommandBuilder; 