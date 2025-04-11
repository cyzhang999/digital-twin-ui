// 处理聊天操作
function handleChatAction(action) {
  console.log('收到聊天操作:', action);
  
  if (action.type === 'rotate' || action.operation === 'rotate') {
    const direction = action.parameters?.direction || 'left';
    const angle = action.parameters?.angle || 30;
    
    console.log(`执行旋转操作: 方向=${direction}, 角度=${angle}`);
    
    if (typeof window.rotateModel === 'function') {
      const result = window.rotateModel(direction, angle);
      if (result) {
        // 只发送成功消息，不发送错误消息
        addMessage('AI助手', `成功执行rotate操作`, 'success');
      }
    } else {
      console.error('ModelViewer组件的rotateModel方法未找到');
    }
  }
  // ... 其他操作类型处理 ...
} 