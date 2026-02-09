import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getViolationForgivenessDays } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const VIOLATIONS_FILE = join(DATA_DIR, 'violations.json');
const PUNISHMENTS_FILE = join(DATA_DIR, 'punishments.json');

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

export async function loadViolationCounts() {
  await ensureDataDir();
  if (!existsSync(VIOLATIONS_FILE)) {
    return new Map();
  }
  try {
    const rawData = await fs.readFile(VIOLATIONS_FILE, 'utf-8');
    const obj = JSON.parse(rawData);
    // Convert object to Map. Structure: userId -> { count, lastViolationDate }
    // If old format (count only), convert it.
    const map = new Map();
    for (const [userId, value] of Object.entries(obj)) {
      if (typeof value === 'number') {
        map.set(userId, { count: value, lastViolationDate: Date.now() });
      } else {
        map.set(userId, value);
      }
    }
    return map;
  } catch (error) {
    console.error('Ошибка при загрузке истории нарушений:', error);
    return new Map();
  }
}

export async function saveViolationCounts(countsMap) {
  await ensureDataDir();
  try {
    const obj = Object.fromEntries(countsMap);
    await fs.writeFile(VIOLATIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении истории нарушений:', error);
  }
}

export async function loadPunishments() {
  await ensureDataDir();
  if (!existsSync(PUNISHMENTS_FILE)) {
    return new Map();
  }
  try {
    const rawData = await fs.readFile(PUNISHMENTS_FILE, 'utf-8');
    const obj = JSON.parse(rawData);
    return new Map(Object.entries(obj));
  } catch (error) {
    console.error('Ошибка при загрузке списка наказаний:', error);
    return new Map();
  }
}

export async function savePunishments(punishmentsMap) {
  await ensureDataDir();
  try {
    const obj = Object.fromEntries(punishmentsMap);
    await fs.writeFile(PUNISHMENTS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении списка наказаний:', error);
  }
}

export async function cleanupOldViolations(countsMap) {
  const days = getViolationForgivenessDays();
  if (days <= 0) return countsMap; // Feature disabled

  const now = Date.now();
  const msInDay = 24 * 60 * 60 * 1000;
  const threshold = now - (days * msInDay);
  let changed = false;

  for (const [userId, data] of countsMap) {
    if (data.lastViolationDate < threshold) {
      countsMap.delete(userId);
      changed = true;
      console.log(`[Forgiveness] Нарушения пользователя ${userId} сброшены (неактивен > ${days} дней).`);
    }
  }

  if (changed) {
    await saveViolationCounts(countsMap);
  }
  return countsMap;
}
