import { PrismaClient, ConversationState, Conversation, MessageDirection, MessageType, RideStatus, VehicleCategory, PaymentMethod } from '@prisma/client';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { whatsappService } from './whatsapp.service.js';
import { openaiService } from './openai.service.js';
import { machineGlobalService } from './machineGlobal.service.js';

const prisma = new PrismaClient();

// Conversation context stored in JSON field
interface ConversationContext {
  origin?: {
    address: string;
    latitude?: number;
    longitude?: number;
    isAutoDetected?: boolean;  // True if origin was auto-detected from location
  };
  destination?: {
    address: string;
    latitude?: number;
    longitude?: number;
  };
  category?: VehicleCategory;
  paymentMethod?: PaymentMethod;
  estimatedPrice?: number;
  estimatedDistance?: number;
  estimatedDuration?: number;
  lastIntent?: string;
  messageHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  locationRequestSent?: boolean;  // Track if we already asked for location
  locationRequestTime?: number;   // Timestamp when location was requested
  flowStarted?: boolean;  // Track if ride flow has started (avoid welcome restart)
}

// Reverse geocoding using OpenStreetMap Nominatim API (free, no API key needed)
async function reverseGeocode(latitude: number, longitude: number): Promise<string> {
  try {
    const response = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'MiChame-WhatsApp-Taxi/1.0',
          'Accept-Language': 'pt-BR',
        },
        timeout: 5000,
      }
    );

    const data = response.data;

    // Build a clean, readable address
    if (data.address) {
      const parts: string[] = [];

      // Street + house number
      if (data.address.road) {
        let street = data.address.road;
        if (data.address.house_number) {
          street += `, ${data.address.house_number}`;
        }
        parts.push(street);
      }

      // Neighborhood
      if (data.address.suburb || data.address.neighbourhood) {
        parts.push(data.address.suburb || data.address.neighbourhood);
      }

      // City
      if (data.address.city || data.address.town || data.address.village) {
        parts.push(data.address.city || data.address.town || data.address.village);
      }

      if (parts.length > 0) {
        return parts.join(' - ');
      }
    }

    // Fallback to display_name if parsing fails
    if (data.display_name) {
      // Truncate long addresses
      const shortAddress = data.display_name.split(',').slice(0, 3).join(', ');
      return shortAddress;
    }

    throw new Error('No address found');
  } catch (error) {
    logger.warn('Reverse geocoding failed:', error);
    // Return a fallback that doesn't expose raw coordinates
    return 'Localização GPS compartilhada';
  }
}

// Pricing rules - single source of truth
// IMPORTANT: This is the ONLY place where pricing is defined
// Never use Machine Global pricing - always use these rules
interface PricingRule {
  baseFare: number;       // Base fare in R$
  pricePerKm: number;     // Price per kilometer in R$
  pricePerMinute: number; // Price per minute in R$
  minimumFare: number;    // Minimum fare in R$
  displayName: string;    // User-friendly name for WhatsApp display
  description: string;    // Description for user understanding
}

const PRICING_RULES: Record<string, PricingRule> = {
  CARRO_PEQUENO: {
    baseFare: 5.00,
    pricePerKm: 2.00,
    pricePerMinute: 0.35,
    minimumFare: 9.00,
    displayName: 'Carro Pequeno',
    description: 'Econômico',
  },
  CARRO_GRANDE: {
    baseFare: 7.00,
    pricePerKm: 2.00,
    pricePerMinute: 0.55,
    minimumFare: 9.00,
    displayName: 'Carro Grande',
    description: 'Conforto / Família',
  },
};

// Calculate ride price based on category, distance, and duration
// Formula: final_price = base_fare + (distance_km × price_per_km) + (duration_minutes × price_per_minute)
// Then apply minimum fare if calculated price is below it
function calculatePrice(category: VehicleCategory, distanceKm: number, durationMinutes: number): number {
  const rules = PRICING_RULES[category as string] || PRICING_RULES.CARRO_PEQUENO;

  const calculatedPrice = rules.baseFare +
    (distanceKm * rules.pricePerKm) +
    (durationMinutes * rules.pricePerMinute);

  // Apply minimum fare if calculated price is below it
  return Math.max(calculatedPrice, rules.minimumFare);
}

// Map VehicleCategory enum to Machine Global API format
function mapCategoryToApi(category?: VehicleCategory): 'Carro' | 'Moto' | 'Premium' | 'Corporativo' {
  if (!category) return 'Carro';
  // Map our categories to Machine Global's categories
  const map: Record<VehicleCategory, 'Carro' | 'Moto' | 'Premium' | 'Corporativo'> = {
    [VehicleCategory.CARRO_PEQUENO]: 'Carro',
    [VehicleCategory.CARRO_GRANDE]: 'Premium',
  };
  return map[category] || 'Carro';
}

class ConversationService {
  // Get or create a conversation for a customer
  async getOrCreateConversation(phoneNumber: string, customerName?: string): Promise<Conversation & { customer: { id: string; phoneNumber: string; name: string | null } }> {
    // Find or create customer
    let customer = await prisma.customer.findUnique({
      where: { phoneNumber },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          phoneNumber,
          name: customerName,
        },
      });
      logger.info(`Created new customer: ${phoneNumber}`);
    } else if (customerName && !customer.name) {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: { name: customerName },
      });
    }

    // Find active conversation or create new one
    let conversation = await prisma.conversation.findFirst({
      where: {
        customerId: customer.id,
        isActive: true,
      },
      include: { customer: true },
    });

    // If conversation is old (> 30 minutes since last message), close it and create new
    if (conversation) {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      if (conversation.lastMessageAt < thirtyMinutesAgo) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { isActive: false },
        });
        conversation = null;
      }
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          customerId: customer.id,
          state: ConversationState.GREETING,
          context: {},
        },
        include: { customer: true },
      });
      logger.info(`Created new conversation for: ${phoneNumber}`);
    }

    return conversation as Conversation & { customer: { id: string; phoneNumber: string; name: string | null } };
  }

  // Process incoming message
  async processMessage(
    phoneNumber: string,
    messageId: string,
    messageType: 'text' | 'audio' | 'location' | 'interactive',
    content: any,
    customerName?: string
  ): Promise<void> {
    try {
      // Get or create conversation
      const conversation = await this.getOrCreateConversation(phoneNumber, customerName);
      const context = (conversation.context as ConversationContext) || {};

      // Save incoming message
      let textContent = '';
      let metadata: any = {};

      switch (messageType) {
        case 'text':
          textContent = content;
          break;
        case 'audio':
          // Download and transcribe audio
          const audioBuffer = await whatsappService.downloadMedia(content.audioId);
          if (audioBuffer) {
            const transcription = await openaiService.transcribeAudio(audioBuffer, content.mimeType);
            textContent = transcription || '[Audio não transcrito]';
            metadata = { audioId: content.audioId, transcription };
          } else {
            textContent = '[Audio não disponível]';
          }
          break;
        case 'location':
          textContent = content.address || `Lat: ${content.latitude}, Lng: ${content.longitude}`;
          metadata = {
            latitude: content.latitude,
            longitude: content.longitude,
            name: content.name,
            address: content.address,
          };
          break;
        case 'interactive':
          textContent = content.buttonTitle || content.listTitle || '';
          metadata = content;
          break;
      }

      // Save message to database
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: MessageDirection.INCOMING,
          content: textContent,
          messageType: messageType.toUpperCase() as MessageType,
          whatsappMsgId: messageId,
          metadata,
        },
      });

      // Update conversation timestamp
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      // Mark message as read
      await whatsappService.markAsRead(messageId);

      // Process based on current state
      await this.handleState(conversation, textContent, messageType, metadata, context);

    } catch (error: any) {
      logger.error('Error processing message:', error);
      // Send error message to user
      await whatsappService.sendTextMessage(
        phoneNumber,
        'Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente.'
      );
    }
  }

  // Handle conversation state
  private async handleState(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    messageType: string,
    metadata: any,
    context: ConversationContext
  ): Promise<void> {
    // Log current state for debugging
    logger.info(`[ConversationFlow] Processing message - State: ${conversation.state}, MessageType: ${messageType}, Phone: ${conversation.customer.phoneNumber}`);

    // Extract intent from message (with fallback if OpenAI fails)
    const intent = await openaiService.extractRideIntent(message, JSON.stringify(context));
    logger.info(`[ConversationFlow] Intent extracted - isConfirmation: ${intent.isConfirmation}, isCancellation: ${intent.isCancellation}`);

    // Handle cancellation at any state
    if (intent.isCancellation && conversation.state !== ConversationState.GREETING) {
      await this.handleCancellation(conversation, context);
      return;
    }

    switch (conversation.state) {
      case ConversationState.GREETING:
        await this.handleGreeting(conversation, message, intent, context);
        break;

      case ConversationState.REQUESTING_LOCATION:
        await this.handleLocationRequest(conversation, message, messageType, metadata, intent, context);
        break;

      case ConversationState.AWAITING_ORIGIN:
        await this.handleOriginInput(conversation, message, messageType, metadata, intent, context);
        break;

      case ConversationState.CONFIRMING_ORIGIN:
        await this.handleOriginConfirmation(conversation, message, messageType, metadata, intent, context);
        break;

      case ConversationState.AWAITING_DESTINATION:
        await this.handleDestinationInput(conversation, message, messageType, metadata, intent, context);
        break;

      case ConversationState.AWAITING_CATEGORY:
        await this.handleCategorySelection(conversation, message, intent, context);
        break;

      case ConversationState.SHOWING_PRICE:
      case ConversationState.AWAITING_CONFIRMATION:
        await this.handleConfirmation(conversation, message, intent, context);
        break;

      case ConversationState.RIDE_CREATED:
      case ConversationState.RIDE_IN_PROGRESS:
        await this.handleActiveRide(conversation, message, intent, context);
        break;

      default:
        // Reset to greeting for unknown states
        await this.handleGreeting(conversation, message, intent, context);
    }
  }

  // Handle greeting state - Uber-like flow: request GPS location first
  private async handleGreeting(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    _message: string,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;
    const customerName = conversation.customer.name;

    // Mark flow as started
    context.flowStarted = true;
    context.locationRequestSent = true;
    context.locationRequestTime = Date.now();

    // Generate personalized greeting - simple, one action
    const greeting = customerName
      ? `Olá, ${customerName}! 👋`
      : `Olá! 👋 Bem-vindo à Mi Chame!`;

    // Send greeting
    const result = await whatsappService.sendTextMessage(phoneNumber, greeting);
    await this.saveOutgoingMessage(conversation.id, greeting, result.messageId);

    // If user already provided destination in first message (power user), save it and continue
    if (intent.hasDestination && intent.destination) {
      context.destination = { address: intent.destination.text };
    }

    await this.updateConversation(conversation.id, ConversationState.REQUESTING_LOCATION, context);

    // GPS-ONLY: Request location with simple, clear message - NO suggestion to type
    const locationRequest = await whatsappService.sendLocationRequest(
      phoneNumber,
      `📍 Compartilhe sua localização atual para começarmos.`
    );
    await this.saveOutgoingMessage(conversation.id, 'Solicitando localização GPS', locationRequest.messageId);
  }

  // Handle location request response - GPS-first with reverse geocoding
  private async handleLocationRequest(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    messageType: string,
    metadata: any,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Check if user shared their GPS location
    if (messageType === 'location' && metadata.latitude && metadata.longitude) {
      logger.info(`[ConversationFlow] GPS location received - Lat: ${metadata.latitude}, Lng: ${metadata.longitude}`);

      // REVERSE GEOCODE: Convert GPS to human-readable address (never show raw coords)
      const humanAddress = await reverseGeocode(metadata.latitude, metadata.longitude);
      logger.info(`[ConversationFlow] Reverse geocoded address: ${humanAddress}`);

      context.origin = {
        address: humanAddress,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        isAutoDetected: true,
      };

      // If we already have destination (power user flow), go to category
      if (context.destination) {
        await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);
        await this.showCategorySelection(conversation, context);
        return;
      }

      // Ask for destination - FREE TEXT input (simple, one action)
      logger.info(`[ConversationFlow] Transitioning to AWAITING_DESTINATION state`);
      await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);

      const destMsg = await whatsappService.sendTextMessage(
        phoneNumber,
        `📍 ${humanAddress}\n\n🎯 Para onde você quer ir?`
      );
      await this.saveOutgoingMessage(conversation.id, `Origem: ${humanAddress}`, destMsg.messageId);
      return;
    }

    // User typed text instead of sharing GPS
    if (message.length > 3) {
      // If user typed a destination, save it but still need GPS for origin
      if (intent.hasDestination && intent.destination) {
        context.destination = { address: intent.destination.text };
      }

      // Still request GPS - don't accept typed origin
      const retryMsg = await whatsappService.sendLocationRequest(
        phoneNumber,
        `📍 Por favor, compartilhe sua localização atual clicando no botão acima.`
      );
      await this.saveOutgoingMessage(conversation.id, 'Solicitando GPS novamente', retryMsg.messageId);
      return;
    }

    // Short message or random input - remind about GPS
    const reminderMsg = await whatsappService.sendLocationRequest(
      phoneNumber,
      `📍 Toque no botão acima para compartilhar sua localização.`
    );
    await this.saveOutgoingMessage(conversation.id, 'Lembrete GPS', reminderMsg.messageId);
  }

  // Handle origin confirmation (when user wants to edit auto-detected origin)
  private async handleOriginConfirmation(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    messageType: string,
    metadata: any,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;
    const lowerMessage = message.toLowerCase();

    // User confirmed origin
    if (intent.isConfirmation || lowerMessage.includes('sim') || lowerMessage.includes('ok') || lowerMessage.includes('correto')) {
      await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);

      const destMsg = await whatsappService.sendLocationRequest(
        phoneNumber,
        `✅ Origem confirmada!\n\n🎯 Para onde você quer ir?`
      );
      await this.saveOutgoingMessage(conversation.id, 'Origem confirmada pelo usuário', destMsg.messageId);
      return;
    }

    // User wants to change origin
    if (lowerMessage.includes('mudar') || lowerMessage.includes('alterar') || lowerMessage.includes('outro')) {
      await this.updateConversation(conversation.id, ConversationState.AWAITING_ORIGIN, context);

      const changeMsg = await whatsappService.sendLocationRequest(
        phoneNumber,
        `📍 Digite o novo endereço de partida ou compartilhe outra localização.`
      );
      await this.saveOutgoingMessage(conversation.id, 'Usuário quer alterar origem', changeMsg.messageId);
      return;
    }

    // User provided new GPS location
    if (messageType === 'location' && metadata.latitude && metadata.longitude) {
      const humanAddress = await reverseGeocode(metadata.latitude, metadata.longitude);
      context.origin = {
        address: humanAddress,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        isAutoDetected: true,
      };

      await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);

      const destMsg = await whatsappService.sendTextMessage(
        phoneNumber,
        `📍 ${humanAddress}\n\n🎯 Para onde você quer ir?`
      );
      await this.saveOutgoingMessage(conversation.id, `Origem: ${humanAddress}`, destMsg.messageId);
      return;
    }

    // User typed text - redirect to GPS
    if (message.length > 3) {
      const retryMsg = await whatsappService.sendLocationRequest(
        phoneNumber,
        `📍 Por favor, compartilhe sua localização clicando no botão acima.`
      );
      await this.saveOutgoingMessage(conversation.id, 'Solicitando GPS', retryMsg.messageId);
      return;
    }

    // Ask again
    const askMsg = await whatsappService.sendButtonMessage(
      phoneNumber,
      `📍 Origem atual: ${context.origin?.address}\n\nEstá correto?`,
      [
        { id: 'confirm_origin', title: 'Sim, está correto' },
        { id: 'change_origin', title: 'Não, alterar' },
      ]
    );
    await this.saveOutgoingMessage(conversation.id, 'Confirmando origem', askMsg.messageId);
  }

  // Helper: Show category selection menu - Carro Pequeno and Carro Grande
  // Using user-friendly names that people in small cities understand
  private async showCategorySelection(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    const response = await whatsappService.sendButtonMessage(
      phoneNumber,
      `📍 ${context.origin?.address}\n🎯 ${context.destination?.address}\n\nEscolha o tipo de carro:`,
      [
        { id: 'cat_pequeno', title: 'Carro Pequeno' },
        { id: 'cat_grande', title: 'Carro Grande' },
      ]
    );
    await this.saveOutgoingMessage(conversation.id, 'Categorias oferecidas', response.messageId);
  }

  // Handle origin input - GPS preferred with reverse geocoding
  private async handleOriginInput(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    _message: string,
    messageType: string,
    metadata: any,
    _intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    if (messageType === 'location' && metadata.latitude && metadata.longitude) {
      // User shared GPS - reverse geocode to human address
      const humanAddress = await reverseGeocode(metadata.latitude, metadata.longitude);
      context.origin = {
        address: humanAddress,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        isAutoDetected: true,
      };

      // Ask for destination
      await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);
      const response = await whatsappService.sendTextMessage(
        phoneNumber,
        `📍 ${humanAddress}\n\n🎯 Para onde você quer ir?`
      );
      await this.saveOutgoingMessage(conversation.id, `Origem: ${humanAddress}`, response.messageId);
      return;
    }

    // User typed text - redirect to GPS request
    const response = await whatsappService.sendLocationRequest(
      phoneNumber,
      `📍 Por favor, compartilhe sua localização clicando no botão acima.`
    );
    await this.saveOutgoingMessage(conversation.id, 'Solicitando GPS', response.messageId);
  }

  // Handle destination input - FREE TEXT (user types destination)
  private async handleDestinationInput(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    messageType: string,
    metadata: any,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Accept location shared for destination (with reverse geocoding)
    if (messageType === 'location' && metadata.latitude && metadata.longitude) {
      const humanAddress = await reverseGeocode(metadata.latitude, metadata.longitude);
      context.destination = {
        address: humanAddress,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
      };
    } else if (intent.hasDestination && intent.destination) {
      // AI extracted destination from message
      context.destination = { address: intent.destination.text };
    } else if (message.length > 3) {
      // Accept any text as destination (free text input)
      context.destination = { address: message };
    } else {
      // Too short - ask again
      const response = await whatsappService.sendTextMessage(
        phoneNumber,
        `🎯 Digite o endereço ou nome do local de destino.`
      );
      await this.saveOutgoingMessage(conversation.id, 'Destino solicitado', response.messageId);
      return;
    }

    // Go directly to category selection
    await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);
    await this.showCategorySelection(conversation, context);
  }

  // Handle category selection - Carro Pequeno or Carro Grande
  private async handleCategorySelection(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    _intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Determine category from message - user-friendly names
    const lowerMessage = message.toLowerCase();
    let category: VehicleCategory = VehicleCategory.CARRO_PEQUENO;

    if (lowerMessage.includes('grande') || lowerMessage.includes('confort') ||
        message === 'cat_grande' || message === 'cat_confort') {
      category = VehicleCategory.CARRO_GRANDE;
    } else if (lowerMessage.includes('pequeno') || lowerMessage.includes('lite') ||
               message === 'cat_pequeno' || message === 'cat_lite') {
      category = VehicleCategory.CARRO_PEQUENO;
    }

    context.category = category;

    // Get distance/duration estimate from Machine Global (ONLY for distance/duration, NOT price)
    // We NEVER use Machine Global pricing - only our own pricing rules
    const quote = await machineGlobalService.getPriceQuote({
      origem: {
        endereco: context.origin?.address || '',
        latitude: context.origin?.latitude,
        longitude: context.origin?.longitude,
      },
      destino: {
        endereco: context.destination?.address || '',
        latitude: context.destination?.latitude,
        longitude: context.destination?.longitude,
      },
      categoria: mapCategoryToApi(category),
    });

    // Get distance and duration for price calculation
    // Use reasonable defaults if Machine Global fails
    let distanceKm = 3.0;  // Default fallback for short city rides
    let durationMin = 8;   // Default fallback (~8 min for 3km)

    if (quote.success && quote.cotacao) {
      // Only use distance/duration from Machine Global, NEVER use their price
      distanceKm = quote.cotacao.distanciaKm || 3.0;
      durationMin = quote.cotacao.tempoEstimado || 8;

      logger.info(`Machine Global quote: ${distanceKm}km, ${durationMin}min (their price ignored: R$${quote.cotacao.valorEstimado})`);
    } else {
      logger.warn('Machine Global quote failed, using default distance/duration');
    }

    // Store internally (will only show after driver accepts)
    context.estimatedDistance = distanceKm;
    context.estimatedDuration = durationMin;

    // Calculate price using OUR pricing formula (single source of truth)
    // Formula: base_fare + (distance_km × price_per_km) + (duration_minutes × price_per_minute)
    context.estimatedPrice = calculatePrice(category, distanceKm, durationMin);

    // Log price calculation for debugging
    const rules = PRICING_RULES[category as string];
    logger.info(`Price calculation: ${rules.baseFare} + (${distanceKm} × ${rules.pricePerKm}) + (${durationMin} × ${rules.pricePerMinute}) = R$${context.estimatedPrice.toFixed(2)}`);

    // PRICING VALIDATION: Ensure price is reasonable before showing to user
    if (context.estimatedPrice < rules.minimumFare) {
      context.estimatedPrice = rules.minimumFare;
      logger.info(`Price below minimum, using minimum fare: R$${rules.minimumFare}`);
    }

    // Update state to showing price - FINAL CONFIRMATION BEFORE RIDE CREATION
    await this.updateConversation(conversation.id, ConversationState.AWAITING_CONFIRMATION, context);

    // Get user-friendly category name from pricing rules
    const categoryDisplayName = PRICING_RULES[category as string]?.displayName || 'Carro Pequeno';

    // UX RULE: Before acceptance, show ONLY price (no km, no ETA)
    const summaryMessage = `📍 ${context.origin?.address}\n🎯 ${context.destination?.address}\n\n🚗 ${categoryDisplayName}\n💰 R$ ${context.estimatedPrice.toFixed(2)}`;

    const response = await whatsappService.sendButtonMessage(
      phoneNumber,
      summaryMessage,
      [
        { id: 'confirm_ride', title: 'Confirmar' },
        { id: 'change_category', title: 'Alterar' },
        { id: 'cancel_ride', title: 'Cancelar' },
      ]
    );
    await this.saveOutgoingMessage(conversation.id, 'Aguardando confirmação', response.messageId);
  }

  // Handle confirmation - FINAL STEP before ride creation
  private async handleConfirmation(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;
    const lowerMessage = message.toLowerCase();

    // Check for change category request
    if (lowerMessage.includes('mudar') || lowerMessage.includes('change') || message === 'change_category') {
      await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);
      await this.showCategorySelection(conversation, context);
      return;
    }

    // Check for change origin request
    if (lowerMessage.includes('origem') || lowerMessage.includes('embarque') || lowerMessage.includes('partida')) {
      await this.updateConversation(conversation.id, ConversationState.AWAITING_ORIGIN, context);
      const response = await whatsappService.sendLocationRequest(
        phoneNumber,
        `📍 Digite o novo endereço de embarque ou compartilhe sua localização.`
      );
      await this.saveOutgoingMessage(conversation.id, 'Solicitando nova origem', response.messageId);
      return;
    }

    // Check for change destination request
    if (lowerMessage.includes('destino') || lowerMessage.includes('para onde')) {
      await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);
      const response = await whatsappService.sendLocationRequest(
        phoneNumber,
        `🎯 Digite o novo endereço de destino ou compartilhe a localização.`
      );
      await this.saveOutgoingMessage(conversation.id, 'Solicitando novo destino', response.messageId);
      return;
    }

    // Check for confirmation - ONLY CREATE RIDE AFTER EXPLICIT CONFIRMATION
    if (intent.isConfirmation || lowerMessage.includes('confirm') || lowerMessage.includes('sim') || message === 'confirm_ride') {
      logger.info(`[ConversationFlow] User confirmed ride - initiating ride creation`);
      await this.createRide(conversation, context);
      return;
    }

    // Check for cancellation
    if (intent.isCancellation || message === 'cancel_ride' || lowerMessage.includes('cancelar')) {
      await this.handleCancellation(conversation, context);
      return;
    }

    // User sent something else - show options again (only price, no km/ETA)
    const categoryDisplayName = PRICING_RULES[context.category as string]?.displayName || 'Carro Pequeno';
    const response = await whatsappService.sendButtonMessage(
      phoneNumber,
      `📍 ${context.origin?.address}\n🎯 ${context.destination?.address}\n\n🚗 ${categoryDisplayName}\n💰 R$ ${context.estimatedPrice?.toFixed(2) || '0.00'}`,
      [
        { id: 'confirm_ride', title: 'Confirmar' },
        { id: 'change_category', title: 'Alterar' },
        { id: 'cancel_ride', title: 'Cancelar' },
      ]
    );
    await this.saveOutgoingMessage(conversation.id, 'Aguardando confirmação', response.messageId);
  }

  // Create ride in Machine Global
  // IMPORTANT: This function handles ride creation with proper error handling
  // Errors should show human-friendly messages, not technical errors
  private async createRide(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // PRICING VALIDATION: Final check before creating ride
    // Block if pricing data is missing or invalid
    if (!context.estimatedPrice || context.estimatedPrice <= 0) {
      logger.error('Pricing validation failed: No valid price before ride creation');

      const errorMsg = await whatsappService.sendButtonMessage(
        phoneNumber,
        'Não foi possível calcular o preço da corrida. Por favor, tente novamente.',
        [
          { id: 'retry_ride', title: 'Tentar novamente' },
          { id: 'cancel_ride', title: 'Cancelar' },
        ]
      );
      await this.saveOutgoingMessage(conversation.id, 'Erro: preço inválido', errorMsg.messageId);

      // Go back to category selection to recalculate
      await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);
      return;
    }

    if (!context.origin?.address || !context.destination?.address) {
      logger.error('Validation failed: Missing origin or destination');

      const errorMsg = await whatsappService.sendButtonMessage(
        phoneNumber,
        'Faltam informações sobre o endereço. Por favor, comece novamente.',
        [
          { id: 'start_over', title: 'Começar de novo' },
        ]
      );
      await this.saveOutgoingMessage(conversation.id, 'Erro: endereço faltando', errorMsg.messageId);

      await this.updateConversation(conversation.id, ConversationState.GREETING, {});
      return;
    }

    // Update state
    await this.updateConversation(conversation.id, ConversationState.CREATING_RIDE, context);

    // Send "creating ride" message
    const waitingMsg = await whatsappService.sendTextMessage(
      phoneNumber,
      'Buscando motoristas disponíveis...'
    );
    await this.saveOutgoingMessage(conversation.id, 'Buscando motoristas', waitingMsg.messageId);

    try {
      logger.info(`[ConversationFlow] Calling Machine Global createRide API`);

      // Create ride in Machine Global
      const rideResult = await machineGlobalService.createRide({
        origem: {
          endereco: context.origin?.address || '',
          latitude: context.origin?.latitude,
          longitude: context.origin?.longitude,
        },
        destino: {
          endereco: context.destination?.address || '',
          latitude: context.destination?.latitude,
          longitude: context.destination?.longitude,
        },
        passageiro: {
          nome: conversation.customer.name || 'Cliente WhatsApp',
          telefone: phoneNumber,
        },
        categoria: mapCategoryToApi(context.category),
        formaPagamento: 'D', // Default to cash
      });

      // Create ride record in our database (always create local record for tracking)
      const ride = await prisma.ride.create({
        data: {
          conversationId: conversation.id,
          customerId: conversation.customer.id,
          machineRideId: rideResult.corrida?.id,
          originAddress: context.origin?.address || '',
          originLatitude: context.origin?.latitude,
          originLongitude: context.origin?.longitude,
          destinationAddress: context.destination?.address || '',
          destinationLatitude: context.destination?.latitude,
          destinationLongitude: context.destination?.longitude,
          category: context.category || VehicleCategory.CARRO_PEQUENO,
          paymentMethod: PaymentMethod.DINHEIRO,
          estimatedPrice: context.estimatedPrice,
          estimatedDistance: context.estimatedDistance,
          estimatedDuration: context.estimatedDuration,
          status: rideResult.success ? RideStatus.DISTRIBUTING : RideStatus.FAILED,
        },
      });

      // Log event
      await prisma.rideEvent.create({
        data: {
          rideId: ride.id,
          eventType: rideResult.success ? 'INFO' : 'ERROR',
          title: rideResult.success ? 'Corrida criada' : 'Falha ao criar corrida',
          description: rideResult.success
            ? `Corrida criada via WhatsApp. Machine ID: ${rideResult.corrida?.id || 'N/A'}`
            : `Erro: ${rideResult.errors?.join(', ') || 'Erro desconhecido'}`,
        },
      });

      if (rideResult.success) {
        await this.updateConversation(conversation.id, ConversationState.RIDE_CREATED, context);

        const categoryDisplayName = PRICING_RULES[context.category as string]?.displayName || 'Carro Pequeno';
        const confirmMsg = await whatsappService.sendTextMessage(
          phoneNumber,
          `Corrida confirmada!\n\n🚗 ${categoryDisplayName}\n💰 R$ ${context.estimatedPrice.toFixed(2)}\n\nEstamos procurando um motorista para você.\n\nCódigo: ${ride.id.slice(0, 8).toUpperCase()}`
        );
        await this.saveOutgoingMessage(conversation.id, 'Corrida confirmada', confirmMsg.messageId);
      } else {
        // Machine Global failed - show human-friendly error
        logger.error('Machine Global createRide failed:', rideResult.errors);

        await this.updateConversation(conversation.id, ConversationState.ERROR, context);

        // Human-friendly error message (not technical)
        const errorMsg = await whatsappService.sendButtonMessage(
          phoneNumber,
          'Não conseguimos encontrar motoristas disponíveis no momento. Por favor, tente novamente em alguns minutos.',
          [
            { id: 'retry_ride', title: 'Tentar novamente' },
            { id: 'cancel_ride', title: 'Cancelar' },
          ]
        );
        await this.saveOutgoingMessage(conversation.id, 'Erro ao criar corrida', errorMsg.messageId);
      }
    } catch (error: any) {
      // Unexpected error - log it but show human-friendly message
      logger.error('Unexpected error creating ride:', error);

      await this.updateConversation(conversation.id, ConversationState.ERROR, context);

      // Human-friendly error message (never show technical details)
      const errorMsg = await whatsappService.sendButtonMessage(
        phoneNumber,
        'Ocorreu um problema ao solicitar sua corrida. Por favor, tente novamente.',
        [
          { id: 'retry_ride', title: 'Tentar novamente' },
          { id: 'cancel_ride', title: 'Cancelar' },
        ]
      );
      await this.saveOutgoingMessage(conversation.id, 'Erro inesperado', errorMsg.messageId);
    }
  }

  // Handle active ride queries
  private async handleActiveRide(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Get current ride
    const ride = await prisma.ride.findFirst({
      where: {
        conversationId: conversation.id,
        status: {
          in: [RideStatus.DISTRIBUTING, RideStatus.AWAITING_ACCEPT, RideStatus.ACCEPTED, RideStatus.DRIVER_ARRIVING, RideStatus.DRIVER_ARRIVED, RideStatus.IN_PROGRESS],
        },
      },
    });

    if (!ride) {
      // No active ride - check if flow was already started (don't restart welcome)
      if (context.flowStarted && (context.origin || context.destination)) {
        // Route detected, continue flow without welcome restart
        if (!context.origin) {
          await this.updateConversation(conversation.id, ConversationState.REQUESTING_LOCATION, context);
          const msg = await whatsappService.sendLocationRequest(
            phoneNumber,
            `📍 Compartilhe sua localização para continuar.`
          );
          await this.saveOutgoingMessage(conversation.id, 'Retomando fluxo - solicitando GPS', msg.messageId);
        } else if (!context.destination) {
          await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);
          const msg = await whatsappService.sendTextMessage(
            phoneNumber,
            `🎯 Para onde você quer ir?`
          );
          await this.saveOutgoingMessage(conversation.id, 'Retomando fluxo - solicitando destino', msg.messageId);
        } else {
          await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);
          await this.showCategorySelection(conversation, context);
        }
        return;
      }

      // Fresh start
      await this.updateConversation(conversation.id, ConversationState.GREETING, {});
      await this.handleGreeting(conversation, message, intent, {});
      return;
    }

    // Check for cancellation request
    if (intent.isCancellation) {
      await whatsappService.sendButtonMessage(
        phoneNumber,
        'Tem certeza que deseja cancelar a corrida?',
        [
          { id: 'confirm_cancel', title: 'Sim, Cancelar' },
          { id: 'keep_ride', title: 'Não, Manter' },
        ]
      );
      return;
    }

    // Provide status update
    const statusMessages: Record<string, string> = {
      DISTRIBUTING: 'Estamos procurando um motorista para você...',
      AWAITING_ACCEPT: 'Um motorista está avaliando sua solicitação...',
      ACCEPTED: ride.driverName ? `${ride.driverName} aceitou sua corrida e está a caminho!` : 'Motorista a caminho!',
      DRIVER_ARRIVING: `O motorista está chegando ao local de embarque.`,
      DRIVER_ARRIVED: `O motorista chegou! Procure por ${ride.driverVehicle || 'o veículo'} - ${ride.driverPlate || ''}`,
      IN_PROGRESS: 'Sua corrida está em andamento. Boa viagem!',
    };

    const statusMsg = statusMessages[ride.status] || 'Corrida em processamento...';
    await whatsappService.sendTextMessage(phoneNumber, statusMsg);
  }

  // Handle cancellation
  private async handleCancellation(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    _context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Find and cancel any active ride
    const ride = await prisma.ride.findFirst({
      where: {
        conversationId: conversation.id,
        status: {
          notIn: [RideStatus.COMPLETED, RideStatus.CANCELLED, RideStatus.FAILED],
        },
      },
    });

    if (ride && ride.machineRideId) {
      await machineGlobalService.cancelRide(ride.machineRideId, 'Cancelado pelo cliente via WhatsApp');

      await prisma.ride.update({
        where: { id: ride.id },
        data: {
          status: RideStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });

      await prisma.rideEvent.create({
        data: {
          rideId: ride.id,
          eventType: 'WARNING',
          title: 'Corrida cancelada',
          description: 'Cancelada pelo cliente via WhatsApp',
        },
      });
    }

    // Reset conversation
    await this.updateConversation(conversation.id, ConversationState.GREETING, {});
    conversation.isActive = false;
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { isActive: false },
    });

    const cancelMsg = openaiService.generateCancellationMessage();
    await whatsappService.sendTextMessage(phoneNumber, cancelMsg);
  }

  // Helper: Update conversation state and context
  private async updateConversation(
    conversationId: string,
    state: ConversationState,
    context: ConversationContext
  ): Promise<void> {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        state,
        context: context as any,
        updatedAt: new Date(),
      },
    });
  }

  // Helper: Save outgoing message
  private async saveOutgoingMessage(
    conversationId: string,
    content: string,
    whatsappMsgId?: string
  ): Promise<void> {
    await prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTGOING,
        content,
        messageType: MessageType.TEXT,
        whatsappMsgId,
      },
    });
  }

  // Handle Machine Global webhook (status updates)
  async handleMachineWebhook(data: {
    corrida_id: string;
    status: string;
    motorista?: {
      nome: string;
      telefone: string;
      veiculo?: string;
      placa?: string;
      avaliacao?: number;
    };
    tempo_chegada?: number;
  }): Promise<void> {
    try {
      // Find ride by Machine Global ID
      const ride = await prisma.ride.findFirst({
        where: { machineRideId: data.corrida_id },
        include: {
          conversation: {
            include: { customer: true },
          },
        },
      });

      if (!ride || !ride.conversation) {
        logger.warn(`Ride not found for Machine ID: ${data.corrida_id}`);
        return;
      }

      const newStatus = machineGlobalService.constructor.prototype.constructor.mapStatus
        ? (machineGlobalService as any).constructor.mapStatus(data.status)
        : data.status;

      // Update ride
      await prisma.ride.update({
        where: { id: ride.id },
        data: {
          status: newStatus as RideStatus,
          driverName: data.motorista?.nome,
          driverPhone: data.motorista?.telefone,
          driverVehicle: data.motorista?.veiculo,
          driverPlate: data.motorista?.placa,
          driverRating: data.motorista?.avaliacao,
          acceptedAt: data.status === 'A' ? new Date() : ride.acceptedAt,
          startedAt: data.status === 'E' ? new Date() : ride.startedAt,
          completedAt: data.status === 'F' ? new Date() : ride.completedAt,
        },
      });

      // Log event
      await prisma.rideEvent.create({
        data: {
          rideId: ride.id,
          eventType: 'INFO',
          title: `Status: ${newStatus}`,
          description: data.motorista ? `Motorista: ${data.motorista.nome}` : undefined,
          metadata: data as any,
        },
      });

      // Send WhatsApp notification based on status
      const phoneNumber = ride.conversation.customer.phoneNumber;

      switch (data.status) {
        case 'A': // Accepted
          if (data.motorista) {
            const msg = openaiService.generateDriverAssignedMessage(
              data.motorista.nome,
              data.motorista.veiculo || 'Veículo',
              data.motorista.placa || '',
              data.tempo_chegada || 10,
              data.motorista.avaliacao
            );
            await whatsappService.sendTextMessage(phoneNumber, msg);

            await this.updateConversation(ride.conversationId!, ConversationState.RIDE_IN_PROGRESS, {});
          }
          break;

        case 'N': // No driver
          const noDriverMsg = openaiService.generateNoDriverMessage();
          await whatsappService.sendButtonMessage(
            phoneNumber,
            noDriverMsg,
            [
              { id: 'retry_ride', title: 'Tentar novamente' },
              { id: 'cancel_ride', title: 'Cancelar' },
            ]
          );
          break;

        case 'F': // Completed
          await whatsappService.sendTextMessage(
            phoneNumber,
            `Corrida finalizada!\n\nValor: R$ ${ride.finalPrice?.toFixed(2) || ride.estimatedPrice?.toFixed(2) || '0.00'}\n\nObrigado por usar a Mi Chame!`
          );

          await this.updateConversation(ride.conversationId!, ConversationState.RIDE_COMPLETED, {});
          await prisma.conversation.update({
            where: { id: ride.conversationId! },
            data: { isActive: false },
          });
          break;

        case 'C': // Cancelled
          await whatsappService.sendTextMessage(
            phoneNumber,
            'Sua corrida foi cancelada. Se precisar de algo, é só me chamar!'
          );
          break;
      }
    } catch (error: any) {
      logger.error('Error handling Machine webhook:', error);
    }
  }
}

// Export singleton instance
export const conversationService = new ConversationService();
