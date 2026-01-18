import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger.js';

/**
 * MACHINE GLOBAL SERVICE (Production-ready)
 * - Normalizes baseURL to ALWAYS include /api/integracao
 * - Uses api-key header + Basic Auth (username/password)
 * - Uses correct estimate endpoint: POST /estimarSolicitacao
 * - Never sends lat/lng empty strings
 * - Logs full URL and payload safely
 */

export interface MachineAddressInput {
  endereco?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  latitude?: number;
  longitude?: number;
}

export interface CreateRideRequest {
  origem: MachineAddressInput;
  destino: MachineAddressInput;
  passageiro: {
    nome: string;
    telefone: string;
  };
  categoria_id?: number;
  formaPagamento?: string; // D, B, C, X, P, H, A, F, I, R
  observacoes?: string;
}

export interface PriceQuoteRequest {
  origem: MachineAddressInput;
  destino: MachineAddressInput;
  categoria_id?: number;
}

export interface PriceQuoteResponse {
  success: boolean;
  cotacao?: any;
  valor_estimado?: number;
  distancia_km?: number;
  tempo_estimado?: number;
  errors?: string[];
}

export interface RideResponse {
  success: boolean;
  corrida?: any;
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

const ENDPOINTS = {
  // Corridas
  ESTIMAR: '/estimarSolicitacao',
  ABRIR: '/abrirSolicitacao',
  STATUS: (id: string) => `/solicitacao/${id}`,
  LISTAR_SOLICITACOES: '/solicitacao',
  CANCELAR: '/cancelar',
  POSICAO_CONDUTOR: (id: string) => `/posicaoCondutor/${id}`,

  // Cadastros
  CONDUTORES: '/condutor',
  CLIENTE: '/cliente',

  // Webhooks
  LISTAR_WEBHOOK: '/listarWebhook',
  CADASTRAR_WEBHOOK: '/cadastrarWebhook',
  ATUALIZAR_WEBHOOK: (id: string) => `/atualizarWebhook/${id}`,
  DELETAR_WEBHOOK: (id: string) => `/deletarWebhook/${id}`,
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

    // You may set either:
    // - https://api.taximachine.com.br
    // - https://api.taximachine.com.br/api/integracao
    // This service will normalize to include /api/integracao only once.
    const envBase = process.env.MACHINE_GLOBAL_BASE_URL || 'https://api.taximachine.com.br';
    this.baseURL = this.normalizeBaseURL(envBase);

    this.client = this.createClient();
  }

  /**
   * Ensures baseURL is ALWAYS: <domain>/api/integracao (exactly once)
   */
  private normalizeBaseURL(input: string): string {
    const raw = (input || '').trim().replace(/\/+$/, '');
    if (!raw) return 'https://api.taximachine.com.br/api/integracao';

    // If user already put /api/integracao (maybe repeated), collapse it:
    if (raw.includes('/api/integracao')) {
      return raw.replace(/(\/api\/integracao)+/g, '/api/integracao');
    }

    return `${raw}/api/integracao`;
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

    // Request logging (never lies)
    client.interceptors.request.use(
      (config) => {
        const base = config.baseURL || '';
        const url = config.url || '';
        const fullUrl = `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;

        logger.info(`Machine API Request: ${String(config.method || '').toUpperCase()} ${url}`);
        logger.info(`[MACHINE] FULL URL: ${fullUrl}`);

        if (config.data) {
          try {
            const parsed = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
            logger.info(`[MACHINE] Request Body: ${JSON.stringify(parsed, null, 2)}`);
          } catch {
            logger.info(`[MACHINE] Request Body: ${String(config.data)}`);
          }
        }

        return config;
      },
      (error) => {
        logger.error('Machine API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Response logging
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

    logger.info(`[MACHINE] Client created. BaseURL: ${this.baseURL}`);
    return client;
  }

  updateCredentials(apiKey: string, username: string, password: string, baseURL?: string): void {
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;

    if (baseURL) {
      this.baseURL = this.normalizeBaseURL(baseURL);
    }

    this.client = this.createClient();
    logger.info(`[MACHINE] Credentials updated. BaseURL: ${this.baseURL}`);
  }

  hasCredentials(): boolean {
    return !!(this.apiKey && this.username && this.password);
  }

  /**
   * Machine requires api-key + basic auth.
   * We use listWebhooks as a quick smoke-test.
   */
  async verifyConnection(): Promise<boolean> {
    try {
      const r = await this.listWebhooks();
      return r.success !== false;
    } catch (e) {
      logger.error('[MACHINE] verifyConnection failed:', e);
      return false;
    }
  }

  /**
   * IMPORTANT: Never send lat/lng empty string.
   * Send address fields if coords are missing.
   */
  private buildLocation(input: MachineAddressInput): Record<string, any> {
    const loc: Record<string, any> = {};

    if (input.endereco) loc.endereco = input.endereco;
    if (input.numero) loc.numero = input.numero;
    if (input.bairro) loc.bairro = input.bairro;
    if (input.cidade) loc.cidade = input.cidade;
    if (input.uf) loc.uf = input.uf;

    // Coordinates only if present (no empty strings)
    if (input.latitude != null) loc.lat = String(input.latitude);
    if (input.longitude != null) loc.lng = String(input.longitude);

    return loc;
  }

  /**
   * Sanitizes phone to digits only
   */
  private sanitizePhone(telefone: string): string {
    return String(telefone || '').replace(/\D/g, '');
  }

  /**
   * Handle errors with clear messages.
   * 404 in Machine = endpoint/url wrong (per doc).
   */
  private handleError(error: unknown): { success: false; errors: string[] } {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const headers = error.response?.headers;

      if (status === 404) {
        return {
          success: false,
          errors: [
            'Endpoint Not Found (404): URL/endpoint inválido. Verifique baseURL e caminho (ex: /api/integracao/estimarSolicitacao).',
          ],
        };
      }

      if (status === 401) {
        return { success: false, errors: ['Authentication Failed (401): username/password inválidos.'] };
      }

      if (status === 403) {
        const ratedBy = (headers as any)?.['mch-rated-by'];
        return {
          success: false,
          errors: [
            ratedBy
              ? `API Access Denied (403): api-key inválida/limitada. mch-rated-by: ${ratedBy}`
              : 'API Access Denied (403): api-key inválida ou sem permissão.',
          ],
        };
      }

      const msg =
        (error.response?.data as any)?.message ||
        (error.response?.data as any)?.errors?.join?.(', ') ||
        error.message;

      return { success: false, errors: [msg] };
    }

    return { success: false, errors: [(error as Error)?.message || 'Unknown error'] };
  }

  // --------------------
  // WEBHOOKS
  // --------------------

  async listWebhooks(): Promise<WebhookListResponse> {
    try {
      const res = await this.client.get(ENDPOINTS.LISTAR_WEBHOOK);
      const data = res.data;

      return {
        success: data.success !== false,
        response:
          data.response || {
            webhooks: data.webhooks || [],
            quantidade_webhooks: data.quantidade_webhooks || 0,
          },
        errors: data.errors,
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  async registerWebhook(
    url: string,
    type: 'status' | 'posicao'
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const res = await this.client.post(ENDPOINTS.CADASTRAR_WEBHOOK, { url, tipo: type });
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async updateWebhook(webhookId: string, url: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const res = await this.client.put(ENDPOINTS.ATUALIZAR_WEBHOOK(webhookId), { url });
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async deleteWebhook(webhookId: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const res = await this.client.delete(ENDPOINTS.DELETAR_WEBHOOK(webhookId));
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  // --------------------
  // ESTIMATIVA / COTAÇÃO
  // --------------------

  /**
   * Estimate/Quote WITHOUT opening a ride
   * POST /estimarSolicitacao
   */
  async getPriceQuote(data: PriceQuoteRequest): Promise<PriceQuoteResponse> {
    const requestPayload: Record<string, any> = {
      categoria_id: data.categoria_id || 4751,
      partida: this.buildLocation(data.origem),
      destino: this.buildLocation(data.destino),
    };

    // Optional: clean empty objects (avoid sending { } with nothing)
    if (!Object.keys(requestPayload.partida || {}).length) delete requestPayload.partida;
    if (!Object.keys(requestPayload.destino || {}).length) delete requestPayload.destino;

    try {
      const res = await this.client.post(ENDPOINTS.ESTIMAR, requestPayload);
      const d = res.data;

      return {
        success: d.success !== false,
        cotacao: d.cotacao,
        valor_estimado: d.valor_estimado ?? d.cotacao?.valorEstimado,
        distancia_km: d.distancia_km ?? d.cotacao?.distanciaKm,
        tempo_estimado: d.tempo_estimado ?? d.cotacao?.tempoEstimado,
      };
    } catch (e) {
      return this.handleError(e);
    }
  }

  // --------------------
  // ABRIR SOLICITAÇÃO
  // --------------------

  async createRide(data: CreateRideRequest): Promise<RideResponse> {
    const requestPayload: Record<string, any> = {
      categoria_id: data.categoria_id || 4751,
      forma_pagamento: data.formaPagamento || PAYMENT_METHODS.DINHEIRO,
      cliente: {
        nome: data.passageiro.nome,
        telefone: this.sanitizePhone(data.passageiro.telefone),
      },
      partida: this.buildLocation(data.origem),
      destino: this.buildLocation(data.destino),
    };

    if (data.observacoes) requestPayload.observacoes = data.observacoes;

    // Remove empty location objects
    if (!Object.keys(requestPayload.partida || {}).length) delete requestPayload.partida;
    if (!Object.keys(requestPayload.destino || {}).length) delete requestPayload.destino;

    try {
      const res = await this.client.post(ENDPOINTS.ABRIR, requestPayload);
      const d = res.data;
      return { success: d.success !== false, corrida: d.corrida || d };
    } catch (e) {
      return this.handleError(e);
    }
  }

  async getRideStatus(rideId: string): Promise<RideResponse> {
    try {
      const res = await this.client.get(ENDPOINTS.STATUS(rideId));
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async queryRides(filters?: {
    status?: string;
    dataInicio?: string;
    dataFim?: string;
    telefone?: string;
  }): Promise<{ success: boolean; corridas?: any[]; errors?: string[] }> {
    try {
      const res = await this.client.get(ENDPOINTS.LISTAR_SOLICITACOES, { params: filters });
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async cancelRide(
    rideId: string,
    motivo?: string
  ): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const res = await this.client.post(ENDPOINTS.CANCELAR, {
        solicitacao_id: rideId,
        motivo: motivo || 'Cancelado pelo cliente',
      });
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async getDriverPosition(
    rideId: string
  ): Promise<{ success: boolean; posicao?: { latitude: number; longitude: number }; errors?: string[] }> {
    try {
      const res = await this.client.get(ENDPOINTS.POSICAO_CONDUTOR(rideId));
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async listDrivers(): Promise<{ success: boolean; condutores?: any[]; errors?: string[] }> {
    try {
      const res = await this.client.get(ENDPOINTS.CONDUTORES);
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }

  async getCustomer(
    telefone: string
  ): Promise<{ success: boolean; cliente?: any; errors?: string[] }> {
    try {
      const res = await this.client.get(ENDPOINTS.CLIENTE, {
        params: { telefone: this.sanitizePhone(telefone) },
      });
      return res.data;
    } catch (e) {
      return this.handleError(e);
    }
  }
}

export const machineGlobalService = new MachineGlobalService();

