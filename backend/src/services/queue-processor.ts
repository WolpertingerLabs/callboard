import { queueFileService } from './queue-file-service.js';

export class QueueProcessor {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private checkInterval = 30000; // Check every 30 seconds

  start() {
    if (this.intervalId) return;

    console.log('Starting queue processor...');
    this.intervalId = setInterval(() => {
      this.processQueue().catch(console.error);
    }, this.checkInterval);

    // Process immediately on start
    this.processQueue().catch(console.error);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Queue processor stopped');
    }
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const dueMessages = this.getDueMessages();

      for (const message of dueMessages) {
        await this.executeMessage(message);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private getDueMessages(): any[] {
    return queueFileService.getDueMessages(10);
  }

  private async executeMessage(queueItem: any): Promise<void> {
    const { id, chat_id, user_message } = queueItem;

    try {
      // Update status to running
      queueFileService.updateQueueItem(id, { status: 'running' });

      // Execute the message
      const response = await fetch(`http://localhost:${process.env.PORT || 8000}/api/chats/${chat_id}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // TODO: Add proper authentication for internal requests
        },
        body: JSON.stringify({ prompt: user_message })
      });

      if (response.ok) {
        // Delete the queue item when completed successfully
        queueFileService.deleteQueueItem(id);
        console.log(`Queue item ${id} executed successfully and removed from queue`);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error: any) {
      console.error(`Failed to execute queue item ${id}:`, error.message);

      // Update retry count and status
      const retryCount = queueItem.retry_count + 1;
      const maxRetries = 3;

      if (retryCount >= maxRetries) {
        queueFileService.updateQueueItem(id, {
          status: 'failed',
          error_message: error.message,
          retry_count: retryCount
        });
        console.log(`Queue item ${id} failed after ${maxRetries} attempts`);
      } else {
        // Schedule for retry (exponential backoff)
        const retryDelay = Math.pow(2, retryCount) * 60 * 1000; // 2^n minutes
        const retryTime = new Date(Date.now() + retryDelay).toISOString();

        queueFileService.updateQueueItem(id, {
          status: 'pending',
          error_message: error.message,
          retry_count: retryCount,
          scheduled_time: retryTime
        });
        console.log(`Queue item ${id} scheduled for retry in ${retryDelay / 60000} minutes`);
      }
    }
  }
}

// Global instance
export const queueProcessor = new QueueProcessor();