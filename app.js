const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const { Pool } = require('pg'); // Switched to pg Pool
const { Resend } = require('resend');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Resend Client using your environmental configuration key
const resend = new Resend(process.env.RESEND_API_KEY);

// Global DB Connection Pool
const db = new Pool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'snookbook',
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

// Database Initialization (Table setup)
(async () => {
    try {
        // Test connection
        await db.query('SELECT NOW()');
        
        // Create tables using standard Postgres syntax
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
                user_id TEXT NOT NULL REFERENCES users(id),
                book_title TEXT NOT NULL,
                author TEXT NOT NULL,
                status TEXT DEFAULT 'suggested',
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("💾 PostgreSQL Database initialized cleanly via pure JS app layer.");
    } catch (error) {
        console.error("❌ Database initialization failed:", error.message);
    }
})();

// Helper function to send the email asynchronously via Resend API
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

// In-Memory Session Storage
const chatSessions = {};

app.get('/api/chat', (req, res) => {
    res.json({ message: "The chat endpoint is active." });
});

// Chat Entry Route
app.post('/api/chat', async (req, res) => {
    const { sessionId, message } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: "A unique sessionId is required." });
    }

    if (!chatSessions[sessionId]) {
        console.log(`🆕 Starting fluid AI discovery session: ${sessionId}`);
        chatSessions[sessionId] = { 
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

    const session = chatSessions[sessionId];

    // --- INTERCEPT WORKFLOW: Check if we are waiting for a verification code ---
    if (session.authEmail && !session.isAuthenticated) {
        const structuralDigits = message.replace(/\s+/g, "");
        
        if (structuralDigits === session.authCode) {
            session.isAuthenticated = true;
            console.log(`🔒 Session ${sessionId} authenticated successfully for user: ${session.authEmail}`);
            
            try {
                // Upsert logic for PostgreSQL using ON CONFLICT DO NOTHING
                await db.query(
                    `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT(email) DO NOTHING`,
                    [session.userId, session.authEmail]
                );

                // Fetch past recommendations from Postgres
                const result = await db.query(
                    `SELECT book_title, author FROM recommendations WHERE user_id = $1`,
                    [session.userId]
                );
                
                if (result.rows && result.rows.length > 0) {
                    session.excludedBooks = result.rows.map(b => `"${b.book_title}" by ${b.author}`);
                    console.log(`📚 Loaded ${session.excludedBooks.length} historical book exclusions.`);
                }
            } catch (dbErr) {
                console.error("Database user setup error:", dbErr.message);
            }

            const systemContextText = session.excludedBooks.length > 0
                ? `[SYSTEM: User successfully entered verification code. This is an EXISTING returning account. Historical recommendations already stored in their profile are: ${session.excludedBooks.join(', ')}. YOU MUST NEVER RECOMMEND THESE TITLES AGAIN IN THIS SESSION. Welcome them back contextually, acknowledge their taste, and ask a discovery question.]`
                : `[SYSTEM: User successfully entered verification code. This is a BRAND NEW account. Welcome them to the platform for the first time, then ask your first discovery question.]`;

            session.history.push({ 
                role: "user", 
                parts: [{ text: `${systemContextText}\nUser Response: "${message}"` }] 
            });
        } else if (/^\d{6}$/.test(structuralDigits)) {
            session.history.push({ role: "user", parts: [{ text: message }] });
            session.history.push({ role: "model", parts: [{ text: "That verification code doesn't match what I generated. Could you please double-check your code?" }] });
            return res.json({ reply: "That verification code doesn't match what I generated. Could you please double-check your code?" });
        }
    }

    const justVerified = session.authEmail && session.isAuthenticated && session.history[session.history.length - 1].parts[0].text.includes('[SYSTEM:');

    if (!justVerified && session.history[session.history.length - 1].role !== "user") {
        session.history.push({ role: "user", parts: [{ text: message }] });
    }

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const detectedEmail = message.match(emailRegex);

    if (detectedEmail && !session.authEmail) {
        const emailTarget = detectedEmail[0].toLowerCase().trim();
        session.authEmail = emailTarget;
        
        try {
            const result = await db.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [emailTarget]);
            if (result.rows.length > 0) {
                console.log(`🔍 Existing user match found in DB. Reusing ID: ${result.rows[0].id}`);
                session.userId = result.rows[0].id;
            } else {
                session.userId = `usr_${Date.now()}`;
                console.log(`🆕 No user found. Pre-generating new ID: ${session.userId}`);
            }
        } catch (dbErr) {
            console.error("❌ Failed to query users table during entry check:", dbErr.message);
        }

        const generatedPin = Math.floor(100000 + Math.random() * 900000).toString();
        session.authCode = generatedPin;

        console.log(`⚡ Code generated locally for session console log tracking: [ ${generatedPin} ]`);
        sendVerificationEmail(session.authEmail, generatedPin);
    }

    const dynamicBlacklist = session.excludedBooks && session.excludedBooks.length > 0 
        ? `CRITICAL EXCLUSIONS: You have already recommended the following books to this user in the past: ${session.excludedBooks.join(', ')}. NEVER suggest these books or their direct sequels again. Focus on fresh alternative content.`
        : ``;

    const accountLogicRule = session.isAuthenticated
        ? `- The user is ALREADY SECURELY AUTHENTICATED via email. Do NOT show, mention, or print the onboarding greeting line. Do NOT ask them to sign in or create an account under any circumstances. Immediately treat them as a logged-in user and ask about their book tastes.`
        : `- First greeting: If the user is unauthenticated and just says hi, you MUST reply with this exact sentence: "If you want to sign in or create an account let's start with your email address. Otherwise, we can skip that for now—what are some of your favorite books or authors?"`;

    const discoverySystemInstruction = `
You are an expert, friendly book recommendation concierge. Keep your responses short, punchy, and conversational (1-2 sentences max).

We track these elements of context throughout the chat:
1. Account verification choice (Providing an email to get a 6-digit verification code pin).
2. Favorite authors or books.
3. Current genre or mood.
4. Loved traits (e.g., witty humor, dark tone, competence porn, vivid descriptions).
5. Media preference (E-books vs audiobooks).
6. Preferred narrators (Only ask if they prefer audiobooks!).

${dynamicBlacklist}

CRITICAL ACCOUNT LOGIC RULES:
${accountLogicRule}
- If you notice the system message "[SYSTEM: User successfully entered matching verification code...]", change your welcome message to match their status (new vs returning), then immediately ask your first casual profiling question in the same text turn.

CRITICAL FLOW INSTRUCTIONS:
- ONLY ASK ONE BRIEF QUESTION AT A TIME. Keep it casual.
- Review history carefully. If they answer multiple details at once, skip those items.

Evaluate the state:
- If context is missing, ask a single brief question in normal text.
- If all context is gathered, return a raw valid JSON array containing exactly 3 book objects. Each object must have keys: "title", "author", and "reason". Do not wrap your response in markdown formatting or tags.
`;

    const maxRetries = 3;
    let currentDelay = 1500;
    let response;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            response = await ai.models.generateContent({
                model: "gemini-3.1-flash-lite", 
                contents: session.history,
                config: {
                    systemInstruction: discoverySystemInstruction,
                    temperature: 0.6, 
                },
            });
            break;
        } catch (error) {
            const is503 = error.status === 503 || (error.error && error.error.code === 503) || error.message?.includes('503');
            if (is503 && attempt < maxRetries) {
                await sleep(currentDelay);
                currentDelay *= 2;
                continue;
            }
            throw error;
        }
    }

    try {
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

            const enrichedBooks = await Promise.all(cleanedBooks.map(async (book) => {
                let coverUrl = "https://via.placeholder.com/120x180?text=No+Cover";
                try {
                    const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(book.cleanTitle + ' ' + book.author)}&fields=title,author_name,cover_i&limit=5`;
                    const apiRes = await fetch(searchUrl);
                    const apiData = await apiRes.json();
                    const docs = apiData.docs || [];
                    
                    const matchedDoc = docs.find(d => d.cover_i);
                    if (matchedDoc) {
                        coverUrl = `https://covers.openlibrary.org/b/id/${matchedDoc.cover_i}-M.jpg`;
                    }
                } catch (apiErr) {
                    console.error(`⚠️ Cover match failed for ${book.cleanTitle}:`, apiErr.message);
                }

                return {
                    title: book.originalTitle,
                    author: book.author,
                    reason: book.reason,
                    imageUrl: coverUrl, 
                    googleUrl: `https://www.google.com/search?q=${encodeURIComponent(`${book.author} ${book.cleanTitle} book amazon and barnes and noble`)}` 
                };
            }));

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
            return res.json({ reply: replyText });
        }

    } catch (error) {
        console.error("Enrichment Pipeline Error:", error);
        res.status(500).json({ reply: "An error occurred while compiling recommendations." });
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
                    await client.query(
                        `INSERT INTO recommendations (user_id, book_title, author) VALUES ($1, $2, $3)`,
                        [userId, book.title, book.author]
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
