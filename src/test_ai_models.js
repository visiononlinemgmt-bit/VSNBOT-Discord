import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Try to just instantiate one first to check generic access or list if possible (SDK doesn't always expose list easily in all versions, but let's try a simple generation to check 1.5 flash)

        // Attempt to just generate "Hello" with 1.5-flash to see if it works
        console.log("Testing gemini-1.5-flash...");
        const result = await model.generateContent("Hello");
        const response = await result.response;
        console.log("gemini-1.5-flash Works! Response:", response.text());
    } catch (error) {
        console.error("gemini-1.5-flash failed:", error.message);
    }

    try {
        console.log("Testing gemini-pro...");
        const modelPro = genAI.getGenerativeModel({ model: "gemini-pro" });
        const resultPro = await modelPro.generateContent("Hello");
        console.log("gemini-pro Works!", resultPro.response.text());
    } catch (error) {
        console.error("gemini-pro failed:", error.message);
    }
}

listModels();
