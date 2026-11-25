/**
 * Generic bounded ring buffer for event storage.
 *
 * When the buffer is full, the oldest item is evicted to make room.
 * Each pushed item receives a monotonically increasing ID that persists
 * across evictions and clears — enabling cursor-based polling.
 */

export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0; // next write position
  private count = 0; // number of items currently stored

  constructor(private readonly capacity: number) {
    this.buffer = new Array<T | undefined>(capacity);
  }

  /**
   * Push an item into the buffer.
   * If the buffer is full, the oldest item is evicted.
   */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Return all buffered items in chronological order (oldest first).
   */
  toArray(): T[] {
    if (this.count === 0) return [];

    const start = (this.head - this.count + this.capacity) % this.capacity;
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  /**
   * Return items where the `id` field is greater than `afterId`.
   * Assumes items have a numeric `id` field (enforced at the call site).
   */
  since(afterId: number): T[] {
    return this.toArray().filter((item) => {
      const id = (item as Record<string, unknown>).id;
      return typeof id === 'number' && id > afterId;
    });
  }

  /** Current number of items in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Remove all items. Does NOT reset any external ID counters. */
  clear(): void {
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
