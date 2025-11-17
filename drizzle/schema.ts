import { pgTable, serial, text, varchar, timestamp, integer, uniqueIndex, pgEnum, unique } from 'drizzle-orm/pg-core';
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
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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

export const instanceState = pgTable('instance_state', {
    id: serial('id').primaryKey(),
    instanceId: integer('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: text('value').notNull(),
}, (table) => {
    return {
        instanceKeyIdx: unique('instance_key_idx').on(table.instanceId, table.key),
    };
});

export const userRelations = relations(users, ({ many }) => ({
  instances: many(instances),
}));

export const instanceRelations = relations(instances, ({ one, many }) => ({
  user: one(users, {
    fields: [instances.userId],
    references: [users.id],
  }),
  state: many(instanceState),
}));

export const instanceStateRelations = relations(instanceState, ({ one }) => ({
    instance: one(instances, {
        fields: [instanceState.instanceId],
        references: [instances.id],
    }),
}));