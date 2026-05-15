// ---------------------------------------------------------------------------
// Google Workspace MCP Server — Gmail, Calendar, Drive, Docs.
//
// Auth: Service account with domain-wide delegation.
// Reads GOOGLE_SERVICE_ACCOUNT_KEY (JSON string) and GOOGLE_IMPERSONATE_EMAIL
// from environment variables. Set via vault before plugin start.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { google } from 'googleapis';

const KEY_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_EMAIL || '';

let creds: { client_email?: string; private_key?: string };
try { creds = JSON.parse(KEY_JSON); } catch { creds = {}; }

const auth = new google.auth.JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
  subject: IMPERSONATE,
});

const gmail = google.gmail({ version: 'v1', auth });
const sheets = google.sheets({ version: 'v4', auth });
const calendar = google.calendar({ version: 'v3', auth });
const drive = google.drive({ version: 'v3', auth });
const docs = google.docs({ version: 'v1', auth });

const server = new McpServer({ name: 'google-workspace', version: '1.0.0' });

// ==========================================================================
// Gmail
// ==========================================================================

server.tool(
  'send_email',
  'Send an email from the founder\'s Gmail account.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC email address'),
  },
  async ({ to, subject, body, cc }) => {
    // RFC 2047: encode Subject as =?UTF-8?B?...?= so non-ASCII chars (emoji, dashes) survive.
    const encodedSubject = /[^\x20-\x7E]/.test(subject)
      ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
      : subject;
    const headers = [
      'MIME-Version: 1.0',
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      `Subject: ${encodedSubject}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ].filter(Boolean).join('\r\n');
    const encodedBody = Buffer.from(body, 'utf-8').toString('base64');
    const raw = Buffer.from(`${headers}\r\n\r\n${encodedBody}`).toString('base64url');
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, messageId: res.data.id }) }] };
  },
);

server.tool(
  'search_emails',
  'Search Gmail messages using Gmail search syntax (e.g. "from:john subject:invoice").',
  {
    query: z.string().describe('Gmail search query'),
    maxResults: z.number().optional().describe('Max results (default 10)'),
  },
  async ({ query, maxResults }) => {
    const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: maxResults ?? 10 });
    const messages = res.data.messages ?? [];
    // Fetch headers for each message.
    const details = await Promise.all(
      messages.slice(0, 10).map(async (m) => {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
        const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name, h.value]));
        return { id: m.id, from: headers.From, subject: headers.Subject, date: headers.Date, snippet: msg.data.snippet };
      }),
    );
    return { content: [{ type: 'text', text: JSON.stringify({ count: messages.length, messages: details }) }] };
  },
);

server.tool(
  'get_email',
  'Read the full content of a Gmail message by ID.',
  {
    messageId: z.string().describe('Gmail message ID'),
  },
  async ({ messageId }) => {
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name, h.value]));
    // Extract body text.
    let body = '';
    const parts = msg.data.payload?.parts ?? [msg.data.payload];
    for (const part of parts) {
      if (part?.mimeType === 'text/plain' && part.body?.data) {
        body += Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ id: messageId, from: headers.From, to: headers.To, subject: headers.Subject, date: headers.Date, body }) }] };
  },
);

server.tool(
  'create_draft',
  'Create a Gmail draft (does not send).',
  {
    to: z.string().describe('Recipient email'),
    subject: z.string().describe('Subject'),
    body: z.string().describe('Body text'),
  },
  async ({ to, subject, body }) => {
    const encodedSubject = /[^\x20-\x7E]/.test(subject)
      ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
      : subject;
    const encodedBody = Buffer.from(body, 'utf-8').toString('base64');
    const raw = Buffer.from(`MIME-Version: 1.0\r\nTo: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}`).toString('base64url');
    const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, draftId: res.data.id }) }] };
  },
);

// ==========================================================================
// Calendar
// ==========================================================================

server.tool(
  'list_events',
  'List upcoming calendar events.',
  {
    timeMin: z.string().optional().describe('Start time (ISO 8601, default: now)'),
    timeMax: z.string().optional().describe('End time (ISO 8601, default: 7 days from now)'),
    maxResults: z.number().optional().describe('Max results (default 10)'),
  },
  async ({ timeMin, timeMax, maxResults }) => {
    const now = new Date();
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin ?? now.toISOString(),
      timeMax: timeMax ?? new Date(now.getTime() + 7 * 86400000).toISOString(),
      maxResults: maxResults ?? 10,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = (res.data.items ?? []).map(e => ({
      id: e.id, summary: e.summary, start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date, attendees: e.attendees?.map(a => a.email),
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ count: events.length, events }) }] };
  },
);

server.tool(
  'create_event',
  'Create a calendar event.',
  {
    summary: z.string().describe('Event title'),
    startTime: z.string().describe('Start time (ISO 8601)'),
    endTime: z.string().describe('End time (ISO 8601)'),
    description: z.string().optional().describe('Event description'),
    attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
  },
  async ({ summary, startTime, endTime, description, attendees }) => {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: startTime },
        end: { dateTime: endTime },
        attendees: attendees?.map(email => ({ email })),
      },
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, eventId: res.data.id, link: res.data.htmlLink }) }] };
  },
);

// ==========================================================================
// Drive
// ==========================================================================

server.tool(
  'list_files',
  'List or search files in Google Drive.',
  {
    query: z.string().optional().describe('Drive search query (e.g. "name contains \'report\'" or "mimeType=\'application/pdf\'")'),
    maxResults: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ query, maxResults }) => {
    const res = await drive.files.list({
      q: query ?? 'trashed=false',
      spaces: 'drive',
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      pageSize: maxResults ?? 20,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ count: res.data.files?.length ?? 0, files: res.data.files }) }] };
  },
);

server.tool(
  'create_file',
  'Create a new file in Google Drive (text, doc, spreadsheet).',
  {
    name: z.string().describe('File name'),
    mimeType: z.string().optional().describe('MIME type (default: application/vnd.google-apps.document for a Google Doc)'),
    content: z.string().optional().describe('Text content for the file'),
    folderId: z.string().optional().describe('Parent folder ID'),
  },
  async ({ name, mimeType, content, folderId }) => {
    const media = content ? { mimeType: 'text/plain', body: content } : undefined;
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: mimeType ?? 'application/vnd.google-apps.document',
        parents: folderId ? [folderId] : undefined,
      },
      media,
      fields: 'id,name,webViewLink',
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fileId: res.data.id, name: res.data.name, link: res.data.webViewLink }) }] };
  },
);

server.tool(
  'share_file',
  'Share a Drive file with someone.',
  {
    fileId: z.string().describe('File ID'),
    email: z.string().describe('Email address to share with'),
    role: z.string().optional().describe('Permission role: reader, writer, commenter (default: reader)'),
  },
  async ({ fileId, email, role }) => {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'user', role: role ?? 'reader', emailAddress: email },
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, shared: email, role: role ?? 'reader' }) }] };
  },
);

// ==========================================================================
// Docs
// ==========================================================================

server.tool(
  'read_document',
  'Read the text content of a Google Doc.',
  {
    documentId: z.string().describe('Google Docs document ID'),
  },
  async ({ documentId }) => {
    const res = await docs.documents.get({ documentId });
    const text = (res.data.body?.content ?? [])
      .flatMap((block: any) => (block.paragraph?.elements ?? []).map((el: any) => el.textRun?.content ?? ''))
      .join('');
    return { content: [{ type: 'text', text: JSON.stringify({ title: res.data.title, text }) }] };
  },
);

server.tool(
  'create_document',
  'Create a new Google Doc.',
  {
    title: z.string().describe('Document title'),
  },
  async ({ title }) => {
    const res = await docs.documents.create({ requestBody: { title } });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, documentId: res.data.documentId, title: res.data.title }) }] };
  },
);

server.tool(
  'append_to_document',
  'Append text to the end of a Google Doc.',
  {
    documentId: z.string().describe('Google Docs document ID'),
    text: z.string().describe('Text to append'),
  },
  async ({ documentId, text }) => {
    // Get the current end index.
    const doc = await docs.documents.get({ documentId });
    const endIndex = (doc.data.body?.content ?? []).reduce((max: number, block: any) => Math.max(max, block.endIndex ?? 0), 1);
    await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ insertText: { location: { index: endIndex - 1 }, text } }],
      },
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, appended: text.length + ' chars' }) }] };
  },
);

// ==========================================================================
// Sheets
// ==========================================================================

server.tool(
  'create_spreadsheet',
  'Create a new Google Spreadsheet.',
  {
    title: z.string().describe('Spreadsheet title'),
  },
  async ({ title }) => {
    const res = await sheets.spreadsheets.create({ requestBody: { properties: { title } } });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, spreadsheetId: res.data.spreadsheetId, url: res.data.spreadsheetUrl }) }] };
  },
);

server.tool(
  'read_sheet',
  'Read values from a Google Spreadsheet range.',
  {
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g. "Sheet1!A1:D10")'),
  },
  async ({ spreadsheetId, range }) => {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return { content: [{ type: 'text', text: JSON.stringify({ range: res.data.range, values: res.data.values }) }] };
  },
);

server.tool(
  'write_sheet',
  'Write values to a Google Spreadsheet range.',
  {
    spreadsheetId: z.string().describe('Spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g. "Sheet1!A1")'),
    values: z.array(z.array(z.string())).describe('2D array of values (rows x cols)'),
  },
  async ({ spreadsheetId, range, values }) => {
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId, range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, updatedCells: res.data.updatedCells }) }] };
  },
);

// ==========================================================================
// Start
// ==========================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.resume();
