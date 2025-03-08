require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');
const mineflayer = require('mineflayer');

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SERVER_ID = process.env.SERVER_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;
const CREATE_BOT_CHANNEL_ID = process.env.CREATE_BOT_CHANNEL_ID;

// Bot storage
let activeBots = {};
let botConfigs = {};

// Load saved bots
function loadSavedBots() {
  try {
    if (fs.existsSync('./bots.json')) {
      const data = fs.readFileSync('./bots.json', 'utf8');
      botConfigs = JSON.parse(data);
      console.log('Loaded saved bots:', Object.keys(botConfigs).length);
    }
  } catch (error) {
    console.error('Error loading saved bots:', error);
  }
}

// Save bot configurations
function saveBotConfigs() {
  try {
    fs.writeFileSync('./bots.json', JSON.stringify(botConfigs, null, 2));
  } catch (error) {
    console.error('Error saving bot configs:', error);
  }
}

// Create Minecraft bot
function createMinecraftBot(username, server, port = 25565, password = '', version = null, channelId) {
  // Check if bot already exists
  if (activeBots[username]) {
    return { success: false, message: `Bot ${username} is already running` };
  }

  const options = {
    host: server,
    port: parseInt(port),
    username: username,
    version: version || null,
    auth: 'offline'
  };

  // Create the bot
  const bot = mineflayer.createBot(options);
  
  // Set up bot configuration
  const botConfig = {
    username,
    server,
    port,
    password,
    version,
    channelId,
    features: {
      autoJump: { enabled: false, interval: 3 },
      autoReconnect: { enabled: true, interval: 5 },
      autoQueue: { enabled: false, server: '', interval: 5 },
      chatLog: { enabled: true }
    }
  };
  
  // Save bot config
  botConfigs[username] = botConfig;
  saveBotConfigs();

  // Store active bot
  activeBots[username] = {
    bot,
    config: botConfig,
    timers: {}
  };

  // Set up bot event handlers
  setupBotEventHandlers(username);

  // Handle automatic authentication if password is provided
  if (password) {
    bot.once('spawn', () => {
      setTimeout(() => {
        bot.chat(`/register ${password} ${password}`);
        setTimeout(() => {
          bot.chat(`/login ${password}`);
        }, 1000);
      }, 1000);
    });
  }

  return { success: true, message: `Bot ${username} created and connected to ${server}:${port}` };
}

// Set up bot event handlers
function setupBotEventHandlers(username) {
  const { bot, config, timers } = activeBots[username];
  const channel = client.channels.cache.get(config.channelId);

  // Message event
  bot.on('message', (message) => {
    if (config.features.chatLog.enabled && channel) {
      channel.send(`${message.toString()}`);
    }
  });

  // Error event
  bot.on('error', (error) => {
    if (channel) {
      channel.send(`Error: ${error.message}`);
    }
    console.error(`Bot ${username} error:`, error);
  });

  // Kicked event
  bot.on('kicked', (reason) => {
    if (channel) {
      channel.send(`Bot was kicked: ${reason}`);
    }
    
    // Handle reconnection
    if (config.features.autoReconnect.enabled) {
      if (channel) {
        channel.send(`Attempting to reconnect in ${config.features.autoReconnect.interval} seconds...`);
      }
      
      // Clear any existing reconnect timer
      if (timers.reconnect) {
        clearTimeout(timers.reconnect);
      }
      
      // Set reconnect timer
      timers.reconnect = setTimeout(() => {
        reconnectBot(username);
      }, config.features.autoReconnect.interval * 1000);
    }
  });

  // Set up auto jump if enabled
  setupAutoJump(username);

  // Set up auto queue if enabled
  setupAutoQueue(username);
}

// Reconnect bot
function reconnectBot(username) {
  if (!botConfigs[username]) return false;
  
  const config = botConfigs[username];
  const channel = client.channels.cache.get(config.channelId);
  
  // Remove existing bot if it exists
  if (activeBots[username]) {
    try {
      activeBots[username].bot.end();
    } catch (error) {
      console.error(`Error ending bot ${username}:`, error);
    }
    
    // Clear all timers
    Object.values(activeBots[username].timers).forEach(timer => clearInterval(timer));
    delete activeBots[username];
  }
  
  // Create a new bot with the saved configuration
  const result = createMinecraftBot(
    config.username,
    config.server,
    config.port,
    config.password,
    config.version,
    config.channelId
  );
  
  if (channel) {
    channel.send(result.message);
  }
  
  return result.success;
}

// Set up auto jump feature
function setupAutoJump(username) {
  const { bot, config, timers } = activeBots[username];
  
  // Clear existing timer if there is one
  if (timers.autoJump) {
    clearInterval(timers.autoJump);
    timers.autoJump = null;
  }
  
  // Set up new timer if enabled
  if (config.features.autoJump.enabled) {
    timers.autoJump = setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => {
          bot.setControlState('jump', false);
        }, 200);
      }
    }, config.features.autoJump.interval * 1000);
  }
}

// Set up auto queue feature
function setupAutoQueue(username) {
  const { bot, config, timers } = activeBots[username];
  
  // Clear existing timer if there is one
  if (timers.autoQueue) {
    clearInterval(timers.autoQueue);
    timers.autoQueue = null;
  }
  
  // Set up new timer if enabled
  if (config.features.autoQueue.enabled && config.features.autoQueue.server) {
    timers.autoQueue = setInterval(() => {
      bot.chat(`/play ${config.features.autoQueue.server}`);
    }, config.features.autoQueue.interval * 1000);
  }
}

// Disconnect bot
function disconnectBot(username) {
  if (!activeBots[username]) {
    return { success: false, message: `Bot ${username} is not running` };
  }
  
  try {
    // End the bot connection
    activeBots[username].bot.end();
    
    // Clear all timers
    Object.values(activeBots[username].timers).forEach(timer => clearInterval(timer));
    
    // Remove from active bots
    delete activeBots[username];
    
    return { success: true, message: `Bot ${username} has been disconnected` };
  } catch (error) {
    console.error(`Error disconnecting bot ${username}:`, error);
    return { success: false, message: `Error disconnecting bot: ${error.message}` };
  }
}

// Discord bot ready handler
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Load saved bot configurations
  loadSavedBots();
  
  // Connect all saved bots
  for (const username in botConfigs) {
    const config = botConfigs[username];
    
    // Verify channel exists
    try {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel) {
        console.error(`Channel for bot ${username} not found`);
        continue;
      }
      
      // Start the bot
      createMinecraftBot(
        config.username,
        config.server,
        config.port,
        config.password,
        config.version,
        config.channelId
      );
      
      console.log(`Started bot: ${username}`);
    } catch (error) {
      console.error(`Failed to start bot ${username}:`, error);
    }
  }
});

// Message handler
client.on('messageCreate', async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Handle bot creation in the create-bot channel
  if (message.channelId === CREATE_BOT_CHANNEL_ID) {
    if (message.content.startsWith('/create')) {
      const args = message.content.split(' ').slice(1);
      
      // Validate arguments
      if (args.length < 2) {
        return message.reply('Use /create <Username> <IP Server> <Port> <Password> <Version>');
      }
      
      const username = args[0];
      const server = args[1];
      const port = args[2] || '25565';
      const password = args[3] || '';
      const version = args[4] || null;
      
      // Validate username
      if (username.length > 16) {
        return message.reply('Username must be 16 characters or less');
      }
      
      // Create channel for the bot
      try {
        const guild = message.guild;
        const category = await client.channels.fetch(CATEGORY_ID);
        
        if (!category) {
          return message.reply('Chat category not found');
        }
        
        // Create channel
        const channel = await guild.channels.create({
          name: `${username}-${server}`,
          type: ChannelType.GuildText,
          parent: category.id
        });
        
        // Create the Minecraft bot
        const result = createMinecraftBot(username, server, port, password, version, channel.id);
        
        if (result.success) {
          message.reply(`Created Channel For: #${username}-${server}`);
          channel.send(`Bot ${username} created and connected to ${server}:${port}`);
        } else {
          message.reply(result.message);
          // Delete channel if bot creation failed
          await channel.delete();
        }
      } catch (error) {
        console.error('Error creating channel:', error);
        message.reply(`Error creating bot: ${error.message}`);
      }
    } else {
      message.reply('Use /create <Username> <IP Server> <Port> <Password> <Version>');
    }
    return;
  }
  
  // Handle commands in bot channels
  for (const username in botConfigs) {
    const config = botConfigs[username];
    
    if (message.channelId === config.channelId) {
      // Feature commands
      if (message.content.startsWith('/')) {
        const [command, ...args] = message.content.slice(1).split(' ');
        
        switch (command) {
          case 'ajump': {
            // Auto jump command
            if (args.length < 1) {
              return message.reply('Usage: /ajump on/off <seconds>');
            }
            
            const enabled = args[0].toLowerCase() === 'on';
            const interval = args[1] ? parseInt(args[1]) : config.features.autoJump.interval;
            
            // Update config
            config.features.autoJump.enabled = enabled;
            config.features.autoJump.interval = interval;
            
            // Apply changes
            if (activeBots[username]) {
              setupAutoJump(username);
            }
            
            // Save config
            saveBotConfigs();
            
            message.reply(`Auto jump ${enabled ? 'enabled' : 'disabled'} with interval of ${interval} seconds`);
            break;
          }
          
          case 'areconnect': {
            // Auto reconnect command
            if (args.length < 1) {
              return message.reply('Usage: /areconnect on/off');
            }
            
            const enabled = args[0].toLowerCase() === 'on';
            
            // Update config
            config.features.autoReconnect.enabled = enabled;
            
            // Save config
            saveBotConfigs();
            
            message.reply(`Auto reconnect ${enabled ? 'enabled' : 'disabled'}`);
            break;
          }
          
          case 'aqueue': {
            // Auto queue command
            if (args.length < 1) {
              return message.reply('Usage: /aqueue on/off <server>');
            }
            
            const enabled = args[0].toLowerCase() === 'on';
            const server = args[1] || config.features.autoQueue.server;
            
            // Update config
            config.features.autoQueue.enabled = enabled;
            if (server) {
              config.features.autoQueue.server = server;
            }
            
            // Apply changes
            if (activeBots[username]) {
              setupAutoQueue(username);
            }
            
            // Save config
            saveBotConfigs();
            
            message.reply(`Auto queue ${enabled ? 'enabled' : 'disabled'}${server ? ` for server ${server}` : ''}`);
            break;
          }
          
          case 'chatlog': {
            // Chat log command
            if (args.length < 1) {
              return message.reply('Usage: /chatlog on/off');
            }
            
            const enabled = args[0].toLowerCase() === 'on';
            
            // Update config
            config.features.chatLog.enabled = enabled;
            
            // Save config
            saveBotConfigs();
            
            message.reply(`Chat log ${enabled ? 'enabled' : 'disabled'}`);
            break;
          }
          
          case 'disconnect': {
            // Disconnect command
            const result = disconnectBot(username);
            message.reply(result.message);
            break;
          }
          
          case 'connect': {
            // Connect command
            const result = reconnectBot(username);
            if (!result) {
              message.reply(`Failed to reconnect bot ${username}`);
            }
            break;
          }
          
          default: {
            // Forward any other command to Minecraft
            if (activeBots[username] && activeBots[username].bot.entity) {
              activeBots[username].bot.chat(`/${command} ${args.join(' ')}`);
              message.react('✅');
            } else {
              message.reply('Bot is not connected');
            }
          }
        }
      } else {
        // Regular chat
        if (activeBots[username] && activeBots[username].bot.entity) {
          activeBots[username].bot.chat(message.content);
          message.react('✅');
        } else {
          message.reply('Bot is not connected');
        }
      }
      
      return;
    }
  }
});

// Handle process exit
process.on('SIGINT', () => {
  console.log('Shutting down...');
  
  // Disconnect all bots
  for (const username in activeBots) {
    try {
      activeBots[username].bot.end();
    } catch (error) {
      console.error(`Error disconnecting bot ${username}:`, error);
    }
  }
  
  // Exit
  process.exit(0);
});

// Login to Discord
client.login(DISCORD_TOKEN);