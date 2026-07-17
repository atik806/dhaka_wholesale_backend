import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _anonClient: SupabaseClient | null = null;
let _adminClient: SupabaseClient | null = null;

const REQUEST_TIMEOUT_MS = 30_000;

export function createSupabaseClient(): SupabaseClient {
  if (_anonClient) return _anonClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_ANON_KEY must be set in environment variables',
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
  if (_adminClient) return _adminClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables',
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
