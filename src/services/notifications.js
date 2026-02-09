import { getRulesChannels } from '../config.js';

export function getRulesConfigForChannel(channelId) {
    const channels = getRulesChannels();
    const id = String(channelId);
    return channels.find((c) => String(c.channelId) === id);
}

function buildRoleMentions(guild, notifyRoleIds) {
    const mentions = [];
    for (const roleId of notifyRoleIds || []) {
        if (roleId === 'everyone') mentions.push('@everyone');
        else {
            const role = guild.roles.cache.get(roleId);
            if (role) mentions.push(role.toString());
        }
    }
    return mentions.join(' ');
}

function slice(str, max) {
    if (!str || str.length <= max) return str || '*пусто*';
    return str.slice(0, max - 3) + '...';
}

export async function notifyRolesAboutRuleUpdate(
    guild,
    targetChannel,
    rulesChannelMention,
    notifyRoleIds,
    oldContent,
    newContent
) {
    const mentionText = buildRoleMentions(guild, notifyRoleIds);
    const embed = {
        color: 0x5865f2,
        title: 'Обновление правил',
        description: `Правила в канале ${rulesChannelMention} были изменены.`,
        fields: [
            { name: 'Было', value: slice(oldContent, 1024), inline: false },
            { name: 'Стало', value: slice(newContent, 1024), inline: false },
        ],
        timestamp: new Date().toISOString(),
    };
    await targetChannel.send({
        content: mentionText || undefined,
        embeds: [embed],
    });
}

export async function notifyNewRule(guild, targetChannel, rulesChannelMention, notifyRoleIds, content) {
    const mentionText = buildRoleMentions(guild, notifyRoleIds);
    const embed = {
        color: 0x57f287,
        title: 'Добавлено новое правило',
        description: `В канале ${rulesChannelMention} опубликовано новое правило.`,
        fields: [{ name: 'Текст', value: slice(content, 1024), inline: false }],
        timestamp: new Date().toISOString(),
    };
    await targetChannel.send({
        content: mentionText || undefined,
        embeds: [embed],
    });
}
