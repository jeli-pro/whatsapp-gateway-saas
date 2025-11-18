import { createApp } from './app';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../drizzle/schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

// Create the app with the database connection
const app = createApp(db);

// Start the server only if this file is the main module
if (import.meta.main) {
    app.listen(3000);
    console.log(
      `🦊 Gateway is running at ${app.server?.hostname}:${app.server?.port}`
    );
}