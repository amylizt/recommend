const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3100;

// Middleware to parse JSON bodies
app.use(express.json());

// Point Express to your "public" folder for all static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Pool of mock Latin responses
const latinReplies = [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    "Alea iacta est. (The die is cast.)",
    "Acta non verba. (Actions, not words.)",
    "Carpe diem. (Seize the day.)",
    "Veni, vidi, vici. (I came, I saw, I conquered.)",
    "In vino veritas. (In wine there is truth.)",
    "Audaces fortuna iuvat. (Fortune favors the bold.)",
    "Cogito, ergo sum. (I think, therefore I am.)"
];

// Chat API Endpoint
app.post('/api/chat', (req, res) => {
    const userMessage = req.body.message;
    
    // Simulate a tiny processing delay, then send back Latin
    setTimeout(() => {
        const randomIndex = Math.floor(Math.random() * latinReplies.length);
        const reply = latinReplies[randomIndex];
        
        res.json({ reply: reply });
    }, 400); 
});

app.listen(PORT, () => {
    console.log(`Server running smoothly at http://localhost:${PORT}`);
});
