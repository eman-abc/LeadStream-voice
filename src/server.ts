import dotenv from 'dotenv';
import express from 'express';
import vapiRouter from './controllers/vapiController';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/vapi', vapiRouter);

// Basic health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`✓ CVision Triage Platform listening on port ${PORT}`);
    console.log(`✓ Webhook endpoint: POST http://localhost:${PORT}/vapi/webhook`);
});
