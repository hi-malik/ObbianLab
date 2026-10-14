import { Module } from '@nestjs/common';
import { ContextGuard } from './auth/context.guard';
import { BookingController } from './bookings/booking.controller';
import { BookingService } from './bookings/booking.service';
import { TrackingGateway } from './bookings/tracking.gateway';
import { DatabaseModule } from './database';
import { HealthController } from './health/health.controller';
import { GatewayWebhookController, PaymentController, SettlementController } from './payments/payment.controller';
import { PaymentService } from './payments/payment.service';
import { PricingService } from './payments/pricing.service';
import { PricingController } from './payments/pricing.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, BookingController, PaymentController, GatewayWebhookController, SettlementController, PricingController],
  providers: [ContextGuard, BookingService, TrackingGateway, PaymentService, PricingService],
})
export class AppModule {}
