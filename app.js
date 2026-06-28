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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Pool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'snookbook',
    port: parseInt(process.env.DB_PORT || '5432', 10),
});


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
        id: 'discoverySystemInstruction',
        build: (session) => {
            const hasRecs = session.excludedBooks && session.excludedBooks.length > 0;
            const blacklist = hasRecs ? `CRITICAL EXCLUSIONS: You have already recommended: ${session.excludedBooks.join(', ')}. NEVER suggest these books or their sequels. Focus on fresh content.\n` : '';
            
            const accountRule = session.isAuthenticated
                ? `- User is ALREADY AUTHENTICATED. Do NOT show onboarding/greeting options or ask them to sign in. Treat them as logged in.`
                : `- Unauthenticated greeting: If they just say hi, you MUST reply with exactly: "If you want to sign in or create an account let's start with your email address. Otherwise, we can skip that for now—what are some of your favorite books or authors?"`;

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
                ${accountRule}
                - If you see "[SYSTEM: User successfully entered verification code...]", match your welcome to their status (new vs returning), then immediately ask your first casual profiling question in the same turn.

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
        console.log("💾 PostgreSQL Database initialized cleanly via pure JS app layer.");
    } catch (error) {
        console.error("❌ Database initialization failed:", error.message);
    }
}

async function createUser (userId, email) {
    await db.query(
        `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT(email) DO NOTHING`,
        [userId, email]
    );
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
            return;
        }
        console.log(`✉️ Mail successfully dispatched via Resend API to ${targetEmail}. ID: ${data.id}`);
    } catch (err) {
        console.error(`❌ Unexpected processing breakdown during mail dispatch:`, err.message);
    }
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
function createSession() {
    console.log(`🆕 Generating fresh session payload parameters.`);
    return { 
        history: [
            { role: "model", parts: [{ text: "Say hello and let's discuss books!" }] }
        ],
        authEmail: null,
        authCode: null,
        isAuthenticated: false,
        userId: null,
        excludedBooks: []
    };
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
    sendVerificationEmail(emailTarget, authCode);

    return { userId, authCode };
}


async function callAI(history, systemPrompt) {
    const maxRetries = 3;
    let currentDelay = 1500;
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`🤖 Requesting Gemini generation (Attempt ${attempt}/${maxRetries})...`);
        try {
            const response = await ai.models.generateContent({
                model: "gemini-3.1-flash-lite", 
                contents: history,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.6, 
                },
            });
            return response; // Return immediately on success
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
            throw error; // Fail fast if it's a non-503 error or we ran out of attempts
        }
    }
}

app.post('/api/chat', async (req, res) => {
    const { sessionId, message } = req.body;
    const cleanMessage = message ? message.trim() : ""; 
    if (!sessionId) {return res.status(400).json({ error: "A unique sessionId is required." });}
    if (!chatSessions[sessionId]) { chatSessions[sessionId] = createSession(); }
    const session = chatSessions[sessionId];

    if (session.authEmail && !session.isAuthenticated) {
        const structuralDigits = cleanMessage.replace(/\s+/g, "");
        
        if (structuralDigits && structuralDigits === session.authCode) {
            session.isAuthenticated = true;
            console.log(`🔒 Session ${sessionId} authenticated successfully for user: ${session.authEmail}`);
            
            try {
                await createUser(session.userId, session.authEmail);
                const activeRecs = await retrieveBooks( session.userId )
                if (activeRecs && activeRecs.length > 0) {
                    session.excludedBooks = activeRecs.map(b => `"${b.book_title}" by ${b.author}`);
                    console.log(`📚 Loaded ${session.excludedBooks.length} historical book exclusions.`);
                }
            } catch (dbErr) {
                console.error("Database user setup error:", dbErr.message);
            }
            const systemContextText = PromptMatrix.find(p => p.id === 'systemContextText').build(session);
            session.history.push({ 
                role: "user", 
                parts: [{ text: systemContextText }] 
            });
            
        } else if (/^\d{6}$/.test(structuralDigits)) {
            return res.json({ 
                reply: "That verification code doesn't match what I generated. Could you please double-check your code?",
                associatedEmail: null
            });
        } else {
            return res.json({
                reply: `We're waiting for the 6-digit verification code sent to ${session.authEmail}. Please enter it to continue, or provide a different email address.`,
                associatedEmail: null
            });
        }
        const aiResponse = await callAI(session.history, systemContextText);
    }

    if (session.history[session.history.length - 1].role !== "user") {
        session.history.push({ role: "user", parts: [{ text: cleanMessage }] });
    }
    if ( session.history[session.history.length - 1].role !== "user") {
        session.history.push({ role: "user", parts: [{ text: message }] });
    }

    const detectedEmail = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

    if (detectedEmail && !session.authEmail) { 
        session.authEmail = detectedEmail[0].toLowerCase().trim();
        const authData = await initEmailReg( session.authEmail );
        session.userId = authData.userId;
        session.authCode = authData.authCode;
    }
        
    const masterSystemPrompt = PromptMatrix.find(p => p.id === 'discoverySystemInstruction').build(session);
    const maxRetries = 3;
    let currentDelay = 1500;
    let response;
    

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


    try {
        response = await callAI(session.history, masterSystemPrompt);
        let replyText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
        session.history.push({ role: "model", parts: [{ text: replyText }] });
        
        let cleanedText = replyText.replace(/```json|```/g, "").trim();
        const isJson = (cleanedText.startsWith('[') && cleanedText.endsWith(']'));

        if (isJson) {
            const rawBooks = JSON.parse(cleanedText);

            const cleanedBooks = rawBooks.map(book => {
                let cleanTitle = book.title.replace(/\(.*?\)|\[.*?\]|[:\-–—.,!?]/g, "").replace(/\s+/g, " ").trim();
                return { originalTitle: book.title, cleanTitle, author: book.author, reason: book.reason };
            });


            const enrichedBooks = [];
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            // Unified helper to lower-case, strip all punctuation, and normalize whitespace chunks
            const normalize = (str) => {
                if (!str) return "";
                return str.toLowerCase()
                          .replace(/[^\w\s]/g, "") // Strips commas, colons, dashes, etc.
                          .replace(/\s+/g, " ")    // Collapses multiple consecutive spaces
                          .trim();
            };


            for (const book of cleanedBooks) {
                let coverUrl = "https://via.placeholder.com/120x180?text=No+Cover";
                const cleanTargetTitle = normalize(book.cleanTitle);
                const cleanTargetAuthor = normalize(book.author);

                try {

                    const cacheCheck = await db.query(
                        `SELECT cover_url FROM open_library_cache 
                         WHERE normalized_title = $1 AND normalized_author = $2`,
                        [cleanTargetTitle, cleanTargetAuthor]
                    );

                    if (cacheCheck.rows.length > 0) {
                        coverUrl = cacheCheck.rows[0].cover_url;
                        console.log(`🗄️ Cache HIT: Retrieved cover locally from DB for "${book.cleanTitle}"`);
                    } else {

                        console.log(`🌐 Cache MISS: Requesting live network payload for "${book.cleanTitle}"`);
                        const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(book.cleanTitle + ' ' + book.author)}&fields=title,author_name,cover_i&limit=5`;
                        
                        const headers = new Headers({
                            "User-Agent": "SnookBook/1.0 (amylizt@gmail.com)"
                        });
                        
                        const options = {
                            method: 'GET',
                            headers: headers,
                            signal: AbortSignal.timeout(4000) 
                        };

                        const apiRes = await fetch(searchUrl, options);
                        const apiData = await apiRes.json();
                        const docs = apiData.docs || [];

                        const matchedDoc = docs.find(d => {
                            if (!d.cover_i) return false;
                            
                            const cleanDbTitle = normalize(d.title);
                            const isTitleMatch = cleanDbTitle === cleanTargetTitle;
                            
                            const isAuthorMatch = d.author_name && d.author_name.some(author => {
                                const cleanDbAuthor = normalize(author);
                                return cleanDbAuthor.includes(cleanTargetAuthor) || cleanTargetAuthor.includes(cleanDbAuthor);
                            });
                            
                            return isTitleMatch && isAuthorMatch;
                        });

                        if (matchedDoc) {
                            coverUrl = `https://covers.openlibrary.org/b/id/${matchedDoc.cover_i}-M.jpg`;
                            console.log(`🎯 Live verification match succeeded for "${book.cleanTitle}": ${coverUrl}`);
                        } else {
                            console.log(`⚠️ No strict title/author document with a cover found for: "${book.cleanTitle}"`);
                        }


                        await db.query(
                            `INSERT INTO open_library_cache (normalized_title, normalized_author, cover_url)
                             VALUES ($1, $2, $3)
                             ON CONFLICT (normalized_title, normalized_author) DO NOTHING`,
                            [cleanTargetTitle, cleanTargetAuthor, coverUrl]
                        );
                        

                        await sleep(400);
                    }
                } catch (apiErr) {
                    console.error(`⚠️ Cover metadata lookup failed for ${book.cleanTitle}:`, apiErr.message);
                    
                    const underlyingError = apiErr.cause ? apiErr.cause.message : 'No underlying cause reported';
                    try {
                        const logPath = path.join(__dirname, 'api_errors.log');
                        const timestamp = new Date().toISOString();
                        const logPayload = `[${timestamp}] FAILURE: Fetch dropped for "${book.cleanTitle}" by ${book.author}.\nDetails: ${apiErr.message}\nUnderlying Cause: ${underlyingError}\nStack: ${apiErr.stack}\n-------------------------------------------------------\n`;
                        
                        fs.appendFile(logPath, logPayload, (fsErr) => {
                            if (fsErr) console.error("❌ Failed to write to local log file:", fsErr.message);
                        });
                    } catch (logCatchErr) {
                        console.error("❌ Critical logging error:", logCatchErr.message);
                    }
                }


                enrichedBooks.push({
                    title: book.originalTitle,
                    author: book.author,
                    reason: book.reason,
                    imageUrl: coverUrl, 
                    googleUrl: `https://www.google.com/search?q=${encodeURIComponent(`${book.author} ${book.cleanTitle} book amazon and barnes and noble`)}` 
                });
            } 
            console.log(`💾 Saving recommendations to existing user record ID: ${userId}`);
            await db.query(
                `UPDATE user_recommendations SET history = history || $1 WHERE user_id = $2`,
                [JSON.stringify(enrichedBooks), userId]
            );


            return res.json({
                success: true,
                message: "Recommendations compiled successfully.",
                books: enrichedBooks
            });

            const savedEmail = session.authEmail;
            const savedUserId = session.userId;
            const savedExclusions = [...session.excludedBooks, ...cleanedBooks.map(b => `"${b.originalTitle}" by ${b.author}`)];

            chatSessions[sessionId] = {
                history: [{ role: "model", parts: [{ text: "Let's find some more books!" }] }],
                authEmail: savedEmail,
                authCode: null,
                isAuthenticated: true,
                userId: savedUserId,
                excludedBooks: savedExclusions
            };

            return res.json({ 
                isRecommendation: true, 
                books: enrichedBooks,
                associatedEmail: savedEmail 
            });

        } else {
            return res.json({ reply: replyText, associatedEmail: session.isAuthenticated ? session.authEmail : null });
        }

    } catch (error) {
        console.error("Enrichment Pipeline Error:", error);
        res.status(500).json({ reply: "An error occurred while compiling recommendations." });
    }
});

// Endpoint to mark a book as removed
app.post('/api/recommendations/status', async (req, res) => {
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

// Endpoint to fetch all non-removed books for a specific user
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
            google_url AS "googleUrl",
            audible_url AS "audibleUrl"
            FROM recommendations 
            WHERE user_id = $1 AND status = 'active'
            ORDER BY id DESC`, [userId]);

        res.json({ success: true, books: savedBooks.rows });
    } catch (err) {
        console.error("❌ Error fetching saved books:", err.message);
        res.status(500).json({ error: "Database retrieval failure." });
    }
});


// Endpoint to persist initial user and recommendation records safely
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
});

module.exports = app;
