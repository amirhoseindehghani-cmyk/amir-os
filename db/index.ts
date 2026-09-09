import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// `prepare: false` is required for Supabase's transaction-mode pooler.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
