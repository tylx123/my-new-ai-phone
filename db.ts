import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const db = new Database(path.join(dataDir, 'app.db'));

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT,
    bio TEXT,
    personality TEXT,
    is_group INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    PRIMARY KEY (group_id, character_id),
    FOREIGN KEY(group_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL, -- Can be a user ID or group ID
    sender_id TEXT, -- If group, which character sent it. If user, null or 'user'
    sender_name TEXT, -- Cache for display
    sender_avatar TEXT, -- Cache for display
    content TEXT,
    type TEXT DEFAULT 'text', -- 'text', 'image', 'sticker', 'narration'
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS moments (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    content TEXT,
    image TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    likes INTEGER DEFAULT 0,
    FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS moment_comments (
    id TEXT PRIMARY KEY,
    moment_id TEXT NOT NULL,
    author_id TEXT NOT NULL, -- 'user' or character_id
    author_name TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(moment_id) REFERENCES moments(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS character_relationships (
    character_id TEXT NOT NULL,
    target_id TEXT NOT NULL, -- Another character_id or 'user'
    relationship TEXT, -- e.g., 'Friend', 'Enemy', 'Lover'
    description TEXT, -- Detailed context
    PRIMARY KEY (character_id, target_id),
    FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
  );
  
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL, -- 'user' or character_id
    url TEXT NOT NULL, -- Base64 data URL
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: Check if is_group exists in characters
try {
  db.prepare('SELECT is_group FROM characters LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE characters ADD COLUMN is_group INTEGER DEFAULT 0');
}

// Migration: Check if gender exists in characters
try {
  db.prepare('SELECT gender FROM characters LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE characters ADD COLUMN gender TEXT');
  db.exec('ALTER TABLE characters ADD COLUMN other_info TEXT');
}

// Migration: Check if background exists in characters
try {
  db.prepare('SELECT background FROM characters LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE characters ADD COLUMN background TEXT');
}

// Migration: Check if relationship exists in characters
try {
  db.prepare('SELECT relationship FROM characters LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE characters ADD COLUMN relationship TEXT');
}

// Migration: Add group chat reply mode
try {
  db.prepare('SELECT reply_mode FROM characters LIMIT 1').get();
} catch (e) {
  db.exec("ALTER TABLE characters ADD COLUMN reply_mode TEXT DEFAULT 'natural'"); // natural, all, mentioned
}

// Migration: Add reply strategy
try {
  db.prepare('SELECT reply_strategy FROM characters LIMIT 1').get();
} catch (e) {
  db.exec("ALTER TABLE characters ADD COLUMN reply_strategy TEXT DEFAULT 'normal'"); // active, normal, passive, manual
}

// Migration: Check if sender_id exists in messages
try {
  db.prepare('SELECT sender_id FROM messages LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE messages ADD COLUMN sender_id TEXT');
  db.exec('ALTER TABLE messages ADD COLUMN sender_name TEXT');
  db.exec('ALTER TABLE messages ADD COLUMN sender_avatar TEXT');
}

// Migration: Check if status exists in messages
try {
  db.prepare('SELECT status FROM messages LIMIT 1').get();
} catch (e) {
  db.exec("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'");
}

// Migration: Add description to stickers
try {
  db.prepare('SELECT description FROM stickers LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE stickers ADD COLUMN description TEXT');
}

// Seed default character if none exists
const count = db.prepare('SELECT count(*) as count FROM characters').get() as { count: number };
if (count.count === 0) {
  const stmt = db.prepare('INSERT INTO characters (id, name, avatar, bio, personality) VALUES (?, ?, ?, ?, ?)');
  stmt.run(
    'default-ai',
    'Alice',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Alice',
    'Your friendly AI assistant.',
    'Helpful, kind, and curious.'
  );
}

export default db;
