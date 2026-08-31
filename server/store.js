// store.js — picks the backend. Everything else imports getStore() from here.
import { JsonStore } from './store-json.js';
import { PgStore } from './store-pg.js';

let singleton = null;

export async function getStore() {
  if (singleton) return singleton;
  if (process.env.DATABASE_URL) {
    console.log('Storage: Postgres');
    singleton = await new PgStore().init();
  } else {
    console.log('Storage: JSON file (no DATABASE_URL — dev/ephemeral)');
    singleton = await new JsonStore().init();
  }
  return singleton;
}
