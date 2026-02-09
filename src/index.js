import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import {
  loadConfig,
  getForbiddenWords,
  getRulesChannels,
  getMuteReportsChannelId,
  getForumAppealChannels,
  getAppealSuccessMessage,
  getMuteDurations,
  getAccessControlConfig,
} from './config.js';
import { loadViolationCounts, saveViolationCounts, cleanupOldViolations } from './data.js';
import { log, warn, error } from './utils/logger.js';
import {
  containsForbiddenWord,
  tryMuteMember,
  checkAppealConformsToTemplates
} from './services/moderation.js';
import {
  getRulesConfigForChannel,
  notifyRolesAboutRuleUpdate,
  notifyNewRule
} from './services/notifications.js';
import { initAI, askAI } from './services/ai.js';
import { getAIConfig } from './config.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!TOKEN) {
  error('Укажите DISCORD_BOT_TOKEN в .env');
  process.exit(1);
}

let configPath = process.env.CONFIG_PATH || null;
loadConfig(configPath);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let userViolationCounts = new Map(); // userId -> { count, lastViolationDate }
let emptyContentWarned = false;

// ——— Обработчики ———

client.once('clientReady', async () => {
  log(`Бот запущен: ${client.user.tag}`);

  const words = getForbiddenWords();
  log(`Банворды (${words.length}): ${words.length ? 'Загружены' : '— список пуст'}`);

  const rules = getRulesChannels();
  log(`Отслеживаю ${rules.length} канал(ов) правил: ${rules.map((r) => r.channelId).join(', ')}`);

  if (words.length === 0) warn('В config.json нет запрещённых слов — добавьте их в "forbiddenWords".');
  log('Если бот не реагирует на слова: убедитесь, что включен MESSAGE CONTENT INTENT.');

  userViolationCounts = await loadViolationCounts();
  log(`Загружено нарушителей: ${userViolationCounts.size}`);

  // Cleanup old violations on startup
  userViolationCounts = await cleanupOldViolations(userViolationCounts);

  // Schedule cleanup every 24 hours
  setInterval(async () => {
    userViolationCounts = await cleanupOldViolations(userViolationCounts);
  }, 24 * 60 * 60 * 1000);

  // Initialize AI Service
  await initAI(client);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // log('messageCreate', message.channel?.id, message.content?.slice(0, 50)); 
  // Commented out verbose logging to reduce noise, unless debug is needed.

  if (!message.content || message.content.trim() === '') {
    if (!emptyContentWarned) {
      emptyContentWarned = true;
      warn('Бот получает сообщения БЕЗ ТЕКСТА. Включите MESSAGE CONTENT INTENT.');
    }
    return;
  }

  // 1. Проверка на запрещенные слова
  const { found, word } = containsForbiddenWord(message.content);
  if (found) {
    const userId = message.author.id;
    let userData = userViolationCounts.get(userId) || { count: 0, lastViolationDate: 0 };

    // Increment violation count
    userData.count++;
    userData.lastViolationDate = Date.now();

    userViolationCounts.set(userId, userData);
    await saveViolationCounts(userViolationCounts); // Async save

    const MUTE_DURATIONS_MINUTES = getMuteDurations();
    const currentDurationMinutes =
      MUTE_DURATIONS_MINUTES[userData.count - 1] ||
      MUTE_DURATIONS_MINUTES[MUTE_DURATIONS_MINUTES.length - 1];

    const durationMs = currentDurationMinutes * 60 * 1000;
    const reason = `[Auto] Forbidden word («${word}»). Violation #${userData.count}.`;

    try {
      const muted = await tryMuteMember(message.member, durationMs, reason);
      if (muted) {
        await message.delete().catch(() => { });
        const reply = await message.channel.send(
          `${message.author}, вы получили мут на **${currentDurationMinutes} мин.** за использование запрещённого слова (нарушение #${userData.count}).`
        );
        setTimeout(() => reply.delete().catch(() => { }), 10000);
        log(`Mute: ${message.author.tag} in #${message.channel?.name} for ${currentDurationMinutes}m. Word: "${word}". Violation #${userData.count}`);

        const muteReportsChannelId = getMuteReportsChannelId();
        if (muteReportsChannelId) {
          const reportsChannel = await client.channels.fetch(muteReportsChannelId).catch((e) => {
            error('Failed to fetch mute reports channel', muteReportsChannelId, e.message);
            return null;
          });
          if (reportsChannel && reportsChannel.isTextBased()) {
            const reportEmbed = {
              color: 0xff0000,
              title: 'Отчёт об автоматическом муте',
              fields: [
                { name: 'Пользователь', value: message.author.tag, inline: true },
                { name: 'ID пользователя', value: message.author.id, inline: true },
                { name: 'Канал', value: message.channel.toString(), inline: true },
                { name: 'Обнаруженное слово', value: word, inline: true },
                { name: 'Длительность', value: `${currentDurationMinutes} мин.`, inline: true },
                { name: 'Нарушение', value: `#${userData.count}`, inline: true },
                { name: 'Время', value: new Date().toISOString(), inline: false },
              ],
            };
            await reportsChannel.send({ embeds: [reportEmbed] }).catch(error);
          }
        }
      } else {
        warn(`Failed to mute ${message.author.tag}: Check permissions or role hierarchy.`);
      }
    } catch (err) {
      error('Error during mute process:', err);
    }
    return;
  }

  // 2. Уведомление о новых правилах (если сообщение в канале правил)
  const rulesConfig = getRulesConfigForChannel(message.channel.id);
  if (rulesConfig) {
    const targetChannelId = rulesConfig.notificationChannelId ?? message.channel.id;
    const targetChannel =
      String(targetChannelId) === String(message.channel.id)
        ? message.channel
        : await client.channels.fetch(targetChannelId).catch(() => null);
    if (targetChannel) {
      try {
        await notifyNewRule(
          message.guild,
          targetChannel,
          message.channel.toString(),
          rulesConfig.notifyRoleIds,
          message.content
        );
        log(`Rule notification (new) sent to ${targetChannel.name} (${targetChannel.id})`);
      } catch (err) {
        error('Error notifying about new rule:', err);
      }
    }
  }

  // 3. Проверка апелляций в форумных каналах
  if (message.channel.isThread() && message.channel.parent && message.channel.id === message.id) {
    const forumChannelId = String(message.channel.parent.id);
    const forumConfig = getForumAppealChannels().find(f => String(f.channelId) === forumChannelId);

    if (forumConfig) {
      // Check if it's the first message of a new thread
      const botReply = await message.reply({ content: "# Проверка формата..." });

      if (checkAppealConformsToTemplates(message.content)) {
        setTimeout(async () => {
          try {
            await botReply.edit({ content: getAppealSuccessMessage() });
            log(`Appeal verified in ${message.channel.name}`);
          } catch (err) {
            error('Error editing verification message:', err);
          }
        }, 3000); // 3 seconds delay should be enough
      } else {
        setTimeout(async () => {
          try {
            await botReply.edit({ content: forumConfig.warningMessage });
            log(`Appeal warning sent in ${message.channel.name}`);
          } catch (err) {
            error('Error sending appeal warning:', err);
          }
        }, 3000);

      }
    }
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.partial) await newMessage.fetch().catch(() => null);
  if (oldMessage.partial) await oldMessage.fetch().catch(() => null);

  if (!newMessage.guild) return;

  const rulesChannel = newMessage.channel;
  const channelId = rulesChannel?.id;

  const rulesConfig = getRulesConfigForChannel(channelId);
  if (!rulesConfig) return; // Not a rules channel

  const oldContent = oldMessage.content ?? '';
  const newContent = newMessage.content ?? '';
  if (oldContent === newContent) return;

  const targetChannelId = rulesConfig.notificationChannelId ?? rulesChannel.id;
  const targetChannel =
    String(targetChannelId) === String(rulesChannel.id)
      ? rulesChannel
      : await client.channels.fetch(targetChannelId).catch((e) => {
        error('Failed to fetch notification channel', targetChannelId, e.message);
        return null;
      });

  if (!targetChannel) return;

  try {
    await notifyRolesAboutRuleUpdate(
      rulesChannel.guild,
      targetChannel,
      rulesChannel.toString(),
      rulesConfig.notifyRoleIds,
      oldContent,
      newContent
    );
    log(`Rule notification (update) sent to ${targetChannel.name} (${targetChannel.id})`);
  } catch (err) {
    error('Error notifying about rule update:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ask') {
    const aiConfig = getAIConfig();
    if (!aiConfig) {
      return interaction.reply({ content: 'AI configuration missing.', ephemeral: true });
    }

    const memberRoles = interaction.member.roles.cache;
    const hasAllowedRole = memberRoles.some((role) => aiConfig.allowedRoleIds.includes(role.id));

    if (!hasAllowedRole) {
      return interaction.reply({ content: 'У вас нет прав на использование команды /ask.', ephemeral: true });
    }

    await interaction.deferReply();
    const question = interaction.options.getString('question');

    try {
      const answer = await askAI(question);

      // Truncate if too long for a single message, though Discord limit is 2000. 
      // Embed description limit is 4096.
      if (answer.length > 2000) {
        // Split or send file? For simplicity, truncate.
        await interaction.editReply({ content: answer.slice(0, 2000) });
        if (answer.length > 2000) {
          await interaction.followUp({ content: answer.slice(2000, 4000) });
        }
      } else {
        await interaction.editReply({ content: answer });
      }
    } catch (err) {
      error('Error handling /ask:', err);
      await interaction.editReply({ content: 'Произошла ошибка при генерации ответа.' });
    }
    return;
  }

  const config = getAccessControlConfig();
  if (!config) return;

  const validCommands = ['chsp', 'chs', 'btd', 'forgive'];
  if (!validCommands.includes(interaction.commandName)) return;

  // 1. Check Channel
  if (interaction.channelId !== config.allowedChannelId) {
    return interaction.reply({ content: 'Эту команду нельзя использовать в этом канале.', ephemeral: true });
  }

  // 2. Check Permissions (Role)
  const memberRoles = interaction.member.roles.cache;
  const hasAllowedRole = memberRoles.some((role) => config.allowedRoleIds.includes(role.id));

  if (!hasAllowedRole) {
    return interaction.reply({ content: 'У вас нет прав на использование этой команды (роль не подходит).', ephemeral: true });
  }

  const targetUser = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason');

  if (!targetUser) {
    return interaction.reply({ content: 'Пользователь не найден (возможно, вышел с сервера).', ephemeral: true });
  }

  // Classic protection
  if (targetUser.roles.highest.position >= interaction.member.roles.highest.position) {
    return interaction.reply({ content: 'Нельзя применить/снять санкции к пользователю с ролью выше или равной вашей.', ephemeral: true });
  }

  const commandName = interaction.commandName;

  await interaction.deferReply();

  try {
    if (commandName === 'forgive') {
      const rolesToRemove = Object.values(config.targetRoles).filter(id => targetUser.roles.cache.has(id));

      if (rolesToRemove.length > 0) {
        await targetUser.roles.remove(rolesToRemove, `Command /forgive by ${interaction.user.tag}: ${reason}`);
      }

      const embed = {
        title: 'Снятие наказаний',
        color: 0x00ff00, // Green
        fields: [
          { name: 'Пользователь', value: `${targetUser} (${targetUser.id})`, inline: true },
          { name: 'Модератор', value: `${interaction.user} (${interaction.user.id})`, inline: true },
          { name: 'Причина', value: reason, inline: false },
          { name: 'Снятые роли', value: rolesToRemove.length > 0 ? rolesToRemove.map(id => `<@&${id}>`).join(', ') : 'Нет активных ролей наказания', inline: false }
        ],
        timestamp: new Date().toISOString(),
      };

      await interaction.editReply({ embeds: [embed] });
      log(`Command /forgive executed on ${targetUser.user.tag} by ${interaction.user.tag}`);

    } else {
      // chsp, chs, btd logic
      const targetRoleId = config.targetRoles[commandName];

      if (!targetRoleId) {
        return interaction.editReply({ content: `Ошибка конфигурации: ID роли для "${commandName}" не найден.` });
      }

      // 3. Remove all roles (except managed and @everyone)
      const rolesToRemove = targetUser.roles.cache.filter((r) => !r.managed && r.name !== '@everyone' && r.id !== targetRoleId);

      if (rolesToRemove.size > 0) {
        await targetUser.roles.remove(rolesToRemove, `Command /${commandName} by ${interaction.user.tag}`);
      }

      // 4. Add specific role
      await targetUser.roles.add(targetRoleId, `Command /${commandName} by ${interaction.user.tag}: ${reason}`);

      // 5. Send Output
      const embed = {
        title: `Выдано наказание: ${commandName.toUpperCase()}`,
        color: 0xff0000,
        fields: [
          { name: 'Пользователь', value: `${targetUser} (${targetUser.id})`, inline: true },
          { name: 'Модератор', value: `${interaction.user} (${interaction.user.id})`, inline: true },
          { name: 'Причина', value: reason, inline: false },
        ],
        timestamp: new Date().toISOString(),
      };

      await interaction.editReply({ embeds: [embed] });
      log(`Command /${commandName} executed on ${targetUser.user.tag} by ${interaction.user.tag}`);
    }

  } catch (err) {
    error(`Error executing /${commandName}:`, err);
    await interaction.editReply({ content: `Произошла ошибка при выполнении: ${err.message}` });
  }
});

client.login(TOKEN).catch((err) => {
  error('Login failed:', err);
  process.exit(1);
});
