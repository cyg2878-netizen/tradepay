import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

// Keep server running and log any unhandled promise rejections or exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('[server.ts] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err, origin) => {
  console.error(`[server.ts] Uncaught Exception (${origin}):`, err);
});

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

// ==========================================
// PAYPAL SANDBOX INTEGRATION (SERVER-SIDE ONLY)
// ==========================================
const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';

// In-memory store for invoice <-> order mapping to aid recovery across page refresh
const invoiceOrdersMap = new Map<
  string,
  { orderId: string; invoiceId: string; invoiceNumber: string; amountPence: number; createdAt: string }
>();

// Helper: 15-second timeout on all PayPal requests
async function fetchPayPalWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`PayPal request timed out after ${timeoutMs / 1000}s (${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'PayPal credentials missing: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not configured in AI Studio Secrets.'
    );
  }

  const auth = Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64');
  const res = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();
  if (!res.ok) {
    const errorDetails = data.error_description || data.message || JSON.stringify(data);
    throw new Error(`PayPal OAuth authentication failed (${res.status}): ${errorDetails}`);
  }

  return data.access_token;
}

// PayPal Config Check
app.get('/api/paypal/config', (req, res) => {
  const hasClientId = Boolean(process.env.PAYPAL_CLIENT_ID);
  const hasSecret = Boolean(process.env.PAYPAL_CLIENT_SECRET);
  res.json({
    configured: hasClientId && hasSecret,
    hasClientId,
    hasSecret,
    mode: 'sandbox',
    baseUrl: PAYPAL_API_BASE,
  });
});

// Lookup latest order created for an invoice
app.get('/api/paypal/invoice-order/:invoiceId', (req, res) => {
  const { invoiceId } = req.params;
  const record = invoiceOrdersMap.get(invoiceId);
  if (!record) {
    return res.status(404).json({ found: false, error: 'No recent PayPal order found for this invoice.' });
  }
  return res.json({ found: true, ...record });
});

// Detailed Order Diagnostic (PayPal order status right now, capture status, raw response, elapsed ms)
app.get('/api/paypal/order-diagnostic/:orderId', async (req, res) => {
  const startMs = Date.now();
  try {
    const { orderId } = req.params;
    const token = await getPayPalAccessToken();

    console.log(`[server.ts] Diagnosing PayPal order ${orderId}...`);

    const orderRes = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const orderData = await orderRes.json();
    const elapsedMs = Date.now() - startMs;

    if (!orderRes.ok) {
      console.error(`[server.ts] PayPal order-diagnostic failed (${orderRes.status}) in ${elapsedMs}ms:`, orderData);
      return res.status(orderRes.status).json({
        success: false,
        orderId,
        httpStatus: orderRes.status,
        elapsedMs,
        error: orderData.message || `Failed to fetch order ${orderId}`,
        rawResponse: orderData,
      });
    }

    const captures = orderData.purchase_units?.[0]?.payments?.captures || [];
    const captureSent = captures.length > 0 || orderData.status === 'COMPLETED';
    const captureId = captures[0]?.id;
    const amountVal = captures[0]?.amount?.value || orderData.purchase_units?.[0]?.amount?.value || '0.00';
    const amountPence = Math.round(parseFloat(amountVal) * 100);

    console.log(
      `[server.ts] Diagnostic for ${orderId}: Status=${orderData.status}, CaptureSent=${captureSent}, HTTP=${orderRes.status}, Elapsed=${elapsedMs}ms`
    );

    return res.json({
      success: true,
      orderId,
      status: orderData.status, // "CREATED", "APPROVED", "COMPLETED"
      captureSent,
      httpStatus: orderRes.status,
      elapsedMs,
      amountGbp: amountVal,
      amountPence,
      captureId,
      captures,
      rawResponse: orderData,
    });
  } catch (err: unknown) {
    const elapsedMs = Date.now() - startMs;
    console.error(`[server.ts] Error in /api/paypal/order-diagnostic in ${elapsedMs}ms:`, err);
    return res.status(500).json({
      success: false,
      orderId: req.params.orderId,
      httpStatus: 500,
      elapsedMs,
      error: (err as Error).message || 'Failed to diagnose PayPal order',
    });
  }
});

// Create PayPal Orders v2 Order
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { invoiceId, invoiceNumber, amountPence } = req.body;

    if (!amountPence || amountPence <= 0) {
      return res.status(400).json({
        error: 'Cannot create PayPal order for an invoice with zero or negative balance due.',
      });
    }

    const token = await getPayPalAccessToken();
    const amountGbp = (Math.round(amountPence) / 100).toFixed(2);
    const origin = req.headers.origin || 'http://localhost:3000';

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: invoiceNumber || 'INV',
          description: `TradePay: Payment for Invoice ${invoiceNumber || ''}`,
          amount: {
            currency_code: 'GBP',
            value: amountGbp,
          },
        },
      ],
      application_context: {
        brand_name: 'TradePay',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        return_url: `${origin}?paypal_action=approved&invoiceId=${invoiceId || ''}`,
        cancel_url: `${origin}?paypal_action=cancelled&invoiceId=${invoiceId || ''}`,
      },
    };

    console.log(
      `[server.ts] Creating PayPal Sandbox order for £${amountGbp} (Invoice ${invoiceNumber})...`
    );

    const orderRes = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      console.error('[server.ts] PayPal create-order error:', orderData);
      const detailMsg =
        orderData.details?.[0]?.description || orderData.message || JSON.stringify(orderData);
      return res.status(orderRes.status).json({
        error: `PayPal order creation failed (${orderRes.status}): ${detailMsg}`,
        raw: orderData,
      });
    }

    const approveLink = orderData.links?.find((l: any) => l.rel === 'approve')?.href;

    console.log(`[server.ts] PayPal order created: ${orderData.id} (status: ${orderData.status})`);

    // Track in memory
    if (invoiceId) {
      invoiceOrdersMap.set(invoiceId, {
        orderId: orderData.id,
        invoiceId,
        invoiceNumber: invoiceNumber || '',
        amountPence: Math.round(amountPence),
        createdAt: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      orderId: orderData.id,
      status: orderData.status,
      approvalUrl: approveLink,
      amountGbp,
      amountPence,
    });
  } catch (err: unknown) {
    console.error('[server.ts] Error in /api/paypal/create-order:', err);
    return res.status(500).json({
      error: (err as Error).message || 'Failed to create PayPal order',
    });
  }
});

// Check PayPal Order Status
app.get('/api/paypal/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const token = await getPayPalAccessToken();

    const orderRes = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        error: orderData.message || `Failed to fetch order ${orderId}`,
        raw: orderData,
      });
    }

    return res.json({
      success: true,
      orderId: orderData.id,
      status: orderData.status, // "CREATED", "APPROVED", "COMPLETED"
      order: orderData,
    });
  } catch (err: unknown) {
    console.error('[server.ts] Error in /api/paypal/order-status:', err);
    return res.status(500).json({
      error: (err as Error).message || 'Failed to check PayPal order status',
    });
  }
});

// Capture PayPal Order (Handles already-COMPLETED orders without duplicate captures)
app.post('/api/paypal/capture-order/:orderId', async (req, res) => {
  const startMs = Date.now();
  try {
    const { orderId } = req.params;
    const token = await getPayPalAccessToken();

    console.log(`[server.ts] Inspecting order status before capture for ${orderId}...`);

    // 1. Check order status first: if already COMPLETED at PayPal, don't capture again, just return it!
    const checkRes = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const checkData = await checkRes.json();
    if (checkRes.ok && checkData.status === 'COMPLETED') {
      const elapsedMs = Date.now() - startMs;
      const captures = checkData.purchase_units?.[0]?.payments?.captures || [];
      const cap = captures[0];
      const amountVal = cap?.amount?.value || checkData.purchase_units?.[0]?.amount?.value || '0.00';
      const amountPence = Math.round(parseFloat(amountVal) * 100);

      console.log(
        `[server.ts] Order ${orderId} is ALREADY COMPLETED at PayPal. Returning capture without re-capturing (${elapsedMs}ms).`
      );

      return res.json({
        success: true,
        alreadyCompleted: true,
        status: 'COMPLETED',
        captureId: cap?.id || orderId,
        amountGbp: amountVal,
        amountPence,
        captureData: checkData,
        raw: checkData,
        httpStatus: 200,
        elapsedMs,
      });
    }

    // 2. If not already completed, send capture request
    console.log(`[server.ts] Sending capture request to PayPal for order ${orderId}...`);
    const captureRes = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const captureData = await captureRes.json();
    const elapsedMs = Date.now() - startMs;

    if (!captureRes.ok) {
      console.error(`[server.ts] PayPal capture-order error (${captureRes.status}):`, captureData);

      // Check if it's ORDER_ALREADY_CAPTURED
      const isAlreadyCaptured =
        captureData.details?.some((d: any) => d.issue === 'ORDER_ALREADY_CAPTURED') ||
        (captureData.message && captureData.message.includes('already captured'));

      if (isAlreadyCaptured) {
        console.log(`[server.ts] Order ${orderId} was already captured in another thread. Returning COMPLETED.`);
        // Re-read order to get captureId and amount
        const recheckRes = await fetchPayPalWithTimeout(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        const recheckData = await recheckRes.json();
        const captures = recheckData.purchase_units?.[0]?.payments?.captures || [];
        const cap = captures[0];
        const amountVal = cap?.amount?.value || recheckData.purchase_units?.[0]?.amount?.value || '0.00';

        return res.json({
          success: true,
          alreadyCompleted: true,
          status: 'COMPLETED',
          captureId: cap?.id || orderId,
          amountGbp: amountVal,
          amountPence: Math.round(parseFloat(amountVal) * 100),
          captureData: recheckData,
          raw: captureData,
          httpStatus: captureRes.status,
          elapsedMs,
        });
      }

      const detailMsg =
        captureData.details?.[0]?.description ||
        captureData.message ||
        JSON.stringify(captureData);

      return res.status(captureRes.status).json({
        success: false,
        error: `PayPal order capture failed (${captureRes.status}): ${detailMsg}`,
        httpStatus: captureRes.status,
        raw: captureData,
        elapsedMs,
      });
    }

    const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId;
    const amountVal =
      captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
      captureData.purchase_units?.[0]?.amount?.value ||
      '0.00';
    const amountPence = Math.round(parseFloat(amountVal) * 100);

    console.log(
      `[server.ts] PayPal order ${orderId} captured successfully (Capture ID: ${captureId}) in ${elapsedMs}ms`
    );

    return res.json({
      success: true,
      status: captureData.status, // "COMPLETED"
      captureId,
      amountGbp: amountVal,
      amountPence,
      captureData,
      raw: captureData,
      httpStatus: captureRes.status,
      elapsedMs,
    });
  } catch (err: unknown) {
    const elapsedMs = Date.now() - startMs;
    console.error(`[server.ts] Error in /api/paypal/capture-order in ${elapsedMs}ms:`, err);
    return res.status(500).json({
      success: false,
      error: (err as Error).message || 'Failed to capture PayPal order',
      httpStatus: 500,
      elapsedMs,
    });
  }
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

  const callWithTimeout = (modelName: string, timeoutMs: number) => {
    let t: NodeJS.Timeout | undefined;
    const p = new Promise<never>((_, rej) => {
      t = setTimeout(
        () => rej(new Error(`Gemini call to ${modelName} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    return Promise.race([
      ai.models.generateContent({
        ...generateParams,
        model: modelName,
      }),
      p,
    ]).finally(() => {
      if (t) clearTimeout(t);
    });
  };

  try {
    console.log(`[server.ts] Executing Gemini call for ${ACTIVE_MODEL} (attempt 1)...`);
    response = await callWithTimeout(ACTIVE_MODEL, 9000);
  } catch (firstErr: unknown) {
    const elapsedSoFar = Date.now() - requestStartTime;
    const errString = String(firstErr);
    const is503OrTimeout =
      errString.includes('503') ||
      errString.includes('UNAVAILABLE') ||
      errString.includes('high demand') ||
      errString.includes('timed out') ||
      errString.includes('timeout');

    if (is503OrTimeout && elapsedSoFar < MAX_TOTAL_BUDGET_MS - 4000) {
      isRetrying = true;
      const fallbackModel = 'gemini-3.5-flash';
      console.log(
        `[server.ts] Gemini model ${ACTIVE_MODEL} returned 503 or timed out. Automatically retrying once with ${fallbackModel} (attempt 2/2)...`
      );
      const remainingBudget = Math.min(MAX_TOTAL_BUDGET_MS - (Date.now() - requestStartTime), 9000);
      try {
        response = await callWithTimeout(fallbackModel, remainingBudget);
      } catch (secondErr: unknown) {
        console.error(`[server.ts] Retry attempt with ${fallbackModel} failed:`, secondErr);
        const elapsedMs = Date.now() - requestStartTime;
        return res.status(503).json({
          success: false,
          error: 'The AI is busy, please try again',
          rawError: String(secondErr),
          modelUsed: fallbackModel,
          retried: true,
          elapsedMs,
        });
      }
    } else {
      console.error(`[server.ts] Gemini call to ${ACTIVE_MODEL} failed (no retry):`, firstErr);
      const elapsedMs = Date.now() - requestStartTime;
      return res.status(503).json({
        success: false,
        error: 'The AI is busy, please try again',
        rawError: String(firstErr),
        modelUsed: ACTIVE_MODEL,
        retried: false,
        elapsedMs,
      });
    }
  }

  const totalServerDurationMs = Date.now() - requestStartTime;
  console.log(
    `[server.ts] Gemini finished in ${totalServerDurationMs}ms (Retried: ${isRetrying}, Model: ${ACTIVE_MODEL})`
  );

  const rawText = response?.text;
  if (!rawText) {
    return res.status(503).json({
      success: false,
      error: 'The AI is busy, please try again',
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
  } catch (jsonErr: unknown) {
    console.error('[server.ts] Invalid JSON returned by AI:', jsonErr);
    return res.status(502).json({
      success: false,
      error: 'The AI is busy, please try again',
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
