import twilio from 'twilio';
import { logger } from '../utils/logger.js';
import { whatsappService } from './whatsapp.service.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Twilio Voice Response for Call Deflection
const VoiceResponse = twilio.twiml.VoiceResponse;

class TwilioService {
  private client: twilio.Twilio | null = null;
  private phoneNumber: string;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.phoneNumber = process.env.TWILIO_PHONE_NUMBER || '';

    if (accountSid && authToken) {
      this.client = twilio(accountSid, authToken);
      logger.info('Twilio client initialized');
    } else {
      logger.warn('Twilio credentials not configured - Call Deflection disabled');
    }
  }

  // Generate TwiML response for incoming calls (Call Deflection)
  generateCallDeflectionResponse(callerNumber: string): string {
    const response = new VoiceResponse();

    // Play a message in Portuguese
    response.say(
      {
        voice: 'Polly.Camila', // Brazilian Portuguese voice
        language: 'pt-BR',
      },
      'Olá! Obrigado por ligar para a Mi Chame. Para sua comodidade, enviamos uma mensagem pelo WhatsApp para você solicitar sua corrida de forma rápida e fácil. Aguarde a mensagem. Obrigado!'
    );

    // Pause briefly
    response.pause({ length: 2 });

    // End the call
    response.hangup();

    return response.toString();
  }

  // Handle incoming voice call - send WhatsApp message and return TwiML
  async handleIncomingCall(
    callerNumber: string,
    calledNumber: string
  ): Promise<{ twiml: string; whatsappSent: boolean }> {
    logger.info(`Incoming call from ${callerNumber} to ${calledNumber}`);

    // Format phone number for WhatsApp
    let formattedNumber = callerNumber.replace(/\D/g, '');
    if (formattedNumber.startsWith('0')) {
      formattedNumber = formattedNumber.substring(1);
    }
    if (!formattedNumber.startsWith('55')) {
      formattedNumber = '55' + formattedNumber;
    }

    // Send WhatsApp message
    const message = `Oi! Notamos que você tentou ligar para a Mi Chame.\n\n` +
      `Para solicitar uma corrida de forma rápida, basta me responder aqui mesmo pelo WhatsApp!\n\n` +
      `De onde você gostaria de sair?`;

    const result = await whatsappService.sendTextMessage(formattedNumber, message);

    // Log the call deflection
    await prisma.systemLog.create({
      data: {
        level: 'info',
        source: 'twilio',
        message: `Call deflection: ${callerNumber} -> WhatsApp`,
        metadata: {
          callerNumber,
          calledNumber,
          whatsappSent: result.success,
          whatsappMessageId: result.messageId,
        },
      },
    });

    // Generate TwiML response
    const twiml = this.generateCallDeflectionResponse(callerNumber);

    return {
      twiml,
      whatsappSent: result.success,
    };
  }

  // Verify Twilio webhook signature
  validateRequest(
    signature: string,
    url: string,
    params: Record<string, string>
  ): boolean {
    if (!this.client) return false;

    return twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN || '',
      signature,
      url,
      params
    );
  }

  // Send SMS (backup if WhatsApp fails)
  async sendSMS(to: string, message: string): Promise<boolean> {
    if (!this.client) {
      logger.warn('Twilio client not initialized');
      return false;
    }

    try {
      await this.client.messages.create({
        body: message,
        from: this.phoneNumber,
        to: to,
      });
      return true;
    } catch (error: any) {
      logger.error('Failed to send SMS:', error.message);
      return false;
    }
  }

  // Get call logs
  async getCallLogs(limit: number = 50): Promise<any[]> {
    if (!this.client) return [];

    try {
      const calls = await this.client.calls.list({ limit });
      return calls.map((call) => ({
        sid: call.sid,
        from: call.from,
        to: call.to,
        status: call.status,
        direction: call.direction,
        duration: call.duration,
        startTime: call.startTime,
        endTime: call.endTime,
      }));
    } catch (error: any) {
      logger.error('Failed to get call logs:', error.message);
      return [];
    }
  }
}

// Export singleton instance
export const twilioService = new TwilioService();
