import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config = null;

export function loadConfig(configPath = null) {
  const path = configPath ?? join(__dirname, '..', 'config.json');
  if (!existsSync(path)) {
    console.error(`Файл конфигурации не найден: ${path}`);
    console.error('Скопируйте config.example.json в config.json и заполните его.');
    process.exit(1);
  }
  const raw = readFileSync(path, 'utf-8');
  config = JSON.parse(raw);
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}

export function getForbiddenWords() {
  return getConfig().forbiddenWords ?? [];
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
