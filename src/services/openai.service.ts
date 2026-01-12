import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Types for ride intent extraction
export interface RideIntent {
  hasOrigin: boolean;
  hasDestination: boolean;
  origin?: {
    text: string;
    isComplete: boolean;
  };
  destination?: {
    text: string;
    isComplete: boolean;
  };
  category?: 'Carro' | 'Moto' | 'Premium' | 'Corporativo';
  isConfirmation: boolean;
  isCancellation: boolean;
  isGreeting: boolean;
  isQuestion: boolean;
  sentiment: 'positive' | 'neutral' | 'negative';
  suggestedResponse?: string;
}

// System prompts
const RIDE_EXTRACTION_PROMPT = `Você é um assistente de IA para a Mi Chame, uma central de táxi em São Paulo, Brasil.
Sua tarefa é extrair informações sobre solicitações de corrida das mensagens dos clientes.

Analise a mensagem e extraia:
1. Se contém um endereço de ORIGEM (ponto de partida)
2. Se contém um endereço de DESTINO (onde o cliente quer ir)
3. Se é uma confirmação (sim, confirmo, ok, pode ser, etc.)
4. Se é um cancelamento (não, cancela, desisto, etc.)
5. Se é uma saudação inicial (oi, olá, bom dia, etc.)
6. Se é uma pergunta (quanto custa, qual o preço, etc.)
7. Categoria preferida do veículo se mencionada (Carro, Moto, Premium, Corporativo)
8. O sentimento geral (positivo, neutro, negativo)

Cidades de atendimento: Capivari, Rafard, Santa Bárbara d'Oeste, Americana, Nova Odessa, Sumaré, Mirassol, São José do Rio Preto (SP).

Responda APENAS em formato JSON válido, sem markdown.`;

const CONVERSATION_PROMPT = `Você é a assistente virtual da Mi Chame, uma central de táxi em São Paulo.
Seu nome é "Mi" e você deve ser amigável, profissional e eficiente.

Regras:
- Seja breve e direto nas respostas
- Use português brasileiro informal mas educado
- Nunca invente preços ou tempos - espere os dados reais
- Se o cliente parecer frustrado, seja ainda mais gentil
- Sempre confirme as informações antes de criar a corrida

Cidades de atendimento: Capivari, Rafard, Santa Bárbara d'Oeste, Americana, Nova Odessa, Sumaré, Mirassol, São José do Rio Preto.

Categorias disponíveis:
- Carro: Veículo padrão
- Moto: Mototáxi (mais rápido, 1 passageiro)
- Premium: Veículo executivo
- Corporativo: Para empresas

Formas de pagamento: Dinheiro, Cartão (débito/crédito), Pix`;

class OpenAIService {
  private client: OpenAI;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.client = new OpenAI({
      apiKey: this.apiKey,
    });
  }

  // Update credentials dynamically (from database)
  updateCredentials(apiKey: string): void {
    this.apiKey = apiKey;
    this.client = new OpenAI({ apiKey });
    logger.info('OpenAI credentials updated');
  }

  // Check if credentials are configured
  hasCredentials(): boolean {
    return !!this.apiKey;
  }

  // Transcribe audio using Whisper
  async transcribeAudio(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<string | null> {
    try {
      // Create temp file
      const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'wav';
      const tempPath = path.join(os.tmpdir(), `audio_${Date.now()}.${extension}`);

      // Write buffer to temp file
      fs.writeFileSync(tempPath, audioBuffer);

      try {
        // Transcribe using Whisper
        const transcription = await this.client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: 'whisper-1',
          language: 'pt', // Portuguese
          response_format: 'text',
        });

        logger.info(`Audio transcribed: ${transcription.substring(0, 100)}...`);
        return transcription;
      } finally {
        // Clean up temp file
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
    } catch (error: any) {
      logger.error('Failed to transcribe audio:', error.message);
      return null;
    }
  }

  // Extract ride intent from message
  async extractRideIntent(message: string, conversationContext?: string): Promise<RideIntent> {
    try {
      const contextPrompt = conversationContext
        ? `\n\nContexto da conversa atual:\n${conversationContext}`
        : '';

      const response = await this.client.chat.completions.create({
      model: "gpt-4.1-mini"
 
        input: [
          { role: 'system', content: RIDE_EXTRACTION_PROMPT + contextPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.output_text;
      }

      const parsed = JSON.parse(content);

      return {
        hasOrigin: parsed.hasOrigin || false,
        hasDestination: parsed.hasDestination || false,
        origin: parsed.origin,
        destination: parsed.destination,
        category: parsed.category,
        isConfirmation: parsed.isConfirmation || false,
        isCancellation: parsed.isCancellation || false,
        isGreeting: parsed.isGreeting || false,
        isQuestion: parsed.isQuestion || false,
        sentiment: parsed.sentiment || 'neutral',
        suggestedResponse: parsed.suggestedResponse,
      };
    } catch (error: any) {
      logger.error('Failed to extract ride intent:', error.message);

      // Return basic analysis based on keywords
      const lowerMessage = message.toLowerCase();
      return {
        hasOrigin: false,
        hasDestination: false,
        isConfirmation: /\b(sim|confirmo|ok|pode|certo|isso|confirma)\b/i.test(lowerMessage),
        isCancellation: /\b(não|cancela|desisto|pare|para)\b/i.test(lowerMessage),
        isGreeting: /\b(oi|olá|ola|bom dia|boa tarde|boa noite|hey|hi)\b/i.test(lowerMessage),
        isQuestion: lowerMessage.includes('?') || /\b(quanto|qual|como|onde|quando)\b/i.test(lowerMessage),
        sentiment: 'neutral',
      };
    }
  }

  // Generate conversational response
  async generateResponse(
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    context: {
      state: string;
      origin?: string;
      destination?: string;
      price?: number;
      category?: string;
      driverName?: string;
      eta?: number;
    }
  ): Promise<string> {
    try {
      // Build context message
      let contextInfo = `\nEstado atual: ${context.state}`;
      if (context.origin) contextInfo += `\nOrigem: ${context.origin}`;
      if (context.destination) contextInfo += `\nDestino: ${context.destination}`;
      if (context.price) contextInfo += `\nPreço estimado: R$ ${context.price.toFixed(2)}`;
      if (context.category) contextInfo += `\nCategoria: ${context.category}`;
      if (context.driverName) contextInfo += `\nMotorista: ${context.driverName}`;
      if (context.eta) contextInfo += `\nTempo estimado de chegada: ${context.eta} minutos`;

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: CONVERSATION_PROMPT + contextInfo },
        ...conversationHistory.slice(-10), // Last 10 messages for context
        { role: 'user', content: userMessage },
      ];

      const response = await this.client.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages,
        temperature: 0.7,
        max_tokens: 300,
      });

      return response.choices[0]?.message?.content || 'Desculpe, não consegui processar sua mensagem. Pode repetir?';
    } catch (error: any) {
      logger.error('Failed to generate response:', error.message);
      return 'Desculpe, estou com dificuldades técnicas. Por favor, tente novamente em alguns instantes.';
    }
  }

  // Generate greeting message
  async generateGreeting(customerName?: string): Promise<string> {
    const hour = new Date().getHours();
    let timeGreeting = 'Olá';

    if (hour >= 5 && hour < 12) {
      timeGreeting = 'Bom dia';
    } else if (hour >= 12 && hour < 18) {
      timeGreeting = 'Boa tarde';
    } else {
      timeGreeting = 'Boa noite';
    }

    const name = customerName ? `, ${customerName.split(' ')[0]}` : '';

    return `${timeGreeting}${name}! Sou a Mi, assistente virtual da Mi Chame. Como posso ajudar você hoje?\n\nPara solicitar uma corrida, me diga de onde você quer sair.`;
  }

  // Generate price confirmation message
  generatePriceMessage(
    origin: string,
    destination: string,
    price: number,
    distance: number,
    duration: number,
    category: string
  ): string {
    return `Encontrei sua rota!\n\n` +
      `De: ${origin}\n` +
      `Para: ${destination}\n\n` +
      `Categoria: ${category}\n` +
      `Distância: ${distance.toFixed(1)} km\n` +
      `Tempo estimado: ${duration} min\n` +
      `Valor: R$ ${price.toFixed(2)}\n\n` +
      `Deseja confirmar a corrida?`;
  }

  // Generate driver assigned message
  generateDriverAssignedMessage(
    driverName: string,
    vehicle: string,
    plate: string,
    eta: number,
    rating?: number
  ): string {
    let msg = `Motorista encontrado!\n\n` +
      `${driverName}\n` +
      `${vehicle} - ${plate}\n`;

    if (rating) {
      msg += `Avaliação: ${''.repeat(Math.round(rating))}\n`;
    }

    msg += `\nChega em aproximadamente ${eta} minutos.\n\n` +
      `Você pode acompanhar a corrida por aqui. Boa viagem!`;

    return msg;
  }

  // Generate no driver message
  generateNoDriverMessage(): string {
    return `Infelizmente não encontramos motoristas disponíveis no momento.\n\n` +
      `Deseja que eu tente novamente em alguns minutos?`;
  }

  // Generate cancellation confirmation
  generateCancellationMessage(): string {
    return `Corrida cancelada com sucesso.\n\n` +
      `Se precisar de algo mais, é só me chamar!`;
  }
}

// Export singleton instance
export const openaiService = new OpenAIService();
