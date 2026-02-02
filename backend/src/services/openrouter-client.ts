/**
 * OpenRouter client service for AI-powered chat title generation
 */

import { OpenRouter } from '@openrouter/sdk';
import type { ChatTitleContext, GenerationResult } from '../types/openrouter.js';

export class OpenRouterClient {
	private client: OpenRouter | null = null;

	constructor(apiKey: string | null) {
		if (apiKey && apiKey.trim()) {
			try {
				this.client = new OpenRouter({
					apiKey: apiKey.trim()
				});
			} catch (error) {
				console.error('[OpenRouter] Failed to initialize client:', error);
				this.client = null;
			}
		}
	}

	/**
	 * Check if the client is initialized and ready to use
	 */
	isReady(): boolean {
		return this.client !== null;
	}

	/**
	 * Generate a chat title based on the initial user message
	 */
	async generateChatTitle(context: ChatTitleContext): Promise<GenerationResult> {
		if (!this.isReady()) {
			return {
				success: false,
				error: 'OpenRouter client not initialized'
			};
		}

		try {
			const prompt = this.buildChatTitlePrompt(context);

			const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';

			const result = await this.client!.chat.send({
				messages: [
					{
						role: 'user',
						content: prompt
					}
				],
				model,
				stream: false
			});

			// Extract text from response
			const content = result.choices?.[0]?.message?.content;
			if (!content) {
				return {
					success: false,
					error: 'No content in OpenRouter response'
				};
			}

			// Convert content to string if it's an array
			const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

			// Clean up the response (remove quotes, trim)
			let chatTitle = contentStr.trim();
			chatTitle = chatTitle.replace(/^["']|["']$/g, '');
			chatTitle = chatTitle.split('\n')[0]; // Take only first line

			// Limit title length
			if (chatTitle.length > 80) {
				chatTitle = chatTitle.substring(0, 77) + '...';
			}

			return {
				success: true,
				content: chatTitle
			};
		} catch (error) {
			console.error('[OpenRouter] Failed to generate chat title:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	private buildChatTitlePrompt(context: ChatTitleContext): string {
		const { userMessage, projectName } = context;

		return `Generate a concise, descriptive title for a chat conversation based on this initial user message:

"${userMessage}"

${projectName ? `Project context: ${projectName}` : ''}

Requirements:
- Keep it under 80 characters
- Make it specific and descriptive
- Focus on the main topic or request
- Don't use quotes in the response
- Use title case

Example: "Fix Authentication Bug in Login Component"

Title:`;
	}
}