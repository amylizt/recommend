const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const { Pool } = require('pg'); // Switched to pg Pool
const { Resend } = require('resend');
const chatSessions = {};
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();
const crypto = require('crypto');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Pool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'snookbook',
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

setupDB()
const PromptMatrix = [
    {
        id: 'systemContextText',
        build: (session) => {
            const hasRecs = session.excludedBooks && session.excludedBooks.length > 0;
            return hasRecs
                ? `[SYSTEM: User successfully entered verification code. This is an EXISTING returning account. Historical recommendations already stored in their profile are: ${session.excludedBooks.join(', ')}. YOU MUST NEVER RECOMMEND THESE TITLES AGAIN IN THIS SESSION. Welcome them back warmly and ask what they are in the mood to read today.]`
                : `[SYSTEM: User successfully entered verification code. This is a BRAND NEW account. Welcome them to the platform for the first time, and ask what genres or authors they love.]`;
        }
    },
    {
        id: 'deviceMessageText',
        build: (session) => {
            return `
                [SYSTEM: Explicitly thank the user for verifying their code and confirm they are authenticated.
                Next, ask them clearly if they would like to save/remember this device so they can skip logging in next time.
                
                CRITICAL DIRECTIVE: You must ONLY ask this question. Do NOT welcome them to the platform, do NOT mention book recommendations, and do NOT ask what they want to read. 
                Stop talking immediately after asking about the device permission so the user has space to answer 'yes' or 'no'.]`;
        }
    },
        {
        id: 'welcomePreAuthenticated',
        build: (session) => {
            return `
                You are an expert, friendly book recommendation concierge. Keep responses short and conversational (1-2 sentences max).

                CRITICAL ACCOUNT LOGIC RULES:
                - User is NOT AUTHENTICATED. SHOW onboarding/greeting options or ask them to sign in.
                
                GREETING STYLE DIRECTION:
                - Greet them warmly and casually asking them to sign in.
                - ONLY ASK ONE BRIEF QUESTION. Do not suggest books yet.
            `;
        }
    },
    {   id: 'welcomePostAuthenticated',
        build: (session) => {
            return `
                You are an expert, friendly book recommendation concierge. Keep responses short and conversational (1-2 sentences max).

                CRITICAL ACCOUNT LOGIC RULES:
                - User is ALREADY AUTHENTICATED. Do NOT show onboarding/greeting options or ask them to sign in.
                - Match your welcome tone to their status (new vs returning) passed in the system context.
                
                GREETING STYLE DIRECTION:
                - Greet them warmly and casual using their name or email identifier (e.g., "Welcome to the platform, amylizt! I'm so glad you're here...").
                - You MUST immediately ask your first casual profiling question in this turn to prompt them for their preferences (e.g., "...to get us started, what are some of your favorite authors or genres you've been enjoying lately?").
                - ONLY ASK ONE BRIEF QUESTION. Do not suggest books yet.
            `;
        }
    },
    {
        id: 'mainPrompt',
        build: (session) => {
            const hasRecs = session.excludedBooks && session.excludedBooks.length > 0;
            const blacklist = hasRecs ? `CRITICAL EXCLUSIONS: You have already recommended: ${session.excludedBooks.join(', ')}. NEVER suggest these books or their sequels. Focus on fresh content.\n` : '';
                        
            return `
                You are an expert, friendly book recommendation concierge. Keep responses short and conversational (1-2 sentences max).

                We track these elements of context:
                1. Account verification choice (Email for 6-digit pin).
                2. Favorite authors/books.
                3. Current genre/mood.
                4. Loved traits (witty humor, dark tone, competence porn, vivid descriptions).
                5. Media preference (E-books vs audiobooks).
                6. Preferred narrators (Only ask if they prefer audiobooks).

                ${blacklist}
                CRITICAL ACCOUNT LOGIC RULES:
                - User is ALREADY AUTHENTICATED. 
                - DO NOT COMPOSE A WELCOME MESSAGE
                - DO NOT MENTION mention verification codes or ask them to sign in. 
                - MOVE straight into conversational profiling or delivering recommendations.

                CRITICAL FLOW & FORMATTING:
                - ONLY ASK ONE BRIEF QUESTION AT A TIME. Keep it casual.
                - Series Rule: Always output the specific title of the FIRST BOOK or volume as the 'title' parameter (e.g., "All Systems Red", not "The Murderbot Diaries"). Mention the series name in your conversational description instead.

                Evaluate state:
                - If context is missing, ask a single brief question in plain text.
                - If context is gathered, return a raw valid JSON array containing exactly 3 book objects with keys: "title", "author", and "reason". No markdown backticks or formatting tags.
                `;
        }
    }
];

async function setupDB (){
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                auth_provider TEXT DEFAULT 'local',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS recommendations (
                id SERIAL PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                book_title TEXT NOT NULL,
                author TEXT NOT NULL,
                status TEXT DEFAULT 'active', -- 'active' or 'removed'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                image_url TEXT,
                google_url TEXT,
                audible_url TEXT
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS open_library_cache (
                id SERIAL PRIMARY KEY,
                normalized_title TEXT NOT NULL,
                normalized_author TEXT NOT NULL,
                cover_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(normalized_title, normalized_author)
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_device_tokens (
                id SERIAL PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                device_token TEXT UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            );
        `);

        console.log("setupDB() db established.");
    } catch (error) {
        console.error("❌ db setup failed:", error.message);
    }
}



async function retrieveBooks(userId){
    const result = await db.query(
        `SELECT book_title, author, image_url, google_url, audible_url 
        FROM recommendations 
        WHERE user_id = $1 AND status = 'active' 
        ORDER BY id DESC`,
       [userId]
        );
    return result.rows || [];
}


/*
CHAT NOTES
1. First hello no authentication and no history.
2. Authentication and no chat history.
3. Authentication and chat history.
4. No authentication and chat history.
*/

/**
 * Generates a fresh, default state payload structure for a new chat session.
 */

//Create Session
function createSession() {
    console.log(`CreateSession() session established`);
    return { 
        history: [
            { role: "model", parts: [{ text: "Say hello and let's discuss books!" }] }
        ],
        authEmail: null,
        authCode: null,
        isAuthenticated: false,
        userId: null,
        excludedBooks: [],
        deviceTokenAccept: false,
        deviceToken: null
    };
}

//handle Tokens
async function createDeviceToken(session, cleanMessage) {
    let token;
    if( cleanMessage === "yes"){
        token = crypto.randomBytes(32).toString('hex');
        const expiration = new Date();
        expiration.setDate(expiration.getDate() + 30);
        session.deviceToken = token;
        session.deviceTokenAccept = "yes";
        await createUser(session.userId, session.authEmail);
        await db.query(
            `INSERT INTO user_device_tokens (user_id, device_token, expires_at) 
            VALUES ($1, $2, $3)`,
            [session.userId, token, expiration]
        );
    } else {
        session.deviceToken = null;
        session.deviceTokenAccept = "no"
    }
    const welcomeMessage = await handleSuccessfulVerification(session);
    return {
        reply: welcomeMessage,
        associatedEmail: session.authEmail,
        deviceToken: token
    };
}


async function verifyDeviceToken(session, token) {
    try {
        const result = await db.query(
            `SELECT user_id, email FROM user_device_tokens t
             JOIN users u ON t.user_id = u.id
             WHERE t.device_token = $1 AND t.expires_at > CURRENT_TIMESTAMP`,
            [token]
        );
        
        if (result.rows.length > 0) {
            const row = result.rows[0];

            session.userId = row.user_id;
            session.authEmail = row.email;
            session.isAuthenticated = true;
            session.deviceToken = token;
            session.deviceTokenAccept = "yes";
            
            return row; 
        }
        return null;
    } catch (err) {
        console.error("Device token issue:", err.message);
        return null;
    }
}

//AI Call

async function callAI(history, systemPrompt) {
    const maxRetries = 3;
    let currentDelay = 1500;
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`AI call: (Attempt ${attempt}/${maxRetries})...`);
        try {
            const response = await ai.models.generateContent({
                model: "gemini-3.1-flash-lite", 
                contents: history,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.6, 
                },
            });
            return response;
        } catch (error) {
            const is503 = error.status === 503 || 
                          (error.error && error.error.code === 503) || 
                          error.message?.includes('503');
                          
            if (is503 && attempt < maxRetries) {
                console.warn(`⏳ 503 Service Unavailable. Retrying in ${currentDelay}ms...`);
                await sleep(currentDelay);
                currentDelay *= 2;
                continue;
            }
            throw error; 
        }
    }
}

//logging in
async function createUser (userId, email) {
    await db.query(
        `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT(email) DO NOTHING`,
        [userId, email]
    );
}

async function handleEmailAddress(session, detectedEmail, res) {
    session.authEmail = detectedEmail[0].toLowerCase().trim();
    const authData = await initEmailReg(session.authEmail);
    session.userId = authData.userId;
    session.authCode = authData.authCode;
    return res.json({
        reply: authData.message,
        associatedEmail: session.authEmail
    });
}

async function initEmailReg(emailTarget) {
    let userId;
    try {
        const result = await db.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [emailTarget]);
        userId = result.rows.length > 0 ? result.rows[0].id : `usr_${Date.now()}`;
    } catch (dbErr) {
        console.error("❌ DB Check Failed:", dbErr.message);
        userId = `usr_${Date.now()}`;
    }
    const authCode = Math.floor(100000 + Math.random() * 900000).toString();
    await sendVerificationEmail(emailTarget, authCode);

    return { 
        userId, 
        authCode,
        message: `I've sent a 6-digit verification code to ${emailTarget}. Please enter it here to link your account!` 
    };
}

async function sendVerificationEmail(targetEmail, pinCode) {
    try {
        const { data, error } = await resend.emails.send({
            from: 'My Snook Book Concierge <no-reply@snookbook.com>',
            to: [targetEmail],
            subject: 'Your 6-Digit Verification Code',
            text: `Hello! Your one-time verification access code for My Snook Book is: ${pinCode}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e1e6eb; border-radius: 8px; max-width: 500px;">
                    <h2 style="color: #075e54; margin-top: 0;">My Snook Book Access Token</h2>
                    <p>Hello! Use the secure 6-digit verification pin below to complete your sign-in process inside the chat window:</p>
                    <div style="background-color: #f0f2f5; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; border-radius: 4px; color: #111; margin: 20px 0;">
                        ${pinCode}
                    </div>
                    <p style="font-size: 12px; color: #666;">If you didn't request this code, you can safely ignore this automated message.</p>
                </div>
            `
        });

        if (error) {
            console.error(`❌ Resend Delivery Error to ${targetEmail}:`, error.message);
            return false;
        }
        console.log(`Mail sent to: ${targetEmail}. ID: ${data.id}`);
        return true;
    } catch (err) {
        console.error(`❌ Unexpected processing breakdown during mail dispatch:`, err.message);
        return false;
    }
}

async function doVerify(session, structuralDigits) {
    /*if (structuralDigits && structuralDigits === session.authCode) {*/
        session.isAuthenticated = true;
        /*const welcomeMessage = await handleSuccessfulVerification(session);*/
        const deviceMessageText = PromptMatrix.find(p => p.id === 'deviceMessageText').build(session);
        const deviceMessage = await callAI( session.history, deviceMessageText);
        return {
            reply: deviceMessage.text,
            associatedEmail: session.authEmail,

        };
        
    /*} else if (/^\d{6}$/.test(structuralDigits)) {
        return { 
            reply: "That verification code doesn't match what I generated. Could you please double-check your code?",
            associatedEmail: null
        };
    } else {
        return {
            reply: `We're waiting for the 6-digit verification code sent to ${session.authEmail}. Please enter it to continue, or provide a different email address.`,
            associatedEmail: null
        };
    }*/
   
}

async function handleSuccessfulVerification(session) {
    try {
        await createUser(session.userId, session.authEmail);
        
        const activeRecs = await retrieveBooks(session.userId);
        if (activeRecs && activeRecs.length > 0) {
            session.excludedBooks = activeRecs.map(b => `"${b.book_title}" by ${b.author}`);
        }
    } catch (dbErr) {
        console.error("Database user setup error:", dbErr.message);
    }

    const systemContextText = PromptMatrix.find(p => p.id === 'systemContextText').build(session);
    session.history.push({ 
        role: "user", 
        parts: [{ text: systemContextText }] 
    });
    
    const masterSystemPrompt = PromptMatrix.find(p => p.id === 'mainPrompt').build(session);
    const aiResponse = await callAI(session.history, masterSystemPrompt);
    session.history.push({ 
        role: "model", 
        parts: [{ text: aiResponse.text }] 
    });
    return aiResponse.text;
}
async function doIntro(session){
    const welcomePrePrompt = PromptMatrix.find(p => p.id === 'welcomePreAuthenticated').build(session);
    try {
        const response = await callAI(session.history, welcomePrePrompt);
        const replyText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
        session.history.push({ role: "model", parts: [{ text: replyText }] });
        return { reply: replyText, associatedEmail: null };
    } catch (error) {
        console.error("Chat Generation Failure:", error);
        throw error;
    }
}

//Book Chat
async function handleBookChat(session, res) {
    try {
        const mainPrompt = PromptMatrix.find(p => p.id === 'mainPrompt').build(session);    
        const response = await callAI(session.history, mainPrompt);
        let replyText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
        session.history.push({ role: "model", parts: [{ text: replyText }] });
        let cleanedText = replyText.replace(/```json|```/g, "").trim();
        const isJson = (cleanedText.startsWith('[') && cleanedText.endsWith(']'));

        if (isJson) {
            return await formatBooks(cleanedText, res, session);
        } else {
            return res.json({ 
                reply: replyText, 
                associatedEmail: session.isAuthenticated ? session.authEmail : null 
            });
        }
    } catch (error) {
        console.error("Enrichment Pipeline Error:", error);
        return res.status(500).json({ reply: "An error occurred while compiling recommendations." });
    }
}
async function formatBooks( cleanedText, res, session ){
        const rawBooks = JSON.parse(cleanedText);
        const cleanedBooks = rawBooks.map(book => {
            let cleanTitle = book.title.replace(/\(.*?\)|\[.*?\]|[:\-–—.,!?]/g, "").replace(/\s+/g, " ").trim();
            return { originalTitle: book.title, cleanTitle, author: book.author, reason: book.reason };
        });
        const enrichedBooks = [];
        const normalize = (str) => {
            if (!str) return "";
            return str.toLowerCase()
                    .replace(/[^\w\s]/g, "")
                    .replace(/\s+/g, " ")    
                    .trim();
        };
        for (const book of cleanedBooks) {
            const coverUrl = await getCoverUrl( book);
            const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(`${book.author} ${book.cleanTitle} book amazon and barnes and noble`)}`;
            try {
            await db.query(
                `INSERT INTO recommendations (user_id, book_title, author, image_url, google_url, status)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [session.userId, book.originalTitle, book.author, coverUrl, googleUrl, 'active']
            );
                console.log(`💾 Saved "${book.originalTitle}" to database profile.`);
            } catch (dbErr) {
                console.error("❌ Failed to save recommendation to DB:", dbErr.message);
            }
            enrichedBooks.push({
                title: book.originalTitle,
                author: book.author,
                reason: book.reason,
                imageUrl: coverUrl, 
                googleUrl: googleUrl
            });
        }
        const savedExclusions = [...session.excludedBooks, ...cleanedBooks.map(b => `"${b.originalTitle}" by ${b.author}`)];
        chatSessions[session.sessionId] = {
            history: [{ role: "model", parts: [{ text: "Let's find some more books!" }] }],
            authEmail: session.authEmail,
            authCode: null,
            isAuthenticated: true,
            userId: session.userId,
            excludedBooks: savedExclusions
        };
        return res.json({ 
            isRecommendation: true, 
            books: enrichedBooks,
            associatedEmail: session.authEmail 
        });

}
async function getCoverUrl(book) {
    const normalize = (str) => { return (str || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim(); };
    const cacheCheck = await db.query(
        `SELECT cover_url FROM open_library_cache 
        WHERE normalized_title = $1 AND normalized_author = $2`,
        [normalize(book.cleanTitle), normalize(book.author)]
    );
    if (cacheCheck.rows.length > 0) { return cacheCheck.rows[0].cover_url; }
    
    let coverUrl = null;
    const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(book.cleanTitle + ' ' + book.author)}&fields=title,author_name,cover_i&limit=5`;
    const headers = new Headers({ "User-Agent": "SnookBook/1.0 (amylizt@gmail.com)" });
    const options = { method: 'GET', headers: headers, signal: AbortSignal.timeout(4000) };
    try {
        const apiRes = await fetch(searchUrl, options).then(res => res.json());
        const matchedDoc = (apiRes.docs || []).find(d => d.cover_i);
        if (matchedDoc) { 
            coverUrl = `https://covers.openlibrary.org/b/id/${matchedDoc.cover_i}-M.jpg`;
            await db.query(
                `INSERT INTO open_library_cache (normalized_title, normalized_author, cover_url)
                VALUES ($1, $2, $3)
                ON CONFLICT (normalized_title, normalized_author) DO NOTHING`,
                [normalize(book.cleanTitle), normalize(book.author), coverUrl]
            );
        }
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        await sleep(400);
    } catch (apiErr) {
        console.error(`⚠️ Cover metadata lookup failed for ${book.cleanTitle}:`, apiErr.message);
    }
    if (!coverUrl) {
        const title = book.originalTitle || book.cleanTitle;
        const displayTitle = title.length > 50 ? title.substring(0, 47) + '...' : title;
        coverUrl = `data:image/svg+xml;utf8,${encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 180" width="120" height="180">
            <rect width="120" height="180" fill="#555555" rx="2" />
            <rect x="4" y="4" width="112" height="172" fill="none" stroke="#ffffff" stroke-width="0.75" stroke-opacity="0.2" rx="1" />
            <foreignObject x="8" y="20" width="104" height="140">
                <p xmlns="http://www.w3.org/1999/xhtml" style="margin:0; padding:0; color:#ffffff; font-family:sans-serif; font-size:20px; 
                font-weight:bold; text-align:center; line-height:1.3; display:-webkit-box; -webkit-line-clamp:7; -webkit-box-orient:vertical; overflow:hidden;">
                    ${displayTitle}
                </p>
            </foreignObject>
        </svg>`.trim().replace(/\s+/g, ' '))}`;
    }

    return coverUrl;
}

//api
app.post('/api/chat', async (req, res) => {
    const { sessionId, message, deviceToken } = req.body;
    const cleanMessage = message ? message.trim() : ""; 
    const structuralDigits = cleanMessage.replace(/\D/g, "");
    if (!sessionId) { return res.status(400).json({ error: "A unique sessionId is required." });  }
    if (!chatSessions[sessionId]) { chatSessions[sessionId] = createSession(); }
    const session = chatSessions[sessionId];
    session.sessionId = sessionId;
    if (deviceToken && !session.isAuthenticated) {await verifyDeviceToken(session, deviceToken);}
    const deviceResolved = (session.deviceToken !== null) || (session.deviceTokenAccept === "no");
    const isVerifying = session.authEmail && !session.isAuthenticated && !deviceToken;
    const detectedEmail = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const isRegisteringEmail = detectedEmail && !session.authEmail && !deviceToken;
    const isNewUser = !session.isAuthenticated && !session.authEmail && !deviceToken;
    const isSaveDevice = cleanMessage === "yes" || cleanMessage === "no" && !session.deviceToken;
    const isAuthenticatedUser = session.isAuthenticated === true && deviceResolved;
    if (session.history[session.history.length - 1].role !== "user") {session.history.push({ role: "user", parts: [{ text: cleanMessage }] }); }
    switch (true) {
        case isSaveDevice: return res.json(await createDeviceToken(session, cleanMessage));
        case isRegisteringEmail: return await handleEmailAddress(session, detectedEmail, res);
        case isVerifying: {return res.json(await doVerify(session, structuralDigits));}
        case isNewUser: return res.json(await doIntro(session));
        case isAuthenticatedUser: return await handleBookChat(session, res);
        default:return res.status(400).json({ error: "Unhandled chat state." });
    }
});

/*app.post('/api/recommendations/status', async (req, res) => {
    const { email, title, author, status } = req.body; // status will be 'removed'

    if (!email || !title || !author || !status) {
        return res.status(400).json({ error: "Missing required parameters." });
    }

    try {
        // Find user id
        const userRow = await db.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email.toLowerCase().trim()]);
        if (userRow.rows.length === 0) {
            return res.status(404).json({ error: "User not found." });
        }
        const userId = userRow.rows[0].id;

        // Update the status of the specific book matching title and author for this user
        await db.query(`
            UPDATE recommendations 
            SET status = $1 
            WHERE user_id = $2 AND LOWER(book_title) = $3 AND LOWER(author) = $4
        `, [status, userId, title.toLowerCase().trim(), author.toLowerCase().trim()]);

        res.json({ success: true, message: `Book status updated to ${status}.` });
    } catch (err) {
        console.error("❌ Error updating book status:", err.message);
        res.status(500).json({ error: "Database update failure." });
    }
});
*/

app.get('/api/recommendations/saved', async (req, res) => {
    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ error: "Email parameter required." });
    }

    try {
        const userRow = await db.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email.toLowerCase().trim()]);
        if (userRow.rows.length === 0) {
            return res.json({ success: true, books: [] });
        }
        const userId = userRow.rows[0].id;

        // Pull only books that are 'active'
        const savedBooks = await db.query(`
            SELECT book_title as title, author, 
            image_url AS "imageUrl",
            google_url AS "googleUrl"
            FROM recommendations 
            WHERE user_id = $1 AND status = 'active'
            ORDER BY id DESC`, [userId]);

        res.json({ success: true, books: savedBooks.rows });
    } catch (err) {
        console.error("❌ Error fetching saved books:", err.message);
        res.status(500).json({ error: "Database retrieval failure." });
    }
});
/*

app.post('/api/auth/register-and-save', async (req, res) => {
    const { email, authProvider, initialBooks } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: "Email attribute is required." });
    }

    const cleanEmail = email.toLowerCase().trim();

    try {
        let userId;
        const userRow = await db.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [cleanEmail]);
        
        if (userRow.rows.length > 0) {
            userId = userRow.rows[0].id;
            console.log(`💾 Saving recommendations to existing user record ID: ${userId}`);
        } else {
            userId = `usr_${Date.now()}`;
            await db.query(
                `INSERT INTO users (id, email, auth_provider) VALUES ($1, $2, $3)`,
                [userId, cleanEmail, authProvider || 'email_code']
            );
            console.log(`💾 Created a fresh user record (${userId}).`);
        }

        // Batch transactional insert for recommendations using Postgres parameters
        if (initialBooks && Array.isArray(initialBooks)) {
            const client = await db.connect();
            try {
                await client.query('BEGIN');
                for (const book of initialBooks) {
                    const title = book.title || book.book_title;
                    const author = book.author;
                    const img = book.imageUrl || book.image_url || "https://via.placeholder.com/120x180?text=No+Cover";
                    const gUrl = book.googleUrl || book.google_url || `https://www.google.com/search?q=${encodeURIComponent(title + ' ' + author)}`;
                    const aUrl = book.audibleUrl || book.audible_url || `https://www.audible.com/search?keywords=${encodeURIComponent(title + ' ' + author)}`;
                    await client.query(
                        `INSERT INTO recommendations (user_id, book_title, author, image_url, google_url, audible_url, status)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [userId, title, author, img, gUrl, aUrl, 'active']
                    );
                }
                await client.query('COMMIT');
                console.log(`📊 Successfully stored ${initialBooks.length} book entries via Postgres transaction.`);
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }
        }

        res.json({ success: true, userId, message: "Reading data synced cleanly to database profile." });
    } catch (err) {
        console.error("❌ DB Auto-Save Failure Error:", err.message);
        res.status(500).json({ error: "Failed to record parameters." });
    }
});*/

module.exports = app;
