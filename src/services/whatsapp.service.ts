import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';

// WhatsApp message types
export interface WhatsAppTextMessage {
  type: 'text';
  text: {
    body: string;
    preview_url?: boolean;
  };
}

export interface WhatsAppInteractiveButton {
  type: 'reply';
  reply: {
    id: string;
    title: string;
  };
}

export interface WhatsAppInteractiveMessage {
  type: 'interactive';
  interactive: {
    type: 'button' | 'list';
    header?: {
      type: 'text';
      text: string;
    };
    body: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: {
      buttons?: WhatsAppInteractiveButton[];
      button?: string;
      sections?: Array<{
        title: string;
        rows: Array<{
          id: string;
          title: string;
          description?: string;
        }>;
      }>;
    };
  };
}

export interface WhatsAppLocationRequestMessage {
  type: 'interactive';
  interactive: {
    type: 'location_request_message';
    body: {
      text: string;
    };
    action: {
      name: 'send_location';
    };
  };
}

export interface IncomingWhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'audio' | 'location' | 'interactive' | 'image';
  text?: { body: string };
  audio?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  image?: { id: string; mime_type: string; caption?: string };
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: IncomingWhatsAppMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}

class WhatsAppService {
  private client: AxiosInstance;
  private phoneNumberId: string;

  constructor() {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

    this.client = axios.create({
      baseURL: 'https://graph.facebook.com/v18.0',
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    // Request/Response logging
    this.client.interceptors.request.use(
      (config) => {
        logger.info(`WhatsApp API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('WhatsApp API Request Error:', error);
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      (response) => {
        logger.info(`WhatsApp API Response: ${response.status}`);
        return response;
      },
      (error) => {
        logger.error(`WhatsApp API Error: ${error.response?.status} - ${error.message}`);
        return Promise.reject(error);
      }
    );
  }

  // Send a text message
  async sendTextMessage(to: string, message: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'text',
        text: {
          body: message,
          preview_url: false,
        },
      });

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
      };
    } catch (error: any) {
      logger.error('Failed to send WhatsApp message:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }

  // Send interactive button message
  async sendButtonMessage(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    headerText?: string,
    footerText?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const message: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((btn) => ({
              type: 'reply',
              reply: {
                id: btn.id,
                title: btn.title.slice(0, 20), // Max 20 chars
              },
            })),
          },
        },
      };

      if (headerText) {
        message.interactive.header = { type: 'text', text: headerText };
      }
      if (footerText) {
        message.interactive.footer = { text: footerText };
      }

      const response = await this.client.post(`/${this.phoneNumberId}/messages`, message);

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
      };
    } catch (error: any) {
      logger.error('Failed to send WhatsApp button message:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }

  // Send location request message
  async sendLocationRequest(to: string, bodyText: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'location_request_message',
          body: { text: bodyText },
          action: { name: 'send_location' },
        },
      });

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
      };
    } catch (error: any) {
      logger.error('Failed to send location request:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }

  // Send list message (for vehicle category selection)
  async sendListMessage(
    to: string,
    bodyText: string,
    buttonText: string,
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>,
    headerText?: string,
    footerText?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const message: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: buttonText,
            sections: sections,
          },
        },
      };

      if (headerText) {
        message.interactive.header = { type: 'text', text: headerText };
      }
      if (footerText) {
        message.interactive.footer = { text: footerText };
      }

      const response = await this.client.post(`/${this.phoneNumberId}/messages`, message);

      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
      };
    } catch (error: any) {
      logger.error('Failed to send list message:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }

  // Download media (audio, image)
  async downloadMedia(mediaId: string): Promise<Buffer | null> {
    try {
      // First, get the media URL
      const mediaResponse = await this.client.get(`/${mediaId}`);
      const mediaUrl = mediaResponse.data.url;

      // Then download the actual file
      const fileResponse = await axios.get(mediaUrl, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
        responseType: 'arraybuffer',
      });

      return Buffer.from(fileResponse.data);
    } catch (error: any) {
      logger.error('Failed to download media:', error.message);
      return null;
    }
  }

  // Mark message as read
  async markAsRead(messageId: string): Promise<boolean> {
    try {
      await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
      return true;
    } catch (error: any) {
      logger.error('Failed to mark message as read:', error.message);
      return false;
    }
  }

  // Format phone number for WhatsApp API
  private formatPhoneNumber(phone: string): string {
    // Remove all non-numeric characters
    let cleaned = phone.replace(/\D/g, '');

    // If starts with 0, remove it
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }

    // If doesn't start with country code, add Brazil (+55)
    if (!cleaned.startsWith('55') && cleaned.length <= 11) {
      cleaned = '55' + cleaned;
    }

    return cleaned;
  }

  // Parse incoming webhook payload
  parseWebhookPayload(payload: WhatsAppWebhookPayload): {
    messages: Array<{
      from: string;
      name: string;
      messageId: string;
      timestamp: Date;
      type: string;
      content: any;
    }>;
    statuses: Array<{
      messageId: string;
      status: string;
      recipientId: string;
      timestamp: Date;
    }>;
  } {
    const messages: Array<{
      from: string;
      name: string;
      messageId: string;
      timestamp: Date;
      type: string;
      content: any;
    }> = [];
    const statuses: Array<{
      messageId: string;
      status: string;
      recipientId: string;
      timestamp: Date;
    }> = [];

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        // Parse messages
        if (value.messages) {
          for (const msg of value.messages) {
            const contact = value.contacts?.find((c) => c.wa_id === msg.from);

            let content: any;
            switch (msg.type) {
              case 'text':
                content = msg.text?.body || '';
                break;
              case 'audio':
                content = { audioId: msg.audio?.id, mimeType: msg.audio?.mime_type };
                break;
              case 'location':
                content = {
                  latitude: msg.location?.latitude,
                  longitude: msg.location?.longitude,
                  name: msg.location?.name,
                  address: msg.location?.address,
                };
                break;
              case 'interactive':
                content = {
                  type: msg.interactive?.type,
                  buttonId: msg.interactive?.button_reply?.id,
                  buttonTitle: msg.interactive?.button_reply?.title,
                  listId: msg.interactive?.list_reply?.id,
                  listTitle: msg.interactive?.list_reply?.title,
                };
                break;
              case 'image':
                content = { imageId: msg.image?.id, caption: msg.image?.caption };
                break;
              default:
                content = msg;
            }

            messages.push({
              from: msg.from,
              name: contact?.profile?.name || 'Unknown',
              messageId: msg.id,
              timestamp: new Date(parseInt(msg.timestamp) * 1000),
              type: msg.type,
              content,
            });
          }
        }

        // Parse statuses
        if (value.statuses) {
          for (const status of value.statuses) {
            statuses.push({
              messageId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
              timestamp: new Date(parseInt(status.timestamp) * 1000),
            });
          }
        }
      }
    }

    return { messages, statuses };
  }

  // Verify webhook (for initial setup)
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === verifyToken) {
      return challenge;
    }
    return null;
  }
}

// Export singleton instance
export const whatsappService = new WhatsAppService();
