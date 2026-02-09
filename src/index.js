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
  addForbiddenWord,
  removeForbiddenWord,
} from './config.js';
import { loadViolationCounts, saveViolationCounts, cleanupOldViolations, loadPunishments, savePunishments } from './data.js';
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
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let userViolationCounts = new Map(); // userId -> { count, lastViolationDate }
let punishedUsersDatabase = new Map(); // userId -> { tag, roleIds }
let emptyContentWarned = false;

// Function to sync local DB with Discord roles
async function syncPunishmentsWithDiscord(guild) {
  log('Синхронизация базы наказаний с Discord...');
  const config = getAccessControlConfig();
  if (!config) return;

  const rolesToWatch = Object.values(config.targetRoles);
  const newPunishedMap = new Map();

  try {
    // Try to fetch members with a slightly longer wait if we hitting rate limits
    const members = await guild.members.fetch().catch(async (err) => {
      if (err.name === 'GatewayRateLimitError') {
        const retryAfter = (err.data?.retry_after || 5) * 1000;
        warn(`Rate limited during sync. Retrying in ${retryAfter / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter + 1000));
        return guild.members.fetch();
      }
      throw err;
    });

    members.forEach(m => {
      const foundRoles = rolesToWatch.filter(id => m.roles.cache.has(id));
      if (foundRoles.length > 0) {
        newPunishedMap.set(m.id, {
          tag: m.user.tag,
          roleIds: foundRoles
        });
      }
    });

    punishedUsersDatabase = newPunishedMap;
    await savePunishments(punishedUsersDatabase);
    log(`Синхронизация завершена. Найдено наказанных: ${punishedUsersDatabase.size}`);
  } catch (err) {
    error('Ошибка при синхронизации наказаний (0x1):', err);
    punishedUsersDatabase = await loadPunishments();
    log(`Использую локальную базу (найдено: ${punishedUsersDatabase.size})`);
  }
}

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

  punishedUsersDatabase = await loadPunishments();

  // Sync on startup (only if we can find a guild)
  const GUILD_ID = '1220681422583496794';
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (guild) {
    await syncPunishmentsWithDiscord(guild);
  }

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

  const config = getAccessControlConfig();
  const aiConfig = getAIConfig();

  // Helper: check if user is admin or has one of the allowed roles
  const isAuthorized = (member) => {
    if (member.permissions.has(GatewayIntentBits.Administrator)) return true;
    if (!config) return false;
    return member.roles.cache.some(role => config.allowedRoleIds.includes(role.id));
  };

  const commandName = interaction.commandName;

  // 1. Access Control Logic for ALL commands except /my-stats
  if (commandName !== 'my-stats') {
    // Check Channel Restriction (only for moderation commands)
    const modCommands = ['chsp', 'chs', 'btd', 'forgive', 'punishments', 'warns', 'clear-warns', 'unmute', 'words'];
    if (modCommands.includes(commandName) && config && interaction.channelId !== config.allowedChannelId) {
      return interaction.reply({ content: 'Эту команду нельзя использовать в этом канале.', ephemeral: true });
    }

    // Check Permissions
    if (!isAuthorized(interaction.member)) {
      return interaction.reply({ content: 'У вас нет прав на использование этой команды.', ephemeral: true });
    }
  }

  // Handle Commands
  try {
    if (commandName === 'ask') {
      if (!aiConfig) return interaction.reply({ content: 'AI configuration missing.', ephemeral: true });

      const memberRoles = interaction.member.roles.cache;
      const hasAIRole = memberRoles.some((role) => aiConfig.allowedRoleIds.includes(role.id));
      if (!hasAIRole && !interaction.member.permissions.has(GatewayIntentBits.Administrator)) {
        return interaction.reply({ content: 'У вас нет прав на использование команды /ask.', ephemeral: true });
      }

      await interaction.deferReply();
      const question = interaction.options.getString('question');
      const answer = await askAI(question);

      if (answer.length > 2000) {
        await interaction.editReply({ content: answer.slice(0, 2000) });
        if (answer.length > 2000) await interaction.followUp({ content: answer.slice(2000, 4000) });
      } else {
        await interaction.editReply({ content: answer });
      }

    } else if (['chsp', 'chs', 'btd', 'forgive'].includes(commandName)) {
      const targetMember = interaction.options.getMember('user');
      const reason = interaction.options.getString('reason');

      if (!targetMember) return interaction.reply({ content: 'Пользователь не найден.', ephemeral: true });

      const botMember = interaction.guild.members.me;

      if (targetMember.roles.highest.position >= interaction.member.roles.highest.position && !interaction.member.permissions.has(GatewayIntentBits.Administrator)) {
        return interaction.reply({ content: 'Нельзя применить/снять санкции к пользователю с ролью выше или равной вашей.', ephemeral: true });
      }

      await interaction.deferReply();

      try {
        if (commandName === 'forgive') {
          const rolesToRemove = Object.values(config.targetRoles).filter(id => targetMember.roles.cache.has(id));

          // Only remove roles that the bot is physically allowed to (below its highest role)
          const manageableRolesToRemove = rolesToRemove.filter(id => {
            const role = interaction.guild.roles.cache.get(id);
            return role && role.position < botMember.roles.highest.position;
          });

          if (manageableRolesToRemove.length > 0) {
            await targetMember.roles.remove(manageableRolesToRemove, `Command /forgive by ${interaction.user.tag}: ${reason}`);
          }

          // Update local database
          punishedUsersDatabase.delete(targetMember.id);
          await savePunishments(punishedUsersDatabase);

          const embed = {
            title: 'Снятие наказаний',
            color: 0x00ff00,
            fields: [
              { name: 'Пользователь', value: `${targetMember} (${targetMember.id})`, inline: true },
              { name: 'Модератор', value: `${interaction.user} (${interaction.user.id})`, inline: true },
              { name: 'Причина', value: reason, inline: false },
              { name: 'Снятые роли', value: manageableRolesToRemove.length > 0 ? manageableRolesToRemove.map(id => `<@&${id}>`).join(', ') : 'Нет активных ролей наказания (или недостаточно прав для снятия)', inline: false }
            ],
            timestamp: new Date().toISOString(),
          };
          await interaction.editReply({ embeds: [embed] });
        } else {
          const targetRoleId = config.targetRoles[commandName];
          if (!targetRoleId) return interaction.editReply({ content: `ID роли для "${commandName}" не найден.` });

          const targetRole = interaction.guild.roles.cache.get(targetRoleId);
          if (targetRole && targetRole.position >= botMember.roles.highest.position) {
            return interaction.editReply({ content: `Ошибка: Роль наказания (${targetRole.name}) выше или на одном уровне с ролью бота. Передвиньте роль бота выше в настройках сервера.` });
          }

          // Strip all roles that are manageable by the bot
          const rolesToRemove = targetMember.roles.cache.filter((r) =>
            !r.managed &&
            r.name !== '@everyone' &&
            r.id !== targetRoleId &&
            r.position < botMember.roles.highest.position
          );

          if (rolesToRemove.size > 0) await targetMember.roles.remove(rolesToRemove, `Command /${commandName} by ${interaction.user.tag}`);
          await targetMember.roles.add(targetRoleId, `Command /${commandName} by ${interaction.user.tag}: ${reason}`);

          // Update local database
          const existingData = punishedUsersDatabase.get(targetMember.id);
          const currentRoleIds = existingData ? existingData.roleIds : [];
          if (!currentRoleIds.includes(targetRoleId)) {
            currentRoleIds.push(targetRoleId);
          }
          punishedUsersDatabase.set(targetMember.id, {
            tag: targetMember.user.tag,
            roleIds: currentRoleIds
          });
          await savePunishments(punishedUsersDatabase);

          const embed = {
            title: `Выдано наказание: ${commandName.toUpperCase()}`,
            color: 0xff0000,
            fields: [
              { name: 'Пользователь', value: `${targetMember} (${targetMember.id})`, inline: true },
              { name: 'Модератор', value: `${interaction.user} (${interaction.user.id})`, inline: true },
              { name: 'Причина', value: reason, inline: false },
            ],
            timestamp: new Date().toISOString(),
          };
          await interaction.editReply({ embeds: [embed] });
        }
      } catch (err) {
        error(`Error managing roles for ${targetMember.user.tag}:`, err);
        await interaction.editReply({ content: `Ошибка при выдаче/снятии роли: ${err.message}` });
      }

    } else if (commandName === 'punishments') {
      await interaction.deferReply();

      const punishedLines = [];
      for (const [userId, data] of punishedUsersDatabase) {
        punishedLines.push(`${data.tag} (${userId}) — ${data.roleIds.map(id => `<@&${id}>`).join(', ')}`);
      }

      const embed = {
        title: 'Список наказанных пользователей (База данных)',
        description: punishedLines.length > 0 ? punishedLines.join('\n') : 'На данный момент в базе нет пользователей с ролями наказаний.',
        color: 0x5865f2,
        timestamp: new Date().toISOString(),
      };
      await interaction.editReply({ embeds: [embed] });

    } else if (commandName === 'warns') {
      const targetUser = interaction.options.getUser('user');
      const data = userViolationCounts.get(targetUser.id) || { count: 0 };
      await interaction.reply({ content: `У пользователя **${targetUser.tag}** всего нарушений: **${data.count}**.` });

    } else if (commandName === 'clear-warns') {
      const targetUser = interaction.options.getUser('user');
      if (userViolationCounts.has(targetUser.id)) {
        userViolationCounts.delete(targetUser.id);
        await saveViolationCounts(userViolationCounts);
        await interaction.reply({ content: `Счетчик нарушений для **${targetUser.tag}** успешно сброшен.` });
      } else {
        await interaction.reply({ content: `У пользователя **${targetUser.tag}** нет записанных нарушений.` });
      }

    } else if (commandName === 'unmute') {
      const targetMember = interaction.options.getMember('user');
      if (!targetMember) return interaction.reply({ content: 'Пользователь не найден.', ephemeral: true });
      if (!targetMember.communicationDisabledUntilTimestamp) return interaction.reply({ content: 'Пользователь не находится в муте (тайм-ауте).', ephemeral: true });

      try {
        await targetMember.timeout(null, `Command /unmute by ${interaction.user.tag}`);
        await interaction.reply({ content: `Мут с пользователя **${targetMember.user.tag}** успешно снят.` });
      } catch (err) {
        await interaction.reply({ content: `Не удалось снять мут: ${err.message}` });
      }

    } else if (commandName === 'words') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const words = getForbiddenWords();
        await interaction.reply({ content: `**Список запрещенных слов:**\n${words.length > 0 ? words.join(', ') : 'Список пуст.'}` });
      } else if (sub === 'add') {
        const word = interaction.options.getString('word').toLowerCase().trim();
        if (addForbiddenWord(word)) {
          await interaction.reply({ content: `Слово "${word}" успешно добавлено в список.` });
        } else {
          await interaction.reply({ content: `Слово "${word}" уже есть в списке.` });
        }
      } else if (sub === 'remove') {
        const word = interaction.options.getString('word').toLowerCase().trim();
        if (removeForbiddenWord(word)) {
          await interaction.reply({ content: `Слово "${word}" успешно удалено из списка.` });
        } else {
          await interaction.reply({ content: `Слово "${word}" не найдено в списке.` });
        }
      }

    } else if (commandName === 'user-info') {
      const targetMember = interaction.options.getMember('user');
      const data = userViolationCounts.get(targetMember.id) || { count: 0 };

      const embed = {
        title: `Информация о пользователе ${targetMember.user.tag}`,
        thumbnail: { url: targetMember.user.displayAvatarURL() },
        color: 0x5865f2,
        fields: [
          { name: 'ID', value: targetMember.id, inline: true },
          { name: 'На сервере с', value: `<t:${Math.floor(targetMember.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Аккаунт создан', value: `<t:${Math.floor(targetMember.user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Нарушений (авто)', value: `${data.count}`, inline: true },
          { name: 'В муте до', value: targetMember.communicationDisabledUntilTimestamp ? `<t:${Math.floor(targetMember.communicationDisabledUntilTimestamp / 1000)}:F>` : 'Нет', inline: false },
          { name: 'Роли', value: targetMember.roles.cache.filter(r => r.name !== '@everyone').map(r => r.toString()).join(', ') || 'Нет ролей', inline: false },
        ],
        timestamp: new Date().toISOString(),
      };
      await interaction.reply({ embeds: [embed] });

    } else if (commandName === 'ping') {
      const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      await interaction.editReply({ content: `Задержка: **${latency}ms**. API Latency: **${Math.round(client.ws.ping)}ms**.` });

    } else if (commandName === 'my-stats') {
      const data = userViolationCounts.get(interaction.user.id) || { count: 0 };
      await interaction.reply({ content: `Ваша статистика нарушений: **${data.count}**.`, ephemeral: true });
    }

  } catch (err) {
    let errorCode = '0x0';
    if (err.name === 'GatewayRateLimitError') errorCode = '0x1';
    else if (err.code === 50013) errorCode = '0x2'; // Missing Permissions
    else if (err.code === 10007) errorCode = '0x3'; // Unknown Member
    else if (err.code === 50001) errorCode = '0x4'; // Missing Access
    else if (err.code === 10008) errorCode = '0x5'; // Unknown Message
    else if (err.code === 30005) errorCode = '0x6'; // Max Guild Roles
    else if (err.code === 40002) errorCode = '0x7'; // Unauthorized
    else if (err.code === 50033) errorCode = '0x8'; // Invalid Recipient
    else if (err.code === 50035) errorCode = '0x9'; // Invalid Form Body
    else if (err.message && err.message.toLowerCase().includes('ai')) errorCode = '0x10'; // AI Service Error
    else if (err.message && err.message.toLowerCase().includes('config')) errorCode = '0x11'; // Config Error

    error(`Error executing /${commandName} (${errorCode}):`, err);

    const userMessage = `Произошла внутренняя ошибка. Код ошибки: ${errorCode}`;

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: userMessage });
    } else {
      await interaction.reply({ content: userMessage, ephemeral: true });
    }
  }
});

client.login(TOKEN).catch((err) => {
  error('Login failed:', err);
  process.exit(1);
});
