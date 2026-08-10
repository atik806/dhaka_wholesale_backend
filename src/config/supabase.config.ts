import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _anonClient: SupabaseClient | null = null;
let _adminClient: SupabaseClient | null = null;

const REQUEST_TIMEOUT_MS = 30_000;

export function createSupabaseClient(): SupabaseClient {
  if (_anonClient) return _anonClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    const missing: string[] = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL');
    if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
    throw new Error(
      `Missing environment variables: ${missing.join(' and ')}. Set them in your .env file or Vercel project settings.`,
    );
  }

  _anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: 'public',
    },
    global: {
      fetch: (url, init) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );
        const signal = init?.signal
          ? mergeAbortSignals(init.signal, controller.signal)
          : controller.signal;
        return fetch(url, { ...init, signal }).finally(() =>
          clearTimeout(timeoutId),
        );
      },
    },
  });

  return _anonClient;
}

export function createSupabaseAdminClient(): SupabaseClient {
  // The service-role key must never reach the browser. A bundler would
  // replace `process.env.SUPABASE_SERVICE_ROLE_KEY` with the literal env
  // value at build time, embedding the key into any JS bundle that imports
  // this module. Fail loudly if client code ever tries.
  if (typeof window !== 'undefined') {
    throw new Error(
      'createSupabaseAdminClient() may only be called on the server. The SUPABASE_SERVICE_ROLE_KEY must never be bundled into client-side code.',
    );
  }
  if (_adminClient) return _adminClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    const missing: string[] = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL');
    if (!supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    throw new Error(
      `Missing environment variables: ${missing.join(' and ')}. Set them in your .env file or Vercel project settings.`,
    );
  }

  _adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: 'public',
    },
    global: {
      fetch: (url, init) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );
        const signal = init?.signal
          ? mergeAbortSignals(init.signal, controller.signal)
          : controller.signal;
        return fetch(url, { ...init, signal }).finally(() =>
          clearTimeout(timeoutId),
        );
      },
    },
  });

  return _adminClient;
}

function mergeAbortSignals(
  signal1: AbortSignal,
  signal2: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal1.addEventListener('abort', onAbort, { once: true });
  signal2.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
