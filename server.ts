import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import db from './db';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

// Initialize Gemini (Default)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// OpenAI Compatible Client Helper
async function generateWithOpenAI(apiKey: string, baseURL: string, model: string, messages: any[], temperature: number = 0.7) {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '');
  const url = `${normalizedBaseURL}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature
    })
  });
  
  if (!response.ok) {
    const status = response.status;
    const errText = await response.text();
    let errorMessage = errText;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.error) {
        errorMessage = errJson.error.message || JSON.stringify(errJson.error);
      } else if (errJson.message) {
        errorMessage = errJson.message;
      }
    } catch (e) {}
    throw new Error(`[HTTP ${status}] ${errorMessage}`);
  }
  
  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error("API 响应格式错误: 缺少 choices");
  }
  return data.choices[0].message.content;
}

async function describeImage(apiKey: string, model: string, base64Image: string) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: model || 'gemini-3-flash-preview',
    contents: [
      {
        parts: [
          { text: "请详细描述这张图片的内容，包括主体、动作、环境、氛围等。如果是表情包，请解释其含义。请用中文回答。" },
          {
            inlineData: {
              mimeType: "image/png",
              data: base64Image.split(',')[1] || base64Image
            }
          }
        ]
      }
    ]
  });
  return response.text;
}

async function generateImage(apiKey: string, model: string, prompt: string) {
  const ai = new GoogleGenAI({ apiKey });
  const size = model?.includes('2k') ? "2K" : (model?.includes('4k') ? "4K" : "1K");
  const response = await ai.models.generateContent({
    model: model || 'gemini-2.5-flash-image',
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      imageConfig: {
        aspectRatio: "1:1",
        imageSize: size as any
      }
    }
  });
  
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  return null;
}

async function generateImageWithOpenAI(apiKey: string, baseURL: string, model: string, prompt: string) {
  const normalizedBaseURL = baseURL.replace(/\/+$/, '');
  const url = `${normalizedBaseURL}/images/generations`;
  
  const bodies = [
    { model, prompt, n: 1, size: "1024x1024", response_format: 'b64_json' },
    { model, prompt, n: 1, response_format: 'b64_json' },
    { model, prompt, n: 1 }
  ];

  let lastError = null;
  let lastStatus = 0;

  for (const body of bodies) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.data && data.data[0]) {
          const imageData = data.data[0];
          if (imageData.b64_json) return `data:image/png;base64,${imageData.b64_json}`;
          if (imageData.url) return imageData.url;
        }
      } else {
        lastStatus = response.status;
        lastError = await response.text();
        // If it's a 401 or 404, don't bother retrying with different body
        if (lastStatus === 401 || lastStatus === 404) break;
      }
    } catch (e: any) {
      lastError = e.message;
    }
  }

  let errorMessage = lastError || "未知错误";
  try {
    const errJson = JSON.parse(lastError);
    if (errJson.error) {
      errorMessage = errJson.error.message || JSON.stringify(errJson.error);
      if (errJson.error.code === 'bad_response_status_code' || errorMessage.includes('openai_error')) {
        errorMessage = `上游服务器错误 (Bad Response). 请确保模型名称 "${model}" 正确，且 API Key 余额充足并支持生图。`;
      }
    }
  } catch (e) {}

  throw new Error(`[HTTP ${lastStatus}] ${errorMessage}`);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // --- API Routes ---

  // Get Settings
  app.get('/api/settings', (req, res) => {
    const settings = db.prepare('SELECT * FROM settings').all();
    const settingsMap: any = {};
    settings.forEach((s: any) => settingsMap[s.key] = s.value);
    res.json(settingsMap);
  });

  // Test Connection
  app.post('/api/test-connection', async (req, res) => {
    const { url, key, model, type } = req.body;
    try {
      if (type === 'image') {
        // Use a more descriptive prompt for image testing
        const result = await generateImageWithOpenAI(key, url, model, "A beautiful digital art piece of a futuristic city with neon lights, high resolution, detailed");
        if (result) return res.json({ success: true, message: '连接成功！已生成测试图片。' });
      } else {
        const result = await generateWithOpenAI(key, url, model, [{ role: 'user', content: 'hi' }]);
        if (result) return res.json({ success: true, message: '连接成功！' });
      }
      res.json({ success: false, message: '连接失败：未知错误' });
    } catch (e: any) {
      res.json({ success: false, message: `${e.message}` });
    }
  });

  // Update Settings
  app.post('/api/settings', (req, res) => {
    const { 
        chat_api_url, chat_api_key, chat_model,
        vision_api_url, vision_api_key, vision_model,
        image_api_url, image_api_key, image_model,
        user_name, user_gender, user_bio, user_avatar, user_background 
    } = req.body;
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    if (chat_api_url !== undefined) stmt.run('chat_api_url', chat_api_url);
    if (chat_api_key !== undefined) stmt.run('chat_api_key', chat_api_key);
    if (chat_model !== undefined) stmt.run('chat_model', chat_model);
    if (vision_api_url !== undefined) stmt.run('vision_api_url', vision_api_url);
    if (vision_api_key !== undefined) stmt.run('vision_api_key', vision_api_key);
    if (vision_model !== undefined) stmt.run('vision_model', vision_model);
    if (image_api_url !== undefined) stmt.run('image_api_url', image_api_url);
    if (image_api_key !== undefined) stmt.run('image_api_key', image_api_key);
    if (image_model !== undefined) stmt.run('image_model', image_model);
    if (user_name !== undefined) stmt.run('user_name', user_name);
    if (user_gender !== undefined) stmt.run('user_gender', user_gender);
    if (user_bio !== undefined) stmt.run('user_bio', user_bio);
    if (user_avatar !== undefined) stmt.run('user_avatar', user_avatar);
    if (user_background !== undefined) stmt.run('user_background', user_background);
    res.json({ success: true });
  });

  // Mark messages as read
  app.post('/api/messages/:chatId/read', (req, res) => {
    const { chatId } = req.params;
    db.prepare("UPDATE messages SET status = 'read' WHERE character_id = ? AND sender_id != 'user' AND status = 'sent'").run(chatId);
    res.json({ success: true });
  });

  // Get all characters
  app.get('/api/characters', (req, res) => {
    const characters = db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all();
    // Get last message for each character to show in list
    const charsWithLastMsg = characters.map((char: any) => {
      const lastMsg = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp DESC LIMIT 1').get(char.id);
      return { ...char, lastMessage: lastMsg };
    });
    res.json(charsWithLastMsg);
  });

  // Create character or group
  app.post('/api/characters', (req, res) => {
    const { name, avatar, bio, personality, gender, other_info, background, relationship, is_group, members, reply_strategy } = req.body;
    const id = uuidv4();
    
    const stmt = db.prepare('INSERT INTO characters (id, name, avatar, bio, personality, gender, other_info, background, relationship, is_group, reply_strategy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    stmt.run(id, name, avatar, bio || '', personality || '', gender || '', other_info || '', background || '', relationship || 'Friend', is_group ? 1 : 0, reply_strategy || 'normal');

    if (is_group && members && Array.isArray(members)) {
      const memberStmt = db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)');
      members.forEach((memberId: string) => {
        memberStmt.run(id, memberId);
      });
    }

    res.json({ id, name, avatar, bio, personality, gender, other_info, background, relationship, is_group });
  });

  // Update character
  app.put('/api/characters/:id', (req, res) => {
    const { id } = req.params;
    const { name, avatar, bio, personality, gender, other_info, background, relationship, members, reply_mode, reply_strategy } = req.body;
    
    // Update character table
    const stmt = db.prepare('UPDATE characters SET name = ?, avatar = ?, bio = ?, personality = ?, gender = ?, other_info = ?, background = ?, relationship = ?, reply_mode = ?, reply_strategy = ? WHERE id = ?');
    stmt.run(name, avatar, bio, personality, gender || '', other_info || '', background || '', relationship || 'Friend', reply_mode || 'natural', reply_strategy || 'normal', id);

    // If it's a group, update members
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as any;
    if (character.is_group && members && Array.isArray(members)) {
      // 1. Remove all existing members
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
      // 2. Add new members
      const memberStmt = db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)');
      members.forEach((memberId: string) => {
        memberStmt.run(id, memberId);
      });
    }

    res.json({ success: true });
  });

  // Get group members
  app.get('/api/characters/:id/members', (req, res) => {
    const { id } = req.params;
    const members = db.prepare(`
      SELECT c.* FROM characters c
      JOIN group_members gm ON c.id = gm.character_id
      WHERE gm.group_id = ?
    `).all(id);
    res.json(members);
  });

  // Delete character or group
  app.delete('/api/characters/:id', (req, res) => {
    const { id } = req.params;
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as any;

    if (character.is_group) {
      // Delete group members first
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    }
    // Delete messages
    db.prepare('DELETE FROM messages WHERE character_id = ?').run(id);
    // Delete stickers
    db.prepare('DELETE FROM stickers WHERE owner_id = ?').run(id);
    // Delete character
    db.prepare('DELETE FROM characters WHERE id = ?').run(id);

    res.status(204).send();
  });

  // Get messages for a chat (character or group)
  app.get('/api/messages/:chatId', (req, res) => {
    const { chatId } = req.params;
    const messages = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp ASC').all(chatId);
    res.json(messages);
  });

  // Get stickers for an owner
  app.get('/api/stickers/:ownerId', (req, res) => {
    const { ownerId } = req.params;
    const stickers = db.prepare('SELECT * FROM stickers WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
    res.json(stickers);
  });

  // Add a sticker
  app.post('/api/stickers', (req, res) => {
    const { ownerId, url, description } = req.body;
    if (!ownerId || !url) {
      return res.status(400).json({ error: 'ownerId and url are required' });
    }
    const id = uuidv4();
    db.prepare('INSERT INTO stickers (id, owner_id, url, description) VALUES (?, ?, ?, ?)')
      .run(id, ownerId, url, description || '');
    res.json({ id, owner_id: ownerId, url, description });
  });

  // Delete a sticker
  app.delete('/api/stickers/:id', (req, res) => {
    const { id } = req.params;
    db.prepare('DELETE FROM stickers WHERE id = ?').run(id);
    res.status(204).send();
  });

  // Send message (User -> AI/Group)
  app.post('/api/chat', async (req, res) => {
    const { characterId, content, type, image, mode, description } = req.body;
    
    // Fetch User Persona Settings
    const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings: any = {};
    settingsRows.forEach(s => settings[s.key] = s.value);

    const userName = settings.user_name || 'Me';
    const userBio = settings.user_bio || '';
    const userGender = settings.user_gender || '';
    
    // 1. Save User Message
    const userMsgId = uuidv4();
    db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, content, type, timestamp, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userMsgId, characterId, 'user', userName, content, type, new Date().toISOString(), 'sent');

    // 1.5 Handle Vision if image
    let imageDescription = "";
    if (type === 'image' && (settings.vision_api_key || process.env.GEMINI_API_KEY)) {
        try {
            if (settings.vision_api_url) { // Use custom OpenAI-compatible vision
                 const visionMessages = [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: "请详细描述这张图片的内容，包括主体、动作、环境、氛围等。如果是表情包，请解释其含义。请用中文回答。" },
                            { type: 'image_url', image_url: { url: content } }
                        ]
                    }
                ];
                imageDescription = await generateWithOpenAI(settings.vision_api_key, settings.vision_api_url, settings.vision_model, visionMessages);
            } else { // Use Gemini for vision
                imageDescription = await describeImage(process.env.GEMINI_API_KEY, settings.vision_model, content);
            }
        } catch (e) {
            console.error("Vision Error:", e);
        }
    }

    // 2. Determine Context (Individual or Group)
    const chatEntity = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as any;
    
    let responders = [];
    let groupContext = "";
    
    if (chatEntity.is_group) {
      const members = db.prepare(`
        SELECT c.* FROM characters c 
        JOIN group_members gm ON c.id = gm.character_id 
        WHERE gm.group_id = ?
      `).all(characterId) as any[];
      
      groupContext = `Context: You are in a group chat named "${chatEntity.name}".
        Group Members: ${members.map((m:any) => m.name).join(', ')}
        `;

      if (members.length > 0) {
        const replyMode = chatEntity.reply_mode || 'natural';

        if (replyMode === 'all') {
          responders = members;
        } else if (replyMode === 'mentioned') {
          for (const member of members) {
            if (content.includes(`@${member.name}`)) {
              responders.push(member);
            }
          }
        } else { // natural
          // 1. Anyone mentioned?
          for (const member of members) {
            if (content.includes(`@${member.name}`)) {
              responders.push(member);
            }
          }
          // 2. If no one mentioned, pick 1-2 random members to respond
          if (responders.length === 0) {
            const shuffled = members.sort(() => 0.5 - Math.random());
            const count = Math.floor(Math.random() * 2) + 1; 
            responders = shuffled.slice(0, count);
          }
        }
      }
    } else {
      if (chatEntity.reply_strategy !== 'manual') {
        responders.push(chatEntity);
      }
    }

    // 3. Generate Responses
    const useChatApi = settings.chat_api_url && settings.chat_api_key;

    const responses = [];
    for (const responder of responders) {
      try {
        const history = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp DESC LIMIT 20').all(characterId) as any[];
        
        // Fetch relationships for this responder
        const relationships = db.prepare('SELECT * FROM character_relationships WHERE character_id = ?').all(responder.id) as any[];
        const relationshipContext = relationships.map(r => {
           const target = r.target_id === 'user' ? 'User' : (db.prepare('SELECT name FROM characters WHERE id = ?').get(r.target_id) as any)?.name || 'Someone';
           return `- Relationship with ${target}: ${r.relationship}. Context: ${r.description}`;
        }).join('\n');

        let text = "...";

        // Fetch character's stickers
        const stickers = db.prepare('SELECT * FROM stickers WHERE owner_id = ?').all(responder.id) as any[];
        const stickerList = stickers.map((s: any) => `[sticker:${s.id}] (${s.description || '无描述'})`).join(', ');

        // Construct User Persona Context
        const userContext = `User Info: Name: ${userName}, Gender: ${userGender}, Bio: ${userBio}`;
        
        // Scenario Mode Context
        let scenarioInstruction = "";
        if (mode === 'scenario') {
            scenarioInstruction = `
            MODE: SCENARIO / ROLEPLAY
            The user has provided a description of the scene/action: "${description || 'No description'}".
            
            INSTRUCTIONS:
            1. You MUST start your response with a descriptive paragraph (narration) of your own actions, feelings, or the environment.
            2. Follow the narration with your spoken dialogue.
            3. SEPARATE the narration and the dialogue with the delimiter "|||".
            Example:
            I looked up at the sky, feeling a bit lonely.|||I miss you so much.
            `;
        } else {
            scenarioInstruction = `
            MODE: CHAT
            Reply naturally as if using a chat app (WeChat). Keep it concise.
            `;
        }

        if (useChatApi) {
          // OpenAI Format
          const messages = history.reverse().map(msg => ({
            role: msg.sender_id === 'user' ? 'user' : 'assistant',
            content: msg.content
          }));

          // Add current user message with description if scenario
          if (mode === 'scenario' && description) {
              const lastMsg = messages[messages.length - 1];
              if (lastMsg && lastMsg.role === 'user') {
                  lastMsg.content = `(Action/Context: ${description}) ${lastMsg.content}`;
              }
          }

          const systemPrompt = `You are roleplaying as ${responder.name}.
          Gender: ${responder.gender || 'Unknown'}
          Bio: ${responder.bio}
          Personality: ${responder.personality}
          Relationship with User: ${responder.relationship || 'Friend'}
          Other Info: ${responder.other_info || ''}
          
          Your Relationships with others in this chat:
          ${relationshipContext || 'No specific relationships defined.'}

          ${groupContext}
          
          You are talking to: ${userContext}
          
          ${scenarioInstruction}
          
          General Instructions:
          - If in a group, interact with others if they spoke recently. Reference what they said.
          - CRITICAL: Speak ONLY as ${responder.name}. Do NOT simulate other characters. Do NOT include other characters' names or dialogue in your response.
          - MULTI-MESSAGE: You can send multiple messages in a row by using the separator "[NEXT]". Use this for emphasis, to send a follow-up thought, or to separate a text from a sticker/image.
          - You have a personal sticker library. Here are your stickers: ${stickerList || 'None'}. 
          - To send a sticker, output its ID exactly, e.g., [sticker:uuid]. 
          - ONLY send a sticker if it strongly enhances the emotion or if the user asks for one. Do NOT send stickers with every message.
          - ${settings.image_model ? `You can generate images by outputting [生图: 提示词]. Use this when you want to share a photo, show something, or create art. The prompt should be descriptive and in English for better results.` : ''}
          - If the user sent an image, you will see a description of it in the history. Respond as if you can see it.
          - Do NOT include your name at the start of the message (e.g. avoid "[Name]: ...").
          - IMPORTANT: ALWAYS REPLY IN CHINESE (Simplified Chinese).
          `;

          // Inject image description into history if available
          if (imageDescription) {
              messages.push({ role: 'system', content: `[User sent an image. Description: ${imageDescription}]` });
          }

          messages.unshift({ role: 'system', content: systemPrompt });
          
          text = await generateWithOpenAI(
            settings.chat_api_key, 
            settings.chat_api_url, 
            settings.chat_model || 'gpt-3.5-turbo', 
            messages
          );

        } else {
          // Gemini Format
          const recentHistory = history.reverse().map(msg => ({
            role: msg.sender_id === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
          }));

           // Add current user message with description if scenario
           if (mode === 'scenario' && description) {
              const lastMsg = recentHistory[recentHistory.length - 1];
              if (lastMsg && lastMsg.role === 'user') {
                  lastMsg.parts[0].text = `(Action/Context: ${description}) ${lastMsg.parts[0].text}`;
              }
          }

          const systemInstruction = `You are roleplaying as ${responder.name} in a chat.
          Gender: ${responder.gender || 'Unknown'}
          Bio: ${responder.bio}
          Personality: ${responder.personality}
          Relationship with User: ${responder.relationship || 'Friend'}
          Other Info: ${responder.other_info || ''}
          
          Your Relationships with others in this chat:
          ${relationshipContext || 'No specific relationships defined.'}

          ${groupContext}
          
          You are talking to: ${userContext}
          
          ${scenarioInstruction}
          
          General Instructions:
          - If in a group, interact with others if they spoke recently. Reference what they said.
          - CRITICAL: Speak ONLY as ${responder.name}. Do NOT simulate other characters. Do NOT include other characters' names or dialogue in your response.
          - MULTI-MESSAGE: You can send multiple messages in a row by using the separator "[NEXT]". Use this for emphasis, to send a follow-up thought, or to separate a text from a sticker/image.
          - You have a personal sticker library. Here are your stickers: ${stickerList || 'None'}. 
          - To send a sticker, output its ID exactly, e.g., [sticker:uuid].
          - ONLY send a sticker if it strongly enhances the emotion or if the user asks for one. Do NOT send stickers with every message.
          - ${settings.image_model ? `You can generate images by outputting [生图: 提示词]. Use this when you want to share a photo, show something, or create art. The prompt should be descriptive and in English for better results.` : ''}
          - If the user sent an image, you will see a description of it in the history. Respond as if you can see it.
          - Do NOT include your name at the start of the message (e.g. avoid "[Name]: ...").
          - IMPORTANT: ALWAYS REPLY IN CHINESE (Simplified Chinese).
          `;

          // Inject image description into history if available
          if (imageDescription) {
              recentHistory.push({ role: 'user', parts: [{ text: `[User sent an image. Description: ${imageDescription}]` }] });
          }

          const model = 'gemini-3-flash-preview';
          const result = await ai.models.generateContent({
            model,
            contents: recentHistory,
            config: { systemInstruction, temperature: 0.8 }
          });
          text = result.text || "...";
        }

        // Clean up text (remove [Name]: prefix if AI ignores instruction)
        text = text.replace(/^\[.*?\]:?\s*/, '').replace(new RegExp(`^${responder.name}:?\\s*`), '');

        // Parse Scenario Response
        let narration = "";
        let dialogue = text;
        
        if (mode === 'scenario' && text.includes('|||')) {
            const parts = text.split('|||');
            narration = parts[0].trim();
            dialogue = parts[1].trim();
        }

        // Handle Multi-Message Split
        const messageParts = dialogue.split(/\[NEXT\]|\n\n+/).filter(p => p.trim());
        
        // Insert Narration Message if exists
        if (narration) {
            const narrationId = uuidv4();
            const ts = new Date(Date.now() - 500).toISOString();
            db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, sender_avatar, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
             .run(narrationId, characterId, responder.id, responder.name, responder.avatar, narration, 'narration', ts);
             
             responses.push({
                id: narrationId,
                sender_id: responder.id,
                sender_name: responder.name,
                sender_avatar: responder.avatar,
                content: narration,
                type: 'narration',
                timestamp: ts
              });
        }

        for (let i = 0; i < messageParts.length; i++) {
            let partText = messageParts[i].trim();
            if (!partText) continue;

            // Handle Image Generation Tag in this part
            let partGeneratedImageUrl = null;
            if (partText.includes('[生图:')) {
                const match = partText.match(/\[生图:\s*(.*?)\]/);
                if (match && (settings.image_api_key || process.env.GEMINI_API_KEY)) {
                    const prompt = match[1];
                    try {
                        if(settings.image_api_url && settings.image_api_key) {
                            partGeneratedImageUrl = await generateImageWithOpenAI(settings.image_api_key, settings.image_api_url, settings.image_model, prompt);
                        } else {
                            partGeneratedImageUrl = await generateImage(process.env.GEMINI_API_KEY, settings.image_model, prompt);
                        }
                        partText = partText.replace(/\[生图:.*?\]/, '').trim();
                    } catch (e) {
                        console.error("Image Gen Error:", e);
                    }
                }
            }

            // Handle Sticker Tag in this part
            let partStickerUrl = null;
            if (partText.includes('[sticker:')) {
                const match = partText.match(/\[sticker:(.*?)\]/);
                if (match) {
                    const stickerId = match[1];
                    const sticker = db.prepare('SELECT url FROM stickers WHERE id = ?').get(stickerId) as any;
                    if (sticker) {
                        partStickerUrl = sticker.url;
                        partText = partText.replace(/\[sticker:.*?\]/, '').trim();
                    }
                }
            }

            // Save text part if exists
            if (partText) {
                const aiMsgId = uuidv4();
                const ts = new Date(Date.now() + i * 500).toISOString();
                db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, sender_avatar, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(aiMsgId, characterId, responder.id, responder.name, responder.avatar, partText, 'text', ts);

                responses.push({
                    id: aiMsgId,
                    sender_id: responder.id,
                    sender_name: responder.name,
                    sender_avatar: responder.avatar,
                    content: partText,
                    type: 'text',
                    timestamp: ts
                });
            }

            // Save image if exists
            if (partGeneratedImageUrl) {
                const imgMsgId = uuidv4();
                const ts = new Date(Date.now() + i * 500 + 100).toISOString();
                db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, sender_avatar, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(imgMsgId, characterId, responder.id, responder.name, responder.avatar, partGeneratedImageUrl, 'image', ts);
                
                responses.push({
                    id: imgMsgId,
                    sender_id: responder.id,
                    sender_name: responder.name,
                    sender_avatar: responder.avatar,
                    content: partGeneratedImageUrl,
                    type: 'image',
                    timestamp: ts
                });
            }

            // Save sticker if exists
            if (partStickerUrl) {
                const stickerMsgId = uuidv4();
                const ts = new Date(Date.now() + i * 500 + 200).toISOString();
                db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, sender_avatar, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(stickerMsgId, characterId, responder.id, responder.name, responder.avatar, partStickerUrl, 'sticker', ts);
                
                responses.push({
                    id: stickerMsgId,
                    sender_id: responder.id,
                    sender_name: responder.name,
                    sender_avatar: responder.avatar,
                    content: partStickerUrl,
                    type: 'sticker',
                    timestamp: ts
                });
            }
        }

        // Mark user messages as read
        db.prepare("UPDATE messages SET status = 'read' WHERE character_id = ? AND sender_id = 'user' AND status = 'sent'").run(characterId);
      } catch (err) {
        console.error(err);
      }
    }

    res.json(responses);
  });

  // Proactive Message Trigger
  app.post('/api/trigger-message', async (req, res) => {
    // 1. Pick a random character (excluding groups and manual trigger only)
    const characters = db.prepare("SELECT * FROM characters WHERE is_group = 0 AND (reply_strategy IS NULL OR reply_strategy != 'manual')").all() as any[];
    if (characters.length === 0) return res.json({ success: false });
    
    // Shuffle and pick one that hasn't spoken *too* recently
    const shuffled = characters.sort(() => 0.5 - Math.random());
    let selectedChar = null;
    let history: any[] = [];

    for (const char of shuffled) {
      const lastMsg = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp DESC LIMIT 1').get(char.id) as any;
      
      // Determine interval based on relationship and strategy
      let requiredInterval = 60 * 1000; // Default 60s
      const strategy = char.reply_strategy || 'normal';
      
      if (strategy === 'active') {
          requiredInterval = 10 * 1000; // 10s for active
      } else if (strategy === 'passive') {
          requiredInterval = 600 * 1000; // 10m for passive
      } else {
          // Normal strategy, check relationship
          const rel = (char.relationship || '').toLowerCase();
          if (rel.includes('lover') || rel.includes('partner') || rel.includes('wife') || rel.includes('husband')) {
            requiredInterval = 30 * 1000; // 30s for close relationships
          } else if (rel.includes('stranger')) {
            requiredInterval = 300 * 1000; // 5m for strangers
          }
      }

      // If no messages, this is a good candidate to start a convo
      if (!lastMsg) {
        selectedChar = char;
        break;
      }

      // Check time interval
      const lastTime = new Date(lastMsg.timestamp).getTime();
      const now = Date.now();
      if (now - lastTime > requiredInterval) {
        // Also add a random chance based on strategy
        let chance = 0.5;
        if (strategy === 'active') chance = 0.8;
        if (strategy === 'passive') chance = 0.2;
        
        if (Math.random() < chance) {
            selectedChar = char;
            // Fetch recent history for context
            history = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp DESC LIMIT 5').all(char.id) as any[];
            break;
        }
      }
    }

    if (!selectedChar) return res.json({ success: false, message: 'No eligible characters found (too recent)' });

    const character = selectedChar;
    
    // Fetch Settings
    const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings: any = {};
    settingsRows.forEach(s => settings[s.key] = s.value);
    
    const useChatApi = settings.chat_api_url && settings.chat_api_key;
    const userName = settings.user_name || 'Me';
    const userContext = `User Info: Name: ${userName}, Gender: ${settings.user_gender || ''}, Bio: ${settings.user_bio || ''}`;

    // 2. Generate a message
    try {
      let text = "";
      
      // Format history for prompt
      const historyText = history.reverse().map(m => `${m.sender_name}: ${m.content}`).join('\n');

      const prompt = `You are ${character.name}. 
      Gender: ${character.gender || 'Unknown'}
      Bio: ${character.bio}
      Personality: ${character.personality}
      Relationship with User: ${character.relationship || 'Friend'}
      Other Info: ${character.other_info || ''}
      
      You are thinking about your friend ${userName}.
      
      Context (Recent Chat History):
      ${historyText || '(No previous conversation)'}
      
      Task:
      Send a message to ${userName}.
      - Consider your relationship: Lovers are more affectionate and frequent; Friends are casual; Strangers are polite.
      - If the conversation ended recently, follow up or change the topic.
      - If it's a new conversation, say hello or share something related to your bio.
      - Do NOT repeat the last message.
      - Keep it short, casual, and natural (like a WeChat message).
      - IMPORTANT: ALWAYS WRITE IN CHINESE (Simplified Chinese).
      `;

      if (useChatApi) {
         text = await generateWithOpenAI(
            settings.chat_api_key, 
            settings.chat_api_url, 
            settings.chat_model || 'gpt-3.5-turbo', 
            [{ role: 'system', content: prompt }]
          );
      } else {
        const result = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt
        });
        text = result.text || "...";
      }
      
      const id = uuidv4();
      
      db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, sender_avatar, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, character.id, character.id, character.name, character.avatar, text, 'text', new Date().toISOString());
        
      res.json({ success: true, message: text, character: character.name });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Manual Trigger for a specific character
  app.post('/api/chat/trigger-manual', async (req, res) => {
    const { characterId } = req.body;
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as any;
    if (!character) return res.status(404).json({ error: 'Character not found' });

    // Fetch Settings
    const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings: any = {};
    settingsRows.forEach(s => settings[s.key] = s.value);
    const useChatApi = settings.chat_api_url && settings.chat_api_key;
    const userName = settings.user_name || 'Me';

    // Fetch recent history
    const history = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp DESC LIMIT 10').all(characterId) as any[];
    
    try {
      let text = "";
      const historyText = history.reverse().map(m => `${m.sender_name}: ${m.content}`).join('\n');
      const prompt = `You are ${character.name}. 
      Gender: ${character.gender || 'Unknown'}
      Bio: ${character.bio}
      Personality: ${character.personality}
      Relationship with User: ${character.relationship || 'Friend'}
      
      You are thinking about your friend ${userName}.
      
      Context (Recent Chat History):
      ${historyText || '(No previous conversation)'}
      
      Task:
      The user just "nudged" you or pulled up the chat to get a reply.
      Send a message to ${userName}.
      - Consider your relationship.
      - Keep it short, casual, and natural.
      - IMPORTANT: ALWAYS WRITE IN CHINESE (Simplified Chinese).
      `;

      if (useChatApi) {
          text = await generateWithOpenAI(settings.chat_api_key, settings.chat_api_url, settings.chat_model || 'gpt-3.5-turbo', [{ role: 'system', content: prompt }]);
      } else {
        const result = await ai.models.generateContent({ model: 'gemini-2.5-flash-latest', contents: prompt });
        text = result.text || "...";
      }
      
      const id = uuidv4();
      db.prepare('INSERT INTO messages (id, character_id, sender_id, sender_name, sender_avatar, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, character.id, character.id, character.name, character.avatar, text, 'text', new Date().toISOString());
        
      res.json([{ id, sender_id: character.id, sender_name: character.name, sender_avatar: character.avatar, content: text, type: 'text', timestamp: new Date().toISOString() }]);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Get character relationships
  app.get('/api/characters/:id/relationships', (req, res) => {
    const { id } = req.params;
    const relationships = db.prepare('SELECT * FROM character_relationships WHERE character_id = ?').all(id);
    res.json(relationships);
  });

  // Update character relationships
  app.post('/api/characters/:id/relationships', (req, res) => {
    const { id } = req.params;
    const { target_id, relationship, description } = req.body;
    db.prepare('INSERT OR REPLACE INTO character_relationships (character_id, target_id, relationship, description) VALUES (?, ?, ?, ?)')
      .run(id, target_id, relationship, description);
    res.json({ success: true });
  });

  // Get moments with comments
  app.get('/api/moments', (req, res) => {
    // Fetch Settings for user info
    const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings: any = {};
    settingsRows.forEach(s => settings[s.key] = s.value);
    const userName = settings.user_name || '我';
    const userAvatar = settings.user_avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=User';

    const moments = db.prepare(`
      SELECT moments.*, 
             CASE WHEN moments.character_id = 'user' THEN ? ELSE characters.name END as author_name,
             CASE WHEN moments.character_id = 'user' THEN ? ELSE characters.avatar END as author_avatar
      FROM moments 
      LEFT JOIN characters ON moments.character_id = characters.id 
      ORDER BY timestamp DESC
    `).all(userName, userAvatar) as any[];

    const momentsWithComments = moments.map(m => {
      const comments = db.prepare('SELECT * FROM moment_comments WHERE moment_id = ? ORDER BY timestamp ASC').all(m.id);
      return { ...m, comments };
    });

    res.json(momentsWithComments);
  });

  // Post a comment on a moment
  app.post('/api/moments/:id/comments', async (req, res) => {
    const { id: momentId } = req.params;
    const { author_id, author_name, content } = req.body;
    const id = uuidv4();
    
    db.prepare('INSERT INTO moment_comments (id, moment_id, author_id, author_name, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, momentId, author_id, author_name, content, new Date().toISOString());

    // Trigger AI reply to comment (higher chance for user comments)
    if (author_id === 'user') {
       // 90% chance for the author to reply to user's comment
       if (Math.random() < 0.9) {
          setTimeout(() => triggerAiCommentReply(momentId), 2000 + Math.random() * 3000);
       }
       // 30% chance for another random character to chime in
       if (Math.random() < 0.3) {
          setTimeout(() => triggerRandomCharacterComment(momentId), 5000 + Math.random() * 5000);
       }
    }

    res.json({ id, moment_id: momentId, author_id, author_name, content });
  });

  // Like a moment
  app.post('/api/moments/:id/like', (req, res) => {
    const { id } = req.params;
    db.prepare('UPDATE moments SET likes = likes + 1 WHERE id = ?').run(id);
    res.json({ success: true });
  });

  // Helper for AI to reply to comments
  async function triggerAiCommentReply(momentId: string) {
    try {
      const moment = db.prepare('SELECT * FROM moments WHERE id = ?').get(momentId) as any;
      if (!moment) return;
      const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(moment.character_id) as any;
      const comments = db.prepare('SELECT * FROM moment_comments WHERE moment_id = ? ORDER BY timestamp ASC').all(momentId) as any[];
      
      // Fetch Settings
      const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
      const settings: any = {};
      settingsRows.forEach(s => settings[s.key] = s.value);
      const useChatApi = settings.chat_api_url && settings.chat_api_key;

      const commentThread = comments.map(c => `${c.author_name}: ${c.content}`).join('\n');

      const prompt = `You are ${character.name}. You just posted this on your moments: "${moment.content}".
      People are commenting on it:
      ${commentThread}
      
      Task: Write a short, natural reply to the latest comment (especially if it's from your friend). 
      - Keep it very short (one sentence).
      - Be consistent with your persona.
      - IMPORTANT: ALWAYS WRITE IN CHINESE (Simplified Chinese).
      `;

      let text = "";
      if (useChatApi) {
        text = await generateWithOpenAI(settings.chat_api_key, settings.chat_api_url, settings.chat_model, [{ role: 'system', content: prompt }]);
      } else {
        const result = await ai.models.generateContent({ model: 'gemini-2.5-flash-latest', contents: prompt });
        text = result.text || "...";
      }
      
      const id = uuidv4();
      db.prepare('INSERT INTO moment_comments (id, moment_id, author_id, author_name, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, momentId, character.id, character.name, text.trim(), new Date().toISOString());
    } catch (e) {
      console.error("AI Comment Reply Error:", e);
    }
  }

  // Helper for a random character to comment on a moment
  async function triggerRandomCharacterComment(momentId: string) {
    try {
      const moment = db.prepare('SELECT * FROM moments WHERE id = ?').get(momentId) as any;
      if (!moment) return;
      
      // Pick a random character who is NOT the author
      const characters = db.prepare('SELECT * FROM characters WHERE is_group = 0 AND id != ?').all(moment.character_id) as any[];
      if (characters.length === 0) return;
      const character = characters[Math.floor(Math.random() * characters.length)];

      const comments = db.prepare('SELECT * FROM moment_comments WHERE moment_id = ? ORDER BY timestamp ASC').all(momentId) as any[];
      const commentThread = comments.map(c => `${c.author_name}: ${c.content}`).join('\n');

      // Fetch Settings
      const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
      const settings: any = {};
      settingsRows.forEach(s => settings[s.key] = s.value);
      const useChatApi = settings.chat_api_url && settings.chat_api_key;

      const prompt = `You are ${character.name}. Your friend ${db.prepare('SELECT name FROM characters WHERE id = ?').get(moment.character_id).name} just posted: "${moment.content}".
      Current comments:
      ${commentThread}
      
      Task: Write a short, natural comment or reply to existing comments.
      - Keep it very short.
      - Be consistent with your persona.
      - IMPORTANT: ALWAYS WRITE IN CHINESE (Simplified Chinese).
      `;

      let text = "";
      if (useChatApi) {
        text = await generateWithOpenAI(settings.chat_api_key, settings.chat_api_url, settings.chat_model, [{ role: 'system', content: prompt }]);
      } else {
        const result = await ai.models.generateContent({ model: 'gemini-2.5-flash-latest', contents: prompt });
        text = result.text || "...";
      }
      
      const id = uuidv4();
      db.prepare('INSERT INTO moment_comments (id, moment_id, author_id, author_name, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, momentId, character.id, character.name, text.trim(), new Date().toISOString());
      
      // Also maybe like it
      if (Math.random() < 0.5) {
        db.prepare('UPDATE moments SET likes = likes + 1 WHERE id = ?').run(momentId);
      }
    } catch (e) {
      console.error("Random Character Comment Error:", e);
    }
  }

  // Post a moment (User)
  app.post('/api/moments', (req, res) => {
    const { content, image } = req.body;
    const id = uuidv4();
    db.prepare('INSERT INTO moments (id, character_id, content, image, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'user', content, image || null, new Date().toISOString());
    
    // Trigger some initial interactions from characters
    const otherChars = db.prepare('SELECT id FROM characters WHERE is_group = 0').all() as any[];
    if (otherChars.length > 0) {
        const count = Math.min(otherChars.length, Math.floor(Math.random() * 3) + 1);
        const shuffled = otherChars.sort(() => 0.5 - Math.random()).slice(0, count);
        
        shuffled.forEach((char, index) => {
            const delay = (index + 1) * (5000 + Math.random() * 5000);
            if (Math.random() < 0.7) { // 70% chance to like user's post
                setTimeout(() => {
                    db.prepare('UPDATE moments SET likes = likes + 1 WHERE id = ?').run(id);
                }, delay);
            }
            if (Math.random() < 0.5) { // 50% chance to comment on user's post
                setTimeout(() => {
                    triggerRandomCharacterComment(id);
                }, delay + 2000);
            }
        });
    }

    res.json({ success: true, id });
  });

  // Trigger AI to post a moment (Improved)
  app.post('/api/moments/generate', async (req, res) => {
    const { characterId } = req.body;
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as any;

    if (!character || character.is_group) {
        return res.status(400).json({ error: 'Invalid character or character is a group' });
    }

    // Fetch Settings
    const settingsRows = db.prepare('SELECT * FROM settings').all() as any[];
    const settings: any = {};
    settingsRows.forEach(s => settings[s.key] = s.value);
    const useChatApi = settings.chat_api_url && settings.chat_api_key;

    // Fetch context
    const history = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp DESC LIMIT 10').all(characterId) as any[];
    const historyText = history.reverse().map(m => `${m.sender_name}: ${m.content}`).join('\n');
    
    const relationships = db.prepare('SELECT * FROM character_relationships WHERE character_id = ?').all(characterId) as any[];
    const relationshipContext = relationships.map(r => {
       const target = r.target_id === 'user' ? 'User' : (db.prepare('SELECT name FROM characters WHERE id = ?').get(r.target_id) as any)?.name || 'Someone';
       return `- Relationship with ${target}: ${r.relationship}. Context: ${r.description}`;
    }).join('\n');

    try {
      const prompt = `Generate a social media post (like a WeChat Moment) for ${character.name}.
      Gender: ${character.gender || 'Unknown'}
      Bio: ${character.bio}
      Personality: ${character.personality}
      Other Info: ${character.other_info || ''}
      
      Relationships:
      ${relationshipContext || 'No specific relationships defined.'}

      Recent Chat History with User:
      ${historyText || 'No recent chat history.'}

      Content: Write a short, engaging post about something you are doing, thinking, or seeing right now. 
      - It should be influenced by your personality, background, and recent conversations.
      - Max 50 words. 
      - Do not use hashtags.
      - IMPORTANT: ALWAYS WRITE IN CHINESE (Simplified Chinese).
      `;

      let text = "";
      if (useChatApi) {
         text = await generateWithOpenAI(settings.chat_api_key, settings.chat_api_url, settings.chat_model, [{ role: 'system', content: prompt }]);
      } else {
        const response = await ai.models.generateContent({ model: 'gemini-3-flash-preview', contents: prompt });
        text = response.text || "...";
      }
      
      // Randomly assign a placeholder image sometimes
      const hasImage = Math.random() > 0.5;
      const image = hasImage ? `https://picsum.photos/seed/${uuidv4()}/400/300` : null;

      const id = uuidv4();
      db.prepare('INSERT INTO moments (id, character_id, content, image, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(id, characterId, text.trim(), image, new Date().toISOString());

      // Trigger some initial interactions from other characters
      const otherChars = db.prepare('SELECT id FROM characters WHERE is_group = 0 AND id != ?').all(characterId) as any[];
      if (otherChars.length > 0) {
          // 1-3 random characters might interact
          const count = Math.min(otherChars.length, Math.floor(Math.random() * 3) + 1);
          const shuffled = otherChars.sort(() => 0.5 - Math.random()).slice(0, count);
          
          shuffled.forEach((char, index) => {
              const delay = (index + 1) * (5000 + Math.random() * 5000);
              if (Math.random() < 0.6) { // 60% chance to like
                  setTimeout(() => {
                      db.prepare('UPDATE moments SET likes = likes + 1 WHERE id = ?').run(id);
                  }, delay);
              }
              if (Math.random() < 0.4) { // 40% chance to comment
                  setTimeout(() => {
                      triggerRandomCharacterComment(id);
                  }, delay + 2000);
              }
          });
      }

      res.json({ success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed' });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
