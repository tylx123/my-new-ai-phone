export default async function handler(req, res) {
  // 允许跨域请求，适配前端所有请求
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 处理浏览器预检OPTIONS请求，避免跨域报错
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 仅支持POST请求，符合接口规范
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { platform, apiKey, model, messages, apiUrl, action } = req.body;

    // 基础校验：API Key不能为空
    if (!apiKey) {
      return res.status(400).json({ error: '缺少必要参数: API Key' });
    }

    // 处理【拉取模型】和【测试链接】的特殊请求（带action字段）
    if (action === 'fetchModels' || action === 'testConnection') {
      if (platform !== 'custom-openai' || !apiUrl) {
        return res.status(400).json({ error: '拉取模型/测试链接仅支持自定义OpenAI协议，且需填写API地址' });
      }
      const targetUrl = `${apiUrl}/models`;
      return await forwardRequest(req, res, targetUrl, {}, 'GET');
    }

    // 处理【发送消息】请求：校验model和messages
    if (!model || !messages) {
      return res.status(400).json({ error: '缺少必要参数: model 或 messages' });
    }

    let targetUrl;
    let requestBody;
    // 自定义OpenAI平台：用用户填写的apiUrl拼接转发地址
    if (platform === 'custom-openai') {
      if (!apiUrl) {
        return res.status(400).json({ error: '自定义OpenAI平台需要提供API接口地址' });
      }
      targetUrl = `${apiUrl}/chat/completions`;
      requestBody = { model: model, messages: messages }; // 标准OpenAI请求体
    } else {
      // 内置平台（OpenAI/豆包/DeepSeek/OpenRouter）：固定转发地址
      const platformConfig = {
        openai: { url: 'https://api.openai.com/v1/chat/completions', body: { model, messages } },
        doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', body: { model, messages } },
        deepseek: { url: 'https://api.deepseek.com/chat/completions', body: { model, messages } },
        openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', body: { model, messages } }
      };
      const config = platformConfig[platform];
      if (!config) {
        return res.status(400).json({ error: '不支持的模型平台' });
      }
      targetUrl = config.url;
      requestBody = config.body;
    }

    // 转发发送消息的请求
    return await forwardRequest(req, res, targetUrl, requestBody, 'POST');

  } catch (error) {
    console.error('后端转发请求失败:', error);
    return res.status(500).json({ error: '内部服务器错误: ' + error.message });
  }
}

// 封装转发请求的通用函数，复用GET/POST逻辑
async function forwardRequest(req, res, targetUrl, body, method) {
  const { apiKey } = req.body;
  try {
    const response = await fetch(targetUrl, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined
    });

    // 目标平台返回错误时，透传错误信息给前端
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '目标平台返回未知错误' }));
      return res.status(response.status).json(errorData);
    }

    // 转发成功，透传目标平台的响应给前端
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('转发请求失败:', error);
    return res.status(500).json({ error: '转发请求失败: ' + error.message });
  }
}
