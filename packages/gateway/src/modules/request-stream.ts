import { EventEmitter } from 'events';

/**
 * Request event emitted whenever a completion request is processed
 */
export interface RequestEvent {
  request_id: string;
  caller: string;
  task_type?: string;
  model: string;
  status: 'approved' | 'warning' | 'pending_review' | 'rejected' | 'error';
  confidence_score?: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  fallback_used: boolean;
  error_message?: string;
  timestamp: number; // Unix epoch seconds
}

/**
 * GlobalRequestStream: Singleton EventEmitter for broadcasting request events
 * Used for SSE endpoints and real-time dashboard updates
 */
class GlobalRequestStream extends EventEmitter {
  private static instance: GlobalRequestStream;
  private maxListeners = 50;

  private constructor() {
    super();
    this.setMaxListeners(this.maxListeners);
  }

  static getInstance(): GlobalRequestStream {
    if (!GlobalRequestStream.instance) {
      GlobalRequestStream.instance = new GlobalRequestStream();
    }
    return GlobalRequestStream.instance;
  }

  /**
   * Emit a request event to all subscribers
   */
  emitRequest(event: RequestEvent): void {
    this.emit('request', event);
  }

  /**
   * Subscribe to request events (used by SSE endpoint)
   */
  onRequest(callback: (event: RequestEvent) => void): () => void {
    this.on('request', callback);
    // Return unsubscribe function
    return () => this.off('request', callback);
  }

  /**
   * Get current number of active listeners
   */
  getListenerCount(): number {
    return this.listenerCount('request');
  }
}

export const globalRequestStream = GlobalRequestStream.getInstance();
