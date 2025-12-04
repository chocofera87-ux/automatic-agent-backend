import { PrismaClient, ConversationState, Conversation, Message, MessageDirection, MessageType, Ride, RideStatus, VehicleCategory, PaymentMethod } from '@prisma/client';
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
    const phoneNumber = conversation.customer.phoneNumber;

    // Extract intent from message
    const intent = await openaiService.extractRideIntent(message, JSON.stringify(context));

    // Handle cancellation at any state
    if (intent.isCancellation && conversation.state !== ConversationState.GREETING) {
      await this.handleCancellation(conversation, context);
      return;
    }

    switch (conversation.state) {
      case ConversationState.GREETING:
        await this.handleGreeting(conversation, message, intent, context);
        break;

      case ConversationState.AWAITING_ORIGIN:
        await this.handleOriginInput(conversation, message, messageType, metadata, intent, context);
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

  // Handle greeting state
  private async handleGreeting(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;
    const greeting = await openaiService.generateGreeting(conversation.customer.name || undefined);

    // Send greeting
    const result = await whatsappService.sendTextMessage(phoneNumber, greeting);

    // Save outgoing message
    await this.saveOutgoingMessage(conversation.id, greeting, result.messageId);

    // If user already provided origin, process it
    if (intent.hasOrigin && intent.origin) {
      context.origin = { address: intent.origin.text };
      await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);

      // Ask for destination
      const destRequest = await whatsappService.sendLocationRequest(
        phoneNumber,
        `Entendi! Você está em: ${intent.origin.text}\n\nAgora, para onde você quer ir? Pode digitar o endereço ou compartilhar a localização.`
      );
      await this.saveOutgoingMessage(conversation.id, `Destino solicitado`, destRequest.messageId);
    } else {
      // Move to awaiting origin
      await this.updateConversation(conversation.id, ConversationState.AWAITING_ORIGIN, context);
    }
  }

  // Handle origin input
  private async handleOriginInput(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    messageType: string,
    metadata: any,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    if (messageType === 'location' && metadata.latitude && metadata.longitude) {
      // User shared location
      context.origin = {
        address: metadata.address || metadata.name || `${metadata.latitude}, ${metadata.longitude}`,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
      };
    } else if (intent.hasOrigin && intent.origin) {
      context.origin = { address: intent.origin.text };
    } else if (message.length > 5) {
      // Assume any message > 5 chars is an address
      context.origin = { address: message };
    } else {
      // Ask again for origin
      const response = await whatsappService.sendLocationRequest(
        phoneNumber,
        'Por favor, me diga de onde você quer sair. Pode digitar o endereço ou compartilhar sua localização.'
      );
      await this.saveOutgoingMessage(conversation.id, 'Origem solicitada', response.messageId);
      return;
    }

    // Update state and ask for destination
    await this.updateConversation(conversation.id, ConversationState.AWAITING_DESTINATION, context);

    const response = await whatsappService.sendLocationRequest(
      phoneNumber,
      `Origem: ${context.origin.address}\n\nAgora, para onde você quer ir?`
    );
    await this.saveOutgoingMessage(conversation.id, `Destino solicitado. Origem: ${context.origin.address}`, response.messageId);
  }

  // Handle destination input
  private async handleDestinationInput(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    messageType: string,
    metadata: any,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    if (messageType === 'location' && metadata.latitude && metadata.longitude) {
      context.destination = {
        address: metadata.address || metadata.name || `${metadata.latitude}, ${metadata.longitude}`,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
      };
    } else if (intent.hasDestination && intent.destination) {
      context.destination = { address: intent.destination.text };
    } else if (message.length > 5) {
      context.destination = { address: message };
    } else {
      const response = await whatsappService.sendLocationRequest(
        phoneNumber,
        'Por favor, me diga para onde você quer ir. Pode digitar o endereço ou compartilhar a localização.'
      );
      await this.saveOutgoingMessage(conversation.id, 'Destino solicitado', response.messageId);
      return;
    }

    // Update state and show category selection
    await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);

    const response = await whatsappService.sendListMessage(
      phoneNumber,
      `De: ${context.origin?.address}\nPara: ${context.destination.address}\n\nEscolha a categoria do veículo:`,
      'Escolher',
      [
        {
          title: 'Categorias',
          rows: [
            { id: 'cat_carro', title: 'Carro', description: 'Veículo padrão' },
            { id: 'cat_moto', title: 'Moto', description: 'Mototáxi - mais rápido' },
            { id: 'cat_premium', title: 'Premium', description: 'Veículo executivo' },
            { id: 'cat_corporativo', title: 'Corporativo', description: 'Para empresas' },
          ],
        },
      ],
      'Mi Chame',
      'Selecione a melhor opção para você'
    );
    await this.saveOutgoingMessage(conversation.id, 'Categorias oferecidas', response.messageId);
  }

  // Handle category selection
  private async handleCategorySelection(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Determine category from message
    const lowerMessage = message.toLowerCase();
    let category: VehicleCategory = VehicleCategory.CARRO;

    if (lowerMessage.includes('moto')) {
      category = VehicleCategory.MOTO;
    } else if (lowerMessage.includes('premium') || lowerMessage.includes('executivo')) {
      category = VehicleCategory.PREMIUM;
    } else if (lowerMessage.includes('corporativo') || lowerMessage.includes('empresa')) {
      category = VehicleCategory.CORPORATIVO;
    } else if (intent.category) {
      category = intent.category.toUpperCase() as VehicleCategory;
    }

    context.category = category;

    // Get price quote from Machine Global
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
      categoria: category,
    });

    if (quote.success && quote.cotacao) {
      context.estimatedPrice = quote.cotacao.valorEstimado;
      context.estimatedDistance = quote.cotacao.distanciaKm;
      context.estimatedDuration = quote.cotacao.tempoEstimado;
    } else {
      // Use estimated values if API fails
      context.estimatedPrice = 25.0;
      context.estimatedDistance = 10.0;
      context.estimatedDuration = 15;
    }

    // Update state to showing price
    await this.updateConversation(conversation.id, ConversationState.AWAITING_CONFIRMATION, context);

    // Send price confirmation with buttons
    const priceMessage = openaiService.generatePriceMessage(
      context.origin?.address || '',
      context.destination?.address || '',
      context.estimatedPrice,
      context.estimatedDistance,
      context.estimatedDuration,
      category
    );

    const response = await whatsappService.sendButtonMessage(
      phoneNumber,
      priceMessage,
      [
        { id: 'confirm_ride', title: 'Confirmar' },
        { id: 'change_category', title: 'Mudar Categoria' },
        { id: 'cancel_ride', title: 'Cancelar' },
      ]
    );
    await this.saveOutgoingMessage(conversation.id, priceMessage, response.messageId);
  }

  // Handle confirmation
  private async handleConfirmation(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    message: string,
    intent: any,
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;
    const lowerMessage = message.toLowerCase();

    // Check for change category request
    if (lowerMessage.includes('mudar') || lowerMessage.includes('change')) {
      await this.updateConversation(conversation.id, ConversationState.AWAITING_CATEGORY, context);
      const response = await whatsappService.sendListMessage(
        phoneNumber,
        'Escolha a nova categoria:',
        'Escolher',
        [
          {
            title: 'Categorias',
            rows: [
              { id: 'cat_carro', title: 'Carro', description: 'Veículo padrão' },
              { id: 'cat_moto', title: 'Moto', description: 'Mototáxi' },
              { id: 'cat_premium', title: 'Premium', description: 'Executivo' },
              { id: 'cat_corporativo', title: 'Corporativo', description: 'Empresas' },
            ],
          },
        ]
      );
      await this.saveOutgoingMessage(conversation.id, 'Categorias oferecidas', response.messageId);
      return;
    }

    // Check for confirmation
    if (intent.isConfirmation || lowerMessage.includes('confirm') || message === 'confirm_ride') {
      await this.createRide(conversation, context);
      return;
    }

    // Check for cancellation
    if (intent.isCancellation || message === 'cancel_ride') {
      await this.handleCancellation(conversation, context);
      return;
    }

    // Ask again
    const response = await whatsappService.sendButtonMessage(
      phoneNumber,
      'Deseja confirmar a corrida?',
      [
        { id: 'confirm_ride', title: 'Sim, Confirmar' },
        { id: 'cancel_ride', title: 'Cancelar' },
      ]
    );
    await this.saveOutgoingMessage(conversation.id, 'Aguardando confirmação', response.messageId);
  }

  // Create ride in Machine Global
  private async createRide(
    conversation: Conversation & { customer: { id: string; phoneNumber: string; name: string | null } },
    context: ConversationContext
  ): Promise<void> {
    const phoneNumber = conversation.customer.phoneNumber;

    // Update state
    await this.updateConversation(conversation.id, ConversationState.CREATING_RIDE, context);

    // Send "creating ride" message
    const waitingMsg = await whatsappService.sendTextMessage(
      phoneNumber,
      'Buscando motoristas disponíveis...'
    );
    await this.saveOutgoingMessage(conversation.id, 'Buscando motoristas', waitingMsg.messageId);

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
      categoria: context.category || 'Carro',
      formaPagamento: 'D', // Default to cash
    });

    // Create ride record in our database
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
        category: context.category || VehicleCategory.CARRO,
        paymentMethod: PaymentMethod.DINHEIRO,
        estimatedPrice: context.estimatedPrice,
        estimatedDistance: context.estimatedDistance,
        estimatedDuration: context.estimatedDuration,
        status: RideStatus.DISTRIBUTING,
      },
    });

    // Log event
    await prisma.rideEvent.create({
      data: {
        rideId: ride.id,
        eventType: 'INFO',
        title: 'Corrida criada',
        description: `Corrida criada via WhatsApp. Machine ID: ${rideResult.corrida?.id || 'N/A'}`,
      },
    });

    if (rideResult.success) {
      await this.updateConversation(conversation.id, ConversationState.RIDE_CREATED, context);

      const confirmMsg = await whatsappService.sendTextMessage(
        phoneNumber,
        `Corrida confirmada!\n\nEstamos procurando um motorista para você. Você receberá uma notificação assim que um motorista aceitar.\n\nCódigo: ${ride.id.slice(0, 8).toUpperCase()}`
      );
      await this.saveOutgoingMessage(conversation.id, 'Corrida confirmada', confirmMsg.messageId);
    } else {
      await this.updateConversation(conversation.id, ConversationState.ERROR, context);

      const errorMsg = await whatsappService.sendButtonMessage(
        phoneNumber,
        'Desculpe, não foi possível criar a corrida no momento. Deseja tentar novamente?',
        [
          { id: 'retry_ride', title: 'Tentar novamente' },
          { id: 'cancel_ride', title: 'Cancelar' },
        ]
      );
      await this.saveOutgoingMessage(conversation.id, 'Erro ao criar corrida', errorMsg.messageId);
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
      // No active ride, restart conversation
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
    context: ConversationContext
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
