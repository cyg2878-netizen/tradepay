import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Generous body limit for multi-image receipts + audio recordings
app.use(express.json({ limit: '35mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasKey: Boolean(process.env.GEMINI_API_KEY) });
});

// AI Parse Invoice Endpoint
app.post('/api/ai/parse-invoice', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error:
          'GEMINI_API_KEY is not configured on the server. Please ensure your Gemini API key is set in the AI Studio Settings > Secrets panel.',
      });
    }

    const { audio, images, text, pageContext } = req.body;

    if (!audio && (!images || images.length === 0) && (!text || !text.trim())) {
      return res.status(400).json({
        error: 'No input provided. Please provide an audio recording, images/receipts, or written text.',
      });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];

    // 1. Audio part if provided
    if (audio && audio.base64) {
      // Clean base64 prefix if present
      const cleanAudioBase64 = audio.base64.replace(/^data:[^;]+;base64,/, '');
      const mime = audio.mimeType || 'audio/webm';
      parts.push({
        inlineData: {
          mimeType: mime,
          data: cleanAudioBase64,
        },
      });
    }

    // 2. Images (up to 5)
    if (Array.isArray(images)) {
      const selectedImages = images.slice(0, 5);
      for (const img of selectedImages) {
        if (img && img.base64) {
          const cleanImgBase64 = img.base64.replace(/^data:[^;]+;base64,/, '');
          const mime = img.mimeType || 'image/jpeg';
          parts.push({
            inlineData: {
              mimeType: mime,
              data: cleanImgBase64,
            },
          });
        }
      }
    }

    // 3. Context & instructions
    let contextNote = 'User is currently on the Dashboard.';
    if (pageContext?.page === 'client' && pageContext?.clientName) {
      contextNote = `User is currently on the client page for: "${pageContext.clientName}" (Client ID: ${pageContext.clientId || 'unknown'}). Assign this client_name unless the user explicitly names a different client in their note/audio.`;
    }

    const promptText = `
You are an expert UK trade invoice extractor. You analyze trade voice recordings, job site notes, material receipts, and customer details to generate clean, accurate invoice line items.

Context:
${contextNote}

User Written Notes (if any):
${text ? `"${text.trim()}"` : '(None provided)'}

Extraction Instructions:
1. Client Name: Extract the client name from the audio/text or receipts. If user is already on a client page, keep "${pageContext?.clientName || ''}" unless a different customer is clearly identified. If no client is identifiable, return null.
2. Line items:
   - One object per separate item, never merge items.
   - For materials or receipts: extract each purchased material item as a separate line with type "material". Extract its price and quantity.
   - For trade labour/hours: extract as type "labour". Example: "2 hours at £100 an hour" -> quantity: 2, unit_price_gbp: 100, type: "labour".
   - If a price or quantity is not stated, use null. Never invent values.
   - Classification: "material", "labour", or "other".
3. VAT Rate:
   - If 20% or standard VAT is mentioned, return 20.
   - If zero-rated / exempt or no VAT is mentioned, return 0 or null if unknown.
4. Notes: Summarize any relevant job terms, warranty, or completion notes.
5. Uncertain fields:
   - If you are unsure about any field (e.g. uncertain client spelling, missing unit price, missing quantity, unclear line item text), include the field identifier in the "uncertain" array.
   - Examples of uncertain identifiers: "client_name", "vat_rate", "line_items[0].unit_price_gbp", "line_items[1].quantity".

Return strictly JSON adhering to the specified schema.
`.trim();

    parts.push({ text: promptText });

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: { parts },
      config: {
        systemInstruction:
          'You are a professional UK trades invoicing extractor. Return ONLY valid JSON adhering strictly to the responseSchema.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            client_name: { type: Type.STRING, nullable: true },
            line_items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  description: { type: Type.STRING },
                  type: { type: Type.STRING, enum: ['material', 'labour', 'other'] },
                  quantity: { type: Type.NUMBER, nullable: true },
                  unit_price_gbp: { type: Type.NUMBER, nullable: true },
                },
                required: ['description', 'type'],
              },
            },
            vat_rate: { type: Type.NUMBER, nullable: true },
            notes: { type: Type.STRING, nullable: true },
            uncertain: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['line_items', 'uncertain'],
        },
      },
    });

    const rawText = response.text;
    if (!rawText) {
      return res.status(502).json({
        error: 'AI did not return any text. Please try again.',
      });
    }

    try {
      const parsed = JSON.parse(rawText);
      return res.json({ success: true, data: parsed });
    } catch {
      return res.status(502).json({
        error: 'Invalid JSON returned by AI.',
        raw: rawText,
      });
    }
  } catch (err: unknown) {
    const error = err as { message?: string; status?: number };
    console.error('Error in /api/ai/parse-invoice:', error);
    const msg = error?.message || 'Failed to process AI input';
    return res.status(500).json({ error: msg });
  }
});

// Dev / Prod serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TradePay server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
