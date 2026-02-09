import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config = null;
let currentConfigPath = null;

export function loadConfig(configPath = null) {
  currentConfigPath = configPath ?? join(__dirname, '..', 'config.json');
  if (!existsSync(currentConfigPath)) {
    console.error(`Файл конфигурации не найден: ${currentConfigPath}`);
    console.error('Скопируйте config.example.json в config.json и заполните его.');
    process.exit(1);
  }
  const raw = readFileSync(currentConfigPath, 'utf-8');
  config = JSON.parse(raw);
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}

export function saveConfig() {
  if (!config || !currentConfigPath) return;
  try {
    writeFileSync(currentConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Ошибка при сохранении конфигурации:', err);
  }
}

export function getForbiddenWords() {
  return getConfig().forbiddenWords ?? [];
}

export function addForbiddenWord(word) {
  const words = getForbiddenWords();
  if (!words.includes(word)) {
    words.push(word);
    config.forbiddenWords = words;
    saveConfig();
    return true;
  }
  return false;
}

export function removeForbiddenWord(word) {
  const words = getForbiddenWords();
  const index = words.indexOf(word);
  if (index !== -1) {
    words.splice(index, 1);
    config.forbiddenWords = words;
    saveConfig();
    return true;
  }
  return false;
}

export function getMuteDurations() {
  return getConfig().muteDurations ?? [5, 10, 30, 60, 24 * 60, 7 * 24 * 60, 28 * 24 * 60];
}

export function getViolationForgivenessDays() {
  return getConfig().violationForgivenessDays ?? 30;
}

// Удаляю getMuteDurationMinutes, так как теперь оно не используется

export function getRulesChannels() {
  return getConfig().rulesChannels ?? [];
}

export function getMuteReportsChannelId() {
  return getConfig().muteReportsChannelId ?? null;
}

export function getForumAppealChannels() {
  return getConfig().forumAppealChannels ?? [];
}

export function getDefaultAppealTemplates() {
  return getConfig().defaultAppealTemplates ?? [];
}

export function getAppealSuccessMessage() {
  return getConfig().appealSuccessMessage ?? "# Сообщение прошло верификацию.";
}

export function getAccessControlConfig() {
  return getConfig().accessControl ?? null;
}

export function getAIConfig() {
  return getConfig().ai ?? null;
}
