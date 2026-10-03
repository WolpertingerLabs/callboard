/** One API key as the UI sees it — every stored field except the token hash. */
export interface ApiKeyInfo {
  id: string;
  name: string;
  description: string;
  /** First characters of the token (e.g. "cbk_a1b2c3") kept for display only. */
  tokenPreview: string;
  created_at: number;
  /** Epoch ms; null means the key never expires. */
  expires_at: number | null;
  last_used_at: number | null;
}
