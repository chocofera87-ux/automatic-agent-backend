import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { credentialsService, CREDENTIAL_KEYS } from '../services/credentials.service.js';
import { authenticate, requireAdmin } from '../middleware/auth.middleware.js';

const router = Router();

// Get all credentials (masked) - requires authentication
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const credentials = await credentialsService.getAllCredentials();

    // Group by service
    const grouped: Record<string, typeof credentials> = {};
    for (const cred of credentials) {
      if (!grouped[cred.service]) {
        grouped[cred.service] = [];
      }
      grouped[cred.service].push(cred);
    }

    res.json({
      success: true,
      data: {
        credentials,
        grouped,
        services: Object.keys(CREDENTIAL_KEYS),
      },
    });
  } catch (error: any) {
    logger.error('Error fetching credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get missing required credentials - requires authentication
router.get('/missing', authenticate, async (req: Request, res: Response) => {
  try {
    const missing = await credentialsService.getMissingCredentials();
    const isComplete = missing.length === 0;

    res.json({
      success: true,
      data: {
        missing,
        isComplete,
        message: isComplete
          ? 'All required credentials are configured'
          : `Missing ${missing.length} required credentials`,
      },
    });
  } catch (error: any) {
    logger.error('Error checking missing credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save credentials for a service - requires admin
router.post('/:service', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { service } = req.params;
    const credentials = req.body;

    // Validate service
    if (!CREDENTIAL_KEYS[service as keyof typeof CREDENTIAL_KEYS]) {
      return res.status(400).json({
        success: false,
        error: `Invalid service: ${service}. Valid services: ${Object.keys(CREDENTIAL_KEYS).join(', ')}`
      });
    }

    // Prepare credentials array
    const credArray: Array<{ key: string; value: string; service: string }> = [];

    for (const [key, value] of Object.entries(credentials)) {
      if (typeof value === 'string' && value.trim()) {
        credArray.push({ key, value: value.trim(), service });
      }
    }

    if (credArray.length === 0) {
      return res.status(400).json({ success: false, error: 'No credentials provided' });
    }

    // Save credentials
    await credentialsService.setCredentials(credArray);

    logger.info(`Credentials updated for service: ${service}`);

    res.json({
      success: true,
      message: `${credArray.length} credentials saved for ${service}`,
      savedKeys: credArray.map(c => c.key),
    });
  } catch (error: any) {
    logger.error('Error saving credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test credentials for a service - requires admin
router.post('/:service/test', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { service } = req.params;
    let result: { success: boolean; error?: string };

    switch (service) {
      case 'whatsapp':
        result = await credentialsService.testWhatsAppCredentials();
        break;
      case 'machine':
        result = await credentialsService.testMachineGlobalCredentials();
        break;
      case 'openai':
        result = await credentialsService.testOpenAICredentials();
        break;
      case 'twilio':
        result = await credentialsService.testTwilioCredentials();
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Invalid service: ${service}`
        });
    }

    res.json({
      success: result.success,
      service,
      message: result.success
        ? `${service} credentials verified successfully`
        : `${service} credential verification failed`,
      error: result.error,
    });
  } catch (error: any) {
    logger.error('Error testing credentials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a specific credential - requires admin
router.delete('/:key', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { key } = req.params;

    await credentialsService.deleteCredential(key);

    res.json({
      success: true,
      message: `Credential ${key} deleted`,
    });
  } catch (error: any) {
    logger.error('Error deleting credential:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
