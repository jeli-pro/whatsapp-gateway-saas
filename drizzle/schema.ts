import { pgTable, serial, text, varchar, timestamp, integer, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 256 }).notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const providerEnum = pgEnum('provider', ['whatsmeow', 'baileys', 'wawebjs', 'waba']);
export const instanceStatusEnum = pgEnum('status', ['creating', 'starting', 'running', 'stopped', 'error']);

export const instances = pgTable('instances', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    phoneNumber: varchar('phone_number', { length: 20 }).notNull(),
    provider: providerEnum('provider').notNull(),
    webhookUrl: text('webhook_url'),
    status: instanceStatusEnum('status').default('creating').notNull(),
    cpuLimit: varchar('cpu_limit', { length: 10 }).default('0.5'), // e.g., "0.5"
    memoryLimit: varchar('memory_limit', { length: 10 }).default('512m'), // e.g., "512m"
    createdAt: timestamp('created_at').defaultNow().notNull(),
  }, (table) => {
    return {
      userPhoneIdx: uniqueIndex('user_phone_idx').on(table.userId, table.phoneNumber),
    };
});

export const userRelations = relations(users, ({ many }) => ({
  instances: many(instances),
}));

export const instanceRelations = relations(instances, ({ one }) => ({
  user: one(users, {
    fields: [instances.userId],
    references: [users.id],
  }),
}));