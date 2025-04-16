/**
 * 命令状态管理器
 * 用于记录命令执行状态、防止重复执行和命令冲突
 */
export default class CommandStateManager {
  constructor(options = {}) {
    // 配置项
    this.options = {
      // 记录保留时间（毫秒）
      recordTTL: options.recordTTL || 5000,
      // 相似参数阈值
      similarityThreshold: options.similarityThreshold || 0.8,
      ...options
    };

    // 已执行命令记录
    this.executedCommands = {};
    // 待处理命令记录
    this.pendingCommands = {};
    // 命令锁状态
    this.locked = false;
    // 锁定时间戳
    this.lockTimestamp = null;
    // 自动清理锁的超时ID
    this.lockTimeoutId = null;
    // 最大锁定时间（毫秒）
    this.maxLockTime = options.maxLockTime || 10000;

    // 设置清理间隔
    this.setupCleanupInterval();
  }

  /**
   * 设置定期清理已过期命令记录的定时器
   */
  setupCleanupInterval() {
    // 每5秒执行一次清理
    setInterval(() => this.cleanupExpiredRecords(), 5000);
  }

  /**
   * 清理已过期的命令记录
   */
  cleanupExpiredRecords() {
    const now = Date.now();
    
    // 清理已执行命令记录
    Object.keys(this.executedCommands).forEach(key => {
      const record = this.executedCommands[key];
      if (now - record.timestamp > this.options.recordTTL) {
        delete this.executedCommands[key];
      }
    });

    // 清理待处理命令记录
    Object.keys(this.pendingCommands).forEach(key => {
      const record = this.pendingCommands[key];
      if (now - record.timestamp > this.options.recordTTL) {
        delete this.pendingCommands[key];
      }
    });

    // 清理过期的锁
    if (this.locked && (now - this.lockTimestamp > this.maxLockTime)) {
      console.warn('命令锁已超时，强制释放');
      this.releaseLock();
    }
  }

  /**
   * 注册一个待执行的命令
   * @param {string} operation 操作类型
   * @param {object} params 参数
   * @returns {string} 命令唯一标识
   */
  registerCommand(operation, params = {}) {
    const commandId = `${operation}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    
    this.pendingCommands[commandId] = {
      operation,
      params,
      timestamp: Date.now()
    };
    
    return commandId;
  }

  /**
   * 标记命令为已执行
   * @param {string} commandId 命令ID
   * @param {object} result 执行结果
   */
  markAsExecuted(commandId, result = {}) {
    const pendingCommand = this.pendingCommands[commandId];
    
    if (!pendingCommand && !commandId.includes('-')) {
      // 如果是简单的操作类型，直接创建一个记录
      const [operation] = commandId.split('-');
      this.executedCommands[commandId] = {
        operation,
        timestamp: Date.now(),
        result
      };
      return;
    }
    
    if (pendingCommand) {
      // 移动到已执行记录
      this.executedCommands[commandId] = {
        ...pendingCommand,
        timestamp: Date.now(), // 更新时间戳
        result
      };
      
      // 删除待处理记录
      delete this.pendingCommands[commandId];
    } else {
      console.warn(`找不到待处理命令: ${commandId}`);
      
      // 尝试从ID提取操作类型
      const parts = commandId.split('-');
      if (parts.length > 0) {
        this.executedCommands[commandId] = {
          operation: parts[0],
          timestamp: Date.now(),
          result
        };
      }
    }
  }

  /**
   * 检查是否近期已执行过相似命令
   * @param {string} operation 操作类型
   * @param {object} params 参数
   * @returns {boolean} 是否存在相似命令
   */
  isCommandExecuted(operation, params = {}) {
    const now = Date.now();
    
    // 找出最近执行的相同类型命令
    const recentCommands = Object.values(this.executedCommands)
      .filter(cmd => 
        cmd.operation === operation && 
        now - cmd.timestamp < this.options.recordTTL
      );
    
    // 检查是否有参数相似的命令
    return recentCommands.some(cmd => 
      this.areParamsSimilar(cmd.params, params, operation)
    );
  }

  /**
   * 比较两个参数对象的相似度
   * @param {object} params1 参数1
   * @param {object} params2 参数2
   * @param {string} operation 操作类型，用于特定操作的特殊比较逻辑
   * @returns {boolean} 是否相似
   */
  areParamsSimilar(params1 = {}, params2 = {}, operation = '') {
    // 处理空参数情况
    if (!params1 || !params2) return false;
    if (Object.keys(params1).length === 0 && Object.keys(params2).length === 0) return true;
    
    // 不同操作类型的特殊比较逻辑
    switch (operation) {
      case 'focus':
        // focus命令比较目标ID
        if (params1.targetId && params2.targetId) {
          return params1.targetId === params2.targetId;
        }
        if (params1.position && params2.position) {
          return this.arePositionsSimilar(params1.position, params2.position);
        }
        return false;
        
      case 'zoom':
        // zoom命令比较方向和距离
        if (params1.direction && params2.direction) {
          // 方向相同且距离相似
          return params1.direction === params2.direction &&
                (Math.abs(params1.distance - params2.distance) < 0.3);
        }
        if (params1.value && params2.value) {
          // 值相似
          return Math.abs(params1.value - params2.value) < 0.3;
        }
        return false;
        
      case 'rotate':
        // rotate命令比较轴和角度
        if (params1.axis && params2.axis && params1.angle && params2.angle) {
          return params1.axis === params2.axis &&
                 Math.abs(params1.angle - params2.angle) < 15; // 角度差小于15度
        }
        return false;
        
      case 'reset':
        // reset命令通常没有参数或参数不重要
        return true;
        
      default:
        // 默认参数比较
        return this.calculateParamSimilarity(params1, params2) >= this.options.similarityThreshold;
    }
  }

  /**
   * 比较两个位置是否相似
   * @param {object|array} pos1 位置1
   * @param {object|array} pos2 位置2
   * @returns {boolean} 是否相似
   */
  arePositionsSimilar(pos1, pos2) {
    // 处理数组形式的位置
    if (Array.isArray(pos1) && Array.isArray(pos2)) {
      if (pos1.length !== pos2.length) return false;
      
      // 计算欧几里得距离
      let sumSquaredDiff = 0;
      for (let i = 0; i < pos1.length; i++) {
        sumSquaredDiff += Math.pow(pos1[i] - pos2[i], 2);
      }
      const distance = Math.sqrt(sumSquaredDiff);
      
      // 距离小于阈值则认为相似
      return distance < 1.0;
    }
    
    // 处理对象形式的位置
    if (typeof pos1 === 'object' && typeof pos2 === 'object') {
      const x1 = pos1.x || 0;
      const y1 = pos1.y || 0;
      const z1 = pos1.z || 0;
      
      const x2 = pos2.x || 0;
      const y2 = pos2.y || 0;
      const z2 = pos2.z || 0;
      
      const distance = Math.sqrt(
        Math.pow(x1 - x2, 2) + 
        Math.pow(y1 - y2, 2) + 
        Math.pow(z1 - z2, 2)
      );
      
      return distance < 1.0;
    }
    
    return false;
  }

  /**
   * 计算两个参数对象的相似度
   * @param {object} params1 参数1
   * @param {object} params2 参数2
   * @returns {number} 相似度 (0-1)
   */
  calculateParamSimilarity(params1, params2) {
    const keys1 = Object.keys(params1);
    const keys2 = Object.keys(params2);
    
    // 无参数情况
    if (keys1.length === 0 && keys2.length === 0) return 1.0;
    if (keys1.length === 0 || keys2.length === 0) return 0.0;
    
    // 计算交集
    const commonKeys = keys1.filter(key => keys2.includes(key));
    
    // 计算Jaccard系数
    const unionSize = new Set([...keys1, ...keys2]).size;
    const keysSimilarity = commonKeys.length / unionSize;
    
    // 计算值相似度
    let valuesSimilarity = 0;
    if (commonKeys.length > 0) {
      // 对公共键的值进行比较
      let matchingValues = 0;
      for (const key of commonKeys) {
        if (this.areValuesSimilar(params1[key], params2[key])) {
          matchingValues++;
        }
      }
      valuesSimilarity = matchingValues / commonKeys.length;
    }
    
    // 综合键和值的相似度
    return (keysSimilarity * 0.4) + (valuesSimilarity * 0.6);
  }

  /**
   * 比较两个值是否相似
   * @param {any} val1 值1
   * @param {any} val2 值2
   * @returns {boolean} 是否相似
   */
  areValuesSimilar(val1, val2) {
    // 类型不同
    if (typeof val1 !== typeof val2) return false;
    
    // 处理不同类型的值
    switch (typeof val1) {
      case 'number':
        return Math.abs(val1 - val2) < 0.3 * Math.max(Math.abs(val1), Math.abs(val2));
        
      case 'string':
        return val1 === val2;
        
      case 'boolean':
        return val1 === val2;
        
      case 'object':
        if (val1 === null || val2 === null) return val1 === val2;
        
        if (Array.isArray(val1) && Array.isArray(val2)) {
          if (val1.length !== val2.length) return false;
          
          // 对数组内容进行比较
          for (let i = 0; i < val1.length; i++) {
            if (!this.areValuesSimilar(val1[i], val2[i])) return false;
          }
          return true;
        }
        
        // 对对象递归计算相似度
        return this.calculateParamSimilarity(val1, val2) >= this.options.similarityThreshold;
        
      default:
        return val1 === val2;
    }
  }

  /**
   * 获取命令执行锁
   * @returns {boolean} 是否成功获取锁
   */
  acquireLock() {
    if (this.locked) {
      // 检查锁是否过期
      const now = Date.now();
      if (now - this.lockTimestamp > this.maxLockTime) {
        console.warn('发现过期的命令锁，强制释放');
        this.releaseLock();
      } else {
        return false;
      }
    }
    
    this.locked = true;
    this.lockTimestamp = Date.now();
    
    // 设置自动释放锁的安全机制
    this.lockTimeoutId = setTimeout(() => {
      console.warn('命令锁超时，自动释放');
      this.releaseLock();
    }, this.maxLockTime);
    
    return true;
  }

  /**
   * 释放命令执行锁
   */
  releaseLock() {
    this.locked = false;
    this.lockTimestamp = null;
    
    // 清除自动释放锁的定时器
    if (this.lockTimeoutId) {
      clearTimeout(this.lockTimeoutId);
      this.lockTimeoutId = null;
    }
  }

  /**
   * 重置状态管理器
   */
  reset() {
    this.executedCommands = {};
    this.pendingCommands = {};
    this.releaseLock();
  }
} 