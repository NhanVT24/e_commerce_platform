import { env } from "../../config/env.js";
import { ManagedProducts } from "./application/managed-products.js";
import { managedProductReads } from "./infrastructure/persistence/managed-product-reads.js";
import { Module } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { UpdateProduct } from "./application/update-product/update-product.js";
import { DynamoProductWriteRepository } from "./infrastructure/persistence/dynamo-product-write-repository.js";
import { NotificationsInventoryAlertPublisher } from "./infrastructure/notifications/inventory-alert-publisher.js";
import { ShoppingController } from "./shopping.controller.js";
import { ShoppingService } from "./shopping.service.js";
import { IncrementProductField } from "./application/increment-product-field/increment-product-field.js";
import { CreateProduct } from "./application/create-product/create-product.js";
import { DeleteProduct } from "./application/delete-product/delete-product.js";
import { DynamoProductCounterRepository } from "./infrastructure/persistence/dynamo-product-counter-repository.js";
import { DynamoProductCreator } from "./infrastructure/persistence/dynamo-product-creator.js";
import { DynamoProductDeleter } from "./infrastructure/persistence/dynamo-product-deleter.js";

@Module({
  imports: [NotificationsModule],
  controllers: [ShoppingController],
  providers: [
    ShoppingService,
    { provide: ManagedProducts, useFactory: () => new ManagedProducts(managedProductReads) },
    {
      provide: UpdateProduct,
      inject: [NotificationsService],
      useFactory: (notifications: NotificationsService) => new UpdateProduct(
        new DynamoProductWriteRepository(),
        new NotificationsInventoryAlertPublisher(notifications), env.INVENTORY_ALERT_OUTBOX_ENABLED ? "outbox" : "direct"
      )
    },
    {
      provide: IncrementProductField,
      inject: [NotificationsService],
      useFactory: (notifications: NotificationsService) => new IncrementProductField(
        new DynamoProductCounterRepository(), new NotificationsInventoryAlertPublisher(notifications), env.INVENTORY_ALERT_OUTBOX_ENABLED ? "outbox" : "direct"
      )
    },
    {
      provide: CreateProduct,
      useFactory: () => new CreateProduct(new DynamoProductCreator(), randomUUID, () => new Date())
    },
    {
      provide: DeleteProduct,
      useFactory: () => new DeleteProduct(new DynamoProductDeleter())
    }
  ]
})
export class ShoppingModule {}
