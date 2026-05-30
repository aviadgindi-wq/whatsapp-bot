const { GoogleGenAI } = require('@google/genai');
const apiKey = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY';
const ai = new GoogleGenAI({ apiKey });

async function main() {
    try {
        console.log('Listing available models...');
        const response = await ai.models.list();
        const models = response.pageInternal || [];
        console.log(`Found ${models.length} models:`);
        
        for (const model of models) {
            const shortName = model.name.replace('models/', '');
            console.log(`Testing: ${shortName} ("${model.displayName}")...`);
            try {
                const res = await ai.models.generateContent({
                    model: shortName,
                    contents: 'test'
                });
                console.log(`  ✅ Working! Result: "${res.text?.trim()}"`);
            } catch (err) {
                console.log(`  ❌ Failed: [${err.status || err.code}] ${err.message.split('\n')[0]}`);
            }
        }
    } catch (err) {
        console.error('Error listing models:', err.stack || err.message || err);
    }
}

main();
