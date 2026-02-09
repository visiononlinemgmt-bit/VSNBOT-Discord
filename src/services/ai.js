import 'dotenv/config';
import OpenAI from 'openai';
import { getAIConfig } from '../config.js';
import { log, error } from '../utils/logger.js';

let openai = null;
let systemInstruction = '';

/**
 * Initializes the AI service (now using OpenRouter).
 * Fetches context from configured Discord channels.
 * @param {import('discord.js').Client} client 
 */
export async function initAI(client) {
    const config = getAIConfig();
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!config || !apiKey) {
        error('AI initialization skipped: Missing config or OPENROUTER_API_KEY');
        return;
    }

    try {
        openai = new OpenAI({
            apiKey: apiKey,
            baseURL: 'https://openrouter.ai/api/v1',
        });

        // Fetch context from channels
        let contextText = 'You are a helpful assistant for a Discord server project.\n\n';
        contextText += 'Here are the SERVER RULES and ADMINISTRATION RULES. You must answer questions based on this context. ';
        contextText += 'If a user asks a question unrelated to the project or these rules (e.g., about the weather, general knowledge), politely refuse to answer.\n\n';
        contextText += '--- START OF CONTEXT ---\n\n';

        for (const channelId of config.contextChannels) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (channel && channel.isTextBased()) {
                    // OpenRouter/Gemini Flash has decent context, but we keep it reasonable
                    const messages = await channel.messages.fetch({ limit: 50 });
                    // Reverse to get chronological order (oldest first)
                    const tempMessages = Array.from(messages.values()).reverse();

                    contextText += `CHANNEL: ${channel.name} (${channel.id})\n`;
                    let channelContext = "";
                    for (const msg of tempMessages) {
                        if (msg.content) {
                            channelContext += `- ${msg.content}\n`;
                        }
                    }
                    // Cap context per channel
                    if (channelContext.length > 5000) {
                        channelContext = channelContext.slice(-5000);
                    }
                    contextText += channelContext + '\n';
                }
            } catch (err) {
                error(`Failed to fetch context from channel ${channelId}:`, err);
            }
        }

        contextText += '--- END OF CONTEXT ---\n';

        systemInstruction = contextText;

        log('AI Service (OpenRouter) initialized successfully with context.');
    } catch (err) {
        error('Failed to initialize AI Service:', err);
    }
}

/**
 * Asks the AI a question.
 * @param {string} question The user's question.
 * @returns {Promise<string>} The AI's response.
 */
export async function askAI(question) {
    if (!openai) {
        return "AI service is not initialized or unavailable.";
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "arcee-ai/trinity-large-preview:free", // Using OpenRouter model ID
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: question }
            ],
        });

        return completion.choices[0].message.content;
    } catch (err) {
        error('AI Generation Error:', err);
        return "An error occurred while generating the response.";
    }
}
