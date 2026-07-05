require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3200; 

const server = app.listen(PORT, () => {
    console.log(`Sever initialized and listening on port ${PORT}`);
});

//test comment
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server safely');
    server.close(() => {
        console.log('HTTP server terminated down cleanly.');
    });
});
