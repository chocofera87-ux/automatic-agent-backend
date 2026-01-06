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
  categoria_id?: number;  // Machine category ID (numeric)
  categoria?: string;     // Category name fallback
  formaPagamento?: string; // D, B, C, X, P, H, A, F, I, R
  observacoes?: string;
}

export interface PriceQuoteRequest {
  origem: MachineLocation;
  destino: MachineLocation;
  categoria_id?: number;  // Machine category ID
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
  // Machine API may return estimate in different format
  valor_estimado?: number;
  distancia_km?: number;
  tempo_estimado?: number;
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
      const urlMatch = baseURL.match(/^(https?:\/\/[^\/]+)/);
      if (urlMatch) {
        this.baseURL = urlMatch[1];
      } else {
        this.baseURL = baseURL;
      }
    }

    // CRITICAL: Force correct API URL - cloud.taximachine is web panel, not API
    if (this.baseURL.includes('cloud.taximachine.com.br')) {
      logger.warn(`Machine Global: Correcting URL from cloud.taximachine to api-trial.taximachine`);
      this.baseURL = 'https://api-trial.taximachine.com.br';
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

  // Get price quote / estimation from Machine API
  // This should be used to get the REAL price from Machine, not calculated locally
  async getPriceQuote(data: PriceQuoteRequest): Promise<PriceQuoteResponse> {
    const endpoint = '/api/integracao/estimativa';
    const fullUrl = `${this.baseURL}${endpoint}`;

    const requestPayload: Record<string, any> = {
      origem: data.origem,
      destino: data.destino,
    };

    // Use categoria_id if provided
    if (data.categoria_id) {
      requestPayload.categoria_id = data.categoria_id;
    } else if (data.categoria) {
      requestPayload.categoria = data.categoria;
    }

    logger.info(`========== MACHINE PRICE QUOTE REQUEST ==========`);
    logger.info(`[MACHINE] POST ${fullUrl}`);
    logger.info(`[MACHINE] Request Body: ${JSON.stringify(requestPayload, null, 2)}`);
    logger.info(`=================================================`);

    try {
      const response = await this.client.post(endpoint, requestPayload);

      logger.info(`========== MACHINE PRICE QUOTE RESPONSE ==========`);
      logger.info(`[MACHINE] Status: ${response.status}`);
      logger.info(`[MACHINE] Response: ${JSON.stringify(response.data, null, 2)}`);
      logger.info(`==================================================`);

      // Normalize response format
      const result: PriceQuoteResponse = {
        success: response.data.success !== false,
        cotacao: response.data.cotacao,
        valor_estimado: response.data.valor_estimado || response.data.cotacao?.valorEstimado,
        distancia_km: response.data.distancia_km || response.data.cotacao?.distanciaKm,
        tempo_estimado: response.data.tempo_estimado || response.data.cotacao?.tempoEstimado,
      };

      return result;
    } catch (error: any) {
      logger.error(`========== MACHINE PRICE QUOTE ERROR ==========`);
      logger.error(`[MACHINE] POST ${fullUrl} FAILED`);

      if (axios.isAxiosError(error)) {
        logger.error(`[MACHINE] Status: ${error.response?.status}`);
        logger.error(`[MACHINE] Error: ${JSON.stringify(error.response?.data)}`);
      } else {
        logger.error(`[MACHINE] Error: ${error.message}`);
      }
      logger.error(`================================================`);

      return {
        success: false,
        errors: [error.response?.data?.error?.message || error.message],
      };
    }
  }

  // Create a new ride using official Machine Global API
  // Endpoint: POST /api/integracao/abrirSolicitacao
  async createRide(data: CreateRideRequest): Promise<RideResponse> {
    const endpoint = '/api/integracao/abrirSolicitacao';
    const fullUrl = `${this.baseURL}${endpoint}`;

    // Build request payload - use categoria_id if provided (Machine requires numeric IDs)
    const requestPayload: Record<string, any> = {
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
      formaPagamento: data.formaPagamento || PAYMENT_METHODS.DINHEIRO,
      observacoes: data.observacoes,
    };

    // IMPORTANT: Use categoria_id (numeric) if provided, otherwise fall back to categoria (string)
    if (data.categoria_id) {
      requestPayload.categoria_id = data.categoria_id;
    } else if (data.categoria) {
      requestPayload.categoria = data.categoria;
    }

    // === FULL REQUEST LOG ===
    logger.info(`========== MACHINE API REQUEST ==========`);
    logger.info(`[MACHINE] POST ${fullUrl}`);
    logger.info(`[MACHINE] Headers: { "api-key": "${this.apiKey ? this.apiKey.substring(0, 15) + '...' : 'NOT SET'}", "Authorization": "Basic ***" }`);
    logger.info(`[MACHINE] Auth: { username: "${this.username}", password: "***" }`);
    logger.info(`[MACHINE] Request Body: ${JSON.stringify(requestPayload, null, 2)}`);
    logger.info(`=========================================`);

    try {
      const response = await this.client.post(endpoint, requestPayload);

      // === FULL RESPONSE LOG ===
      logger.info(`========== MACHINE API RESPONSE ==========`);
      logger.info(`[MACHINE] Status: ${response.status} ${response.statusText}`);
      logger.info(`[MACHINE] Response Body: ${JSON.stringify(response.data, null, 2)}`);
      logger.info(`[MACHINE] Ride ID (id_mch): ${response.data?.id || response.data?.corrida?.id || response.data?.solicitacao_id || 'NOT FOUND'}`);
      logger.info(`==========================================`);

      return {
        success: true,
        corrida: response.data.corrida || response.data,
      };
    } catch (error: any) {
      // === FULL ERROR LOG ===
      logger.error(`========== MACHINE API ERROR ==========`);
      logger.error(`[MACHINE] POST ${fullUrl} FAILED`);

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const statusText = error.response?.statusText;
        const errorData = error.response?.data;

        logger.error(`[MACHINE] Status: ${status} ${statusText}`);
        logger.error(`[MACHINE] Error Response: ${JSON.stringify(errorData, null, 2)}`);
        logger.error(`[MACHINE] Request that failed: ${JSON.stringify(requestPayload, null, 2)}`);
      } else {
        logger.error(`[MACHINE] Non-HTTP Error: ${error.message}`);
        logger.error(`[MACHINE] Stack: ${error.stack}`);
      }
      logger.error(`========================================`);

      return this.handleError(error);
    }
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

  // Cancel a ride - POST /api/integracao/cancelar
  async cancelRide(rideId: string, motivo?: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.post('/api/integracao/cancelar', {
        solicitacao_id: rideId,
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
