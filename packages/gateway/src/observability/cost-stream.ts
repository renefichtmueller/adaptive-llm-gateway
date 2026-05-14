// Real-time cost update stream using EventEmitter
// Broadcasts cost_analytics changes to all connected dashboard clients

import { EventEmitter } from 'events';

export interface CostUpdate {
  callId: string;
  project: string;
  taskType: string;
  model: string;
  costUsd: number;
  costSavedUsd: number;
  tokensIn: number;
  tokensOut: number;
  confidence: number;
  timestamp: string;
}

class CostStream extends EventEmitter {
  private static instance: CostStream;

  private constructor() {
    super();
  }

  static getInstance(): CostStream {
    if (!CostStream.instance) {
      CostStream.instance = new CostStream();
    }
    return CostStream.instance;
  }

  /**
   * Broadcast a cost update to all connected clients
   */
  broadcast(update: CostUpdate): void {
    this.emit('cost-update', update);
  }

  /**
   * Subscribe to cost updates
   */
  subscribe(callback: (update: CostUpdate) => void): () => void {
    this.on('cost-update', callback);
    // Return unsubscribe function
    return () => this.off('cost-update', callback);
  }

  /**
   * Broadcast a summary update (for periodic dashboard refreshes)
   */
  broadcastSummary(summary: any): void {
    this.emit('summary-update', summary);
  }

  subscribeToSummary(callback: (summary: any) => void): () => void {
    this.on('summary-update', callback);
    return () => this.off('summary-update', callback);
  }
}

export const costStream = CostStream.getInstance();
