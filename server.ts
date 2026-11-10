import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
let PORT = 3000;
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) {
  PORT = parseInt(process.argv[portIdx + 1], 10);
} else if (process.env.PORT) {
  PORT = parseInt(process.env.PORT, 10);
}

// Allow dynamic model selection - default to gemini-flash-lite-latest
let ACTIVE_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

// Generous body limit for multi-image receipts + audio recordings
app.use(express.json({ limit: '35mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: Boolean(process.env.GEMINI_API_KEY),
    activeModel: ACTIVE_MODEL,
  });
});

// Endpoint to switch active model
app.post('/api/ai/set-model', (req, res) => {
  const { model } = req.body;
  if (model && typeof model === 'string') {
    ACTIVE_MODEL = model;
    console.log(`[server.ts] Switched ACTIVE_MODEL to: ${ACTIVE_MODEL}`);
  }
  res.json({ success: true, activeModel: ACTIVE_MODEL });
});

// Main AI Parse & Diagnostics Endpoint
app.post('/api/ai/parse-invoice', async (req, res) => {
  const requestStartTime = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      error:
        'GEMINI_API_KEY is not configured on the server. Please ensure your Gemini API key is set in the AI Studio Settings > Secrets panel.',
      modelUsed: ACTIVE_MODEL,
      hasKey: false,
      httpStatus: 400,
      elapsedMs: Date.now() - requestStartTime,
    });
  }

  const { audio, images, text, pageContext } = req.body;
  const isDiagnostic = text?.trim() === 'Reply with the word OK';

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

  // If this is the diagnostic "Reply with the word OK" test
  if (isDiagnostic) {
    console.log(`[server.ts] === Running Diagnostic Test (Model: ${ACTIVE_MODEL}) ===`);
    let primaryResultText: string | null = null;
    let primaryError: string | null = null;
    let primaryStatus = 200;
    const primaryStart = Date.now();

    // 1. Run the same Gemini call the app uses with ACTIVE_MODEL
    try {
      console.log(`[server.ts] Testing primary model ${ACTIVE_MODEL} with "Reply with the word OK"...`);
      const testTimeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`Primary call to ${ACTIVE_MODEL} timed out after 10s`)), 10000)
      );
      const testRes = await Promise.race([
        ai.models.generateContent({
          model: ACTIVE_MODEL,
          contents: 'Reply with the word OK',
        }),
        testTimeout,
      ]);
      primaryResultText = testRes.text?.trim() || '';
      console.log(`[server.ts] Primary model ${ACTIVE_MODEL} returned: "${primaryResultText}" in ${Date.now() - primaryStart}ms`);
    } catch (err: unknown) {
      const errorObj = err as { message?: string; status?: number };
      primaryStatus = errorObj?.status || 500;
      primaryError = errorObj?.message || String(err);
      console.error(`[server.ts] Primary model ${ACTIVE_MODEL} failed:`, primaryError);
    }
    const primaryElapsedMs = Date.now() - primaryStart;

    // 2. Call list-models endpoint with the same key
    let flashModelsFound: string[] = [];
    let listModelsError: string | null = null;
    try {
      console.log('[server.ts] Calling ai.models.list()...');
      const listRes = await ai.models.list();
      for await (const m of listRes) {
        const name = (m.name || '').replace(/^models\//, '');
        if (
          name.includes('flash') &&
          !name.includes('image') &&
          !name.includes('tts') &&
          !name.includes('embed')
        ) {
          flashModelsFound.push(name);
        }
      }
      console.log(`[server.ts] List-models returned ${flashModelsFound.length} flash models:`, flashModelsFound);
    } catch (err: unknown) {
      listModelsError = (err as Error).message || String(err);
      console.log(`[server.ts] List-models failed (${listModelsError}), using known Flash candidates`);
    }

    // 3. Select 4-5 text-capable Flash-class models to benchmark
    const testList = [
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-3.7-flash',
    ];

    console.log('[server.ts] Testing Flash-class models:', testList);
    const benchmarks: Array<{
      model: string;
      status: 'ok' | 'error';
      elapsedMs: number;
      output?: string;
      error?: string;
    }> = [];

    for (const m of testList) {
      const bStart = Date.now();
      try {
        const bTimeout = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Timeout after 10s for ${m}`)), 10000)
        );
        const bRes = await Promise.race([
          ai.models.generateContent({
            model: m,
            contents: 'Reply with the word OK',
          }),
          bTimeout,
        ]);
        const textOut = bRes.text?.trim() || '';
        const elapsed = Date.now() - bStart;
        benchmarks.push({
          model: m,
          status: 'ok',
          elapsedMs: elapsed,
          output: textOut,
        });
        console.log(`[server.ts] Model benchmark ${m}: OK in ${elapsed}ms`);
      } catch (bErr: unknown) {
        const elapsed = Date.now() - bStart;
        const errMessage = (bErr as Error).message || String(bErr);
        benchmarks.push({
          model: m,
          status: 'error',
          elapsedMs: elapsed,
          error: errMessage,
        });
        console.log(`[server.ts] Model benchmark ${m} failed in ${elapsed}ms: ${errMessage}`);
      }
    }

    return res.status(primaryError ? primaryStatus : 200).json({
      isDiagnostic: true,
      modelUsed: ACTIVE_MODEL,
      hasKey: true,
      httpStatus: primaryError ? primaryStatus : 200,
      rawError: primaryError,
      elapsedMs: primaryElapsedMs,
      resultText: primaryResultText,
      totalServerElapsedMs: Date.now() - requestStartTime,
      listModels: {
        success: !listModelsError,
        flashModelsFound,
        error: listModelsError,
      },
      benchmarks,
    });
  }

  // --- Normal Invoice Extraction Route ---
  const payloadSizeKb = (JSON.stringify(req.body).length / 1024).toFixed(1);
  console.log(
    `[server.ts] Received /api/ai/parse-invoice request at ${new Date().toISOString()} (Payload: ${payloadSizeKb} KB, model: ${ACTIVE_MODEL})`
  );

  const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];

  // 1. Audio part if provided
  if (audio && audio.base64) {
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

  const MAX_TOTAL_BUDGET_MS = 18000; // Keep total server time under 20s
  let isRetrying = false;
  let response;

  const generateParams = {
    model: ACTIVE_MODEL,
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
  };

  const callWithTimeout = (timeoutMs: number) => {
    let t: NodeJS.Timeout | undefined;
    const p = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`Gemini call timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([ai.models.generateContent(generateParams), p]).finally(() => {
      if (t) clearTimeout(t);
    });
  };

  try {
    console.log(`[server.ts] Executing Gemini call for ${ACTIVE_MODEL} (attempt 1)...`);
    response = await callWithTimeout(9000);
  } catch (firstErr: unknown) {
    const elapsedSoFar = Date.now() - requestStartTime;
    const errString = String(firstErr);
    const isTransient =
      errString.includes('503') ||
      errString.includes('UNAVAILABLE') ||
      errString.includes('high demand') ||
      errString.includes('timed out');

    if (isTransient && elapsedSoFar < MAX_TOTAL_BUDGET_MS - 4000) {
      isRetrying = true;
      console.log(
        `[server.ts] Gemini call retrying (attempt 2/2) due to transient issue: ${(firstErr as Error).message}`
      );
      const remainingBudget = Math.min(MAX_TOTAL_BUDGET_MS - (Date.now() - requestStartTime), 8500);
      try {
        response = await callWithTimeout(remainingBudget);
      } catch (secondErr: unknown) {
        console.error('[server.ts] Retry attempt failed:', secondErr);
        throw secondErr;
      }
    } else {
      console.log(`[server.ts] Not retrying (elapsed: ${elapsedSoFar}ms, isTransient: ${isTransient})`);
      throw firstErr;
    }
  }

  const totalServerDurationMs = Date.now() - requestStartTime;
  console.log(
    `[server.ts] Gemini finished in ${totalServerDurationMs}ms (Retried: ${isRetrying}, Model: ${ACTIVE_MODEL})`
  );

  const rawText = response.text;
  if (!rawText) {
    return res.status(502).json({
      error: 'AI did not return any text. Please try again.',
      modelUsed: ACTIVE_MODEL,
      elapsedMs: totalServerDurationMs,
    });
  }

  try {
    const parsed = JSON.parse(rawText);
    return res.json({
      success: true,
      data: parsed,
      modelUsed: ACTIVE_MODEL,
      retried: isRetrying,
      timing: { totalMs: totalServerDurationMs },
    });
  } catch {
    return res.status(502).json({
      error: 'Invalid JSON returned by AI.',
      raw: rawText,
      modelUsed: ACTIVE_MODEL,
      elapsedMs: totalServerDurationMs,
    });
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
    console.log(`\n  VITE v8.3.0  ready in 120 ms\n\n  ➜  Local:   http://localhost:${PORT}/\n  ➜  Network: http://0.0.0.0:${PORT}/\n`);
  });
}

startServer();
