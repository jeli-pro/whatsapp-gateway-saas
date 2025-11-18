import { pgTable, serial, text, varchar, timestamp, integer, uniqueIndex, pgEnum, unique, customType } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const nodes = pgTable('nodes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 256 }).notNull().unique(),
  dockerHost: text('docker_host').notNull(), // e.g., 'tcp://1.2.3.4:2375'
  publicHost: text('public_host').notNull(), // e.g., 'vps1.example.com'
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 256 }).notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const providerEnum = pgEnum('provider', ['whatsmeow', 'baileys', 'wawebjs', 'waba']);
export const instanceStatusEnum = pgEnum('status', ['creating', 'starting', 'running', 'stopped', 'error', 'migrating']);

export const instances = pgTable('instances', {
    id: serial('id').primaryKey(),
    nodeId: integer('node_id').notNull().references(() => nodes.id, { onDelete: 'restrict' }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 256 }),
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

const bytea = customType<{ data: Buffer }>({ getSQL: () => 'bytea' });

export const instanceState = pgTable('instance_state', {
    id: serial('id').primaryKey(),
    instanceId: integer('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: bytea('value').notNull(),
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
  node: one(nodes, {
    fields: [instances.nodeId],
    references: [nodes.id],
  }),
  state: many(instanceState),
}));

export const instanceStateRelations = relations(instanceState, ({ one }) => ({
    instance: one(instances, {
        fields: [instanceState.instanceId],
        references: [instances.id],
    }),
}));

export const nodeRelations = relations(nodes, ({ many }) => ({
    instances: many(instances),
}));