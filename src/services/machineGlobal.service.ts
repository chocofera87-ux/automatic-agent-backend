import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger.js';

// Types for Machine Global API
export interface MachineLocation {
  endereco: string;
  latitude?: number;
  longitude?: number;
}

export interface MachinePassenger {
  nome: string;
  telefone: string;
  documento?: string;
}

export interface CreateRideRequest {
  origem: MachineLocation;
  destino: MachineLocation;
  passageiro: MachinePassenger;
  categoria?: 'Carro' | 'Moto' | 'Premium' | 'Corporativo';
  formaPagamento?: string; // D, B, C, X, P, H, A, F, I, R
  observacoes?: string;
}

export interface PriceQuoteRequest {
  origem: MachineLocation;
  destino: MachineLocation;
  categoria?: string;
}

export interface PriceQuoteResponse {
  success: boolean;
  cotacao?: {
    valorEstimado: number;
    distanciaKm: number;
    tempoEstimado: number;
    categoria: string;
  };
  errors?: string[];
}

export interface RideResponse {
  success: boolean;
  corrida?: {
    id: string;
    status: string;
    valorEstimado?: number;
    motorista?: {
      nome: string;
      telefone: string;
      veiculo?: string;
      placa?: string;
      avaliacao?: number;
    };
  };
  errors?: string[];
}

export interface WebhookData {
  id: string;
  tipo: string;
  url: string;
  empresa_id?: string;
  responsavel?: string;
}

export interface WebhookListResponse {
  success: boolean;
  response?: {
    webhooks: WebhookData[];
    quantidade_webhooks: number;
  };
  errors?: string[];
}

// Payment method codes
export const PAYMENT_METHODS = {
  DINHEIRO: 'D',
  DEBITO: 'B',
  CREDITO: 'C',
  ETICKET: 'T',
  VOUCHER: 'V',
  PIX: 'X',
  PICPAY: 'P',
  WHATSAPP: 'H',
  CARTAO_APP: 'A',
  FATURADO: 'F',
  PIX_APP: 'I',
  CARTEIRA: 'R',
} as const;

// Ride status codes
export const RIDE_STATUS = {
  DISTRIBUINDO: 'D',
  AGUARDANDO_ACEITE: 'G',
  PENDENTE: 'P',
  NAO_ATENDIDA: 'N',
  ACEITA: 'A',
  EM_ANDAMENTO: 'E',
  FINALIZADA: 'F',
  CANCELADA: 'C',
  AGUARDANDO_PAGAMENTO: 'R',
} as const;

// Machine Global API Client
class MachineGlobalService {
  private client: AxiosInstance;
  private apiKey: string;
  private username: string;
  private password: string;
  private baseURL: string;

  constructor() {
    this.apiKey = process.env.MACHINE_GLOBAL_API_KEY || '';
    this.username = process.env.MACHINE_GLOBAL_USERNAME || '';
    this.password = process.env.MACHINE_GLOBAL_PASSWORD || '';
    // Official Machine Global API URL (not the web panel cloud.taximachine.com.br)
    this.baseURL = process.env.MACHINE_GLOBAL_BASE_URL || 'https://api-trial.taximachine.com.br';

    this.client = this.createClient();
  }

  // Create axios client with current credentials
  private createClient(): AxiosInstance {
    const client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      auth: {
        username: this.username,
        password: this.password,
      },
    });

    // Request interceptor for logging
    client.interceptors.request.use(
      (config) => {
        logger.info(`Machine API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('Machine API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging
    client.interceptors.response.use(
      (response) => {
        logger.info(`Machine API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error: AxiosError) => {
        logger.error(`Machine API Error: ${error.response?.status} - ${error.message}`);
        return Promise.reject(error);
      }
    );

    return client;
  }

  // Update credentials dynamically (from database)
  updateCredentials(apiKey: string, username: string, password: string, baseURL?: string): void {
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;
    if (baseURL) {
      // Sanitize the base URL - remove any path after the domain
      // Users sometimes enter login page URLs like "https://cloud.taximachine.com.br/site/login"
      // We need just the base domain: "https://cloud.taximachine.com.br"
      // Use regex to extract protocol and host
      const urlMatch = baseURL.match(/^(https?:\/\/[^\/]+)/);
      if (urlMatch) {
        this.baseURL = urlMatch[1];
        if (baseURL !== this.baseURL) {
          logger.warn(`Machine Global Base URL sanitized: "${baseURL}" -> "${this.baseURL}"`);
        }
      } else {
        // If URL doesn't match expected pattern, use as-is
        this.baseURL = baseURL;
        logger.warn(`Machine Global Base URL format unexpected: "${baseURL}"`);
      }
    }
    this.client = this.createClient();
    logger.info(`Machine Global credentials updated. BaseURL: ${this.baseURL}`);
  }

  // Check if credentials are configured
  hasCredentials(): boolean {
    return !!(this.apiKey && this.username && this.password);
  }

  // Verify API connectivity
  async verifyConnection(): Promise<boolean> {
    try {
      const response = await this.listWebhooks();
      // Consider connected if we got a response and it's not explicitly failed
      // Machine Global might return { webhooks: [...] } without a success field
      if (response.success === false) {
        return false;
      }
      // If we got here without error and success is not false, we're connected
      return true;
    } catch (error) {
      logger.error('Machine Global connection verification failed:', error);
      return false;
    }
  }

  // List all webhooks
  async listWebhooks(): Promise<WebhookListResponse> {
    try {
      const response = await this.client.get('/listarWebhook');
      // Normalize response - Machine Global might not include success field
      const data = response.data;
      return {
        success: data.success !== false, // true unless explicitly false
        response: data.response || { webhooks: data.webhooks || [], quantidade_webhooks: data.quantidade_webhooks || 0 },
        errors: data.errors,
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Register a webhook
  async registerWebhook(url: string, type: 'status' | 'posicao'): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.post('/cadastrarWebhook', {
        url,
        tipo: type,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Update a webhook
  async updateWebhook(webhookId: string, url: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.put(`/atualizarWebhook/${webhookId}`, { url });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Delete a webhook
  async deleteWebhook(webhookId: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.delete(`/deletarWebhook/${webhookId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Get price quote / estimation
  async getPriceQuote(data: PriceQuoteRequest): Promise<PriceQuoteResponse> {
    try {
      // Try different possible endpoints
      const endpoints = [
        '/api/integracao/estimativa',
        '/api/integracao/cotacao',
        '/estimativa',
        '/cotacao',
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await this.client.post(endpoint, {
            origem: data.origem,
            destino: data.destino,
            categoria: data.categoria || 'Carro',
          });
          if (response.data.success !== false) {
            return response.data;
          }
        } catch (e) {
          // Continue to next endpoint
          continue;
        }
      }

      return {
        success: false,
        errors: ['Price quote endpoint not found'],
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Create a new ride
  // Supports multiple possible API endpoints for different Machine Global versions
  async createRide(data: CreateRideRequest): Promise<RideResponse> {
    // Log the request payload for debugging
    const requestPayload = {
      origem: {
        endereco: data.origem.endereco,
        latitude: data.origem.latitude,
        longitude: data.origem.longitude,
      },
      destino: {
        endereco: data.destino.endereco,
        latitude: data.destino.latitude,
        longitude: data.destino.longitude,
      },
      passageiro: {
        nome: data.passageiro.nome,
        telefone: data.passageiro.telefone,
        documento: data.passageiro.documento,
      },
      categoria: data.categoria || 'Carro',
      formaPagamento: data.formaPagamento || PAYMENT_METHODS.DINHEIRO,
      observacoes: data.observacoes,
    };

    logger.info(`Machine Global createRide - Full BaseURL: ${this.baseURL}`);
    logger.info(`Machine Global createRide - API Key: ${this.apiKey ? `SET (${this.apiKey.substring(0, 10)}...)` : 'NOT SET'}`);
    logger.info(`Machine Global createRide - Username: ${this.username || 'NOT SET'}`);
    logger.info(`Machine Global createRide - Password: ${this.password ? 'SET' : 'NOT SET'}`);
    logger.info(`Machine Global createRide - Request payload: ${JSON.stringify(requestPayload)}`);

    // Try multiple possible API endpoints
    const endpoints = [
      '/api/integracao/abrirSolicitacao',
      '/abrirSolicitacao',
      '/api/solicitacao',
      '/solicitacao',
      '/api/corrida',
      '/corrida',
    ];

    let lastError: any = null;

    for (const endpoint of endpoints) {
      try {
        logger.info(`Machine Global createRide - Trying endpoint: ${this.baseURL}${endpoint}`);
        const response = await this.client.post(endpoint, requestPayload);

        logger.info(`Machine Global createRide - Endpoint ${endpoint} succeeded!`);
        logger.info(`Machine Global createRide - Response: ${JSON.stringify(response.data)}`);

        // Check if response indicates success
        if (response.data.success !== false) {
          return {
            success: true,
            corrida: response.data.corrida || response.data,
          };
        }
      } catch (error: any) {
        lastError = error;

        // Log each endpoint attempt
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          logger.warn(`Machine Global createRide - Endpoint ${endpoint} failed: HTTP ${status}`);

          // If we get 401/403, credentials are wrong - don't try other endpoints
          if (status === 401 || status === 403) {
            logger.error(`Machine Global createRide - Authentication failed (${status}). Check credentials.`);
            logger.error(`Machine Global createRide - Response: ${JSON.stringify(error.response?.data)}`);
            break;
          }

          // If we get 404, try next endpoint
          if (status === 404) {
            continue;
          }

          // For other errors, log and try next
          logger.warn(`Machine Global createRide - Response: ${JSON.stringify(error.response?.data)}`);
        }

        continue;
      }
    }

    // All endpoints failed - log comprehensive error
    if (lastError) {
      if (axios.isAxiosError(lastError)) {
        logger.error(`Machine Global createRide - ALL endpoints failed!`);
        logger.error(`Machine Global createRide - Last HTTP Error: Status=${lastError.response?.status}`);
        logger.error(`Machine Global createRide - Last Response data: ${JSON.stringify(lastError.response?.data)}`);
        logger.error(`Machine Global createRide - Full URL attempted: ${lastError.config?.baseURL}${lastError.config?.url}`);
        logger.error(`Machine Global createRide - Request headers: ${JSON.stringify(lastError.config?.headers)}`);
      } else {
        logger.error(`Machine Global createRide - Non-HTTP Error: ${lastError.message}`);
      }
      return this.handleError(lastError);
    }

    return { success: false, errors: ['No working endpoint found'] };
  }

  // Get ride status
  async getRideStatus(rideId: string): Promise<RideResponse> {
    try {
      const response = await this.client.get(`/api/integracao/solicitacao/${rideId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Query rides with filters
  async queryRides(filters?: {
    status?: string;
    dataInicio?: string;
    dataFim?: string;
    telefone?: string;
  }): Promise<{ success: boolean; corridas?: any[]; errors?: string[] }> {
    try {
      const response = await this.client.get('/api/integracao/solicitacao', {
        params: filters,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Cancel a ride
  async cancelRide(rideId: string, motivo?: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.post(`/api/integracao/cancelarSolicitacao/${rideId}`, {
        motivo: motivo || 'Cancelado pelo cliente',
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Get driver position
  async getDriverPosition(rideId: string): Promise<{
    success: boolean;
    posicao?: { latitude: number; longitude: number };
    errors?: string[];
  }> {
    try {
      const response = await this.client.get(`/api/integracao/posicaoCondutor/${rideId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // List available drivers
  async listDrivers(): Promise<{ success: boolean; condutores?: any[]; errors?: string[] }> {
    try {
      const response = await this.client.get('/api/integracao/condutor');
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Get customer info
  async getCustomer(telefone: string): Promise<{ success: boolean; cliente?: any; errors?: string[] }> {
    try {
      const response = await this.client.get('/api/integracao/cliente', {
        params: { telefone },
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  // Handle errors uniformly
  private handleError(error: unknown): { success: false; errors: string[] } {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ errors?: string[]; message?: string }>;
      const errors = axiosError.response?.data?.errors || [
        axiosError.response?.data?.message || axiosError.message,
      ];
      return { success: false, errors };
    }
    return { success: false, errors: [(error as Error).message] };
  }

  // Map Machine Global status to our status
  static mapStatus(machineStatus: string): string {
    const statusMap: Record<string, string> = {
      'D': 'DISTRIBUTING',
      'G': 'AWAITING_ACCEPT',
      'P': 'PENDING',
      'N': 'NO_DRIVER',
      'A': 'ACCEPTED',
      'E': 'IN_PROGRESS',
      'F': 'COMPLETED',
      'C': 'CANCELLED',
      'R': 'AWAITING_PAYMENT',
    };
    return statusMap[machineStatus] || 'REQUESTED';
  }

  // Map our status to Machine Global status
  static reverseMapStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'DISTRIBUTING': 'D',
      'AWAITING_ACCEPT': 'G',
      'PENDING': 'P',
      'NO_DRIVER': 'N',
      'ACCEPTED': 'A',
      'IN_PROGRESS': 'E',
      'COMPLETED': 'F',
      'CANCELLED': 'C',
      'AWAITING_PAYMENT': 'R',
    };
    return statusMap[status] || 'D';
  }
}

// Export singleton instance
export const machineGlobalService = new MachineGlobalService();
