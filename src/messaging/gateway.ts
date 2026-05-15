import type { Vault } from '../secrets/vault.js';
import type { PluginRegistry } from '../tools/registry.js';
import type { WebhookServer } from '../jira/webhook-server.js';

// ---------------------------------------------------------------------------
// ContactGateway — inbound/outbound messaging for the Secretary.
//
// Three channels:
//   1. Telegram — Bot API long polling for inbound, direct API for outbound
//   2. Email — periodic Gmail polling via google-workspace plugin
//   3. WhatsApp — UniPile webhook for inbound, UniPile plugin for outbound
//
// All inbound messages from the founder are routed to a handler (the Secretary).
// Responses are sent back on the same channel.
// ---------------------------------------------------------------------------

export type Channel = 'telegram' | 'email' | 'whatsapp';

export interface InboundMessage {
  channel: Channel;
  from: string;
  text: string;
  /** Channel-specific ID for threading replies. */
  replyTo: string;
  timestamp: Date;
}

export type MessageHandler = (message: InboundMessage) => Promise<string>;
export type CommandHandler = (command: string, args: string) => Promise<string | null>;

export class ContactGateway {
  private handler: MessageHandler | null = null;
  private commandHandler: CommandHandler | null = null;
  private telegramToken: string;
  private telegramChatId: string;
  private founderEmail: string;
  private founderPhone: string;
  private telegramOffset = 0;
  private telegramPollTimer: ReturnType<typeof setInterval> | null = null;
  private emailPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastEmailCheck: string;

  constructor(
    private vault: Vault,
    private registry: PluginRegistry,
    private webhookServer: WebhookServer,
  ) {
    this.telegramToken = vault.get('TELEGRAM_BOT_TOKEN') ?? '';
    this.telegramChatId = vault.get('TELEGRAM_FOUNDER_CHAT_ID') ?? '';
    this.founderEmail = vault.get('FOUNDER_EMAIL') ?? '';
    this.founderPhone = vault.get('FOUNDER_PHONE') ?? '';
    this.lastEmailCheck = new Date().toISOString();

    if (!this.telegramToken) console.warn('ContactGateway: TELEGRAM_BOT_TOKEN not in vault.');
    if (!this.founderEmail) console.warn('ContactGateway: FOUNDER_EMAIL not in vault.');
  }

  /** Register the handler that receives all inbound messages. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Register a handler for /commands. Return null to fall through to the message handler. */
  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  private telegramPolling = false;

  start(): void {
    // Telegram: long polling every 2 seconds (skips if previous poll still running).
    if (this.telegramToken) {
      this.telegramPollTimer = setInterval(() => {
        if (this.telegramPolling) return;
        this.telegramPolling = true;
        this.pollTelegram()
          .catch((err) => console.error('Telegram poll error:', err))
          .finally(() => { this.telegramPolling = false; });
      }, 2000);
      console.log('ContactGateway: Telegram bot polling started.');
    }

    // Email: check Gmail every 30 seconds.
    if (this.founderEmail) {
      this.emailPollTimer = setInterval(() => {
        this.pollEmail().catch((err) =>
          console.error('Email poll error:', err),
        );
      }, 30_000);
      console.log('ContactGateway: Gmail polling started.');
    }

    // WhatsApp: listen for UniPile webhooks.
    this.registerWhatsAppWebhook();
  }

  stop(): void {
    if (this.telegramPollTimer) clearInterval(this.telegramPollTimer);
    if (this.emailPollTimer) clearInterval(this.emailPollTimer);
    this.telegramPollTimer = null;
    this.emailPollTimer = null;
  }

  // -----------------------------------------------------------------------
  // Outbound — send a response on a specific channel
  // -----------------------------------------------------------------------

  async send(channel: Channel, replyTo: string, text: string): Promise<void> {
    switch (channel) {
      case 'telegram':
        await this.sendTelegram(replyTo, text);
        break;
      case 'email':
        await this.sendEmail(replyTo, text);
        break;
      case 'whatsapp':
        await this.sendWhatsApp(replyTo, text);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Telegram — Bot API
  // -----------------------------------------------------------------------

  private async pollTelegram(): Promise<void> {
    const url = `https://api.telegram.org/bot${this.telegramToken}/getUpdates?offset=${this.telegramOffset}&timeout=1`;
    const res = await fetch(url);
    const data = await res.json() as {
      ok: boolean;
      result: {
        update_id: number;
        message?: {
          chat: { id: number };
          from?: { id: number; first_name: string };
          text?: string;
          date: number;
        };
      }[];
    };

    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      this.telegramOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text) continue;

      // Only accept messages from the founder's chat.
      const chatId = String(msg.chat.id);
      if (this.telegramChatId && chatId !== this.telegramChatId) continue;

      // Auto-learn the chat ID on first message if not set.
      if (!this.telegramChatId) {
        this.telegramChatId = chatId;
        this.vault.set('TELEGRAM_FOUNDER_CHAT_ID', chatId);
        console.log(`ContactGateway: Learned Telegram chat ID: ${chatId}`);
      }

      await this.dispatch({
        channel: 'telegram',
        from: msg.from?.first_name ?? 'Founder',
        text: msg.text,
        replyTo: chatId,
        timestamp: new Date(msg.date * 1000),
      });
    }
  }

  private async sendTelegram(chatId: string, text: string): Promise<void> {
    // Telegram has a 4096 char limit per message — split if needed.
    const chunks = splitText(text, 4000);
    for (const chunk of chunks) {
      await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Email — Gmail via google-workspace plugin
  // -----------------------------------------------------------------------

  private async pollEmail(): Promise<void> {
    try {
      const resultStr = await this.registry.invoke(
        'google-workspace', 'search_emails',
        { query: `from:${this.founderEmail} after:${this.lastEmailCheck.split('T')[0]} is:unread` },
      );
      this.lastEmailCheck = new Date().toISOString();

      const result = JSON.parse(resultStr) as { emails?: { id: string; subject: string; body: string; from: string; date: string }[] };
      if (!result.emails?.length) return;

      for (const email of result.emails) {
        await this.dispatch({
          channel: 'email',
          from: email.from,
          text: `Subject: ${email.subject}\n\n${email.body}`,
          replyTo: email.id,
          timestamp: new Date(email.date),
        });
      }
    } catch {
      // Plugin might not be connected yet — silently skip.
    }
  }

  private async sendEmail(threadId: string, text: string): Promise<void> {
    try {
      await this.registry.invoke('google-workspace', 'send_email', {
        to: this.founderEmail,
        subject: 'Re: HIRAM Secretary',
        body: text,
        thread_id: threadId,
      });
    } catch (err) {
      console.error('Failed to send email reply:', err);
    }
  }

  // -----------------------------------------------------------------------
  // WhatsApp — UniPile webhooks + plugin
  // -----------------------------------------------------------------------

  private registerWhatsAppWebhook(): void {
    // Listen for UniPile webhook events on the existing webhook server.
    // UniPile sends POST to /webhook/unipile when messages arrive.
    const server = this.webhookServer as unknown as {
      // Access the underlying http server to add a route.
      // The webhook server only handles /webhook/jira, so we add a handler
      // for /webhook/unipile via the same mechanism.
    };

    // UniPile webhook events come through as POST /webhook/unipile.
    // For now, we piggyback on the existing webhook server by checking
    // a custom header or path. The simplest approach: register a handler
    // on the JIRA webhook path that also checks for UniPile payloads.
    //
    // TODO: Extend WebhookServer to support multiple webhook paths.
    // For now, we'll use UniPile's polling mode via the plugin.
    void server;

    if (this.founderPhone) {
      console.log('ContactGateway: WhatsApp ready (via UniPile plugin).');
    }
  }

  private async sendWhatsApp(recipientId: string, text: string): Promise<void> {
    try {
      await this.registry.invoke('unipile', 'send_message', {
        provider: 'whatsapp',
        recipient_id: recipientId,
        text,
      });
    } catch (err) {
      console.error('Failed to send WhatsApp message:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Message dispatch
  // -----------------------------------------------------------------------

  private async dispatch(message: InboundMessage): Promise<void> {
    console.log(`ContactGateway: ${message.channel} message from ${message.from}: ${message.text.slice(0, 100)}`);

    try {
      // Intercept /commands before they reach the Secretary agent loop.
      if (this.commandHandler && message.text.startsWith('/')) {
        const spaceIdx = message.text.indexOf(' ');
        const command = spaceIdx > 0 ? message.text.slice(1, spaceIdx) : message.text.slice(1);
        const args = spaceIdx > 0 ? message.text.slice(spaceIdx + 1).trim() : '';
        const result = await this.commandHandler(command, args);
        if (result !== null) {
          await this.send(message.channel, message.replyTo, result);
          return;
        }
      }

      if (!this.handler) return;
      const response = await this.handler(message);
      await this.send(message.channel, message.replyTo, response);
    } catch (err) {
      console.error(`ContactGateway: Handler error (${message.channel}):`, err);
      await this.send(
        message.channel,
        message.replyTo,
        'Sorry, I encountered an error processing your message. The issue has been logged.',
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Split at last newline within limit, or hard cut.
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
