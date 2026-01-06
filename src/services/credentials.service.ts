import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import axios from 'axios';

const prisma = new PrismaClient();

// Encryption key (in production, use a secure key from environment)
const ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'mi-chame-default-key-change-me!!';
const ALGORITHM = 'aes-256-cbc';

// Credential keys by service
export const CREDENTIAL_KEYS = {
  whatsapp: [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_VERIFY_TOKEN',
  ],
  machine: [
    'MACHINE_GLOBAL_API_KEY',
    'MACHINE_GLOBAL_USERNAME',
    'MACHINE_GLOBAL_PASSWORD',
    'MACHINE_GLOBAL_BASE_URL',
  ],
  openai: [
    'OPENAI_API_KEY',
  ],
  twilio: [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
  ],
} as const;

// Encrypt a value
function encrypt(text: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Decrypt a value
function decrypt(encryptedText: string): string {
  try {
    const [ivHex, encrypted] = encryptedText.split(':');
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    logger.error('Failed to decrypt credential:', error);
    return '';
  }
}

// Mask a credential value for display
function maskValue(value: string): string {
  if (!value || value.length < 8) return '••••••••';
  return value.substring(0, 4) + '••••••••' + value.substring(value.length - 4);
}

class CredentialsService {
  // Get all credentials (masked for security)
  async getAllCredentials(): Promise<Array<{
    key: string;
    service: string;
    isConfigured: boolean;
    isValid: boolean;
    maskedValue: string;
    lastTest: Date | null;
  }>> {
    const credentials = await prisma.systemCredential.findMany();

    // Build full list with all expected keys
    const allKeys: Array<{
      key: string;
      service: string;
      isConfigured: boolean;
      isValid: boolean;
      maskedValue: string;
      lastTest: Date | null;
    }> = [];

    for (const [service, keys] of Object.entries(CREDENTIAL_KEYS)) {
      for (const key of keys) {
        const existing = credentials.find(c => c.key === key);
        if (existing) {
          allKeys.push({
            key: existing.key,
            service: existing.service,
            isConfigured: true,
            isValid: existing.isValid,
            maskedValue: maskValue(decrypt(existing.value)),
            lastTest: existing.lastTest,
          });
        } else {
          allKeys.push({
            key,
            service,
            isConfigured: false,
            isValid: false,
            maskedValue: '',
            lastTest: null,
          });
        }
      }
    }

    return allKeys;
  }

  // Get a single credential value (decrypted)
  async getCredential(key: string): Promise<string | null> {
    const credential = await prisma.systemCredential.findUnique({
      where: { key },
    });

    if (!credential) {
      // Fall back to environment variable
      return process.env[key] || null;
    }

    return decrypt(credential.value);
  }

  // Get multiple credentials for a service
  async getServiceCredentials(service: string): Promise<Record<string, string>> {
    const keys = CREDENTIAL_KEYS[service as keyof typeof CREDENTIAL_KEYS] || [];
    const result: Record<string, string> = {};

    for (const key of keys) {
      const value = await this.getCredential(key);
      if (value) {
        result[key] = value;
      }
    }

    return result;
  }

  // Set a credential
  async setCredential(key: string, value: string, service: string): Promise<void> {
    const encryptedValue = encrypt(value);

    await prisma.systemCredential.upsert({
      where: { key },
      create: {
        key,
        value: encryptedValue,
        service,
        isValid: false,
      },
      update: {
        value: encryptedValue,
        isValid: false,
        updatedAt: new Date(),
      },
    });

    logger.info(`Credential ${key} updated for service ${service}`);
  }

  // Set multiple credentials
  async setCredentials(credentials: Array<{ key: string; value: string; service: string }>): Promise<void> {
    for (const cred of credentials) {
      if (cred.value && cred.value.trim()) {
        await this.setCredential(cred.key, cred.value.trim(), cred.service);
      }
    }
  }

  // Delete a credential
  async deleteCredential(key: string): Promise<void> {
    await prisma.systemCredential.delete({
      where: { key },
    }).catch(() => {
      // Ignore if not found
    });
  }

  // Test WhatsApp credentials
  async testWhatsAppCredentials(): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getCredential('WHATSAPP_ACCESS_TOKEN');
      const phoneNumberId = await this.getCredential('WHATSAPP_PHONE_NUMBER_ID');

      if (!token || !phoneNumberId) {
        return { success: false, error: 'Missing WhatsApp credentials' };
      }

      // Test by fetching phone number details
      const response = await axios.get(
        `https://graph.facebook.com/v18.0/${phoneNumberId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        }
      );

      if (response.data && response.data.id) {
        // Update validation status
        await this.updateValidationStatus('WHATSAPP_ACCESS_TOKEN', true);
        await this.updateValidationStatus('WHATSAPP_PHONE_NUMBER_ID', true);
        return { success: true };
      }

      return { success: false, error: 'Invalid response from WhatsApp API' };
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      await this.updateValidationStatus('WHATSAPP_ACCESS_TOKEN', false);
      return { success: false, error: errorMsg };
    }
  }

  // Test Machine Global credentials
  async testMachineGlobalCredentials(): Promise<{ success: boolean; error?: string }> {
    try {
      const apiKey = await this.getCredential('MACHINE_GLOBAL_API_KEY');
      const username = await this.getCredential('MACHINE_GLOBAL_USERNAME');
      const password = await this.getCredential('MACHINE_GLOBAL_PASSWORD');
      let baseUrl = await this.getCredential('MACHINE_GLOBAL_BASE_URL') || 'https://cloud.taximachine.com.br';

      // Sanitize base URL - remove any path (e.g., /site/login)
      const urlMatch = baseUrl.match(/^(https?:\/\/[^\/]+)/);
      if (urlMatch) {
        baseUrl = urlMatch[1];
      }

      if (!apiKey || !username || !password) {
        return { success: false, error: 'Missing Machine Global credentials' };
      }

      // Test by listing webhooks
      const response = await axios.get(`${baseUrl}/listarWebhook`, {
        headers: { 'api-key': apiKey },
        auth: { username, password },
        timeout: 10000,
      });

      if (response.data && response.data.success !== false) {
        await this.updateValidationStatus('MACHINE_GLOBAL_API_KEY', true);
        await this.updateValidationStatus('MACHINE_GLOBAL_USERNAME', true);
        await this.updateValidationStatus('MACHINE_GLOBAL_PASSWORD', true);
        return { success: true };
      }

      return { success: false, error: 'Invalid response from Machine Global API' };
    } catch (error: any) {
      const errorMsg = error.response?.data?.errors?.[0] || error.message;
      await this.updateValidationStatus('MACHINE_GLOBAL_API_KEY', false);
      return { success: false, error: errorMsg };
    }
  }

  // Test OpenAI credentials
  async testOpenAICredentials(): Promise<{ success: boolean; error?: string }> {
    try {
      const apiKey = await this.getCredential('OPENAI_API_KEY');

      if (!apiKey) {
        return { success: false, error: 'Missing OpenAI API key' };
      }

      // Test by listing models
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      });

      if (response.data && response.data.data) {
        await this.updateValidationStatus('OPENAI_API_KEY', true);
        return { success: true };
      }

      return { success: false, error: 'Invalid response from OpenAI API' };
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      await this.updateValidationStatus('OPENAI_API_KEY', false);
      return { success: false, error: errorMsg };
    }
  }

  // Test Twilio credentials
  async testTwilioCredentials(): Promise<{ success: boolean; error?: string }> {
    try {
      const accountSid = await this.getCredential('TWILIO_ACCOUNT_SID');
      const authToken = await this.getCredential('TWILIO_AUTH_TOKEN');

      if (!accountSid || !authToken) {
        return { success: false, error: 'Missing Twilio credentials' };
      }

      // Test by fetching account info
      const response = await axios.get(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
        {
          auth: { username: accountSid, password: authToken },
          timeout: 10000,
        }
      );

      if (response.data && response.data.sid) {
        await this.updateValidationStatus('TWILIO_ACCOUNT_SID', true);
        await this.updateValidationStatus('TWILIO_AUTH_TOKEN', true);
        return { success: true };
      }

      return { success: false, error: 'Invalid response from Twilio API' };
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      await this.updateValidationStatus('TWILIO_ACCOUNT_SID', false);
      return { success: false, error: errorMsg };
    }
  }

  // Update validation status
  private async updateValidationStatus(key: string, isValid: boolean): Promise<void> {
    await prisma.systemCredential.updateMany({
      where: { key },
      data: {
        isValid,
        lastTest: new Date(),
      },
    });
  }

  // Get missing required credentials
  async getMissingCredentials(): Promise<string[]> {
    const requiredKeys = [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'MACHINE_GLOBAL_API_KEY',
      'MACHINE_GLOBAL_USERNAME',
      'MACHINE_GLOBAL_PASSWORD',
    ];

    const missing: string[] = [];

    for (const key of requiredKeys) {
      const value = await this.getCredential(key);
      if (!value) {
        missing.push(key);
      }
    }

    return missing;
  }

  // Check if all required credentials are configured
  async areRequiredCredentialsConfigured(): Promise<boolean> {
    const missing = await this.getMissingCredentials();
    return missing.length === 0;
  }
}

// Export singleton instance
export const credentialsService = new CredentialsService();
