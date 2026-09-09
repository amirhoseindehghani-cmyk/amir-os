import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const plannerState = pgTable('planner_state', {
  userId: text('user_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull().default(5),
  document: text('document').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const plannerEvents = pgTable('planner_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
});

export const plannerSnapshots = pgTable('planner_snapshots', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  date: text('date').notNull(),
  document: text('document').notNull(),
  createdAt: text('created_at').notNull(),
});
