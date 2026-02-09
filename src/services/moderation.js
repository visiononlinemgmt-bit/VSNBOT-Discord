import { PermissionFlagsBits } from 'discord.js';
import { getForbiddenWords, getDefaultAppealTemplates } from '../config.js';

export function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .normalize('NFD') // Decompose combined characters
        .replace(/[\u0300-\u036f]/g, "") // Remove combining diacritical marks
        .replace(/[^a-zа-я0-9\s]/g, '') // Remove most punctuation/symbols (leaving spaces for now)
        .replace(/\s+/g, '') // Remove all whitespace for deep matching
        .replace(/(.)\1+/g, '$1') // Collapse repeated characters: "ппииддоор" -> "пидор"
        .trim();
}

export function containsForbiddenWord(content) {
    const normalized = normalizeText(content);
    const words = getForbiddenWords();
    for (const word of words) {
        // Escape regex special characters in the word just in case
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Look for the word with boundaries or surrounded by non-letter characters if possible, 
        // but the original logic was just .includes. 
        // Let's stick to the improved normalization but similar logic for now to avoid breaking changes,
        // but we normalized the input heavily. 

        const normalizedWord = normalizeText(word);
        if (!normalizedWord) continue;

        if (normalized.includes(normalizedWord)) return { found: true, word: word };
    }
    return { found: false };
}

export async function tryMuteMember(member, durationMs, reason) {
    if (!member.moderatable) return false;
    const botMember = member.guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) return false;
    if (member.roles.highest.position >= botMember.roles.highest.position) return false;

    try {
        await member.timeout(durationMs, reason);
        return true;
    } catch (e) {
        console.error("Failed to mute member:", e);
        return false;
    }
}

const APPEAL_TEMPLATES = [
    {
        name: 'General Ban Appeal',
        keywords: [
            ['ваш', 'никнейм', 'discord', 'id'],
            ['кем', 'была', 'выдана', 'блокировка'],
            ['причина', 'блокировки'],
            ['дата', 'получения', 'блокировки'],
            ['опишите', 'ситуацию'],
            ['почему', 'мы', 'должны', 'снять', 'чс'],
            ['признаете', 'ли', 'вы', 'свою', 'вину'],
            ['дополнительные', 'материалы']
        ]
    },
    {
        name: 'Blacklist Appeal',
        keywords: [
            ['ваш', 'актуальный', 'discord', 'id'],
            ['точная', 'причина', 'занесения', 'чсп'],
            ['срок', 'нахождения', 'чсп'],
            ['подробное', 'признание', 'вины'],
            ['какой', 'ущерб', 'был', 'нанесен'],
            ['что', 'вы', 'сделали', 'чтобы', 'исправить'],
            ['с', 'какой', 'целью', 'хотите', 'вернуться'],
            ['особое', 'обязательство']
        ]
    },
    {
        name: 'Termination Appeal',
        keywords: [
            ['личные', 'данные'],
            ['обстоятельства', 'терминации'],
            ['детальное', 'описание', 'нарушения'],
            ['мотивация', 'действий'],
            ['оценка', 'нанесенного', 'ущерба'],
            ['материалы', 'для', 'возврата'],
            ['гарантии', 'безопасности']
        ]
    }
];

function checkTemplateMatch(normalizedContent, templateKeywords) {
    let matches = 0;
    for (const phraseGroup of templateKeywords) {
        // Check if *all* keywords in this line/group exist in the content (in any order, roughly close to each other would be ideal but simple presence is usually enough for "smart" check)
        // For stricter check: we can require them to be somewhat close or just present. 
        // Given the prompt asks for "not 100% match", simple presence of key terms is robust.

        // Strategy: Check if the normalized content contains the keywords for this line.
        // If a line is "Ваш никнейм и Discord ID", keywords are ["ваш", "никнейм", "discord", "id"].
        // If the user writes "1. Мой никнейм такой-то", it matches "никнейм".
        // Let's require at least 2/3rds of the keywords in a group to match that "line".

        const keywordsInGroup = phraseGroup.length;
        let groupMatches = 0;
        for (const keyword of phraseGroup) {
            if (normalizedContent.includes(keyword)) {
                groupMatches++;
            }
        }

        // If > 50% of keywords in this line are found, we consider the line "found"
        if (groupMatches / keywordsInGroup >= 0.5) {
            matches++;
        }
    }

    // Return the percentage of lines matched
    return matches / templateKeywords.length;
}

export function checkAppealConformsToTemplates(content) {
    const normalizedContent = normalizeText(content);

    // Check against all templates
    for (const template of APPEAL_TEMPLATES) {
        const matchPercentage = checkTemplateMatch(normalizedContent, template.keywords);
        // If > 65% of the template lines are present, we consider it valid
        if (matchPercentage >= 0.65) {
            return true;
        }
    }

    return false;
}
