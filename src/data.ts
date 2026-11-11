/**
 * TradePay Data Layer
 * Single data file for all reading/writing so storage can later be swapped to Firebase without touching screens.
 * Money is strictly stored as integer pence (100 pence = £1.00).
 */

export interface Contact {
  id: string;
  name: string;
  phone: string;
  email: string;
}

export interface Client {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  contacts: Contact[];
  notes?: string;
  status?: 'confirmed' | 'please_confirm';
  createdAt: string;
}

export interface Project {
  id: string;
  clientId: string;
  name: string;
  status: 'active' | 'completed' | 'on_hold';
  createdAt: string;
}

export interface Job {
  id: string;
  clientId: string;
  projectId?: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: string;
}

export type LineItemType = 'material' | 'labour' | 'other';

export interface LineItem {
  id: string;
  description: string;
  type: LineItemType;
  quantity: number;
  unitPrice: number; // integer pence
  totalPrice: number; // integer pence
}

export type PaymentMethod = 'cash' | 'card' | 'bank transfer' | 'PayPal';
export type InvoiceStatus = 'draft' | 'sent' | 'partly paid' | 'paid';

export interface Payment {
  id: string;
  amount: number; // integer pence
  method: PaymentMethod;
  date: string; // YYYY-MM-DD
  notes?: string;
  paypalOrderId?: string;
  paypalCaptureId?: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string; // e.g. "INV-001"
  clientId: string;
  projectId?: string;
  date: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  lineItems: LineItem[];
  vatRate: number; // percentage integer (e.g. 20, 5, 0)
  subtotal: number; // integer pence
  vatAmount: number; // integer pence
  total: number; // integer pence
  payments: Payment[]; // list of payments made
  amountPaid: number; // integer pence (sum of payments)
  balanceDue: number; // integer pence (total - amountPaid)
  status: InvoiceStatus;
  notes?: string;
  pendingPayPalOrderId?: string; // Stored PayPal order ID for cross-refresh recovery
  createdAt: string;
}

export interface Quote {
  id: string;
  quoteNumber: string; // e.g. "QTE-001"
  clientId: string;
  projectId?: string;
  status: 'draft' | 'sent' | 'converted';
  createdAt: string;
}

export interface Draft {
  id: string;
  type: 'invoice' | 'quote' | 'client';
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ========================
// Financial Math Utilities (ALL maths in code)
// ========================

export function formatPenceToGBP(pence: number): string {
  const safePence = Math.round(Number(pence) || 0);
  const pounds = (safePence / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `£${pounds}`;
}

export function poundsToPence(pounds: number | string): number {
  if (typeof pounds === 'number') {
    return Math.round(pounds * 100);
  }
  const clean = pounds.replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(clean);
  if (isNaN(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function penceToPoundInput(pence: number): string {
  if (pence === 0) return '0.00';
  return (pence / 100).toFixed(2);
}

export function calculateLineTotal(qty: number, unitPricePence: number): number {
  const safeQty = Math.max(0, Number(qty) || 0);
  const safePrice = Math.round(Number(unitPricePence) || 0);
  return Math.round(safeQty * safePrice);
}

export function calculateInvoiceTotals(
  items: Array<{ quantity: number; unitPrice: number }>,
  vatRate: number,
  amountPaidPence: number
): {
  subtotal: number;
  vatAmount: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
} {
  const subtotal = items.reduce((sum, item) => {
    return sum + calculateLineTotal(item.quantity, item.unitPrice);
  }, 0);

  const safeVatRate = Math.max(0, Number(vatRate) || 0);
  const vatAmount = Math.round((subtotal * safeVatRate) / 100);
  const total = subtotal + vatAmount;
  const safeAmountPaid = Math.max(0, Math.round(Number(amountPaidPence) || 0));
  const balanceDue = Math.max(0, total - safeAmountPaid);

  return {
    subtotal,
    vatAmount,
    total,
    amountPaid: safeAmountPaid,
    balanceDue,
  };
}

// ========================
// Storage Keys & Mock Data
// ========================

const STORAGE_KEYS = {
  CLIENTS: 'tradepay_clients',
  PROJECTS: 'tradepay_projects',
  JOBS: 'tradepay_jobs',
  INVOICES: 'tradepay_invoices',
  QUOTES: 'tradepay_quotes',
  DRAFTS: 'tradepay_drafts',
};

const INITIAL_CLIENTS: Client[] = [
  {
    id: 'cli_01',
    name: 'Harrison Property Group',
    phone: '07700 900123',
    email: 'admin@harrisonproperties.co.uk',
    address: '14 Elm Road, Bristol, BS7 8AA',
    contacts: [
      {
        id: 'con_01',
        name: 'Dave Harrison',
        phone: '07700 900124',
        email: 'dave@harrisonproperties.co.uk',
      },
      {
        id: 'con_02',
        name: 'Sarah Mills (Site Mgr)',
        phone: '07700 900125',
        email: 'sarah.site@harrisonproperties.co.uk',
      },
    ],
    status: 'confirmed',
    createdAt: '2026-11-01T09:00:00Z',
  },
  {
    id: 'cli_02',
    name: 'Mark Pendelton (Domestic)',
    phone: '07891 234567',
    email: 'mark.pendelton@gmail.com',
    address: '42 Meadow Lane, Bath, BA1 3LT',
    contacts: [],
    status: 'confirmed',
    createdAt: '2026-11-05T14:30:00Z',
  },
];

const INITIAL_INVOICES: Invoice[] = [
  {
    id: 'inv_01',
    invoiceNumber: 'INV-001',
    clientId: 'cli_01',
    date: '2026-11-02',
    dueDate: '2026-11-16',
    lineItems: [
      {
        id: 'li_01',
        description: 'First fix electrical wiring - Ground floor extension',
        type: 'labour',
        quantity: 2,
        unitPrice: 32000, // £320.00
        totalPrice: 64000, // £640.00
      },
      {
        id: 'li_02',
        description: 'Consumer unit 10-way dual RCD + copper tails',
        type: 'material',
        quantity: 1,
        unitPrice: 18500, // £185.00
        totalPrice: 18500, // £185.00
      },
    ],
    vatRate: 20,
    subtotal: 82500, // £825.00
    vatAmount: 16500, // £165.00
    total: 99000, // £990.00
    payments: [],
    amountPaid: 0,
    balanceDue: 99000,
    status: 'sent',
    notes: 'Payment terms 14 days. Thank you for your business.',
    createdAt: '2026-11-02T10:15:00Z',
  },
  {
    id: 'inv_02',
    invoiceNumber: 'INV-002',
    clientId: 'cli_02',
    date: '2026-11-06',
    dueDate: '2026-11-20',
    lineItems: [
      {
        id: 'li_03',
        description: 'Bathroom mixer tap replacement & waste seal',
        type: 'labour',
        quantity: 1,
        unitPrice: 14000, // £140.00
        totalPrice: 14000,
      },
    ],
    vatRate: 0,
    subtotal: 14000,
    vatAmount: 0,
    total: 14000,
    payments: [
      {
        id: 'pay_init_01',
        amount: 14000,
        method: 'bank transfer',
        date: '2026-11-06',
        notes: 'Paid via bank transfer on completion.',
        createdAt: '2026-11-06T15:00:00Z',
      },
    ],
    amountPaid: 14000,
    balanceDue: 0,
    status: 'paid',
    notes: 'Paid via bank transfer on completion.',
    createdAt: '2026-11-06T15:00:00Z',
  },
];

// Helper to access LocalStorage safely
type DBListener = () => void;
const dbListeners = new Set<DBListener>();

function notifySubscribers() {
  dbListeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[TradePayDB] Subscriber error:', err);
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', () => {
    notifySubscribers();
  });
}

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      localStorage.setItem(key, JSON.stringify(fallback));
      return fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    notifySubscribers();
  } catch (err) {
    console.error('TradePay Storage Save Error:', err);
  }
}

// ========================
// Single Data Access API
// (Easily replaced with Firebase or Cloud SQL later)
// ========================

export const TradePayDB = {
  // Clients
  getClients(): Client[] {
    return loadFromStorage<Client[]>(STORAGE_KEYS.CLIENTS, INITIAL_CLIENTS);
  },

  getClientById(id: string): Client | undefined {
    return this.getClients().find((c) => c.id === id);
  },

  saveClient(clientData: Omit<Client, 'id' | 'createdAt'> & { id?: string }): Client {
    const clients = this.getClients();
    let updated: Client;

    if (clientData.id) {
      const index = clients.findIndex((c) => c.id === clientData.id);
      if (index >= 0) {
        updated = {
          ...clients[index],
          ...clientData,
          id: clientData.id,
        };
        clients[index] = updated;
      } else {
        updated = {
          ...clientData,
          id: clientData.id,
          createdAt: new Date().toISOString(),
        } as Client;
        clients.push(updated);
      }
    } else {
      updated = {
        ...clientData,
        id: 'cli_' + Math.random().toString(36).substring(2, 9),
        createdAt: new Date().toISOString(),
      };
      clients.unshift(updated);
    }

    saveToStorage(STORAGE_KEYS.CLIENTS, clients);
    return updated;
  },

  deleteClient(id: string): void {
    const clients = this.getClients().filter((c) => c.id !== id);
    saveToStorage(STORAGE_KEYS.CLIENTS, clients);
    const invoices = this.getInvoices().filter((inv) => inv.clientId !== id);
    saveToStorage(STORAGE_KEYS.INVOICES, invoices);
  },

  // Invoices
  getInvoices(): Invoice[] {
    const list = loadFromStorage<Invoice[]>(STORAGE_KEYS.INVOICES, INITIAL_INVOICES);
    return list.map((inv) => {
      const payments: Payment[] = Array.isArray(inv.payments)
        ? inv.payments
        : (inv.amountPaid > 0
        ? [
            {
              id: 'pay_legacy_' + inv.id,
              amount: inv.amountPaid,
              method: 'bank transfer' as PaymentMethod,
              date: inv.date,
              createdAt: inv.createdAt,
            },
          ]
        : []);
      const amountPaid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const balanceDue = Math.max(0, inv.total - amountPaid);
      let status = inv.status;
      if (inv.total > 0 && amountPaid >= inv.total) {
        status = 'paid';
      } else if (amountPaid > 0 && balanceDue > 0) {
        status = 'partly paid';
      }
      return {
        ...inv,
        payments,
        amountPaid,
        balanceDue,
        status,
      };
    });
  },

  getInvoiceById(id: string): Invoice | undefined {
    return this.getInvoices().find((inv) => inv.id === id);
  },

  getInvoicesForClient(clientId: string): Invoice[] {
    return this.getInvoices().filter((inv) => inv.clientId === clientId);
  },

  getNextInvoiceNumber(): string {
    const invoices = this.getInvoices();
    let maxNum = 0;
    for (const inv of invoices) {
      const match = inv.invoiceNumber.match(/INV-(\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
    const next = maxNum + 1;
    return `INV-${next.toString().padStart(3, '0')}`;
  },

  saveInvoice(
    invoiceData: Omit<Invoice, 'id' | 'createdAt' | 'invoiceNumber' | 'payments'> & {
      id?: string;
      invoiceNumber?: string;
      payments?: Payment[];
    }
  ): Invoice {
    const invoices = this.getInvoices();
    let updated: Invoice;

    const existing = invoiceData.id ? invoices.find((i) => i.id === invoiceData.id) : undefined;
    const payments = invoiceData.payments || (existing ? existing.payments : []);
    const amountPaid = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    const mathTotals = calculateInvoiceTotals(
      invoiceData.lineItems,
      invoiceData.vatRate,
      amountPaid
    );

    // Auto-update status if paid or partly paid
    let status = invoiceData.status;
    if (mathTotals.total > 0 && amountPaid >= mathTotals.total) {
      status = 'paid';
    } else if (amountPaid > 0 && mathTotals.balanceDue > 0) {
      status = 'partly paid';
    }

    if (invoiceData.id && existing) {
      const index = invoices.findIndex((i) => i.id === invoiceData.id);
      updated = {
        ...invoices[index],
        ...invoiceData,
        ...mathTotals,
        payments,
        status,
        id: invoiceData.id,
        invoiceNumber: invoiceData.invoiceNumber || invoices[index].invoiceNumber,
      };
      invoices[index] = updated;
    } else {
      updated = {
        ...invoiceData,
        ...mathTotals,
        payments,
        status,
        id: invoiceData.id || ('inv_' + Math.random().toString(36).substring(2, 9)),
        invoiceNumber: invoiceData.invoiceNumber || this.getNextInvoiceNumber(),
        createdAt: new Date().toISOString(),
      };
      invoices.unshift(updated);
    }

    saveToStorage(STORAGE_KEYS.INVOICES, invoices);
    return updated;
  },

  recordPayment(
    invoiceId: string,
    paymentData: {
      amount: number; // integer pence
      method: PaymentMethod;
      date: string;
      notes?: string;
      paypalOrderId?: string;
      paypalCaptureId?: string;
    }
  ): Invoice | undefined {
    const invoices = this.getInvoices();
    const index = invoices.findIndex((i) => i.id === invoiceId);
    if (index < 0) return undefined;

    const inv = invoices[index];

    // Capture only once per order (no duplicate payments)
    if (
      paymentData.paypalOrderId &&
      (inv.payments || []).some((p) => p.paypalOrderId === paymentData.paypalOrderId)
    ) {
      console.log(
        `[TradePayDB] PayPal order ${paymentData.paypalOrderId} already recorded on invoice ${invoiceId}. Skipping duplicate.`
      );
      if (inv.pendingPayPalOrderId === paymentData.paypalOrderId) {
        inv.pendingPayPalOrderId = undefined;
        invoices[index] = inv;
        saveToStorage(STORAGE_KEYS.INVOICES, invoices);
      }
      return inv;
    }

    const newPayment: Payment = {
      ...paymentData,
      id: 'pay_' + Math.random().toString(36).substring(2, 9),
      amount: Math.round(Number(paymentData.amount) || 0),
      createdAt: new Date().toISOString(),
    };

    const payments = [...(inv.payments || []), newPayment];
    const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balanceDue = Math.max(0, inv.total - amountPaid);

    let status: InvoiceStatus = inv.status;
    if (inv.total > 0 && amountPaid >= inv.total) {
      status = 'paid';
    } else if (amountPaid > 0 && balanceDue > 0) {
      status = 'partly paid';
    }

    const updated: Invoice = {
      ...inv,
      payments,
      amountPaid,
      balanceDue,
      status,
      pendingPayPalOrderId:
        inv.pendingPayPalOrderId === paymentData.paypalOrderId ? undefined : inv.pendingPayPalOrderId,
    };

    invoices[index] = updated;
    saveToStorage(STORAGE_KEYS.INVOICES, invoices);
    return updated;
  },

  setPendingPayPalOrder(invoiceId: string, orderId: string | undefined): Invoice | undefined {
    const invoices = this.getInvoices();
    const index = invoices.findIndex((i) => i.id === invoiceId);
    if (index < 0) return undefined;

    const updated: Invoice = {
      ...invoices[index],
      pendingPayPalOrderId: orderId,
    };
    invoices[index] = updated;
    saveToStorage(STORAGE_KEYS.INVOICES, invoices);
    return updated;
  },

  deletePayment(invoiceId: string, paymentId: string): Invoice | undefined {
    const invoices = this.getInvoices();
    const index = invoices.findIndex((i) => i.id === invoiceId);
    if (index < 0) return undefined;

    const inv = invoices[index];
    const payments = (inv.payments || []).filter((p) => p.id !== paymentId);
    const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balanceDue = Math.max(0, inv.total - amountPaid);

    let status: InvoiceStatus = inv.status;
    if (inv.total > 0 && amountPaid >= inv.total) {
      status = 'paid';
    } else if (amountPaid > 0 && balanceDue > 0) {
      status = 'partly paid';
    } else if (amountPaid === 0 && (status === 'paid' || status === 'partly paid')) {
      status = 'sent';
    }

    const updated: Invoice = {
      ...inv,
      payments,
      amountPaid,
      balanceDue,
      status,
    };

    invoices[index] = updated;
    saveToStorage(STORAGE_KEYS.INVOICES, invoices);
    return updated;
  },

  deleteInvoice(id: string): void {
    const invoices = this.getInvoices().filter((i) => i.id !== id);
    saveToStorage(STORAGE_KEYS.INVOICES, invoices);
  },

  // Subscription for live reactive updates
  subscribe(listener: () => void): () => void {
    dbListeners.add(listener);
    return () => {
      dbListeners.delete(listener);
    };
  },

  notify(): void {
    notifySubscribers();
  },

  // Client calculations in code (strictly integer pence)
  getClientFinancialSummary(clientId: string): {
    totalInvoiced: number; // integer pence
    totalPaid: number; // integer pence
    totalOutstanding: number; // integer pence
    invoiceCount: number;
  } {
    const invoices = this.getInvoicesForClient(clientId);
    const totalInvoiced = invoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => {
      const paid = (inv.payments || []).reduce((pSum, p) => pSum + (Number(p.amount) || 0), 0);
      return sum + paid;
    }, 0);
    const totalOutstanding = Math.max(0, totalInvoiced - totalPaid);
    return {
      totalInvoiced,
      totalPaid,
      totalOutstanding,
      invoiceCount: invoices.length,
    };
  },

  getClientOutstandingBalance(clientId: string): number {
    return this.getClientFinancialSummary(clientId).totalOutstanding;
  },

  // Placeholders for Projects, Jobs, Quotes, Drafts (empty placeholders as required by Task 1)
  getProjects(): Project[] {
    return loadFromStorage<Project[]>(STORAGE_KEYS.PROJECTS, []);
  },

  getJobs(): Job[] {
    return loadFromStorage<Job[]>(STORAGE_KEYS.JOBS, []);
  },

  getQuotes(): Quote[] {
    return loadFromStorage<Quote[]>(STORAGE_KEYS.QUOTES, []);
  },

  getDrafts(): Draft[] {
    return loadFromStorage<Draft[]>(STORAGE_KEYS.DRAFTS, []);
  },
};
