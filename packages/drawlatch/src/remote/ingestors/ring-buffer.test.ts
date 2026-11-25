/**
 * Unit tests for the RingBuffer.
 */

import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('should push and retrieve items in chronological order', () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(3);
  });

  it('should evict the oldest item when full', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.size).toBe(3);
  });

  it('should handle wrapping around the buffer multiple times', () => {
    const buf = new RingBuffer<number>(2);
    for (let i = 0; i < 10; i++) buf.push(i);
    expect(buf.toArray()).toEqual([8, 9]);
    expect(buf.size).toBe(2);
  });

  it('should return an empty array when empty', () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it('should work with capacity of 1', () => {
    const buf = new RingBuffer<string>(1);
    buf.push('a');
    expect(buf.toArray()).toEqual(['a']);
    buf.push('b');
    expect(buf.toArray()).toEqual(['b']);
    expect(buf.size).toBe(1);
  });

  it('should filter by id with since()', () => {
    const buf = new RingBuffer<{ id: number; value: string }>(5);
    buf.push({ id: 0, value: 'a' });
    buf.push({ id: 1, value: 'b' });
    buf.push({ id: 2, value: 'c' });

    const result = buf.since(0);
    expect(result).toEqual([
      { id: 1, value: 'b' },
      { id: 2, value: 'c' },
    ]);
  });

  it('should return all items when since(-1) is called', () => {
    const buf = new RingBuffer<{ id: number }>(5);
    buf.push({ id: 0 });
    buf.push({ id: 1 });
    buf.push({ id: 2 });

    const result = buf.since(-1);
    expect(result).toHaveLength(3);
  });

  it('should return empty array when since() cursor is past all items', () => {
    const buf = new RingBuffer<{ id: number }>(5);
    buf.push({ id: 0 });
    buf.push({ id: 1 });

    const result = buf.since(5);
    expect(result).toEqual([]);
  });

  it('should clear items but preserve capacity', () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);

    // Can still push after clear
    buf.push(10);
    expect(buf.toArray()).toEqual([10]);
    expect(buf.size).toBe(1);
  });

  it('should handle exactly-at-capacity correctly', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(3);
  });

  it('should handle objects with non-numeric id gracefully in since()', () => {
    const buf = new RingBuffer<{ id: string; value: number }>(3);
    buf.push({ id: 'a', value: 1 });
    buf.push({ id: 'b', value: 2 });

    // since() checks for numeric id — string ids should be filtered out
    const result = buf.since(0);
    expect(result).toEqual([]);
  });
});
