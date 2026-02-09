import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
    new SlashCommandBuilder()
        .setName('chsp')
        .setDescription('Выдать ЧСП (Черный Список Проекта)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Пользователь')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Причина')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('chs')
        .setDescription('Выдать ЧС (Черный Список)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Пользователь')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Причина')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('btd')
        .setDescription('Выдать БТД (Бессрочная Терминация Доступа)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Пользователь')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Причина')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('forgive')
        .setDescription('Снять все наказания (ЧСП, ЧС, БТД)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Пользователь')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Причина')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Задать вопрос ИИ по проекту')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('Ваш вопрос')
                .setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
    try {
        if (!process.env.DISCORD_CLIENT_ID) {
            console.error('Ошибка: DISCORD_CLIENT_ID не найден в .env');
            process.exit(1);
        }

        const GUILD_ID = '1220681422583496794';
        console.log(`Начинаю обновление (/) команд для гильдии ${GUILD_ID}...`);

        await rest.put(
            Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
            { body: commands },
        );

        console.log('Успешно обновлены (/) команды (локально для сервера).');
    } catch (error) {
        console.error(error);
    }
})();
