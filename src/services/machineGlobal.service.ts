import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger.js';

// Types for Machine Global API

export interface MachineAddress {
  endereco: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  lat?: string;
  lng?: string;
}

export interface MachineCliente {
  nome: string;
  telefone: string;
}

export interface MachineParada extends MachineAddress {
  ordem: number;
}

export interface CreateRideRequest {
  origem: {
    endereco: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    latitude?: number;
    longitude?: number;
  };
  destino: {
    endereco: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    latitude?: number;
    longitude?: number;
  };
  passageiro: {
    nome: string;
    telefone: string;
  };
  categoria_id?: number;
  formaPagamento?: string; // D, B, C, X, P, H, A, F, I, R
  observacoes?: string;
}

export interface PriceQuoteRequest {
  origem: {
    endereco: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    latitude?: number;
    longitude?: number;
  };
  destino: {
    endereco: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
    latitude?: number;
    longitude?: number;
  };
  categoria_id?: number;
}

export interface PriceQuoteResponse {
  success: boolean;
  cotacao?: {
    valorEstimado: number;
    distanciaKm: number;
    tempoEstimado: number;
    categoria: string;
  };
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

    // IMPORTANT: baseURL must include /api/integracao
    // Example: https://api.taximachine.com.br/api/integracao
    this.baseURL =
      process.env.MACHINE_GLOBAL_BASE_URL || 'https://api.taximachine.com.br/api/integracao';

    this.client = this.createClient();
  }

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
        const base = config.baseURL || '';
        const url = config.url || '';
        const fullUrl = `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;

        logger.info(`Machine API Request: ${config.method?.toUpperCase()} ${config.url}`);
        logger.info(`[MACHINE] FULL URL: ${fullUrl}`);

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

  updateCredentials(apiKey: string, username: string, password: string, baseURL?: string): void {
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;

    if (baseURL) {
      this.baseURL = baseURL.replace(/\/$/, '');
    }

    this.client = this.createClient();
    logger.info(`Machine Global credentials updated. BaseURL: ${this.baseURL}`);
  }

  hasCredentials(): boolean {
    return !!(this.apiKey && this.username && this.password);
  }

  async verifyConnection(): Promise<boolean> {
    try {
      const response = await this.listWebhooks();
      if (response.success === false) return false;
      return true;
    } catch (error) {
      logger.error('Machine Global connection verification failed:', error);
      return false;
    }
  }

  async listWebhooks(): Promise<WebhookListResponse> {
    try {
      const response = await this.client.get('/listarWebhook');
      const data = response.data;

      return {
        success: data.success !== false,
        response:
          data.response || {
            webhooks: data.webhooks || [],
            quantidade_webhooks: data.quantidade_webhooks || 0,
          },
        errors: data.errors,
      };
    } catch (error) {
      return this.handleError(error);
    }
  }

  async registerWebhook(
    url: string,
    type: 'status' | 'posicao'
  ): Promise<{ success: boolean; errors?: string[] }> {
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

  async updateWebhook(
    webhookId: string,
    url: string
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.put(`/atualizarWebhook/${webhookId}`, { url });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async deleteWebhook(webhookId: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.delete(`/deletarWebhook/${webhookId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getPriceQuote(data: PriceQuoteRequest): Promise<PriceQuoteResponse> {
    const endpoint = '/estimativa';
    const fullUrl = `${this.baseURL}${endpoint}`;

    const requestPayload: Record<string, any> = {
      categoria_id: data.categoria_id || 4751,
      partida: {
        lat: data.origem.latitude?.toString() || '',
        lng: data.origem.longitude?.toString() || '',
        endereco: data.origem.endereco,
      },
      destino: {
        lat: data.destino.latitude?.toString() || '',
        lng: data.destino.longitude?.toString() || '',
        endereco: data.destino.endereco,
      },
    };

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

      return {
        success: response.data.success !== false,
        cotacao: response.data.cotacao,
        valor_estimado: response.data.valor_estimado || response.data.cotacao?.valorEstimado,
        distancia_km: response.data.distancia_km || response.data.cotacao?.distanciaKm,
        tempo_estimado: response.data.tempo_estimado || response.data.cotacao?.tempoEstimado,
      };
    } catch (error: any) {
      logger.error(`========== MACHINE PRICE QUOTE ERROR ==========`); 
      logger.error(`[MACHINE] POST ${fullUrl} FAILED`);

      let errorMessage = error.message;

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const headers = error.response?.headers;

        logger.error(`[MACHINE] Status: ${status}`);
        logger.error(`[MACHINE] Headers: ${JSON.stringify(headers)}`);
        logger.error(`[MACHINE] Error: ${JSON.stringify(error.response?.data)}`);

        if (status === 403) {
          const ratedBy = (headers as any)?.['mch-rated-by'];
          errorMessage = ratedBy
            ? `API Access Denied (403): API key may be rate-limited or invalid. Header: ${ratedBy}.`
            : 'API Access Denied (403): Invalid credentials or API key.';
        } else if (status === 401) {
          errorMessage = 'Authentication Failed (401): Invalid username or password.';
        } else if (status === 404) {
          errorMessage = 'Endpoint Not Found (404): Check baseURL and endpoint path.';
        }
      } else {
        logger.error(`[MACHINE] Error: ${error.message}`);
      }

      logger.error(`================================================`);

      return { success: false, errors: [errorMessage] };
    }
  }

  async createRide(data: CreateRideRequest): Promise<RideResponse> {
    const endpoint = '/abrirSolicitacao';
    const fullUrl = `${this.baseURL}${endpoint}`;

    const requestPayload: Record<string, any> = {
      categoria_id: data.categoria_id || 4751,
      forma_pagamento: data.formaPagamento || PAYMENT_METHODS.DINHEIRO,
      cliente: {
        nome: data.passageiro.nome,
        telefone: data.passageiro.telefone.replace(/\D/g, ''),
      },
      partida: {
        lat: data.origem.latitude?.toString() || '',
        lng: data.origem.longitude?.toString() || '',
        endereco: data.origem.endereco,
      },
      destino: {
        lat: data.destino.latitude?.toString() || '',
        lng: data.destino.longitude?.toString() || '',
        endereco: data.destino.endereco,
      },
    };

    if (data.observacoes) requestPayload.observacoes = data.observacoes;

    logger.info(`========== MACHINE API REQUEST ==========`); 
    logger.info(`[MACHINE] POST ${fullUrl}`);
    logger.info(
      `[MACHINE] Headers: { "api-key": "${
        this.apiKey ? this.apiKey.substring(0, 15) + '...' : 'NOT SET'
      }", "Authorization": "Basic ***" }`
    );
    logger.info(`[MACHINE] Auth: { username: "${this.username}", password: "***" }`);
    logger.info(`[MACHINE] Request Body: ${JSON.stringify(requestPayload, null, 2)}`);
    logger.info(`=========================================`);

    try {
      const response = await this.client.post(endpoint, requestPayload);

      logger.info(`========== MACHINE API RESPONSE ==========`); 
      logger.info(`[MACHINE] Status: ${response.status} ${response.statusText}`);
      logger.info(`[MACHINE] Response Body: ${JSON.stringify(response.data, null, 2)}`);
      logger.info(
        `[MACHINE] Ride ID: ${
          response.data?.id || response.data?.corrida?.id || response.data?.solicitacao_id || 'NOT FOUND'
        }`
      );
      logger.info(`==========================================`);

      return { success: true, corrida: response.data.corrida || response.data };
    } catch (error: any) {
      logger.error(`========== MACHINE API ERROR ==========`); 
      logger.error(`[MACHINE] POST ${fullUrl} FAILED`);

      if (axios.isAxiosError(error)) {
        logger.error(`[MACHINE] Status: ${error.response?.status} ${error.response?.statusText}`);
        logger.error(`[MACHINE] Error Response: ${JSON.stringify(error.response?.data, null, 2)}`);
        logger.error(`[MACHINE] Request that failed: ${JSON.stringify(requestPayload, null, 2)}`);
      } else {
        logger.error(`[MACHINE] Non-HTTP Error: ${error.message}`);
        logger.error(`[MACHINE] Stack: ${error.stack}`);
      }

      logger.error(`========================================`);

      return this.handleError(error);
    }
  }

  async getRideStatus(rideId: string): Promise<RideResponse> {
    try {
      const response = await this.client.get(`/solicitacao/${rideId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async queryRides(filters?: {
    status?: string;
    dataInicio?: string;
    dataFim?: string;
    telefone?: string;
  }): Promise<{ success: boolean; corridas?: any[]; errors?: string[] }> {
    try {
      const response = await this.client.get('/solicitacao', { params: filters });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async cancelRide(
    rideId: string,
    motivo?: string
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const response = await this.client.post('/cancelar', {
        solicitacao_id: rideId,
        motivo: motivo || 'Cancelado pelo cliente',
      });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getDriverPosition(
    rideId: string
  ): Promise<{ success: boolean; posicao?: { latitude: number; longitude: number }; errors?: string[] }> {
    try {
      const response = await this.client.get(`/posicaoCondutor/${rideId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async listDrivers(): Promise<{ success: boolean; condutores?: any[]; errors?: string[] }> {
    try {
      const response = await this.client.get('/condutor');
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  async getCustomer(telefone: string): Promise<{ success: boolean; cliente?: any; errors?: string[] }> {
    try {
      const response = await this.client.get('/cliente', { params: { telefone } });
      return response.data;
    } catch (error) {
      return this.handleError(error);
    }
  }

  private handleError(error: unknown): { success: false; errors: string[] } {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ errors?: string[]; message?: string }>;
      const status = axiosError.response?.status;
      const headers = axiosError.response?.headers;

      let errorMessage: string;

      if (status === 403) {
        const ratedBy = (headers as any)?.['mch-rated-by'];
        errorMessage = ratedBy
          ? `API Access Denied (403): API key may be rate-limited or invalid. Header: ${ratedBy}.`
          : 'API Access Denied (403): Invalid credentials or API key.';
      } else if (status === 401) {
        errorMessage = 'Authentication Failed (401): Invalid username or password.';
      } else if (status === 404) {
        errorMessage = 'Endpoint Not Found (404): Check baseURL and endpoint path.';
      } else {
        const errors = axiosError.response?.data?.errors || [
          axiosError.response?.data?.message || axiosError.message,
        ];
        return { success: false, errors };
      }

      return { success: false, errors: [errorMessage] };
    }

    return { success: false, errors: [(error as Error).message] };
  }

  static mapStatus(machineStatus: string): string {
    const statusMap: Record<string, string> = {
      D: 'DISTRIBUTING',
      G: 'AWAITING_ACCEPT',
      P: 'PENDING',
      N: 'NO_DRIVER',
      A: 'ACCEPTED',
      E: 'IN_PROGRESS',
      F: 'COMPLETED',
      C: 'CANCELLED',
      R: 'AWAITING_PAYMENT',
    };
    return statusMap[machineStatus] || 'REQUESTED';
  }

  static reverseMapStatus(status: string): string {
    const statusMap: Record<string, string> = {
      DISTRIBUTING: 'D',
      AWAITING_ACCEPT: 'G',
      PENDING: 'P',
      NO_DRIVER: 'N',
      ACCEPTED: 'A',
      IN_PROGRESS: 'E',
      COMPLETED: 'F',
      CANCELLED: 'C',
      AWAITING_PAYMENT: 'R',
    };
    return statusMap[status] || 'D';
  }
}

export const machineGlobalService = new MachineGlobalService();
