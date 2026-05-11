import { Client } from "pg";

import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import type { FeatureFlagsPayload } from "@/app/lib/feature-flags-config";
import { requireRuntimeEnv } from "@/app/lib/runtime-env";

const FEATURE_STATE_CHANNEL = "ps_feature_state_changed";
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type FeatureFlagsSubscriber = (payload: FeatureFlagsPayload) => void;
type SubscribeOverride = (subscriber: FeatureFlagsSubscriber) => Promise<() => void>;

type BroadcasterState = {
  client: Client | null;
  startPromise: Promise<void> | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  subscribers: Set<FeatureFlagsSubscriber>;
  broadcastPromise: Promise<void> | null;
  broadcastQueued: boolean;
  connectionString: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var _featureFlagsBroadcaster: BroadcasterState | undefined;
}

let subscribeOverride: SubscribeOverride | null = null;

function reportBackgroundFailure(context: string, error: unknown) {
  console.error(`Feature flag stream ${context} failed`, error);
}

function getBroadcasterState(): BroadcasterState {
  if (!global._featureFlagsBroadcaster) {
    global._featureFlagsBroadcaster = {
      client: null,
      startPromise: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      subscribers: new Set<FeatureFlagsSubscriber>(),
      broadcastPromise: null,
      broadcastQueued: false,
      connectionString: null,
    };
  }

  return global._featureFlagsBroadcaster;
}

function clearReconnectTimer(state: BroadcasterState) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

async function disconnectListener(state: BroadcasterState) {
  clearReconnectTimer(state);
  const client = state.client;
  state.client = null;
  if (!client) {
    return;
  }

  client.removeAllListeners();
  try {
    await client.end();
  } catch {
    // Ignore shutdown errors during reconnect or test cleanup.
  }
}

function scheduleReconnect(state: BroadcasterState) {
  if (state.reconnectTimer) {
    return;
  }

  const delayMs = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** state.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void startListener(state).catch((error) => {
      reportBackgroundFailure("reconnect", error);
    });
  }, delayMs);
}

async function broadcastLatestPayload(state: BroadcasterState) {
  if (state.broadcastPromise) {
    state.broadcastQueued = true;
    return state.broadcastPromise;
  }

  state.broadcastPromise = (async () => {
    do {
      state.broadcastQueued = false;
      const payload = await getFeatureFlagsPayload();
      for (const subscriber of [...state.subscribers]) {
        subscriber(payload);
      }
    } while (state.broadcastQueued);
  })().finally(() => {
    state.broadcastPromise = null;
  });

  return state.broadcastPromise;
}

async function connectListener(state: BroadcasterState) {
  const connectionString = await requireRuntimeEnv("DATABASE_URL");

  await disconnectListener(state);

  const client = new Client({ connectionString });
  state.client = client;
  state.connectionString = connectionString;

  client.on("notification", (message) => {
    if (message.channel !== FEATURE_STATE_CHANNEL) {
      return;
    }
    void broadcastLatestPayload(state).catch((error) => {
      reportBackgroundFailure("broadcast", error);
    });
  });

  client.on("error", () => {
    void disconnectListener(state).finally(() => {
      scheduleReconnect(state);
    });
  });

  client.on("end", () => {
    void disconnectListener(state).finally(() => {
      scheduleReconnect(state);
    });
  });

  await client.connect();
  await client.query(`LISTEN ${FEATURE_STATE_CHANNEL}`);
  state.reconnectAttempt = 0;
}

async function startListener(state: BroadcasterState) {
  if (state.startPromise) {
    return state.startPromise;
  }

  state.startPromise = connectListener(state)
    .catch((error) => {
      scheduleReconnect(state);
      throw error;
    })
    .finally(() => {
      state.startPromise = null;
    });

  return state.startPromise;
}

export async function subscribeToFeatureFlagUpdates(subscriber: FeatureFlagsSubscriber): Promise<() => void> {
  if (subscribeOverride) {
    return subscribeOverride(subscriber);
  }

  const state = getBroadcasterState();
  state.subscribers.add(subscriber);

  try {
    await startListener(state);
  } catch (error) {
    state.subscribers.delete(subscriber);
    throw error;
  }

  return () => {
    state.subscribers.delete(subscriber);
  };
}

export function setFeatureFlagSubscriptionForTests(override: SubscribeOverride | null) {
  subscribeOverride = override;
}

export async function resetFeatureFlagStreamForTests() {
  subscribeOverride = null;

  const state = getBroadcasterState();
  state.subscribers.clear();
  state.broadcastQueued = false;
  state.broadcastPromise = null;
  state.startPromise = null;
  state.reconnectAttempt = 0;

  await disconnectListener(state);
}
