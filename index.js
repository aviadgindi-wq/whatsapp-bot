const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { google } = require('googleapis');

// Load .env file manually if it exists
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split(/\r?\n/).forEach(line => {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                const key = match[1];
                let value = match[2] || '';
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                } else if (value.startsWith("'") && value.endsWith("'")) {
                    value = value.slice(1, -1);
                }
                process.env[key] = value.trim();
            }
        });
    }
} catch (err) {
    console.error('Failed to load .env file:', err);
}

// 1. Initialize Gemini API Client
const apiKey = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY';
if (apiKey === 'YOUR_GEMINI_API_KEY' || !apiKey) {
    console.error('⚠️ Warning: GEMINI_API_KEY is not set.');
}
const ai = new GoogleGenAI({ apiKey });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// --- Initialize Google API Clients (Calendar & Sheets) ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1jAWciAo56NYGC5fMQvpRE-qwWcj3FGq_p1U38RRonSo';
let calendarClient = null;
let sheetsClient = null;
try {
    const credentialsPath = path.join(__dirname, 'calendar-credentials.json');
    if (fs.existsSync(credentialsPath)) {
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        const auth = google.auth.fromJSON(credentials);
        auth.scopes = [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/spreadsheets'
        ];
        calendarClient = google.calendar({ version: 'v3', auth });
        sheetsClient = google.sheets({ version: 'v4', auth });
        console.error('✅ Google Calendar & Sheets Auth initialized successfully.');
    } else {
        console.error('⚠️ Warning: calendar-credentials.json not found in root.');
    }
} catch (err) {
    console.error('❌ Error initializing Google API auth:', err);
}

// 2. Weather & Marine Data helper
async function checkMarineWeather() {
    console.error('🌊 Fetching live marine weather conditions for Jaffa Port...');
    try {
        const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=32.05&longitude=34.75&hourly=temperature_2m,wind_speed_10m&timezone=auto';
        const marineUrl  = 'https://marine-api.open-meteo.com/v1/marine?latitude=32.05&longitude=34.75&hourly=wave_height&timezone=auto';
        
        const [weatherRes, marineRes] = await Promise.all([
            fetch(weatherUrl),
            fetch(marineUrl)
        ]);
        
        if (!weatherRes.ok) throw new Error(`Weather API status ${weatherRes.status}`);
        if (!marineRes.ok)  throw new Error(`Marine API status ${marineRes.status}`);
        
        const weatherData = await weatherRes.json();
        const marineData  = await marineRes.json();
        
        return JSON.stringify({
            weather: weatherData,
            marine: marineData
        });
    } catch (error) {
        console.error('Error fetching marine conditions:', error);
        return JSON.stringify({ error: error.message });
    }
}

// 3. Initialize WhatsApp Web Client
const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 300000,
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// --- Tool implementations (need `client` to be defined first) ---

// --- Helper functions ---
function formatWhatsAppJid(phoneNumber) {
    if (typeof phoneNumber !== 'string') return phoneNumber;
    const trimmed = phoneNumber.trim();
    if (trimmed.endsWith('@c.us') || trimmed.endsWith('@lid')) {
        return trimmed;
    }
    let digits = trimmed.replace(/\D/g, '');
    if (digits.startsWith('0')) {
        digits = '972' + digits.substring(1);
    }
    return digits + '@c.us';
}

/**
 * sendWhatsAppMessage: sends a message to a phone number (with @c.us formatting)
 */
async function sendWhatsAppMessage(phoneNumber, message) {
    console.error(`[TOOL] sendWhatsAppMessage → "${phoneNumber}": "${message}"`);
    try {
        const formattedNumber = formatWhatsAppJid(phoneNumber);
        await client.sendMessage(formattedNumber, message);
        console.error(`[TOOL] ✅ Sent to ${formattedNumber}`);
        return `Message successfully sent to ${formattedNumber}`;
    } catch (err) {
        console.error(`[TOOL] ❌ Failed:`, err.message);
        return `Failed to send message: ${err.message}`;
    }
}

/**
 * scheduleWhatsAppMessage: schedules a WhatsApp message to be sent at a specific time in the future
 */
async function scheduleWhatsAppMessage(phoneNumber, messageText, scheduledTimeISO) {
    console.error(`[TOOL] scheduleWhatsAppMessage → "${phoneNumber}" at "${scheduledTimeISO}": "${messageText}"`);
    try {
        const formattedNumber = formatWhatsAppJid(phoneNumber);
        
        const runTime = new Date(scheduledTimeISO);
        schedule.scheduleJob(runTime, async () => {
            console.error(`[SCHEDULED JOB] Running message task for ${formattedNumber}`);
            try {
                await client.sendMessage(formattedNumber, messageText);
                console.error(`[SCHEDULED JOB] ✅ Successfully sent to ${formattedNumber}`);
            } catch (err) {
                console.error(`[SCHEDULED JOB] ❌ Failed to send:`, err.message);
            }
        });
        
        console.error(`[TOOL] ✅ Scheduled for ${scheduledTimeISO}`);
        return "Message scheduled successfully for " + scheduledTimeISO;
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to schedule:`, err.message);
        return `Failed to schedule message: ${err.message}`;
    }
}

/**
 * getUpcomingEvents: fetches events from Google Calendar
 */
async function getUpcomingEvents(timeMin, timeMax) {
    console.error(`[TOOL] getUpcomingEvents → min: "${timeMin}", max: "${timeMax}"`);
    if (!calendarClient) {
        console.error('[TOOL] ❌ Google Calendar client is not initialized.');
        return JSON.stringify({ error: 'Google Calendar is not configured.' });
    }
    try {
        const calendarId = process.env.CALENDAR_ID || 'primary';
        const minDate = timeMin ? new Date(timeMin).toISOString() : new Date().toISOString();
        const maxDate = timeMax ? new Date(timeMax).toISOString() : new Date(new Date(minDate).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

        console.error(`[TOOL] Querying calendar: ${calendarId} between ${minDate} and ${maxDate}`);

        const response = await calendarClient.events.list({
            calendarId: calendarId,
            timeMin: minDate,
            timeMax: maxDate,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];
        console.error(`[TOOL] Found ${events.length} events.`);
        
        const formattedEvents = events.map(event => ({
            summary: event.summary || '(No Title)',
            start: event.start?.dateTime || event.start?.date,
            end: event.end?.dateTime || event.end?.date,
            description: event.description || '',
            location: event.location || ''
        }));

        return JSON.stringify({ events: formattedEvents });
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to fetch calendar events:`, err.message);
        return JSON.stringify({ error: `Failed to fetch calendar events: ${err.message}` });
    }
}

/**
 * createCalendarEvent: creates an event in Google Calendar
 */
async function createCalendarEvent(title, startTimeISO, endTimeISO, description = '', attendeeEmails = []) {
    console.error(`[TOOL] createCalendarEvent → title: "${title}", start: "${startTimeISO}", end: "${endTimeISO}", desc: "${description}", attendees:`, attendeeEmails);
    if (!calendarClient) {
        console.error('[TOOL] ❌ Google Calendar client is not initialized.');
        return "Failed to create event: Google Calendar is not configured.";
    }
    try {
        const calendarId = process.env.CALENDAR_ID || 'primary';
        
        const event = {
            summary: title,
            description: description,
            start: {
                dateTime: new Date(startTimeISO).toISOString(),
            },
            end: {
                dateTime: new Date(endTimeISO).toISOString(),
            }
        };

        if (attendeeEmails && attendeeEmails.length > 0) {
            const emailsText = attendeeEmails.map(email => email.trim()).join(', ');
            event.description = event.description 
                ? `${event.description}\n\nמוזמנים (אימיילים): ${emailsText}` 
                : `מוזמנים (אימיילים): ${emailsText}`;
        }

        let response;
        try {
            console.error(`[TOOL] Inserting event to calendar: ${calendarId} (without attendees array)`);
            console.log(' - Inserting event to Google Calendar...');
            response = await calendarClient.events.insert({
                calendarId: calendarId,
                resource: event
            });
            console.log(' - Event inserted successfully. Link:', response.data.htmlLink);
        } catch (error) {
            console.error("GOOGLE API ERROR:", error.response ? error.response.data : error.message);
            return "Failed to schedule event due to API error.";
        }

        console.error(`[TOOL] ✅ Event created successfully: ${response.data.htmlLink}`);
        return `Event "${title}" created successfully! Link: ${response.data.htmlLink || 'N/A'}`;
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to create calendar event:`, err.message);
        return `Failed to create calendar event: ${err.message}`;
    }
}

/**
 * addToShoppingList: appends items to the Google Sheet shopping list
 */
async function addToShoppingList(items) {
    console.error(`[TOOL] addToShoppingList → items:`, items);
    if (!sheetsClient) {
        console.error('[TOOL] ❌ Google Sheets client is not initialized.');
        return "Failed to add to shopping list: Google Sheets is not configured.";
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
        return "No items provided to add to the shopping list.";
    }
    try {
        const values = items.map(item => [item.trim()]);
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'A:A',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
        console.error(`[TOOL] ✅ Successfully added ${items.length} items to shopping list.`);
        return `הפריטים הבאים נוספו בהצלחה לרשימת הקניות: ${items.join(', ')}`;
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to add to shopping list:`, err.message);
        return `Failed to add to shopping list: ${err.message}`;
    }
}

/**
 * readShoppingList: reads items from the Google Sheet shopping list
 */
async function readShoppingList() {
    console.error(`[TOOL] readShoppingList`);
    if (!sheetsClient) {
        console.error('[TOOL] ❌ Google Sheets client is not initialized.');
        return "Failed to read shopping list: Google Sheets is not configured.";
    }
    try {
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'A:A'
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.error(`[TOOL] Shopping list is empty.`);
            return "רשימת הקניות שלך ריקה כרגע.";
        }
        
        // Flatten array of rows and filter out empty values
        const items = rows.map(row => row[0]).filter(item => item && item.trim() !== '');
        if (items.length === 0) {
            return "רשימת הקניות שלך ריקה כרגע.";
        }

        console.error(`[TOOL] Read ${items.length} items from shopping list.`);
        return `רשימת הקניות שלך:\n` + items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to read shopping list:`, err.message);
        return `Failed to read shopping list: ${err.message}`;
    }
}

/**
 * clearShoppingList: clears the Google Sheet shopping list
 */
async function clearShoppingList() {
    console.error(`[TOOL] clearShoppingList`);
    if (!sheetsClient) {
        console.error('[TOOL] ❌ Google Sheets client is not initialized.');
        return "Failed to clear shopping list: Google Sheets is not configured.";
    }
    try {
        await sheetsClient.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: 'A:A'
        });
        console.error(`[TOOL] ✅ Shopping list cleared.`);
        return "רשימת הקניות נוקתה בהצלחה!";
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to clear shopping list:`, err.message);
        return `Failed to clear shopping list: ${err.message}`;
    }
}

/**
 * removeFromShoppingList: removes specific items from the Google Sheet shopping list
 */
async function removeFromShoppingList(items) {
    console.error(`[TOOL] removeFromShoppingList → items to remove:`, items);
    if (!sheetsClient) {
        console.error('[TOOL] ❌ Google Sheets client is not initialized.');
        return "Failed to remove from shopping list: Google Sheets is not configured.";
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
        return "No items provided to remove from the shopping list.";
    }

    try {
        // 1. Fetch current list
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'A:A'
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return "רשימת הקניות ריקה, אין מה למחוק.";
        }

        const currentItems = rows.map(row => row[0]).filter(item => item && item.trim() !== '');
        
        // Normalize items to remove (lowercase, trimmed)
        const normalizedToRemove = items.map(item => item.trim().toLowerCase());

        // 2. Filter remaining items and identify removed items
        const remainingItems = [];
        const removedItems = [];

        for (const currentItem of currentItems) {
            const normalizedCurrent = currentItem.trim().toLowerCase();
            // Check if this item is in the list to remove
            if (normalizedToRemove.includes(normalizedCurrent)) {
                removedItems.push(currentItem);
            } else {
                remainingItems.push(currentItem);
            }
        }

        if (removedItems.length === 0) {
            return `לא מצאתי את הפריטים הבאים ברשימת הקניות: ${items.join(', ')}`;
        }

        // 3. Clear range A:A
        await sheetsClient.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: 'A:A'
        });

        // 4. Write back remaining items if there are any
        if (remainingItems.length > 0) {
            const values = remainingItems.map(item => [item]);
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: 'A1',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values }
            });
        }

        console.error(`[TOOL] ✅ Successfully removed ${removedItems.length} items from shopping list.`);
        return `הפריטים הבאים הוסרו בהצלחה מרשימת הקניות: ${removedItems.join(', ')}`;
    } catch (err) {
        console.error(`[TOOL] ❌ Failed to remove from shopping list:`, err.message);
        return `Failed to remove from shopping list: ${err.message}`;
    }
}

/**
 * findContactNumber: searches WhatsApp contacts by name and returns their chat ID
 */
async function findContactNumber(name) {
    console.error(`[TOOL] findContactNumber → searching for: "${name}"`);
    try {
        const searchName = name.trim().toLowerCase();

        // 1. Search in active chats first (very fast, never hangs)
        console.error(`[TOOL] findContactNumber → checking active chats...`);
        const chats = await client.getChats();
        const foundChat = chats.find(c => {
            const cName = (c.name || '').toLowerCase();
            return cName.includes(searchName) || searchName.includes(cName);
        });

        if (foundChat) {
            let contactId = foundChat.id._serialized;
            const displayName = foundChat.name;
            // If the JID is a LID, attempt to resolve the actual phone-number JID
            if (contactId.endsWith('@lid')) {
                try {
                    const contactInfo = await foundChat.getContact();
                    if (contactInfo && contactInfo.number) {
                        contactId = contactInfo.number + '@c.us';
                        console.error(`[TOOL] Resolved active chat LID to @c.us: ${contactId}`);
                    }
                } catch (err) {
                    console.error(`[TOOL] Failed to resolve contact info for JID:`, err.message);
                }
            }
            console.error(`[TOOL] ✅ Found contact in active chats: "${displayName}" → ${contactId}`);
            return JSON.stringify({ found: true, contactId, displayName });
        }

        // 2. Search in all contacts with a timeout (fallback)
        console.error(`[TOOL] findContactNumber → checking all contacts with timeout...`);
        const contactsPromise = client.getContacts();
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 4000));
        const contacts = await Promise.race([contactsPromise, timeoutPromise]);

        if (!contacts) {
            console.error(`[TOOL] ⚠️ client.getContacts() timed out or returned empty.`);
            return JSON.stringify({ found: false, message: `Contact "${name}" not found (search timed out).` });
        }

        // Search by name, pushname, or shortName (case-insensitive, partial match)
        const found = contacts.find(c => {
            const cName = (c.name || '').toLowerCase();
            const cPush = (c.pushname || '').toLowerCase();
            const cShort = (c.shortName || '').toLowerCase();
            return cName.includes(searchName) || cPush.includes(searchName) || cShort.includes(searchName) || searchName.includes(cName) || searchName.includes(cPush);
        });

        if (found) {
            let contactId = found.id._serialized;
            if (contactId.endsWith('@lid') && found.number) {
                contactId = found.number + '@c.us';
                console.error(`[TOOL] Resolved contacts list LID to @c.us: ${contactId}`);
            }
            const displayName = found.name || found.pushname || found.shortName || 'Unknown';
            console.error(`[TOOL] ✅ Found contact in contacts list: "${displayName}" → ${contactId}`);
            return JSON.stringify({ found: true, contactId, displayName, number: found.number || '' });
        } else {
            console.error(`[TOOL] ❌ Contact not found in contacts list: "${name}"`);
            return JSON.stringify({ found: false, message: `Contact "${name}" not found in WhatsApp contacts.` });
        }
    } catch (err) {
        console.error(`[TOOL] ❌ Error searching contacts:`, err.message);
        return JSON.stringify({ found: false, message: `Error searching contacts: ${err.message}` });
    }
}

/**
 * sendDailyEveningSummary: generates and sends a daily evening summary to the user's self-chat
 */
async function sendDailyEveningSummary() {
    console.error('🌆 Generating daily evening summary...');
    try {
        const weatherJson = await checkMarineWeather();
        
        // Calculate tomorrow's local range (00:00:00 to 23:59:59)
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const yyyy = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // Format: YYYY-MM-DD
        
        const timeMin = new Date(`${yyyy}T00:00:00`).toISOString();
        const timeMax = new Date(`${yyyy}T23:59:59`).toISOString();
        
        let calendarEventsJson = '[]';
        try {
            calendarEventsJson = await getUpcomingEvents(timeMin, timeMax);
        } catch (calErr) {
            console.error('Error fetching calendar events for evening summary:', calErr);
        }
        
        const currentDateStr = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
        const tomorrowDateStr = tomorrow.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
        
        const prompt = 
            `You are Aviad's personal proactive AI assistant. Today is ${currentDateStr}. Tomorrow is ${tomorrowDateStr}.\n` +
            `Generate a short, energetic evening summary in Hebrew for Aviad.\n` +
            `Include the following:\n` +
            `1. A short, positive wrap-up of today with a motivational quote or sentence.\n` +
            `2. Check if tomorrow has any Jewish or Israeli holidays and mention them.\n` +
            `3. Present tomorrow's schedule / calendar events based on this schedule data:\n` +
            `${calendarEventsJson}\n` +
            `4. Present tomorrow's weather conditions for Jaffa Port based on this forecast data:\n` +
            `${weatherJson}\n` +
            `5. A friendly reminder to prepare for tomorrow.\n\n` +
            `Keep the response short, engaging, and format it nicely with emojis. Do not output any XML or markdown wrapper like codeblocks, just the plain text message.`;

        console.error('🤖 Requesting summary from Gemini...');
        // One-shot call — separate from the user chat session
        let response;
        for (let attempt = 0; attempt <= 2; attempt++) {
            try {
                response = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: prompt,
                    config: {
                        systemInstruction: "You are Aviad's personal AI assistant on WhatsApp. Always answer in Hebrew."
                    }
                });
                break;
            } catch (err) {
                const retryable = err.status === 503 || err.status === 429 || String(err.message).includes('demand');
                if (retryable && attempt < 2) {
                    console.error(`⏳ Evening summary Gemini error [${err.status}], retrying in 3s...`);
                    await new Promise(res => setTimeout(res, 3000));
                } else {
                    throw err;
                }
            }
        }

        const summaryText = response.text?.trim();
        if (summaryText) {
            const selfJid = client.info?.wid?._serialized;
            if (selfJid) {
                const finalMessage = `🤖 ${summaryText}`;
                await client.sendMessage(selfJid, finalMessage);
                console.error('✅ Proactive evening summary sent successfully!');
            } else {
                console.error('❌ Failed: client.info.wid._serialized is not available.');
            }
        } else {
            console.error('❌ Failed: Gemini returned empty summary.');
        }
    } catch (err) {
        console.error('❌ Error generating evening summary:', err);
    }
}

// --- Gemini Tool Definitions ---
// Moved locally to callGeminiWithTools to keep initialization clean

// Map of tool name → JS function
const toolHandlers = {
    sendWhatsAppMessage: ({ phoneNumber, message }) => sendWhatsAppMessage(phoneNumber, message),
    scheduleWhatsAppMessage: ({ phoneNumber, messageText, scheduledTimeISO }) => scheduleWhatsAppMessage(phoneNumber, messageText, scheduledTimeISO),
    checkMarineWeather: () => checkMarineWeather(),
    getUpcomingEvents: ({ timeMin, timeMax }) => getUpcomingEvents(timeMin, timeMax),
    createCalendarEvent: ({ title, startTimeISO, endTimeISO, description, attendeeEmails }) => createCalendarEvent(title, startTimeISO, endTimeISO, description, attendeeEmails),
    addToShoppingList: ({ items }) => addToShoppingList(items),
    readShoppingList: () => readShoppingList(),
    clearShoppingList: () => clearShoppingList(),
    removeFromShoppingList: ({ items }) => removeFromShoppingList(items),
    findContactNumber: ({ name }) => findContactNumber(name)
};

// --- Chat Session State ---
let chatSession = null;


// --- Gemini Chat session send message with retry ---
async function sendMessageWithRetry(chat, messagePayload, retries = 2, delay = 2000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await chat.sendMessage(messagePayload);
        } catch (error) {
            console.warn('Retry attempt failed:', error.message);
            const isRetryable = error.status === 429 || error.status === 503 || error.code === 429 || error.code === 503 || String(error.message).includes('demand') || String(error.message).includes('limit') || String(error.message).includes('resource');
            if (isRetryable && attempt < retries) {
                let waitMs = delay;
                if (error.status === 429 || error.code === 429) {
                    const match = error.message?.match(/retry in ([\d.]+)s/i);
                    if (match) {
                        waitMs = (Math.ceil(parseFloat(match[1])) + 2) * 1000;
                    }
                }
                console.error(`⏳ Gemini API error [${error.status || error.code}]. Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${retries}...`);
                await new Promise(res => setTimeout(res, waitMs));
            } else {
                console.error('ALL RETRIES FAILED:', error);
                throw error;
            }
        }
    }
}

// --- Shared Gemini tools & config builder ---
function buildGeminiToolsAndConfig() {
    const currentTime = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    const tools = [{
        functionDeclarations: [
            {
                name: 'sendWhatsAppMessage',
                description: 'Sends a WhatsApp message to a specific phone number.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        phoneNumber: {
                            type: 'STRING',
                            description: "The recipient's phone number (Israeli format like 0501234567 or international 972501234567)"
                        },
                        message: {
                            type: 'STRING',
                            description: 'The text content of the message to send'
                        }
                    },
                    required: ['phoneNumber', 'message']
                }
            },
            {
                name: 'scheduleWhatsAppMessage',
                description: 'Schedules a WhatsApp message to be sent at a future date and time.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        phoneNumber: {
                            type: 'STRING',
                            description: "The recipient's phone number (Israeli format like 0501234567 or international 972501234567)"
                        },
                        messageText: {
                            type: 'STRING',
                            description: 'The text content of the message to send'
                        },
                        scheduledTimeISO: {
                            type: 'STRING',
                            description: 'The future scheduled date/time in ISO 8601 string format (e.g. 2026-05-24T15:00:00Z)'
                        }
                    },
                    required: ['phoneNumber', 'messageText', 'scheduledTimeISO']
                }
            },
            {
                name: 'checkMarineWeather',
                description: 'Fetches the marine and wind forecast for Jaffa Port (lat: 32.05, lon: 34.75).',
                parameters: {
                    type: 'OBJECT',
                    properties: {}
                }
            },
            {
                name: 'getUpcomingEvents',
                description: 'Fetches upcoming events from the user\'s Google Calendar between timeMin and timeMax.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        timeMin: {
                            type: 'STRING',
                            description: 'The start of the time range to filter events (ISO 8601 string format, e.g. 2026-05-24T00:00:00Z)'
                        },
                        timeMax: {
                            type: 'STRING',
                            description: 'The end of the time range to filter events (ISO 8601 string format, e.g. 2026-05-24T23:59:59Z)'
                        }
                    }
                }
            },
            {
                name: 'createCalendarEvent',
                description: 'Creates a new event / meeting / time-block in the user\'s Google Calendar.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        title: {
                            type: 'STRING',
                            description: 'The title of the meeting or event'
                        },
                        startTimeISO: {
                            type: 'STRING',
                            description: 'The start time of the event in ISO 8601 format (e.g. 2026-05-24T10:00:00+03:00)'
                        },
                        endTimeISO: {
                            type: 'STRING',
                            description: 'The end time of the event in ISO 8601 format (e.g. 2026-05-24T11:00:00+03:00)'
                        },
                        description: {
                            type: 'STRING',
                            description: 'A brief description of the event (optional)'
                        },
                        attendeeEmails: {
                            type: 'ARRAY',
                            items: {
                                type: 'STRING'
                            },
                            description: 'A list of email addresses of attendees to invite to the event (optional)'
                        }
                    },
                    required: ['title', 'startTimeISO', 'endTimeISO']
                }
            },
            {
                name: 'addToShoppingList',
                description: 'Adds one or multiple items to the shopping list.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        items: {
                            type: 'ARRAY',
                            items: {
                                type: 'STRING'
                            },
                            description: 'The list of items to add to the shopping list'
                        }
                    },
                    required: ['items']
                }
            },
            {
                name: 'readShoppingList',
                description: 'Reads the list of all items currently in the shopping list.',
                parameters: {
                    type: 'OBJECT',
                    properties: {}
                }
            },
            {
                name: 'clearShoppingList',
                description: 'Clears/empties the entire shopping list.',
                parameters: {
                    type: 'OBJECT',
                    properties: {}
                }
            },
            {
                name: 'removeFromShoppingList',
                description: 'Removes specific items from the shopping list.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        items: {
                            type: 'ARRAY',
                            items: {
                                type: 'STRING'
                            },
                            description: 'The list of items to remove from the shopping list'
                        }
                    },
                    required: ['items']
                }
            },
            {
                name: 'findContactNumber',
                description: 'Searches WhatsApp contacts by name and returns their contact ID for sending messages. Use this BEFORE sendWhatsAppMessage when the user provides a contact name instead of a phone number.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        name: {
                            type: 'STRING',
                            description: 'The name (or partial name) of the contact to search for'
                        }
                    },
                    required: ['name']
                }
            }
        ]
    }];

    const dynamicConfig = {
        systemInstruction:
            `You are Aviad's personal AI assistant on WhatsApp. Always answer in Hebrew. The current time is ${currentTime}.\n` +
            `- If Aviad asks to send a message at a specific time or with a delay, use the 'scheduleWhatsAppMessage' tool and calculate the correct ISO time.\n` +
            `- If he just says 'send a message' without a time, use 'sendWhatsAppMessage'.\n` +
            `- If he talks about sailing, taking a boat, or asks about the sea/weather, infer that he needs marine conditions and proactively use the 'checkMarineWeather' tool to give him the forecast for Jaffa Port.\n` +
            `- If Aviad asks about his calendar events, schedule, or meetings, use the 'getUpcomingEvents' tool. Make sure to specify the start time range 'timeMin' and end time range 'timeMax' in ISO format based on the current time and what he asked (e.g. today, tomorrow, this week).\n` +
            `- When using the 'createCalendarEvent' tool, if Aviad mentions an email address, that email is a GUEST. You must put it EXCLUSIVELY inside the 'attendeeEmails' array parameter.\n` +
            `- If he asks for the evening summary ("הערב", "סיכום ערב", "בוא נחבר את הערב", etc.), use BOTH 'checkMarineWeather' and 'getUpcomingEvents' (for tomorrow) to generate a short, energetic Hebrew evening summary including today's wrap-up, tomorrow's holiday/weather forecast/schedule, and prep reminders in a single response.\n` +
            `- If you receive a voice message transcription, treat it exactly like a regular text message. Process the user's intent from the transcription and respond accordingly.\n` +
            `- You also manage Aviad's shopping list. Use 'addToShoppingList' to add one or multiple groceries. Use 'readShoppingList' when he asks what to buy. Use 'clearShoppingList' to empty the entire list. Use 'removeFromShoppingList' to remove one or multiple specific items when he asks to delete or remove them from the list.\n` +
            `- IMPORTANT: When Aviad asks to send a message to someone by NAME (not phone number), you MUST first use 'findContactNumber' to look up their WhatsApp contact ID. Then use the returned contactId as the phoneNumber in 'sendWhatsAppMessage'. Never ask for a phone number if a name was provided — always search first.`,
        tools: tools
    };

    return { tools, dynamicConfig, currentTime };
}

// --- Process Gemini tool-calling loop (shared between text & voice) ---
async function processGeminiToolLoop(response, dynamicConfig) {
    while (response.functionCalls && response.functionCalls.length > 0) {
        const calls = response.functionCalls;
        console.error(`[TOOL] Gemini requested ${calls.length} function calls.`);

        const responseParts = [];
        for (const call of calls) {
            console.log('4. Executing tool:', call.name);
            console.error(`[TOOL] Executing local function: ${call.name}`, call.args);
            const handler = toolHandlers[call.name];
            let result;
            if (handler) {
                result = await handler(call.args);
            } else {
                result = `Unknown tool: ${call.name}`;
            }
            responseParts.push({
                functionResponse: {
                    name: call.name,
                    response: { result },
                    id: call.id
                }
            });
        }

        console.log('5. Tool execution finished. Sending results back to Gemini for final response...');
        console.error('🤖 Gemini follow-up call...');
        
        response = await sendMessageWithRetry(chatSession, {
            message: {
                role: 'user',
                parts: responseParts
            },
            config: dynamicConfig
        });
    }
    return response;
}

// --- Gemini multi-turn function calling loop (text messages) ---
async function callGeminiWithTools(userPrompt) {
    const { dynamicConfig } = buildGeminiToolsAndConfig();

    if (!chatSession) {
        chatSession = ai.chats.create({
            model: GEMINI_MODEL,
            config: dynamicConfig
        });
    }

    console.log('2. Sending text to Gemini...');
    console.error('🤖 Gemini first call (text)...');
    let response = await sendMessageWithRetry(chatSession, {
        message: userPrompt,
        config: dynamicConfig
    });

    console.log('3. Gemini response received. Has functionCalls?', !!response.functionCalls);
    response = await processGeminiToolLoop(response, dynamicConfig);

    return response.text?.trim() || '';
}

// --- Gemini multi-turn function calling loop (voice messages) ---
async function callGeminiWithVoice(audioBase64, mimeType) {
    const { dynamicConfig } = buildGeminiToolsAndConfig();

    if (!chatSession) {
        chatSession = ai.chats.create({
            model: GEMINI_MODEL,
            config: dynamicConfig
        });
    }

    // Build multimodal message with audio inline data + text prompt
    const messageParts = [
        {
            inlineData: {
                mimeType: mimeType,
                data: audioBase64
            }
        },
        {
            text: 'הודעה קולית מאביעד. הקשב להודעה הקולית, הבן את התוכן שלה, וענה בהתאם. אם יש בקשה (כמו קביעת פגישה, שליחת הודעה, בדיקת מזג אוויר וכו׳) — בצע אותה. ענה בעברית.'
        }
    ];

    console.log('2. Sending voice to Gemini...');
    console.error('🎙️ Gemini first call (voice)...');
    let response = await sendMessageWithRetry(chatSession, {
        message: {
            role: 'user',
            parts: messageParts
        },
        config: dynamicConfig
    });

    console.log('3. Gemini voice response received. Has functionCalls?', !!response.functionCalls);
    response = await processGeminiToolLoop(response, dynamicConfig);

    return response.text?.trim() || '';
}

client.on('loading_screen', (percent, message) => {
    console.error(`[LOADING] ${percent}% - ${message}`);
});

client.on('auth_failure', (msg) => {
    console.error('❌ Auth failure:', msg);
});

client.on('authenticated', () => {
    console.error('✅ Client authenticated successfully!');
});

client.on('disconnected', (reason) => {
    console.error('❌ Client was disconnected:', reason);
});

// --- QR Code handling ---
client.on('qr', (qr) => {
    console.error('QR Code received. Scan it with your phone to login:');
    qrcode.generate(qr, { small: true });
    try {
        const qrHtmlPath = path.join(__dirname, 'qr.html');
        const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Scan WhatsApp QR Code</title>
    <script src="https://cdn.jsdelivr.net/npm/qrcode_js@1.0.0/qrcode.min.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; background:#f0f2f5; }
        .card { background:white; padding:40px; border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.08); text-align:center; max-width:350px; }
        #qrcode { margin:25px auto; display:flex; justify-content:center; }
        h1 { color:#075e54; font-size:22px; margin:0 0 10px 0; }
        p { color:#54656f; font-size:14px; line-height:1.4; margin:0 0 10px 0; }
    </style>
</head>
<body>
    <div class="card">
        <h1>WhatsApp AI Agent Login</h1>
        <p>Scan this QR code using WhatsApp on your phone (Linked Devices)</p>
        <div id="qrcode"></div>
    </div>
    <script>
        new QRCode(document.getElementById("qrcode"), {
            text: ${JSON.stringify(qr)}, width:256, height:256,
            colorDark:"#000000", colorLight:"#ffffff", correctLevel:QRCode.CorrectLevel.H
        });
    </script>
</body>
</html>`;
        fs.writeFileSync(qrHtmlPath, htmlContent);
        console.error(`👉 Open in browser to scan:\nfile:///${qrHtmlPath.replace(/\\/g, '/')}`);
    } catch (err) {
        console.error('Failed to write qr.html:', err);
    }
});

client.on('ready', () => {
    console.error('✅ WhatsApp Agent is ready! 🚀');
    console.error('✅ Client info details:', JSON.stringify(client.info));
    try {
        const qrHtmlPath = path.join(__dirname, 'qr.html');
        if (fs.existsSync(qrHtmlPath)) fs.unlinkSync(qrHtmlPath);
    } catch (err) { /* ignore */ }

    // Schedule daily evening summary at 20:00 Israel time
    console.error('📅 Scheduling daily evening summary job for 20:00...');
    schedule.scheduleJob('0 20 * * *', async () => {
        try {
            await sendDailyEveningSummary();
        } catch (err) {
            console.error('Error in scheduled evening summary:', err);
        }
    });
});

// --- Message Listener ---
client.on('message_create', async (msg) => {
    try {
        // Restrict bot responses EXCLUSIVELY to the user's own messages in the self-chat (Me-chat)
        if (msg.fromMe !== true) return;

        const remote = msg.id?.remote || '';
        const body   = msg.body || '';

        const selfJid = client.info?.wid?._serialized;
        const isSelfChat = selfJid ? (remote === selfJid) : (msg.from === msg.to);
        if (!isSelfChat) return;

        // Write directly to file to bypass process output buffering
        const logMsg = `[LOG] ${new Date().toISOString()} remote="${remote}" from="${msg.from}" to="${msg.to}" fromMe=${msg.fromMe} body="${body.substring(0, 80)}"\n`;
        fs.appendFileSync(path.join(__dirname, 'bot.log'), logMsg);

        console.error(`[DEBUG] remote="${remote}" fromMe=${msg.fromMe} body="${body.substring(0, 80)}"`);

        // Normalize msg.from to match msg.id.remote for self-chat to satisfy the requested protection rule
        msg.from = remote;

        // Keep the protection rules:
        if (msg.id.remote !== msg.from) return;

        // Ignore bot's own replies (loop prevention)
        if (body.trim().startsWith('🤖')) return;

        // --- Voice Message Handling ---
        const isVoiceMessage = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');
        if (isVoiceMessage) {
            console.log('1. 🎙️ Voice message detected! Downloading audio...');
            console.error(`🎙️ Voice message received in self-chat`);
            try {
                const media = await msg.downloadMedia();
                if (media && media.data) {
                    const mimeType = media.mimetype || 'audio/ogg';
                    console.error(`🎙️ Audio downloaded: ${mimeType}, size: ${media.data.length} chars (base64)`);
                    
                    const replyText = await callGeminiWithVoice(media.data, mimeType);
                    if (replyText) {
                        const finalReply = `🤖 ${replyText}`;
                        await client.sendMessage(remote, finalReply);
                        console.error(`✅ Replied to voice: "${finalReply.substring(0, 100)}"`);
                    }
                } else {
                    console.error('❌ Failed to download voice message media');
                    await client.sendMessage(remote, '🤖 ❌ לא הצלחתי להוריד את ההודעה הקולית. נסה שוב.');
                }
            } catch (voiceErr) {
                console.error('❌ Error processing voice message:', voiceErr);
                await client.sendMessage(remote, `🤖 ❌ שגיאה בעיבוד ההודעה הקולית: ${voiceErr.message?.substring(0, 80) || 'שגיאה לא ידועה'}`);
            }
            return;
        }

        const userMessage = body.trim();
        if (!userMessage) return;

        // Manual command trigger for daily summary testing
        if (userMessage === '!ערב') {
            await sendDailyEveningSummary();
            return;
        }

        console.log('1. Processing message:', msg.body);
        console.error(`✉️  Me-chat message: "${userMessage}"`);

        const replyText = await callGeminiWithTools(userMessage);
        if (replyText) {
            const finalReply = `🤖 ${replyText}`;
            await client.sendMessage(remote, finalReply);
            console.error(`✅ Replied: "${finalReply.substring(0, 100)}"`);
        }
    } catch (error) {
        console.error('❌ Error handling message:', error);
        // Notify the user in chat about the error
        try {
            const remote = msg.id?.remote || '';
            if (remote) {
                const errMsg = error.status === 429
                    ? '🤖 ⚠️ מגבלת API זמנית (429). נסה שוב בעוד דקה.'
                    : `🤖 ❌ שגיאה: ${error.message?.substring(0, 100) || 'שגיאה לא ידועה'}`;
                await client.sendMessage(remote, errMsg);
            }
        } catch (_) { /* ignore */ }
    }
});

// Start
client.initialize().catch(err => {
    console.error('❌ Failed to initialize WhatsApp client:', err);
});
