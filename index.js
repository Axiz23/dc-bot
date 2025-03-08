// Import package yang diperlukan
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField } = require('discord.js');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

// Konfigurasi bot
const TOKEN = process.env.DISCORD_TOKEN; // Token diambil dari .env
const SERVER_ID = '1347135122457100299';
const CREATE_BOT_CHANNEL_ID = '1347135601404674049';
const CATEGORY_CHAT_ID = '1347135122457100301';

// Cek apakah token tersedia
if (!TOKEN) {
  console.error('Error: Token tidak ditemukan! Pastikan file .env sudah dibuat dan berisi DISCORD_TOKEN.');
  process.exit(1);
}

// Buat client Discord dengan intents yang diperlukan
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Penyimpanan instance bot aktif
const activeBots = new Map();
const HISTORY_FILE = path.join(__dirname, 'history_account.json');

// Fungsi untuk memuat bot dari file history
function loadBotsFromHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading history file:', error);
  }
  return [];
}

// Fungsi untuk menyimpan bot ke file history
function saveBotsToHistory() {
  try {
    const botsToSave = Array.from(activeBots.values()).map(botInfo => ({
      username: botInfo.username,
      ip: botInfo.ip,
      port: botInfo.port,
      password: botInfo.password,
      version: botInfo.version,
      channelId: botInfo.channelId,
      features: botInfo.features,
    }));

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(botsToSave, null, 2));
  } catch (error) {
    console.error('Error saving history file:', error);
  }
}

// Fungsi untuk membuat bot Minecraft
async function createMinecraftBot(username, ip, port, password, version, channelId, features = {}) {
  const botFeatures = {
    auth: false,
    aqueue: false,
    ajump: false,
    areconnect: true,
    queueServer: null,
    ajumpSeconds: 60,
    ...features,
  };

  const bot = mineflayer.createBot({
    host: ip,
    port: parseInt(port),
    username,
    password,
    version,
    auth: 'offline',
    keepAlive: true,
  });

  const botInfo = { 
    bot, 
    username, 
    ip, 
    port, 
    password, 
    version, 
    channelId, 
    features: botFeatures, 
    isConnected: false, 
    isInQueue: false,
    targetServer: ip, // Tambahkan targetServer untuk membedakan server queue dan tujuan
    messageQueue: [], // Antrian pesan untuk menangani rate limiting
    processingMessages: false // Flag untuk mengontrol pemrosesan pesan
  };
  
  activeBots.set(channelId, botInfo);
  setupBotEvents(botInfo);
  return botInfo;
}

// Fungsi untuk memproses pesan dari antrian dengan delay
async function processMessageQueue(botInfo) {
  if (botInfo.processingMessages || botInfo.messageQueue.length === 0) return;
  
  botInfo.processingMessages = true;
  
  try {
    const channel = await client.channels.fetch(botInfo.channelId);
    
    while (botInfo.messageQueue.length > 0) {
      const message = botInfo.messageQueue.shift();
      await channel.send(`${message}`);
      
      // Delay antara pengiriman pesan (100ms)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error('Error processing message queue:', error);
  } finally {
    botInfo.processingMessages = false;
  }
}

// Fungsi untuk menjalankan auto queue
function handleAutoQueue(botInfo) {
  if (!botInfo.features.aqueue || !botInfo.features.queueServer) return;
  
  const { bot, channelId } = botInfo;
  
  setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(channelId);
      channel.send(`🔄 Menjalankan auto queue...`);
      bot.chat('/queue main');
    } catch (error) {
      console.error('Error saat menjalankan auto queue:', error);
    }
  }, 2000); // Tunggu 2 detik setelah masuk server queue baru jalankan perintah
}

// Fungsi untuk menangani event bot Minecraft
function setupBotEvents(botInfo) {
  const { bot, channelId } = botInfo;

  bot.on('login', async () => {
    botInfo.isConnected = true;
    const channel = await client.channels.fetch(channelId);
    channel.send(`Bot **${botInfo.username}** terhubung ke ${botInfo.ip}:${botInfo.port}`);
    
    // Jalankan auto queue jika fitur aktif dan ini adalah server queue
    if (botInfo.features.aqueue && botInfo.features.queueServer && botInfo.ip === botInfo.features.queueServer) {
      botInfo.isInQueue = true;
      handleAutoQueue(botInfo);
    }
  });

  bot.on('end', async (reason) => {
    botInfo.isConnected = false;
    const channel = await client.channels.fetch(channelId);
    channel.send(`Bot terputus: ${reason}`);

    if (botInfo.features.areconnect) {
      channel.send('Mencoba untuk menyambungkan ulang dalam 5 detik...');
      setTimeout(() => reconnectBot(botInfo), 5000);
    }
  });

  bot.on('error', async (error) => {
    const channel = await client.channels.fetch(channelId);
    channel.send(`Error: ${error.message}`);
  });

  bot.on('message', async (message) => {
    const messageStr = message.toString();
    
    // Filter pesan yang berisi username bot
    if (!messageStr.includes(`<${botInfo.username}>`)) {
      // Deteksi apakah bot telah mencapai target server dari pesan queue
      if (botInfo.isInQueue && 
          (messageStr.includes('Connected to the server') || 
           messageStr.includes('You have been connected to') || 
           messageStr.includes('Position in queue'))) {
        
        // Simpan pesan ke antrian untuk dikirim ke Discord
        botInfo.messageQueue.push(messageStr);
        if (!botInfo.processingMessages) {
          processMessageQueue(botInfo);
        }
      } else {
        // Pesan normal, tambahkan ke antrian
        botInfo.messageQueue.push(messageStr);
        if (!botInfo.processingMessages) {
          processMessageQueue(botInfo);
        }
      }
    }
  });
}

// Fungsi untuk menyambungkan ulang bot
function reconnectBot(botInfo) {
  try {
    // Tentukan server yang akan digunakan untuk reconnect (queue jika aqueue aktif, atau server target)
    const reconnectIp = (botInfo.features.aqueue && botInfo.features.queueServer) ? 
                         botInfo.features.queueServer : botInfo.ip;
    const reconnectPort = (botInfo.features.aqueue && botInfo.features.queueServer) ? 
                           25565 : parseInt(botInfo.port); // Gunakan port default untuk server queue

    const newBot = mineflayer.createBot({
      host: reconnectIp,
      port: reconnectPort,
      username: botInfo.username,
      password: botInfo.password,
      version: botInfo.version,
      auth: 'offline',
      keepAlive: true,
    });

    botInfo.bot = newBot;
    botInfo.isInQueue = botInfo.features.aqueue && reconnectIp === botInfo.features.queueServer;
    setupBotEvents(botInfo);
  } catch (error) {
    console.error('Error saat reconnect:', error);
  }
}

// Event saat bot Discord siap
client.once('ready', async () => {
  console.log(`Bot Discord masuk sebagai ${client.user.tag}`);

  const savedBots = loadBotsFromHistory();
  for (const botData of savedBots) {
    try {
      const channel = await client.channels.fetch(botData.channelId);
      if (channel) {
        console.log(`Memulihkan bot: ${botData.username} di ${botData.ip}:${botData.port}`);
        await createMinecraftBot(botData.username, botData.ip, botData.port, botData.password, botData.version, botData.channelId, botData.features);
      }
    } catch (error) {
      console.error(`Gagal memulihkan bot ${botData.username}:`, error);
    }
  }
});

// Event saat menerima pesan di Discord
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Handle create bot command
  if (message.channel.id === CREATE_BOT_CHANNEL_ID && message.content.startsWith('/create')) {
    const args = message.content.split(' ').slice(1);
    if (args.length < 5) {
      return message.reply('Format salah! Gunakan: `/create [username] [ip] [port] [password] [version]`');
    }

    const [username, ip, port, password, version] = args;
    try {
      const guild = await client.guilds.fetch(SERVER_ID);
      const botChannel = await guild.channels.create({
        name: `${username}-${ip}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        type: ChannelType.GuildText,
        parent: CATEGORY_CHAT_ID,
        permissionOverwrites: [{ id: guild.id, allow: [PermissionsBitField.Flags.ViewChannel] }],
      });

      await createMinecraftBot(username, ip, port, password, version, botChannel.id);
      saveBotsToHistory();

      message.reply(`Bot **${username}** dibuat untuk server ${ip}:${port}. Lihat <#${botChannel.id}> untuk berinteraksi.`);
    } catch (error) {
      console.error('Gagal membuat bot:', error);
      message.reply(`Gagal membuat bot: ${error.message}`);
    }
  }
  
  // Handle commands in bot channels
  else if (activeBots.has(message.channel.id)) {
    const botInfo = activeBots.get(message.channel.id);
    
    // Perintah untuk mengirim chat ke Minecraft
    if (message.content.startsWith('/chat ')) {
      const chatMessage = message.content.slice(6);
      if (botInfo.isConnected) {
        botInfo.bot.chat(chatMessage);
        message.react('✅');
      } else {
        message.reply('Bot tidak terhubung ke server!');
      }
    }
    
    // Perintah untuk mengaktifkan auto queue
    else if (message.content.startsWith('/setqueue ')) {
      const queueServer = message.content.slice(10);
      botInfo.features.aqueue = true;
      botInfo.features.queueServer = queueServer;
      saveBotsToHistory();
      message.reply(`Auto queue diaktifkan dengan server queue: ${queueServer}`);
    }
    
    // Perintah untuk menonaktifkan auto queue
    else if (message.content === '/disablequeue') {
      botInfo.features.aqueue = false;
      saveBotsToHistory();
      message.reply('Auto queue dinonaktifkan');
    }
    
    // Perintah untuk menyambungkan ulang bot ke server queue
    else if (message.content === '/joinqueue' && botInfo.features.queueServer) {
      reconnectBot(botInfo);
      message.reply(`Bot mencoba tersambung ke server queue: ${botInfo.features.queueServer}`);
    }
    
    // Perintah untuk menyambungkan ulang bot ke server target
    else if (message.content === '/jointarget') {
      botInfo.ip = botInfo.targetServer;
      reconnectBot(botInfo);
      message.reply(`Bot mencoba tersambung ke server target: ${botInfo.targetServer}:${botInfo.port}`);
    }
  }
});

client.on('error', console.error);
client.login(TOKEN);
