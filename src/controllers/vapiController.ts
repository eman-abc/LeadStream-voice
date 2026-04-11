import { Router, Request, Response } from 'express';

const router = Router();

function buildToolCallResults(message: any) {
    const toolCallList = Array.isArray(message.toolCallList)
        ? message.toolCallList
        : Array.isArray(message.toolWithToolCallList)
            ? message.toolWithToolCallList.map((item: any) => item.toolCall)
            : [];

    return toolCallList.map((toolCall: any) => ({
        name: toolCall.name,
        toolCallId: toolCall.id,
        result: JSON.stringify({ status: 'completed' }),
    }));
}

/**
 * POST /vapi/webhook
 * Receives VAPI server events and responds with valid JSON for assistant-request or tool-calls.
 */
router.post('/webhook', (req: Request, res: Response) => {
    console.log('--- Vapi Webhook Received ---');
    console.log(JSON.stringify(req.body, null, 2));

    const message = req.body?.message;
    const messageType = message?.type;

    if (!messageType || typeof messageType !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid message.type' });
    }

    switch (messageType) {
        case 'assistant-request':
            return res.status(200).json({
                assistant: {
                    firstMessage: 'Welcome to Apex Software. How can I help you today?',
                    model: {
                        provider: 'openai',
                        model: 'gpt-4o',
                        messages: [
                            {
                                role: 'system',
                                content: 'You are a professional receptionist for Apex Software. Keep answers concise and helpful.',
                            },
                        ],
                    },
                },
            });

        case 'tool-calls':
            return res.status(200).json({
                results: buildToolCallResults(message),
            });

        case 'end-of-call-report':
            console.log('--- End-of-Call Report ---');
            console.log(JSON.stringify(message, null, 2));
            return res.status(200).json({ status: 'end-of-call-report received' });

        default:
            return res.status(200).json({ status: 'received' });
    }
});

export default router;
