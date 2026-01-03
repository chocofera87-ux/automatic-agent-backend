import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { whatsappService, WhatsAppWebhookPayload } from '../services/whatsapp.service.js';
import { conversationService } from '../services/conversation.service.js';
import { twilioService } from '../services/twilio.service.js';
import { credentialsService } from '../services/credentials.service.js';
import { openaiService } from '../services/openai.service.js';
import { machineGlobalService } from '../services/machineGlobal.service.js';

const router = Router();

// Helper function to load all required credentials from database
async function loadAllCredentials(): Promise<void> {
  try {
    // Load WhatsApp credentials
    const whatsappCreds = await credentialsService.getServiceCredentials('whatsapp');
    if (whatsappCreds.WHATSAPP_ACCESS_TOKEN && whatsappCreds.WHATSAPP_PHONE_NUMBER_ID) {
      whatsappService.updateCredentials(
        whatsappCreds.WHATSAPP_ACCESS_TOKEN,
        whatsappCreds.WHATSAPP_PHONE_NUMBER_ID,
        whatsappCreds.WHATSAPP_VERIFY_TOKEN
      );
    }

    // Load OpenAI credentials
    const openaiCreds = await credentialsService.getServiceCredentials('openai');
    if (openaiCreds.OPENAI_API_KEY) {
      openaiService.updateCredentials(openaiCreds.OPENAI_API_KEY);
    }

    // Load Machine Global credentials
    const machineCreds = await credentialsService.getServiceCredentials('machine');
    if (machineCreds.MACHINE_GLOBAL_API_KEY && machineCreds.MACHINE_GLOBAL_USERNAME && machineCreds.MACHINE_GLOBAL_PASSWORD) {
      machineGlobalService.updateCredentials(
        machineCreds.MACHINE_GLOBAL_API_KEY,
        machineCreds.MACHINE_GLOBAL_USERNAME,
        machineCreds.MACHINE_GLOBAL_PASSWORD,
        machineCreds.MACHINE_GLOBAL_BASE_URL
      );
    }
  } catch (error) {
    logger.error('Failed to load credentials from database:', error);
  }
}

// Helper function to load WhatsApp credentials only
async function loadWhatsAppCredentials(): Promise<boolean> {
  try {
    const creds = await credentialsService.getServiceCredentials('whatsapp');
    if (creds.WHATSAPP_ACCESS_TOKEN && creds.WHATSAPP_PHONE_NUMBER_ID) {
      whatsappService.updateCredentials(
        creds.WHATSAPP_ACCESS_TOKEN,
        creds.WHATSAPP_PHONE_NUMBER_ID,
        creds.WHATSAPP_VERIFY_TOKEN
      );
      return true;
    }
    return false;
  } catch (error) {
    logger.error('Failed to load WhatsApp credentials from database:', error);
    return false;
  }
}

// =====================================================
// WhatsApp Cloud API Webhooks
// =====================================================

// Default verify token (must match what client configures in Meta)
const DEFAULT_WEBHOOK_VERIFY_TOKEN = 'michame_verify_token_2024';

// Webhook verification (GET request from Meta)
// This MUST be fast and reliable - no database dependency!
router.get('/whatsapp', (req: Request, res: Response) => {
  try {
    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'] as string;
    const challenge = req.query['hub.challenge'] as string;

    logger.info(`WhatsApp webhook verification: mode=${mode}, token=${token}, challenge=${challenge}`);

    // Simple verification - no database, no async operations
    if (mode === 'subscribe' && token === DEFAULT_WEBHOOK_VERIFY_TOKEN) {
      logger.info('WhatsApp webhook verified successfully - returning challenge');
      // IMPORTANT: Return challenge as plain text, not JSON
      res.status(200).send(challenge);
    } else {
      logger.warn(`WhatsApp webhook verification failed - mode=${mode}, expected token=${DEFAULT_WEBHOOK_VERIFY_TOKEN}, received token=${token}`);
      res.status(403).send('Verification failed');
    }
  } catch (error: any) {
    logger.error('Webhook verification error:', error);
    res.status(500).send('Internal error');
  }
});

// Webhook for incoming messages (POST request from Meta)
router.post('/whatsapp', async (req: Request, res: Response) => {
  try {
    const payload = req.body as WhatsAppWebhookPayload;

    // Acknowledge receipt immediately (Meta requires 200 within 20 seconds)
    res.status(200).send('OK');

    // Load all credentials from database before processing (WhatsApp, OpenAI, Machine Global)
    await loadAllCredentials();

    logger.info('WhatsApp webhook received - processing messages');

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

// =====================================================
// Test Endpoints (for debugging)
// =====================================================

// Test sending a plain text message
router.get('/test-text/:phone', async (req: Request, res: Response) => {
  try {
    const phone = req.params.phone;

    // Load credentials from database first
    await loadWhatsAppCredentials();

    logger.info(`Testing plain text message to: ${phone}`);

    const result = await whatsappService.sendTextMessage(
      phone,
      'Olá! Esta é uma mensagem de teste do Mi Chame. Se você recebeu esta mensagem, o sistema está funcionando corretamente!'
    );

    if (result.success) {
      logger.info(`Test message sent successfully! Message ID: ${result.messageId}`);
      res.json({
        success: true,
        messageId: result.messageId,
        message: 'Plain text message sent successfully!'
      });
    } else {
      logger.error(`Test message failed: ${result.error}`);
      res.status(400).json({
        success: false,
        error: result.error,
        message: 'Failed to send plain text message. Check logs for full error details.'
      });
    }
  } catch (error: any) {
    logger.error('Test text message error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Internal server error during test'
    });
  }
});

// Test sending a location request message
router.get('/test-location/:phone', async (req: Request, res: Response) => {
  try {
    const phone = req.params.phone;

    // Load credentials from database first
    await loadWhatsAppCredentials();

    logger.info(`Testing location request message to: ${phone}`);

    const result = await whatsappService.sendLocationRequest(
      phone,
      'Por favor, compartilhe sua localização atual para que possamos encontrar táxis próximos a você.'
    );

    if (result.success) {
      logger.info(`Location request sent successfully! Message ID: ${result.messageId}`);
      res.json({
        success: true,
        messageId: result.messageId,
        message: 'Location request message sent successfully!'
      });
    } else {
      logger.error(`Location request failed: ${result.error}`);
      res.status(400).json({
        success: false,
        error: result.error,
        message: 'Failed to send location request. Check logs for full error details.'
      });
    }
  } catch (error: any) {
    logger.error('Test location request error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Internal server error during test'
    });
  }
});

// Check WhatsApp credentials status
router.get('/test-credentials', async (req: Request, res: Response) => {
  try {
    // Load credentials from database
    await loadWhatsAppCredentials();

    const hasCredentials = whatsappService.hasCredentials();

    res.json({
      success: true,
      hasCredentials,
      message: hasCredentials
        ? 'WhatsApp credentials are configured'
        : 'WhatsApp credentials are NOT configured - please set them in the dashboard'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
