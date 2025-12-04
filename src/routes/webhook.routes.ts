import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { whatsappService, WhatsAppWebhookPayload } from '../services/whatsapp.service.js';
import { conversationService } from '../services/conversation.service.js';
import { twilioService } from '../services/twilio.service.js';

const router = Router();

// =====================================================
// WhatsApp Cloud API Webhooks
// =====================================================

// Webhook verification (GET request from Meta)
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  logger.info('WhatsApp webhook verification request received');

  const result = whatsappService.verifyWebhook(mode, token, challenge);

  if (result) {
    logger.info('WhatsApp webhook verified successfully');
    res.status(200).send(result);
  } else {
    logger.warn('WhatsApp webhook verification failed');
    res.status(403).send('Verification failed');
  }
});

// Webhook for incoming messages (POST request from Meta)
router.post('/whatsapp', async (req: Request, res: Response) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;

    // Acknowledge receipt immediately (Meta requires 200 within 20 seconds)
    res.status(200).send('OK');

    // Parse the webhook payload
    const { messages, statuses } = whatsappService.parseWebhookPayload(payload);

    // Process messages
    for (const msg of messages) {
      logger.info(`Incoming WhatsApp message from ${msg.from}: ${msg.type}`);

      await conversationService.processMessage(
        msg.from,
        msg.messageId,
        msg.type as 'text' | 'audio' | 'location' | 'interactive',
        msg.content,
        msg.name
      );
    }

    // Log status updates
    for (const status of statuses) {
      logger.debug(`Message ${status.messageId} status: ${status.status}`);
    }
  } catch (error: any) {
    logger.error('Error processing WhatsApp webhook:', error);
    // Still return 200 to prevent Meta from retrying
    if (!res.headersSent) {
      res.status(200).send('Error processed');
    }
  }
});

// =====================================================
// Machine Global Webhooks
// =====================================================

// Status update webhook from Machine Global
router.post('/machine/status', async (req: Request, res: Response) => {
  try {
    const data = req.body;
    logger.info(`Machine Global status webhook received:`, data);

    // Verify API key if provided
    const apiKey = req.headers['api-key'] || req.headers['x-api-key'];
    // Note: Machine Global might send their own key or no key

    // Process the status update
    await conversationService.handleMachineWebhook({
      corrida_id: data.corrida_id || data.id || data.solicitacao_id,
      status: data.status || data.situacao,
      motorista: data.motorista || data.condutor ? {
        nome: data.motorista?.nome || data.condutor?.nome,
        telefone: data.motorista?.telefone || data.condutor?.telefone,
        veiculo: data.motorista?.veiculo || data.condutor?.veiculo,
        placa: data.motorista?.placa || data.condutor?.placa,
        avaliacao: data.motorista?.avaliacao || data.condutor?.avaliacao,
      } : undefined,
      tempo_chegada: data.tempo_chegada || data.eta,
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error processing Machine Global webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Position update webhook from Machine Global
router.post('/machine/position', async (req: Request, res: Response) => {
  try {
    const data = req.body;
    logger.debug(`Machine Global position webhook:`, data);

    // Position updates can be used for real-time driver tracking
    // Store in Redis or broadcast via WebSocket if needed

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error processing Machine Global position webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// Twilio Voice Webhooks (Call Deflection)
// =====================================================

// Incoming voice call handler
router.post('/twilio/voice', async (req: Request, res: Response) => {
  try {
    const { From, To, CallSid } = req.body;
    logger.info(`Incoming call from ${From} to ${To} (CallSid: ${CallSid})`);

    // Handle call deflection
    const result = await twilioService.handleIncomingCall(From, To);

    // Return TwiML response
    res.type('text/xml');
    res.send(result.twiml);
  } catch (error: any) {
    logger.error('Error handling Twilio voice webhook:', error);

    // Return a basic TwiML response even on error
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say language="pt-BR">Desculpe, estamos com problemas técnicos. Por favor, tente novamente mais tarde.</Say>
        <Hangup/>
      </Response>`);
  }
});

// Call status callback
router.post('/twilio/status', async (req: Request, res: Response) => {
  try {
    const { CallSid, CallStatus, From, To, Duration } = req.body;
    logger.info(`Call ${CallSid} status: ${CallStatus} (Duration: ${Duration}s)`);

    res.status(200).send('OK');
  } catch (error: any) {
    logger.error('Error handling Twilio status webhook:', error);
    res.status(200).send('OK');
  }
});

export default router;
