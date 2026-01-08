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
    } else {
      logger.warn('WhatsApp credentials not found in database - check Settings page');
      logger.warn(`  - Access Token: ${whatsappCreds.WHATSAPP_ACCESS_TOKEN ? 'SET' : 'NOT SET'}`);
      logger.warn(`  - Phone Number ID: ${whatsappCreds.WHATSAPP_PHONE_NUMBER_ID ? 'SET' : 'NOT SET'}`);
    }

    // Load OpenAI credentials
    const openaiCreds = await credentialsService.getServiceCredentials('openai');
    if (openaiCreds.OPENAI_API_KEY) {
      openaiService.updateCredentials(openaiCreds.OPENAI_API_KEY);
    } else {
      logger.warn('OpenAI credentials not found in database');
    }

    // Load Machine Global credentials
    const machineCreds = await credentialsService.getServiceCredentials('machine');
    if (machineCreds.MACHINE_GLOBAL_API_KEY && machineCreds.MACHINE_GLOBAL_USERNAME && machineCreds.MACHINE_GLOBAL_PASSWORD) {
      logger.info(`Loading Machine Global credentials from database:`);
      logger.info(`  - API Key: ${machineCreds.MACHINE_GLOBAL_API_KEY.substring(0, 15)}...`);
      logger.info(`  - Username: ${machineCreds.MACHINE_GLOBAL_USERNAME}`);
      logger.info(`  - Password: SET (${machineCreds.MACHINE_GLOBAL_PASSWORD.length} chars)`);
      logger.info(`  - Base URL: ${machineCreds.MACHINE_GLOBAL_BASE_URL || 'DEFAULT (api-trial.taximachine.com.br)'}`);
      machineGlobalService.updateCredentials(
        machineCreds.MACHINE_GLOBAL_API_KEY,
        machineCreds.MACHINE_GLOBAL_USERNAME,
        machineCreds.MACHINE_GLOBAL_PASSWORD,
        machineCreds.MACHINE_GLOBAL_BASE_URL
      );
    } else {
      logger.warn('Machine Global credentials incomplete in database:');
      logger.warn(`  - API Key: ${machineCreds.MACHINE_GLOBAL_API_KEY ? 'SET' : 'NOT SET'}`);
      logger.warn(`  - Username: ${machineCreds.MACHINE_GLOBAL_USERNAME ? 'SET' : 'NOT SET'}`);
      logger.warn(`  - Password: ${machineCreds.MACHINE_GLOBAL_PASSWORD ? 'SET' : 'NOT SET'}`);
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

    // Log raw payload for debugging - temporarily at info level for troubleshooting
    logger.info(`WhatsApp webhook raw payload: ${JSON.stringify(payload).substring(0, 500)}`);

    // Load all credentials from database before processing (WhatsApp, OpenAI, Machine Global)
    await loadAllCredentials();

    // Parse the webhook payload
    const { messages, statuses } = whatsappService.parseWebhookPayload(payload);

    // Log what we received
    logger.info(`WhatsApp webhook received - ${messages.length} messages, ${statuses.length} statuses`);

    // Process messages
    for (const msg of messages) {
      logger.info(`Incoming WhatsApp message from ${msg.from}: ${msg.type} - "${typeof msg.content === 'string' ? msg.content.substring(0, 50) : JSON.stringify(msg.content)}"`);

      try {
        await conversationService.processMessage(
          msg.from,
          msg.messageId,
          msg.type as 'text' | 'audio' | 'location' | 'interactive',
          msg.content,
          msg.name
        );
        logger.info(`Message from ${msg.from} processed successfully`);
      } catch (msgError: any) {
        logger.error(`Error processing message from ${msg.from}:`, msgError);
      }
    }

    // Log status updates (at info level for debugging)
    for (const status of statuses) {
      logger.info(`Message ${status.messageId} status: ${status.status} (to: ${status.recipientId})`);
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

// Debug endpoint to test Machine Global API directly
// This endpoint helps diagnose API connection issues
router.get('/test-machine-api', async (req: Request, res: Response) => {
  try {
    // Load Machine Global credentials from database
    const machineCreds = await credentialsService.getServiceCredentials('machine');

    const debugInfo: any = {
      timestamp: new Date().toISOString(),
      credentials: {
        apiKey: machineCreds.MACHINE_GLOBAL_API_KEY
          ? `SET (${machineCreds.MACHINE_GLOBAL_API_KEY.substring(0, 15)}...)`
          : 'NOT SET',
        username: machineCreds.MACHINE_GLOBAL_USERNAME || 'NOT SET',
        password: machineCreds.MACHINE_GLOBAL_PASSWORD ? 'SET' : 'NOT SET',
        baseUrl: machineCreds.MACHINE_GLOBAL_BASE_URL || 'NOT SET (will use default)',
      },
      tests: [],
    };

    if (!machineCreds.MACHINE_GLOBAL_API_KEY || !machineCreds.MACHINE_GLOBAL_USERNAME || !machineCreds.MACHINE_GLOBAL_PASSWORD) {
      debugInfo.error = 'Machine Global credentials are incomplete. Please configure them in the Settings page.';
      return res.json({ success: false, debug: debugInfo });
    }

    // Update service credentials
    machineGlobalService.updateCredentials(
      machineCreds.MACHINE_GLOBAL_API_KEY,
      machineCreds.MACHINE_GLOBAL_USERNAME,
      machineCreds.MACHINE_GLOBAL_PASSWORD,
      machineCreds.MACHINE_GLOBAL_BASE_URL
    );

    // Test 1: Try to list webhooks (basic connectivity test)
    try {
      const webhookResult = await machineGlobalService.listWebhooks();
      debugInfo.tests.push({
        name: 'List Webhooks',
        endpoint: '/listarWebhook',
        success: webhookResult.success !== false,
        response: webhookResult,
      });
    } catch (error: any) {
      debugInfo.tests.push({
        name: 'List Webhooks',
        endpoint: '/listarWebhook',
        success: false,
        error: error.message,
        status: error.response?.status,
        responseData: error.response?.data,
      });
    }

    // Test 2: Try to verify connection
    try {
      const isConnected = await machineGlobalService.verifyConnection();
      debugInfo.tests.push({
        name: 'Verify Connection',
        success: isConnected,
      });
    } catch (error: any) {
      debugInfo.tests.push({
        name: 'Verify Connection',
        success: false,
        error: error.message,
      });
    }

    // Overall result
    const allTestsPassed = debugInfo.tests.every((t: any) => t.success);
    debugInfo.overallResult = allTestsPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED';

    res.json({
      success: allTestsPassed,
      debug: debugInfo,
      message: allTestsPassed
        ? 'Machine Global API is working correctly'
        : 'Machine Global API has issues - check the debug info above',
    });
  } catch (error: any) {
    logger.error('Machine API test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

// Debug endpoint to test Machine price quote with custom category ID
// Use this to find the correct category ID for your Machine Global configuration
router.post('/test-machine-price', async (req: Request, res: Response) => {
  try {
    const { categoria_id, origem, destino } = req.body;

    // Load Machine Global credentials from database
    const machineCreds = await credentialsService.getServiceCredentials('machine');

    if (!machineCreds.MACHINE_GLOBAL_API_KEY || !machineCreds.MACHINE_GLOBAL_USERNAME || !machineCreds.MACHINE_GLOBAL_PASSWORD) {
      return res.status(400).json({
        success: false,
        error: 'Machine Global credentials not configured. Please set them in Settings page.',
      });
    }

    // Update service credentials
    machineGlobalService.updateCredentials(
      machineCreds.MACHINE_GLOBAL_API_KEY,
      machineCreds.MACHINE_GLOBAL_USERNAME,
      machineCreds.MACHINE_GLOBAL_PASSWORD,
      machineCreds.MACHINE_GLOBAL_BASE_URL
    );

    // Default test addresses in São Paulo area - CORRECT FORMAT per Machine API docs
    const testOrigem = origem || {
      endereco: 'Rua Regente Feijó',
      numero: '100',
      bairro: 'Centro',
      cidade: 'Capivari',
      uf: 'SP',
      latitude: -22.995,
      longitude: -47.507,
    };
    const testDestino = destino || {
      endereco: 'Rua Virgílio Duarte',
      numero: '34',
      bairro: 'Centro',
      cidade: 'Capivari',
      uf: 'SP',
      latitude: -22.9965,
      longitude: -47.5095,
    };

    logger.info(`Testing Machine price quote with categoria_id: ${categoria_id}`);

    const result = await machineGlobalService.getPriceQuote({
      origem: testOrigem,
      destino: testDestino,
      categoria_id: categoria_id,
    });

    res.json({
      success: result.success,
      categoria_id_tested: categoria_id,
      result: result,
      testData: {
        origem: testOrigem,
        destino: testDestino,
      },
      hint: result.success
        ? `Category ID ${categoria_id} works! Update CATEGORY_CONFIG in conversation.service.ts`
        : 'Try different category IDs (1, 2, 3, etc.) to find the valid ones',
    });
  } catch (error: any) {
    logger.error('Machine price test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Check Railway logs for full request/response details',
    });
  }
});

// Debug endpoint to test creating a ride with custom category ID
router.post('/test-machine-ride', async (req: Request, res: Response) => {
  try {
    const { categoria_id, origem, destino, passageiro } = req.body;

    // Load Machine Global credentials from database
    const machineCreds = await credentialsService.getServiceCredentials('machine');

    if (!machineCreds.MACHINE_GLOBAL_API_KEY || !machineCreds.MACHINE_GLOBAL_USERNAME || !machineCreds.MACHINE_GLOBAL_PASSWORD) {
      return res.status(400).json({
        success: false,
        error: 'Machine Global credentials not configured. Please set them in Settings page.',
      });
    }

    // Update service credentials
    machineGlobalService.updateCredentials(
      machineCreds.MACHINE_GLOBAL_API_KEY,
      machineCreds.MACHINE_GLOBAL_USERNAME,
      machineCreds.MACHINE_GLOBAL_PASSWORD,
      machineCreds.MACHINE_GLOBAL_BASE_URL
    );

    // Default test data - CORRECT FORMAT per Machine API docs
    const testOrigem = origem || {
      endereco: 'Rua Regente Feijó',
      numero: '100',
      bairro: 'Centro',
      cidade: 'Capivari',
      uf: 'SP',
      latitude: -22.995,
      longitude: -47.507,
    };
    const testDestino = destino || {
      endereco: 'Rua Virgílio Duarte',
      numero: '34',
      bairro: 'Centro',
      cidade: 'Capivari',
      uf: 'SP',
      latitude: -22.9965,
      longitude: -47.5095,
    };
    const testPassageiro = passageiro || {
      nome: 'Teste API',
      telefone: '19999999999',
    };

    logger.info(`Testing Machine ride creation with categoria_id: ${categoria_id}`);

    const result = await machineGlobalService.createRide({
      origem: testOrigem,
      destino: testDestino,
      passageiro: testPassageiro,
      categoria_id: categoria_id,
      formaPagamento: 'D', // Cash
      observacoes: 'TESTE - CANCELAR IMEDIATAMENTE',
    });

    res.json({
      success: result.success,
      categoria_id_tested: categoria_id,
      result: result,
      testData: {
        origem: testOrigem,
        destino: testDestino,
        passageiro: testPassageiro,
      },
      warning: result.success
        ? 'IMPORTANT: This created a real ride request! Cancel it immediately via Machine dashboard!'
        : 'Ride creation failed - check the error',
    });
  } catch (error: any) {
    logger.error('Machine ride test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Check Railway logs for full request/response details',
    });
  }
});

// Debug endpoint to show current Machine credentials (masked) and URL being used
router.get('/debug-machine-config', async (_req: Request, res: Response) => {
  try {
    // Load Machine Global credentials from database
    const machineCreds = await credentialsService.getServiceCredentials('machine');

    // Show what's stored vs what's actually being used
    const storedUrl = machineCreds.MACHINE_GLOBAL_BASE_URL || 'NOT SET';

    // Apply the same URL correction logic that machineGlobalService uses
    let correctedUrl = storedUrl;
    if (storedUrl !== 'NOT SET') {
      // Sanitize - remove any path after domain
      const urlMatch = storedUrl.match(/^(https?:\/\/[^\/]+)/);
      if (urlMatch) {
        correctedUrl = urlMatch[1];
      }
      // Force correct API URL - trial.taximachine.com.br is the correct one
      if (correctedUrl.includes('cloud.taximachine.com.br')) {
        correctedUrl = 'https://trial.taximachine.com.br';
      } else if (correctedUrl.includes('api-trial.taximachine.com.br')) {
        correctedUrl = 'https://trial.taximachine.com.br';
      }
    } else {
      correctedUrl = 'https://trial.taximachine.com.br (default)';
    }

    res.json({
      success: true,
      storedConfig: {
        apiKey: machineCreds.MACHINE_GLOBAL_API_KEY
          ? `${machineCreds.MACHINE_GLOBAL_API_KEY.substring(0, 15)}...`
          : 'NOT SET',
        username: machineCreds.MACHINE_GLOBAL_USERNAME || 'NOT SET',
        password: machineCreds.MACHINE_GLOBAL_PASSWORD ? 'SET (hidden)' : 'NOT SET',
        baseUrl: storedUrl,
      },
      effectiveConfig: {
        baseUrl: correctedUrl,
        note: storedUrl !== correctedUrl
          ? `URL was auto-corrected from "${storedUrl}" to "${correctedUrl}"`
          : 'No URL correction needed',
      },
      recommendation: storedUrl.includes('cloud.taximachine') || storedUrl.includes('api-trial')
        ? 'IMPORTANT: The stored URL is wrong. Please update MACHINE_GLOBAL_BASE_URL in Settings to: https://trial.taximachine.com.br'
        : 'URL looks correct',
    });
  } catch (error: any) {
    logger.error('Debug config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug endpoint to scan and find valid category IDs automatically
// This endpoint tries multiple category IDs and reports which ones work
router.get('/scan-machine-categories', async (req: Request, res: Response) => {
  try {
    // Load Machine Global credentials from database
    const machineCreds = await credentialsService.getServiceCredentials('machine');

    if (!machineCreds.MACHINE_GLOBAL_API_KEY || !machineCreds.MACHINE_GLOBAL_USERNAME || !machineCreds.MACHINE_GLOBAL_PASSWORD) {
      return res.status(400).json({
        success: false,
        error: 'Machine Global credentials not configured. Please set them in Settings page.',
      });
    }

    // Update service credentials
    machineGlobalService.updateCredentials(
      machineCreds.MACHINE_GLOBAL_API_KEY,
      machineCreds.MACHINE_GLOBAL_USERNAME,
      machineCreds.MACHINE_GLOBAL_PASSWORD,
      machineCreds.MACHINE_GLOBAL_BASE_URL
    );

    // Test addresses - CORRECT FORMAT per Machine API docs
    const testOrigem = {
      endereco: 'Rua Regente Feijó',
      numero: '100',
      bairro: 'Centro',
      cidade: 'Capivari',
      uf: 'SP',
      latitude: -22.995,
      longitude: -47.507,
    };
    const testDestino = {
      endereco: 'Rua Virgílio Duarte',
      numero: '34',
      bairro: 'Centro',
      cidade: 'Capivari',
      uf: 'SP',
      latitude: -22.9965,
      longitude: -47.5095,
    };

    // Try category IDs from 1 to 20
    const maxId = parseInt(req.query.max as string) || 20;
    const results: Array<{ id: number; success: boolean; price?: number; error?: string }> = [];
    const validCategories: number[] = [];

    logger.info(`Scanning Machine category IDs from 1 to ${maxId}...`);

    for (let id = 1; id <= maxId; id++) {
      try {
        const result = await machineGlobalService.getPriceQuote({
          origem: testOrigem,
          destino: testDestino,
          categoria_id: id,
        });

        const price = result.valor_estimado || result.cotacao?.valorEstimado;

        if (result.success && price && price > 0) {
          validCategories.push(id);
          results.push({ id, success: true, price });
          logger.info(`Category ID ${id}: VALID - Price R$${price}`);
        } else {
          results.push({
            id,
            success: false,
            error: result.errors?.join(', ') || 'No price returned'
          });
          logger.info(`Category ID ${id}: INVALID`);
        }
      } catch (error: any) {
        results.push({ id, success: false, error: error.message });
        logger.info(`Category ID ${id}: ERROR - ${error.message}`);
      }

    }

    res.json({
      success: true,
      summary: {
        scannedRange: `1-${maxId}`,
        validCategoryIds: validCategories,
        totalValid: validCategories.length,
      },
      results,
      nextSteps: validCategories.length > 0
        ? `Found ${validCategories.length} valid category IDs: [${validCategories.join(', ')}]. Update CATEGORY_CONFIG in conversation.service.ts with these IDs.`
        : 'No valid category IDs found. Check if credentials are correct or try a larger range with ?max=50',
    });
  } catch (error: any) {
    logger.error('Category scan error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Debug endpoint to show what API documentation we need from Machine Global
router.get('/machine-api-requirements', async (_req: Request, res: Response) => {
  res.json({
    title: 'Machine Global API Requirements',
    description: 'Information needed from Machine Global (Taxi Machine) support team',
    requiredInfo: {
      '1_base_url': {
        question: 'What is the correct API Base URL?',
        note: 'Not the web panel login URL. Example: https://api.taximachine.com.br',
        currentlyTrying: ['https://cloud.taximachine.com.br', 'https://api.taximachine.com.br'],
      },
      '2_endpoints': {
        question: 'What are the official API endpoints?',
        needed: [
          'Create ride / dispatch request (abrirSolicitacao)',
          'Get price estimate (cotacao/estimativa)',
          'Cancel ride',
          'Get ride status',
          'Webhook registration',
        ],
        currentlyTrying: [
          '/api/integracao/abrirSolicitacao',
          '/api/integracao/estimativa',
          '/listarWebhook',
          '/cadastrarWebhook',
        ],
      },
      '3_authentication': {
        question: 'What is the required authentication method?',
        options: [
          'API Key in header (api-key: xxx)',
          'Bearer token (Authorization: Bearer xxx)',
          'Basic Auth (username:password)',
          'Cookie/Session based',
        ],
        currentlyUsing: 'API Key header + Basic Auth combined',
      },
      '4_payload_format': {
        question: 'What is the required payload format for creating a ride?',
        needed: [
          'Origin format (address string? lat/lng? both?)',
          'Destination format',
          'Passenger info (required fields)',
          'Category options (Carro, Moto, Premium, etc.)',
          'Payment method codes',
          'City/region requirements',
        ],
        currentPayloadExample: {
          origem: { endereco: 'Rua Example, 123', latitude: -22.123, longitude: -47.456 },
          destino: { endereco: 'Av Example, 456', latitude: -22.789, longitude: -47.012 },
          passageiro: { nome: 'Customer Name', telefone: '+5519999999999' },
          categoria: 'Carro',
          formaPagamento: 'D',
        },
      },
      '5_sample_requests': {
        question: 'Can you provide sample curl/Postman requests?',
        for: ['Create ride', 'Get price estimate', 'Cancel ride'],
      },
    },
    instructions: 'Please send this information to Machine Global support and update the credentials in the Settings page once you have the correct values.',
  });
});

export default router;
