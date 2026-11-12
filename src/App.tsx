import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Bell,
  Settings,
  Mic,
  Camera,
  Image as ImageIcon,
  Search,
  Plus,
  ArrowLeft,
  ChevronRight,
  User,
  FileText,
  Briefcase,
  FileClock,
  Quote as QuoteIcon,
  Phone,
  Mail,
  MapPin,
  Trash2,
  CheckCircle2,
  Clock,
  AlertCircle,
  CreditCard,
  Building2,
  PlusCircle,
  X,
  Sparkles,
  Loader2,
  Square,
  AlertTriangle,
  RotateCcw,
  ExternalLink,
  FileDown,
  Share2,
  MessageCircle,
} from 'lucide-react';
import {
  TradePayDB,
  Client,
  Invoice,
  LineItem,
  Contact,
  Payment,
  PaymentMethod,
  formatPenceToGBP,
  poundsToPence,
  penceToPoundInput,
  calculateLineTotal,
  calculateInvoiceTotals,
  InvoiceStatus,
} from './data.ts';
import { downloadInvoicePDF, getInvoicePDFFile } from './pdf.ts';

// ------------------------------------------
// TYPES FOR AI EXTRACTION
// ------------------------------------------
interface ExtractedLineItem {
  description: string;
  type: 'material' | 'labour' | 'other';
  quantity: number | null;
  unit_price_gbp: number | null;
}

interface AIParseResponse {
  client_name: string | null;
  line_items: ExtractedLineItem[];
  vat_rate: number | null;
  notes: string | null;
  uncertain: string[];
}

type ViewMode =
  | { type: 'dashboard' }
  | { type: 'all-clients' }
  | { type: 'all-invoices' }
  | { type: 'client-view'; clientId: string; fromView?: 'dashboard' | 'all-clients' }
  | { type: 'client-form'; clientId?: string }
  | { type: 'invoice-form'; invoiceId?: string; prefilledClientId?: string; fromView?: 'dashboard' | 'all-invoices' }
  | {
      type: 'ai-review';
      aiData: AIParseResponse;
      contextClientId?: string;
    };

interface UploadedImage {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

export type ClientSortOption = 'a-to-z' | 'z-to-a' | 'newest-added' | 'highest-balance';
export type InvoiceSortOption =
  | 'newest'
  | 'oldest'
  | 'number-high-to-low'
  | 'number-low-to-high'
  | 'unpaid-first'
  | 'overdue-first';

function sortClientsList(
  clientList: Client[],
  allInvoices: Invoice[],
  sortOption: ClientSortOption
): Client[] {
  const getOutstanding = (clientId: string) => {
    const invs = allInvoices.filter((i) => i.clientId === clientId);
    const total = invs.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
    const paid = invs.reduce((sum, inv) => {
      const pTotal = (inv.payments || []).reduce((pSum, p) => pSum + (Number(p.amount) || 0), 0);
      return sum + pTotal;
    }, 0);
    return Math.max(0, total - paid);
  };

  return [...clientList].sort((a, b) => {
    switch (sortOption) {
      case 'a-to-z':
        return a.name.localeCompare(b.name);
      case 'z-to-a':
        return b.name.localeCompare(a.name);
      case 'newest-added':
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      case 'highest-balance':
        return getOutstanding(b.id) - getOutstanding(a.id) || a.name.localeCompare(b.name);
      default:
        return 0;
    }
  });
}

function sortInvoicesList(invoiceList: Invoice[], sortOption: InvoiceSortOption): Invoice[] {
  const todayStr = new Date().toISOString().split('T')[0];

  const parseNum = (str: string) => {
    const m = str.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };

  return [...invoiceList].sort((a, b) => {
    switch (sortOption) {
      case 'newest':
        return (
          new Date(b.date || b.createdAt || 0).getTime() -
            new Date(a.date || a.createdAt || 0).getTime() ||
          parseNum(b.invoiceNumber) - parseNum(a.invoiceNumber)
        );
      case 'oldest':
        return (
          new Date(a.date || a.createdAt || 0).getTime() -
            new Date(b.date || b.createdAt || 0).getTime() ||
          parseNum(a.invoiceNumber) - parseNum(b.invoiceNumber)
        );
      case 'number-high-to-low':
        return (
          parseNum(b.invoiceNumber) - parseNum(a.invoiceNumber) ||
          b.invoiceNumber.localeCompare(a.invoiceNumber)
        );
      case 'number-low-to-high':
        return (
          parseNum(a.invoiceNumber) - parseNum(b.invoiceNumber) ||
          a.invoiceNumber.localeCompare(b.invoiceNumber)
        );
      case 'unpaid-first': {
        const aUnpaid = a.status !== 'paid' && a.balanceDue > 0 ? 1 : 0;
        const bUnpaid = b.status !== 'paid' && b.balanceDue > 0 ? 1 : 0;
        return (
          bUnpaid - aUnpaid ||
          new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
        );
      }
      case 'overdue-first': {
        const aOverdue =
          a.status !== 'paid' && a.balanceDue > 0 && a.dueDate && a.dueDate < todayStr ? 1 : 0;
        const bOverdue =
          b.status !== 'paid' && b.balanceDue > 0 && b.dueDate && b.dueDate < todayStr ? 1 : 0;
        return (
          bOverdue - aOverdue ||
          new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
        );
      }
      default:
        return 0;
    }
  });
}

export default function App() {
  const [view, setView] = useState<ViewMode>({ type: 'dashboard' });
  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [clientSort, setClientSort] = useState<ClientSortOption>('a-to-z');
  const [invoiceSort, setInvoiceSort] = useState<InvoiceSortOption>('newest');

  // Trigger re-renders when data updates
  const [dataVersion, setDataVersion] = useState(0);
  const refreshData = () => setDataVersion((v) => v + 1);

  // Auto-subscribe to TradePayDB data changes across the app
  useEffect(() => {
    const unsubscribe = TradePayDB.subscribe(() => {
      setDataVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const clients = useMemo(() => TradePayDB.getClients(), [dataVersion]);
  const invoices = useMemo(() => TradePayDB.getInvoices(), [dataVersion]);
  const projects = useMemo(() => TradePayDB.getProjects(), [dataVersion]);
  const jobs = useMemo(() => TradePayDB.getJobs(), [dataVersion]);
  const quotes = useMemo(() => TradePayDB.getQuotes(), [dataVersion]);

  // Draft invoices
  const draftInvoices = useMemo(
    () => invoices.filter((inv) => inv.status === 'draft'),
    [invoices]
  );

  // Search filtering & sorting
  const filteredClients = useMemo(() => {
    let list = clients;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone.toLowerCase().includes(q) ||
          c.address.toLowerCase().includes(q)
      );
    }
    return sortClientsList(list, invoices, clientSort);
  }, [clients, invoices, searchQuery, clientSort]);

  const filteredInvoices = useMemo(() => {
    let list = invoices;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((inv) => {
        const client = clients.find((c) => c.id === inv.clientId);
        const clientName = client ? client.name.toLowerCase() : '';
        return (
          inv.invoiceNumber.toLowerCase().includes(q) ||
          clientName.includes(q) ||
          inv.status.toLowerCase().includes(q)
        );
      });
    }
    return sortInvoicesList(list, invoiceSort);
  }, [invoices, clients, searchQuery, invoiceSort]);

  const getStatusBadge = (status: InvoiceStatus) => {
    switch (status) {
      case 'paid':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3" /> Paid
          </span>
        );
      case 'partly paid':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <CreditCard className="w-3 h-3" /> Partly Paid
          </span>
        );
      case 'sent':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <Clock className="w-3 h-3" /> Sent
          </span>
        );
      case 'draft':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
            <AlertCircle className="w-3 h-3" /> Draft
          </span>
        );
    }
  };

  // AI input handler callback
  const handleAISuccess = (aiData: AIParseResponse, contextClientId?: string) => {
    setView({
      type: 'ai-review',
      aiData,
      contextClientId,
    });
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans antialiased">
      <div className="max-w-md mx-auto min-h-screen bg-slate-50 flex flex-col shadow-xl border-x border-slate-200/80">
        {/* Toast Alert */}
        {toastMessage && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white px-4 py-2.5 rounded-xl shadow-lg text-xs font-medium flex items-center gap-2 animate-fade-in border border-slate-800">
            <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
            {toastMessage}
          </div>
        )}

        {/* ----------------- DASHBOARD VIEW ----------------- */}
        {view.type === 'dashboard' && (
          <div className="flex-1 pb-12">
            {/* Header */}
            <header className="bg-[#0B1528] text-white pt-6 pb-6 px-4 rounded-b-3xl shadow-md border-b border-[#1b2b48]">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-yellow-400 flex items-center justify-center font-black text-slate-950 text-lg shadow-sm">
                    T
                  </div>
                  <div>
                    <h1 className="text-xl font-black tracking-tight text-white flex items-center gap-1">
                      Trade<span className="text-yellow-400">Pay</span>
                    </h1>
                    <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
                      UK Trades Invoicing
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => showToast('Coming soon')}
                    className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300 transition-colors cursor-pointer"
                    aria-label="Notifications"
                  >
                    <Bell className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => showToast('Coming soon')}
                    className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300 transition-colors cursor-pointer"
                    aria-label="Settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* TASK 2: Integrated AI Input Bar on Dashboard */}
              <div className="mb-4">
                <AIInputBar
                  pageContext={{ page: 'dashboard' }}
                  onSuccess={(data) => handleAISuccess(data)}
                />
              </div>

              {/* General Search Bar */}
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search clients, invoices, status..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[#14233D] text-white placeholder-slate-400 text-xs rounded-xl pl-10 pr-4 py-2.5 border border-slate-700/60 focus:outline-none focus:border-yellow-400 transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </header>

            {/* Dashboard Cards Grid */}
            <main className="p-4 space-y-4">
              {/* 1. Drafts Card */}
              <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-amber-50/50 border-b border-amber-200/50 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <FileClock className="w-4 h-4 text-amber-700" />
                    <h2 className="font-bold text-sm text-slate-900">Drafts</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-200 text-amber-900">
                      {draftInvoices.length}
                    </span>
                  </div>
                  <button
                    onClick={() => setView({ type: 'invoice-form' })}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-900 text-xs font-bold hover:bg-amber-500/30 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" /> Draft
                  </button>
                </div>

                <div className="max-h-[292px] overflow-y-auto divide-y divide-slate-100">
                  {draftInvoices.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      No drafts yet
                    </div>
                  ) : (
                    draftInvoices.map((inv) => {
                      const client = clients.find((c) => c.id === inv.clientId);
                      return (
                        <div
                          key={inv.id}
                          onClick={() => setView({ type: 'invoice-form', invoiceId: inv.id })}
                          className="p-3.5 hover:bg-amber-50/30 cursor-pointer flex items-center justify-between transition-colors"
                        >
                          <div className="min-w-0 flex-1 pr-3">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="font-bold text-xs text-slate-900">
                                {inv.invoiceNumber}
                              </span>
                              <span className="px-2 py-0.2 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                                Draft
                              </span>
                            </div>
                            <p className="text-xs text-slate-600 truncate font-medium">
                              {client ? client.name : 'Unassigned Client'}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {inv.lineItems.length} item{inv.lineItems.length === 1 ? '' : 's'} •{' '}
                              {inv.date}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-sm text-slate-900">
                              {formatPenceToGBP(inv.total)}
                            </p>
                            <span className="text-[10px] text-amber-700 font-semibold flex items-center gap-0.5 justify-end">
                              Resume <ChevronRight className="w-3 h-3" />
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              {/* 2. Invoices Card */}
              <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-200/70 flex items-center justify-between gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setView({ type: 'all-invoices' })}
                    className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer group text-left min-w-0"
                    title="View all invoices"
                  >
                    <FileText className="w-4 h-4 text-[#0B1528] shrink-0" />
                    <h2 className="font-bold text-sm text-slate-900 group-hover:underline truncate">Invoices</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-yellow-400/30 text-slate-900 border border-yellow-400/40 shrink-0">
                      {invoices.length}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-700 shrink-0" />
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={invoiceSort}
                      onChange={(e) => setInvoiceSort(e.target.value as InvoiceSortOption)}
                      className="text-[11px] font-medium text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-yellow-400 cursor-pointer"
                      aria-label="Sort invoices"
                    >
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                      <option value="number-high-to-low">Number high to low</option>
                      <option value="number-low-to-high">Number low to high</option>
                      <option value="unpaid-first">Unpaid first</option>
                      <option value="overdue-first">Overdue first</option>
                    </select>
                    <button
                      onClick={() => setView({ type: 'invoice-form' })}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0B1528] text-yellow-400 text-xs font-bold hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" /> New
                    </button>
                  </div>
                </div>

                <div className="max-h-[292px] overflow-y-auto divide-y divide-slate-100">
                  {filteredInvoices.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      No invoices yet
                    </div>
                  ) : (
                    filteredInvoices.map((inv) => {
                      const client = clients.find((c) => c.id === inv.clientId);
                      return (
                        <div
                          key={inv.id}
                          onClick={() => setView({ type: 'invoice-form', invoiceId: inv.id })}
                          className="p-3.5 hover:bg-slate-50/80 cursor-pointer flex items-center justify-between transition-colors"
                        >
                          <div className="min-w-0 flex-1 pr-3">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-bold text-xs text-[#0B1528]">
                                {inv.invoiceNumber}
                              </span>
                              {getStatusBadge(inv.status)}
                            </div>
                            <p className="text-xs font-medium text-slate-700 truncate">
                              {client ? client.name : 'Unknown Client'}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              Due: {inv.dueDate || 'Upon receipt'}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-sm text-slate-900">
                              {formatPenceToGBP(inv.total)}
                            </p>
                            {inv.balanceDue > 0 && inv.status !== 'paid' && (
                              <p className="text-[10px] font-semibold text-rose-600">
                                Due: {formatPenceToGBP(inv.balanceDue)}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              {/* 3. Clients Card */}
              <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-200/70 flex items-center justify-between gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setView({ type: 'all-clients' })}
                    className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer group text-left min-w-0"
                    title="View all clients"
                  >
                    <User className="w-4 h-4 text-[#0B1528] shrink-0" />
                    <h2 className="font-bold text-sm text-slate-900 group-hover:underline truncate">Clients</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-800 shrink-0">
                      {clients.length}
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-700 shrink-0" />
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={clientSort}
                      onChange={(e) => setClientSort(e.target.value as ClientSortOption)}
                      className="text-[11px] font-medium text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-yellow-400 cursor-pointer"
                      aria-label="Sort clients"
                    >
                      <option value="a-to-z">A to Z</option>
                      <option value="z-to-a">Z to A</option>
                      <option value="newest">Newest added</option>
                      <option value="highest-balance">Highest balance owed</option>
                    </select>
                    <button
                      onClick={() => setView({ type: 'client-form' })}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0B1528] text-yellow-400 text-xs font-bold hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add
                    </button>
                  </div>
                </div>

                <div className="max-h-[292px] overflow-y-auto divide-y divide-slate-100">
                  {filteredClients.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400">
                      No clients yet
                    </div>
                  ) : (
                    filteredClients.map((c) => {
                      const clientInvoices = invoices.filter((i) => i.clientId === c.id);
                      const totalInvoiced = clientInvoices.reduce(
                        (sum, inv) => sum + (Number(inv.total) || 0),
                        0
                      );
                      const totalPaid = clientInvoices.reduce((sum, inv) => {
                        const paid = (inv.payments || []).reduce(
                          (pSum, p) => pSum + (Number(p.amount) || 0),
                          0
                        );
                        return sum + paid;
                      }, 0);
                      const outstanding = Math.max(0, totalInvoiced - totalPaid);
                      const isZero = outstanding === 0;

                      return (
                        <div
                          key={c.id}
                          onClick={() => setView({ type: 'client-view', clientId: c.id })}
                          className="p-3.5 hover:bg-slate-50/80 cursor-pointer flex items-center justify-between transition-colors"
                        >
                          <div className="min-w-0 flex-1 pr-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-bold text-xs text-slate-900 truncate">
                                {c.name}
                              </h3>
                              <span
                                className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                  isZero
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                    : 'bg-amber-50 text-amber-800 border-amber-200'
                                }`}
                              >
                                {formatPenceToGBP(outstanding)}
                              </span>
                              {c.status === 'please_confirm' && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold border border-amber-200">
                                  Confirm Details
                                </span>
                              )}
                              {c.contacts.length > 0 && (
                                <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded font-medium">
                                  +{c.contacts.length}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 truncate mt-0.5">
                              {c.phone || c.email || c.address || 'No phone/email'}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 text-slate-400 shrink-0">
                            <span className="text-[11px] font-semibold text-slate-600">
                              {clientInvoices.length} {clientInvoices.length === 1 ? 'inv' : 'invs'}
                            </span>
                            <ChevronRight className="w-4 h-4" />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              {/* 4. Projects Card (Placeholder) */}
              <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-200/70 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-slate-600" />
                    <h2 className="font-bold text-sm text-slate-900">Projects</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">
                      {projects.length}
                    </span>
                  </div>
                  <button
                    onClick={() => showToast('Coming soon')}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 text-center text-xs text-slate-400">
                  Coming soon
                </div>
              </section>

              {/* 5. Jobs Card (Placeholder) */}
              <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-200/70 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-slate-600" />
                    <h2 className="font-bold text-sm text-slate-900">Jobs</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">
                      {jobs.length}
                    </span>
                  </div>
                  <button
                    onClick={() => showToast('Coming soon')}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 text-center text-xs text-slate-400">
                  Coming soon
                </div>
              </section>

              {/* 6. Quotes Card (Placeholder) */}
              <section className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-200/70 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <QuoteIcon className="w-4 h-4 text-slate-600" />
                    <h2 className="font-bold text-sm text-slate-900">Quotes</h2>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">
                      {quotes.length}
                    </span>
                  </div>
                  <button
                    onClick={() => showToast('Coming soon')}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 text-center text-xs text-slate-400">
                  Coming soon
                </div>
              </section>
            </main>
          </div>
        )}

        {/* ----------------- ALL CLIENTS VIEW (TASK 7) ----------------- */}
        {view.type === 'all-clients' && (
          <AllClientsView
            clients={clients}
            invoices={invoices}
            sort={clientSort}
            onSortChange={setClientSort}
            onBack={() => setView({ type: 'dashboard' })}
            onSelectClient={(clientId) =>
              setView({ type: 'client-view', clientId, fromView: 'all-clients' })
            }
            onAddClient={() => setView({ type: 'client-form' })}
          />
        )}

        {/* ----------------- ALL INVOICES VIEW (TASK 7) ----------------- */}
        {view.type === 'all-invoices' && (
          <AllInvoicesView
            invoices={invoices}
            clients={clients}
            sort={invoiceSort}
            onSortChange={setInvoiceSort}
            onBack={() => setView({ type: 'dashboard' })}
            onSelectInvoice={(invoiceId) =>
              setView({ type: 'invoice-form', invoiceId, fromView: 'all-invoices' })
            }
            onCreateInvoice={() => setView({ type: 'invoice-form' })}
            getStatusBadge={getStatusBadge}
          />
        )}

        {/* ----------------- CLIENT VIEW ----------------- */}
        {view.type === 'client-view' && (
          <ClientDetailView
            clientId={view.clientId}
            onBack={() => {
              if (view.fromView === 'all-clients') {
                setView({ type: 'all-clients' });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
            onEditClient={() => setView({ type: 'client-form', clientId: view.clientId })}
            onCreateInvoice={() =>
              setView({ type: 'invoice-form', prefilledClientId: view.clientId })
            }
            onSelectInvoice={(invoiceId) =>
              setView({ type: 'invoice-form', invoiceId, prefilledClientId: view.clientId })
            }
            getStatusBadge={getStatusBadge}
            onDataChange={refreshData}
            onAISuccess={(data) => handleAISuccess(data, view.clientId)}
          />
        )}

        {/* ----------------- CLIENT FORM (ADD/EDIT) ----------------- */}
        {view.type === 'client-form' && (
          <ClientFormView
            clientId={view.clientId}
            onBack={() => {
              if (view.clientId) {
                setView({ type: 'client-view', clientId: view.clientId });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
            onSaved={(savedClient) => {
              refreshData();
              showToast(view.clientId ? 'Client updated' : 'Client created');
              setView({ type: 'client-view', clientId: savedClient.id });
            }}
          />
        )}

        {/* ----------------- INVOICE EDITOR (MANUAL / EDIT) ----------------- */}
        {view.type === 'invoice-form' && (
          <InvoiceEditorView
            invoiceId={view.invoiceId}
            prefilledClientId={view.prefilledClientId}
            onBack={() => {
              if (view.prefilledClientId) {
                setView({ type: 'client-view', clientId: view.prefilledClientId });
              } else if (view.fromView === 'all-invoices') {
                setView({ type: 'all-invoices' });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
            onSaved={(savedInvoice) => {
              refreshData();
              showToast(`Invoice ${savedInvoice.invoiceNumber} saved!`);
              if (view.prefilledClientId) {
                setView({ type: 'client-view', clientId: view.prefilledClientId });
              } else if (view.fromView === 'all-invoices') {
                setView({ type: 'all-invoices' });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
            onDelete={() => {
              refreshData();
              showToast('Invoice deleted');
              if (view.prefilledClientId) {
                setView({ type: 'client-view', clientId: view.prefilledClientId });
              } else if (view.fromView === 'all-invoices') {
                setView({ type: 'all-invoices' });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
            onOpenAddClient={() => setView({ type: 'client-form' })}
          />
        )}

        {/* ----------------- AI REVIEW SCREEN (TASK 2) ----------------- */}
        {view.type === 'ai-review' && (
          <AIReviewScreen
            aiData={view.aiData}
            contextClientId={view.contextClientId}
            onBack={() => {
              if (view.contextClientId) {
                setView({ type: 'client-view', clientId: view.contextClientId });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
            onSaved={(draftInvoice) => {
              refreshData();
              showToast(`Draft invoice ${draftInvoice.invoiceNumber} saved to Drafts!`);
              if (view.contextClientId) {
                setView({ type: 'client-view', clientId: view.contextClientId });
              } else {
                setView({ type: 'dashboard' });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

// Reusable In-App Confirmation / Alert Dialog for AI Studio preview
interface ConfirmationDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDanger?: boolean;
  isAlert?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isDanger = false,
  isAlert = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]">
      <div className="bg-white w-full max-w-xs rounded-2xl p-5 shadow-2xl border border-slate-200/90 text-center space-y-4 animate-in fade-in zoom-in-95 duration-100">
        {title && (
          <h3 className="text-sm font-bold text-slate-900">{title}</h3>
        )}
        <p className="text-xs text-slate-600 leading-relaxed font-medium">{message}</p>
        <div className={`grid gap-2 pt-1 ${isAlert ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {!isAlert && (
            <button
              type="button"
              onClick={onCancel}
              className="w-full py-2 px-3 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 cursor-pointer transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className={`w-full py-2 px-3 rounded-xl text-xs font-bold text-white cursor-pointer transition-colors shadow-sm ${
              isDanger
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-[#0B1528] hover:bg-slate-800 text-yellow-400'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// TASK 8: SEND INVOICE SHEET (Share / WhatsApp / Email / PDF)
// ==========================================
interface SendInvoiceSheetProps {
  isOpen: boolean;
  invoice: Invoice;
  client?: Client;
  onClose: () => void;
}

function SendInvoiceSheet({
  isOpen,
  invoice,
  client,
  onClose,
}: SendInvoiceSheetProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  if (!isOpen) return null;

  const handleShare = async () => {
    setIsSharing(true);
    setNotice(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        const file = getInvoicePDFFile(invoice, client);
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: `Invoice ${invoice.invoiceNumber}`,
            text: `Invoice ${invoice.invoiceNumber} from TradePay for ${formatPenceToGBP(invoice.total)}`,
            files: [file],
          });
          return;
        }
      }
      // If Web Share API or file sharing not supported:
      downloadInvoicePDF(invoice, client);
      setNotice('PDF downloaded. Attach it to the message.');
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name !== 'AbortError') {
        downloadInvoicePDF(invoice, client);
        setNotice('PDF downloaded. Attach it to the message.');
      }
    } finally {
      setIsSharing(false);
    }
  };

  const handleWhatsApp = () => {
    downloadInvoicePDF(invoice, client);
    setNotice('PDF downloaded. Attach it to the message.');

    const clientName = client?.name || 'Customer';
    const msg = `Hi ${clientName}, please find attached invoice ${invoice.invoiceNumber} for ${formatPenceToGBP(
      invoice.total
    )} from TradePay. Due date: ${invoice.dueDate || 'Upon receipt'}. Balance due: ${formatPenceToGBP(
      invoice.balanceDue
    )}.`;

    let cleanPhone = (client?.phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '44' + cleanPhone.slice(1);
    }
    const waUrl = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;

    try {
      const a = document.createElement('a');
      a.href = waUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // fallback
    }
  };

  const handleEmail = () => {
    downloadInvoicePDF(invoice, client);
    setNotice('PDF downloaded. Attach it to the message.');

    const clientName = client?.name || 'Customer';
    const subject = `Invoice ${invoice.invoiceNumber} from TradePay`;
    const body = `Hi ${clientName},\n\nPlease find attached invoice ${invoice.invoiceNumber} for ${formatPenceToGBP(
      invoice.total
    )}.\nPayment Due: ${invoice.dueDate || 'Upon receipt'}\nBalance Due: ${formatPenceToGBP(
      invoice.balanceDue
    )}\n\nThank you for your business!`;
    const emailTo = client?.email || '';
    const mailtoUrl = `mailto:${encodeURIComponent(emailTo)}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;

    try {
      const a = document.createElement('a');
      a.href = mailtoUrl;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // fallback
    }
  };

  const handleDownloadOnly = () => {
    downloadInvoicePDF(invoice, client);
    setNotice('PDF downloaded. Attach it to the message.');
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-3 animate-fade-in">
      <div className="bg-white w-full max-w-sm rounded-3xl p-5 shadow-2xl border border-slate-200/90 space-y-4 animate-in slide-in-from-bottom duration-200">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-black text-slate-900">Send Invoice</h3>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                Sent
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {invoice.invoiceNumber} • {client?.name || 'Customer'} • {formatPenceToGBP(invoice.total)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Notice Banner */}
        {notice && (
          <div className="p-3 bg-amber-50/90 border border-amber-200 rounded-xl text-xs text-amber-900 font-medium flex items-center gap-2 animate-fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {/* Send Action Options */}
        <div className="space-y-2">
          {/* 1. Share Option */}
          <button
            type="button"
            onClick={handleShare}
            disabled={isSharing}
            className="w-full p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 border border-slate-200 flex items-center justify-between cursor-pointer transition-colors group text-left"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#0B1528] text-yellow-400 flex items-center justify-center shrink-0 shadow-xs">
                {isSharing ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Share2 className="w-5 h-5" />
                )}
              </div>
              <div>
                <p className="text-xs font-bold text-slate-900">Share</p>
                <p className="text-[11px] text-slate-500">System share sheet with PDF</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700" />
          </button>

          {/* 2. WhatsApp Option */}
          <button
            type="button"
            onClick={handleWhatsApp}
            className="w-full p-3 rounded-2xl bg-emerald-50/60 hover:bg-emerald-50 border border-emerald-200/80 flex items-center justify-between cursor-pointer transition-colors group text-left"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                <MessageCircle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-900">WhatsApp</p>
                <p className="text-[11px] text-slate-500 truncate">
                  {client?.phone ? `Send to ${client.phone}` : 'Open chat with prepared message'}
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700" />
          </button>

          {/* 3. Email Option */}
          <button
            type="button"
            onClick={handleEmail}
            className="w-full p-3 rounded-2xl bg-blue-50/60 hover:bg-blue-50 border border-blue-200/80 flex items-center justify-between cursor-pointer transition-colors group text-left"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                <Mail className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-900">Email</p>
                <p className="text-[11px] text-slate-500 truncate">
                  {client?.email ? `Send to ${client.email}` : 'Open email with subject & body'}
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700" />
          </button>

          {/* 4. Download PDF */}
          <button
            type="button"
            onClick={handleDownloadOnly}
            className="w-full p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 border border-slate-200 flex items-center justify-between cursor-pointer transition-colors group text-left"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-200 text-slate-800 flex items-center justify-center shrink-0 shadow-xs">
                <FileDown className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-slate-900">Download PDF</p>
                <p className="text-[11px] text-slate-500">Save copy directly to device</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700" />
          </button>
        </div>

        {/* Done Button */}
        <div className="pt-1">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 px-4 rounded-xl bg-[#0B1528] hover:bg-slate-800 text-yellow-400 font-bold text-xs shadow-md transition-colors cursor-pointer text-center"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Helper to resize images in browser (max 1600px longest side, JPEG quality 0.8)
function resizeImageFile(file: File): Promise<{ base64: string; mimeType: string }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = (err) => {
      console.error('[Client] FileReader error:', err);
      reject(new Error(`Failed to read file "${file.name}"`));
    };
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => {
        reject(new Error(`Failed to load image "${file.name}" for resizing`));
      };
      img.onload = () => {
        const MAX_DIM = 1600;
        let width = img.width;
        let height = img.height;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return resolve({ base64: e.target?.result as string, mimeType: file.type || 'image/jpeg' });
        }
        ctx.drawImage(img, 0, 0, width, height);
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.8);
        const durationMs = Date.now() - start;
        console.log(
          `[Client] Resized "${file.name}" from ${img.width}x${img.height} to ${width}x${height} in ${durationMs}ms (Base64 size: ${(compressedBase64.length / 1024).toFixed(1)} KB)`
        );
        resolve({ base64: compressedBase64, mimeType: 'image/jpeg' });
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// ==========================================
// TASK 2: UNIVERSAL AI INPUT BAR
// (Available on Dashboard and Client Page)
// ==========================================
function AIInputBar({
  pageContext,
  onSuccess,
}: {
  pageContext: { page: 'dashboard' | 'client'; clientId?: string; clientName?: string };
  onSuccess: (data: AIParseResponse) => void;
}) {
  const [textInput, setTextInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioData, setAudioData] = useState<{ mimeType: string; base64: string } | null>(null);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingElapsed, setProcessingElapsed] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [maxImagesAlert, setMaxImagesAlert] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // Clean up recording timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Track processing elapsed seconds for clear user feedback
  useEffect(() => {
    let pTimer: NodeJS.Timeout | null = null;
    if (isProcessing) {
      setProcessingElapsed(0);
      pTimer = setInterval(() => {
        setProcessingElapsed((s) => s + 1);
      }, 1000);
    } else {
      setProcessingElapsed(0);
    }
    return () => {
      if (pTimer) clearInterval(pTimer);
    };
  }, [isProcessing]);

  // Audio Recording (Raw audio directly to Gemini, no browser speech-to-text, up to 3 mins)
  const startRecording = async () => {
    try {
      setErrorMessage(null);
      console.log('[Client] Requesting microphone via getUserMedia...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];

      // Determine mime type supported
      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
          mimeType = 'audio/ogg';
        }
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result as string;
          console.log(`[Client] Audio recorded: ${(base64Audio.length / 1024).toFixed(1)} KB (${mimeType})`);
          setAudioData({
            mimeType,
            base64: base64Audio,
          });
        };
        reader.readAsDataURL(audioBlob);

        // Stop all audio tracks
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start(250);
      setIsRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds((sec) => {
          if (sec >= 179) {
            // Reached 3-minute max limit
            console.log('[Client] Reached 3-minute recording limit (180s). Auto-stopping.');
            setTimeout(() => stopRecording(), 0);
            return 180;
          }
          return sec + 1;
        });
      }, 1000);
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      console.error('[TradePay Mic Error]', error?.name, error?.message, err);
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        setErrorMessage(
          'Microphone permission blocked (NotAllowedError). Please allow microphone access in your browser or iframe.'
        );
      } else if (error?.name === 'NotFoundError') {
        setErrorMessage('No microphone device found on this system (NotFoundError).');
      } else {
        setErrorMessage(`Microphone error: ${error?.name || 'Unknown'} - ${error?.message || 'Access unavailable'}`);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  // Image Upload Handling (Up to 5 images, resized before sending: max 1600px, 0.8 quality)
  const handleImageFiles = async (files: FileList | null) => {
    if (!files) return;
    const remainingSlots = 5 - images.length;
    if (remainingSlots <= 0) {
      setMaxImagesAlert(true);
      return;
    }

    const filesToLoad = Array.from(files).slice(0, remainingSlots);
    for (const file of filesToLoad) {
      try {
        const resized = await resizeImageFile(file);
        setImages((prev) => {
          if (prev.length >= 5) return prev;
          return [
            ...prev,
            {
              id: 'img_' + Math.random().toString(36).substring(2, 7),
              name: file.name,
              mimeType: resized.mimeType,
              base64: resized.base64,
              previewUrl: resized.base64,
            },
          ];
        });
      } catch (err: unknown) {
        console.error('[Client] Image resize error:', err);
        setErrorMessage(`Failed to process image "${file.name}".`);
      }
    }
  };

  const removeImage = (id: string) => {
    setImages(images.filter((img) => img.id !== id));
  };

  const removeAudio = () => {
    setAudioData(null);
    setRecordingSeconds(0);
  };

  // Send raw audio and images directly to Gemini with 30s timeout
  const handleProcess = async () => {
    if (!textInput.trim() && !audioData && images.length === 0) {
      setErrorMessage('Please record audio, upload a receipt/image, or type a note first.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 30000);

    const clientStart = Date.now();
    try {
      const payload = {
        audio: audioData,
        images: images.map((img) => ({
          mimeType: img.mimeType,
          base64: img.base64,
        })),
        text: textInput,
        pageContext,
      };

      console.log(
        `[Client] Dispatching parse request (Text length: ${textInput.length}, Audio: ${Boolean(audioData)}, Images: ${images.length})`
      );

      const response = await fetch('/api/ai/parse-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const clientRoundtrip = Date.now() - clientStart;
      console.log(`[Client] Network fetch finished in ${clientRoundtrip}ms`);

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || `Server responded with status ${response.status}`);
      }

      console.log('[Client] AI extraction successful:', result.timing);

      // Success: notify parent with extracted JSON
      onSuccess(result.data);

      // Reset input bar state only after successful transition
      setTextInput('');
      setAudioData(null);
      setImages([]);
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const error = err as { name?: string; message?: string };
      console.error('[Client] AI processing error:', error);
      if (error?.name === 'AbortError') {
        setErrorMessage(
          'Processing timed out after 30 seconds. Your inputs have been kept safe — please check your network and try again.'
        );
      } else {
        setErrorMessage(
          error?.message ||
            'Failed to connect to Gemini. Your inputs have been kept safe — please check your connection and retry.'
        );
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}:${s.toString().padStart(2, '0')}`;
  };

  const hasAnyInput = Boolean(textInput.trim() || audioData || images.length > 0 || isRecording);

  return (
    <div className="bg-[#14233D] rounded-2xl p-3 border border-slate-700/80 shadow-inner">
      {/* Hidden file inputs for Camera and Gallery */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleImageFiles(e.target.files)}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleImageFiles(e.target.files)}
      />

      {/* Error Banner with Retry reminder */}
      {errorMessage && (
        <div className="mb-2.5 p-2.5 rounded-xl bg-rose-950/80 border border-rose-700/80 text-rose-200 text-xs flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-rose-300 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Live Processing State Banner with animated moving dots (no timer) */}
      {isProcessing && (
        <div className="mb-2.5 p-3 rounded-xl bg-yellow-400/15 border border-yellow-400/40 text-yellow-200 text-xs flex items-center gap-2.5">
          <Loader2 className="w-4 h-4 text-yellow-400 animate-spin shrink-0" />
          <div className="flex items-center gap-1 font-bold text-yellow-300 text-xs">
            <span>Processing</span>
            <span className="inline-flex items-center gap-1 ml-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-bounce" style={{ animationDelay: '0ms' }}></span>
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-bounce" style={{ animationDelay: '150ms' }}></span>
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-bounce" style={{ animationDelay: '300ms' }}></span>
            </span>
          </div>
        </div>
      )}

      {/* Recording in progress indicator */}
      {isRecording && (
        <div className="mb-2.5 px-3 py-2 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-between animate-pulse">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></span>
            <span className="text-xs font-bold text-rose-300">
              Recording Voice Note: {formatTime(recordingSeconds)}
            </span>
          </div>
          <button
            type="button"
            onClick={stopRecording}
            className="px-2 py-0.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
          >
            <Square className="w-3 h-3 fill-current" /> Tap to Stop
          </button>
        </div>
      )}

      {/* Audio Captured Chip */}
      {!isRecording && audioData && (
        <div className="mb-2.5 px-3 py-1.5 rounded-xl bg-yellow-400/15 border border-yellow-400/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-yellow-400 text-slate-950 flex items-center justify-center">
              <Mic className="w-3 h-3" />
            </div>
            <span className="text-xs font-bold text-yellow-300">
              Voice note ready ({formatTime(recordingSeconds || 2)})
            </span>
          </div>
          <button
            type="button"
            onClick={removeAudio}
            className="text-slate-400 hover:text-rose-400 p-1"
            title="Remove recording"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Uploaded Images Previews (up to 5) */}
      {images.length > 0 && (
        <div className="mb-2.5 flex items-center gap-2 overflow-x-auto pb-1">
          {images.map((img) => (
            <div
              key={img.id}
              className="relative w-14 h-14 rounded-xl border border-slate-600 overflow-hidden shrink-0 group bg-slate-900"
            >
              <img
                src={img.previewUrl}
                alt="Receipt"
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-rose-600"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
          {images.length < 5 && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-14 h-14 rounded-xl border border-dashed border-slate-600 hover:border-yellow-400 text-slate-400 flex flex-col items-center justify-center text-[10px] shrink-0"
            >
              <Plus className="w-3.5 h-3.5 mb-0.5" />
              <span>+{5 - images.length}</span>
            </button>
          )}
        </div>
      )}

      {/* Text Box for Typing */}
      <textarea
        rows={2}
        placeholder={
          pageContext.page === 'client'
            ? `Type notes for ${pageContext.clientName || 'this client'} (or tap mic/camera)...`
            : 'Type notes, e.g. "Fitted boiler for Dave, 4 hours at £90, £140 parts"...'
        }
        value={textInput}
        onChange={(e) => setTextInput(e.target.value)}
        className="w-full text-xs p-2.5 rounded-xl bg-[#0B1528] text-white placeholder-slate-400 border border-slate-700/80 focus:outline-none focus:border-yellow-400 resize-none transition-colors"
      />

      {/* Action Buttons Row */}
      <div className="mt-2.5 flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          {/* Mic Button: tap to start, tap to stop */}
          <button
            type="button"
            onClick={isRecording ? stopRecording : startRecording}
            className={`p-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
              isRecording
                ? 'bg-rose-600 text-white animate-pulse'
                : audioData
                ? 'bg-yellow-400 text-slate-950 shadow-sm'
                : 'bg-white/10 hover:bg-white/15 text-slate-200'
            }`}
            title={isRecording ? 'Tap to stop' : 'Record voice note'}
          >
            {isRecording ? <Square className="w-3.5 h-3.5 fill-current" /> : <Mic className="w-3.5 h-3.5" />}
            <span className="text-[11px]">{isRecording ? 'Stop' : 'Mic'}</span>
          </button>

          {/* Camera Button */}
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/15 text-slate-200 text-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
            title="Snap photo with camera"
          >
            <Camera className="w-3.5 h-3.5" />
            <span className="text-[11px]">Camera</span>
          </button>

          {/* Gallery Button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/15 text-slate-200 text-xs font-medium flex items-center gap-1 cursor-pointer transition-colors"
            title="Upload receipts (up to 5)"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span className="text-[11px]">Gallery</span>
          </button>
        </div>

        {/* Process Button */}
        <button
          type="button"
          onClick={handleProcess}
          disabled={isProcessing || !hasAnyInput}
          className={`px-3.5 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 shadow-sm transition-all cursor-pointer ${
            isProcessing || !hasAnyInput
              ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-yellow-400 hover:bg-yellow-300 text-slate-950 active:scale-[0.97]'
          }`}
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="flex items-center gap-0.5">
                Processing
                <span className="inline-flex items-center gap-0.5 ml-0.5">
                  <span className="w-1 h-1 rounded-full bg-slate-950 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                  <span className="w-1 h-1 rounded-full bg-slate-950 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                  <span className="w-1 h-1 rounded-full bg-slate-950 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                </span>
              </span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5 text-slate-950 fill-current" />
              <span>Process</span>
            </>
          )}
        </button>
      </div>

      <ConfirmationDialog
        isOpen={maxImagesAlert}
        message="You can select a maximum of 5 images."
        isAlert={true}
        confirmLabel="OK"
        onConfirm={() => setMaxImagesAlert(false)}
      />
    </div>
  );
}

// ==========================================
// TASK 2: AI REVIEW SCREEN
// (Editable line-items table with "please confirm" highlights)
// ==========================================
function AIReviewScreen({
  aiData,
  contextClientId,
  onBack,
  onSaved,
}: {
  aiData: AIParseResponse;
  contextClientId?: string;
  onBack: () => void;
  onSaved: (invoice: Invoice) => void;
}) {
  const existingClients = TradePayDB.getClients();

  // Try to match extracted client_name with existing clients
  const matchedClient = useMemo(() => {
    if (contextClientId) {
      return existingClients.find((c) => c.id === contextClientId);
    }
    if (!aiData.client_name) return undefined;
    const nameLower = aiData.client_name.toLowerCase().trim();
    return existingClients.find(
      (c) =>
        c.name.toLowerCase().trim() === nameLower ||
        c.name.toLowerCase().includes(nameLower) ||
        nameLower.includes(c.name.toLowerCase())
    );
  }, [existingClients, aiData.client_name, contextClientId]);

  // Client Selection State
  const [selectedClientId, setSelectedClientId] = useState<string>(
    contextClientId || (matchedClient ? matchedClient.id : 'create_draft_client')
  );
  const [draftClientName, setDraftClientName] = useState<string>(
    aiData.client_name || 'New Client'
  );
  const [lineDeleteDialog, setLineDeleteDialog] = useState<{
    isOpen: boolean;
    itemId?: string;
    description?: string;
  }>({ isOpen: false });

  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().split('T')[0];
  });
  const [vatRate, setVatRate] = useState<number>(aiData.vat_rate ?? 20);
  const [notes, setNotes] = useState<string>(aiData.notes || 'Terms: 14 days.');

  // Convert AI line items to editable line item state
  interface ReviewItemState {
    id: string;
    description: string;
    type: 'material' | 'labour' | 'other';
    qtyString: string;
    unitPricePounds: string;
    uncertainQty: boolean;
    uncertainPrice: boolean;
    uncertainDesc: boolean;
  }

  const [items, setItems] = useState<ReviewItemState[]>(() => {
    const uncertainList = aiData.uncertain || [];
    return aiData.line_items.map((it, idx) => {
      const isQtyNull = it.quantity === null || it.quantity === undefined;
      const isPriceNull = it.unit_price_gbp === null || it.unit_price_gbp === undefined;

      const uncertainQty =
        isQtyNull ||
        uncertainList.some((u) => u.includes(`[${idx}].quantity`) || u === 'quantity');
      const uncertainPrice =
        isPriceNull ||
        uncertainList.some(
          (u) =>
            u.includes(`[${idx}].unit_price`) ||
            u.includes(`[${idx}].price`) ||
            u === 'unit_price_gbp'
        );
      const uncertainDesc = uncertainList.some(
        (u) => u.includes(`[${idx}].desc`) || u.includes(`[${idx}].description`)
      );

      return {
        id: 'rev_li_' + idx + '_' + Math.random().toString(36).substring(2, 6),
        description: it.description || '',
        type: it.type || 'material',
        qtyString: isQtyNull ? '' : String(it.quantity),
        unitPricePounds: isPriceNull ? '' : it.unit_price_gbp!.toFixed(2),
        uncertainQty,
        uncertainPrice,
        uncertainDesc,
      };
    });
  });

  const isClientUncertain =
    !matchedClient ||
    !aiData.client_name ||
    aiData.uncertain.includes('client_name') ||
    aiData.uncertain.includes('client');

  const isVatUncertain =
    aiData.vat_rate === null ||
    aiData.uncertain.includes('vat_rate') ||
    aiData.uncertain.includes('vat');

  // Live calculations using code maths & integer pence
  const liveTotals = useMemo(() => {
    const parsedItems = items.map((item) => ({
      quantity: parseFloat(item.qtyString) || 0,
      unitPrice: poundsToPence(item.unitPricePounds),
    }));
    return calculateInvoiceTotals(parsedItems, vatRate, 0);
  }, [items, vatRate]);

  const updateItem = (id: string, field: keyof ReviewItemState, value: string) => {
    setItems(
      items.map((it) => {
        if (it.id !== id) return it;
        const updated = { ...it, [field]: value };
        if (field === 'qtyString') updated.uncertainQty = false;
        if (field === 'unitPricePounds') updated.uncertainPrice = false;
        if (field === 'description') updated.uncertainDesc = false;
        return updated;
      })
    );
  };

  const removeItem = (id: string) => {
    if (items.length <= 1) return;
    setItems(items.filter((it) => it.id !== id));
  };

  const addLineItem = () => {
    setItems([
      ...items,
      {
        id: 'rev_li_' + Math.random().toString(36).substring(2, 7),
        description: '',
        type: 'material',
        qtyString: '1',
        unitPricePounds: '0.00',
        uncertainQty: false,
        uncertainPrice: false,
        uncertainDesc: false,
      },
    ]);
  };

  // Save as DRAFT invoice, converting pounds to pence in code
  const handleSaveDraft = () => {
    let finalClientId = contextClientId || selectedClientId;

    // Create draft client if user chose "create_draft_client" and not started from client page
    if (!contextClientId && selectedClientId === 'create_draft_client') {
      const newDraftClient = TradePayDB.saveClient({
        name: draftClientName.trim() || 'New Client (from voice/receipt)',
        phone: '',
        email: '',
        address: '',
        contacts: [],
        status: 'please_confirm',
      });
      finalClientId = newDraftClient.id;
    }

    const compiledLineItems: LineItem[] = items.map((item) => {
      const quantity = Math.max(0, parseFloat(item.qtyString) || 0);
      const unitPrice = poundsToPence(item.unitPricePounds);
      const totalPrice = calculateLineTotal(quantity, unitPrice);
      return {
        id: item.id,
        description: item.description.trim() || 'Item/Service',
        type: item.type,
        quantity,
        unitPrice,
        totalPrice,
      };
    });

    const draftInvoice = TradePayDB.saveInvoice({
      clientId: finalClientId,
      date,
      dueDate,
      lineItems: compiledLineItems,
      vatRate: Number(vatRate) || 0,
      subtotal: liveTotals.subtotal,
      vatAmount: liveTotals.vatAmount,
      total: liveTotals.total,
      amountPaid: 0,
      balanceDue: liveTotals.total,
      status: 'draft',
      notes,
    });

    onSaved(draftInvoice);
  };

  return (
    <div className="flex-1 flex flex-col pb-12">
      {/* Top Bar */}
      <div className="bg-[#0B1528] text-white px-4 py-4 rounded-b-2xl shadow-sm flex items-center justify-between sticky top-0 z-20">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" /> Cancel
        </button>
        <div className="text-center">
          <span className="text-[10px] text-yellow-400 font-bold uppercase tracking-wider flex items-center justify-center gap-1">
            <Sparkles className="w-3 h-3" /> AI Extracted Draft
          </span>
          <h2 className="text-sm font-black text-white">Review & Confirm</h2>
        </div>
        <div className="w-8"></div>
      </div>

      <div className="p-4 space-y-4">
        {/* Banner with Attention Callout */}
        <div className="bg-amber-50 p-3 rounded-2xl border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5 shadow-sm">
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">Please check highlighted fields below</p>
            <p className="text-[11px] text-amber-800 mt-0.5">
              Any missing or uncertain quantities, prices, or client details are marked with{' '}
              <span className="font-bold underline decoration-amber-500">"Please confirm"</span>.
            </p>
          </div>
        </div>

        {/* Client Selection & Match Card */}
        <div
          className={`bg-white rounded-2xl p-4 border shadow-sm transition-all ${
            !contextClientId && isClientUncertain ? 'border-amber-400 bg-amber-50/20' : 'border-slate-200/90'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-bold text-slate-800">Assigned Client</label>
              {!contextClientId && isClientUncertain && (
                <span className="text-[10px] font-bold px-2 py-0.2 rounded-full bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                  <AlertCircle className="w-2.5 h-2.5" /> Please confirm
                </span>
              )}
            </div>
            {!contextClientId && matchedClient && (
              <span className="text-[10px] text-emerald-700 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Matched: {matchedClient.name}
              </span>
            )}
          </div>

          {contextClientId ? (
            <div className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-slate-50 font-semibold text-slate-800">
              {existingClients.find((c) => c.id === contextClientId)?.name || 'Client'}
            </div>
          ) : (
            <>
              <select
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-white font-medium focus:outline-none focus:border-yellow-400"
              >
                <option value="create_draft_client">
                  + Create draft client: "{draftClientName}" (please confirm details)
                </option>
                {existingClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    Use existing: {c.name} {c.address ? `(${c.address})` : ''}
                  </option>
                ))}
              </select>

              {selectedClientId === 'create_draft_client' && (
                <div className="mt-2.5">
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">
                    Draft Client Name:
                  </label>
                  <input
                    type="text"
                    value={draftClientName}
                    onChange={(e) => setDraftClientName(e.target.value)}
                    placeholder="Enter client name"
                    className="w-full text-xs p-2 rounded-xl border border-amber-300 bg-amber-50/50 font-bold text-slate-900"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Dates */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm grid grid-cols-2 gap-2.5">
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">Invoice Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full text-xs p-2 rounded-xl border border-slate-200 font-medium"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">Payment Due</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full text-xs p-2 rounded-xl border border-slate-200 font-medium"
            />
          </div>
        </div>

        {/* Editable Line Items Table with Highlights */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between">
            <h3 className="font-bold text-xs uppercase tracking-wider text-slate-900">
              Extracted Line Items ({items.length})
            </h3>
            <span className="text-[10px] text-slate-500 font-medium">One item per line</span>
          </div>

          <div className="p-3 space-y-3">
            {items.map((item, index) => {
              const lineQty = parseFloat(item.qtyString) || 0;
              const unitPricePence = poundsToPence(item.unitPricePounds);
              const calculatedTotalPence = calculateLineTotal(lineQty, unitPricePence);

              return (
                <div
                  key={item.id}
                  className={`p-3 rounded-xl border space-y-2 relative transition-all ${
                    item.uncertainPrice || item.uncertainQty
                      ? 'bg-amber-50/40 border-amber-300'
                      : 'bg-slate-50/70 border-slate-200/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-500">#{index + 1}</span>
                    <select
                      value={item.type}
                      onChange={(e) =>
                        updateItem(item.id, 'type', e.target.value as 'material' | 'labour' | 'other')
                      }
                      className="text-[11px] bg-white border border-slate-200 rounded-lg px-2 py-0.5 font-bold text-slate-700"
                    >
                      <option value="material">Material</option>
                      <option value="labour">Labour</option>
                      <option value="other">Other</option>
                    </select>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setLineDeleteDialog({
                            isOpen: true,
                            itemId: item.id,
                            description: item.description,
                          })
                        }
                        className="text-slate-400 hover:text-rose-600 transition-colors ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Description Input */}
                  <div>
                    <input
                      type="text"
                      placeholder="Item description..."
                      value={item.description}
                      onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                      className={`w-full text-xs p-2 bg-white rounded-lg border font-medium ${
                        item.uncertainDesc ? 'border-amber-400' : 'border-slate-200'
                      }`}
                    />
                  </div>

                  {/* Quantity & Unit Price with "Please confirm" Highlights */}
                  <div className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-3">
                      <div className="flex items-center justify-between mb-0.5">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">
                          Qty
                        </label>
                        {item.uncertainQty && (
                          <span className="text-[8px] font-bold text-amber-700 uppercase">
                            Confirm
                          </span>
                        )}
                      </div>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        placeholder="Qty"
                        value={item.qtyString}
                        onChange={(e) => updateItem(item.id, 'qtyString', e.target.value)}
                        className={`w-full text-xs p-1.5 rounded-lg border text-center font-bold ${
                          item.uncertainQty
                            ? 'border-amber-400 bg-amber-50 text-amber-900 ring-2 ring-amber-300/40'
                            : 'border-slate-200 bg-white'
                        }`}
                      />
                    </div>

                    <div className="col-span-4">
                      <div className="flex items-center justify-between mb-0.5">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">
                          Price (£)
                        </label>
                        {item.uncertainPrice && (
                          <span className="text-[8px] font-bold text-amber-700 uppercase">
                            Confirm
                          </span>
                        )}
                      </div>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="£0.00"
                        value={item.unitPricePounds}
                        onChange={(e) => updateItem(item.id, 'unitPricePounds', e.target.value)}
                        className={`w-full text-xs p-1.5 rounded-lg border text-right font-bold ${
                          item.uncertainPrice
                            ? 'border-amber-400 bg-amber-50 text-amber-900 ring-2 ring-amber-300/40'
                            : 'border-slate-200 bg-white'
                        }`}
                      />
                    </div>

                    <div className="col-span-5 text-right pl-2">
                      <span className="block text-[10px] text-slate-400 font-bold uppercase mb-0.5">
                        Total
                      </span>
                      <p className="text-xs font-bold text-slate-900">
                        {formatPenceToGBP(calculatedTotalPence)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addLineItem}
              className="w-full py-2.5 rounded-xl border border-dashed border-slate-300 hover:border-slate-400 bg-white text-slate-700 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-yellow-500" /> Add Another Line
            </button>
          </div>
        </div>

        {/* VAT & Totals */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-bold text-slate-700">VAT Rate (%)</label>
              {isVatUncertain && (
                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-100 text-amber-800">
                  Confirm
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {[0, 5, 20].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setVatRate(rate)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                    vatRate === rate
                      ? 'bg-[#0B1528] text-yellow-400'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {rate}%
                </button>
              ))}
              <input
                type="number"
                min="0"
                max="100"
                value={vatRate}
                onChange={(e) => setVatRate(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 text-xs p-1 text-center font-bold border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-1.5 text-xs">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal:</span>
              <span className="font-semibold text-slate-800">
                {formatPenceToGBP(liveTotals.subtotal)}
              </span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>VAT ({vatRate}%):</span>
              <span className="font-semibold text-slate-800">
                {formatPenceToGBP(liveTotals.vatAmount)}
              </span>
            </div>
            <div className="flex justify-between text-sm font-black text-slate-900 pt-1 border-t border-slate-200">
              <span>Calculated Total:</span>
              <span className="text-[#0B1528]">{formatPenceToGBP(liveTotals.total)}</span>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Notes / Terms
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full text-xs p-2 rounded-xl border border-slate-200 resize-none focus:outline-none focus:border-yellow-400"
            />
          </div>
        </div>

        {/* Save as Draft Button */}
        <div className="pt-2">
          <button
            type="button"
            onClick={handleSaveDraft}
            className="w-full py-3.5 px-4 rounded-xl bg-[#0B1528] hover:bg-slate-800 text-yellow-400 font-black text-sm shadow-md transition-all cursor-pointer flex items-center justify-center gap-2 active:scale-[0.98]"
          >
            <FileClock className="w-4 h-4" /> Save as Draft Invoice
          </button>
          <p className="text-center text-[10px] text-slate-500 mt-2">
            Draft invoice will appear in the Drafts list.
          </p>
        </div>
      </div>

      <ConfirmationDialog
        isOpen={lineDeleteDialog.isOpen}
        message={
          lineDeleteDialog.description
            ? `Delete "${lineDeleteDialog.description}"?`
            : 'Delete this line item?'
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        isDanger={true}
        onCancel={() => setLineDeleteDialog({ isOpen: false })}
        onConfirm={() => {
          if (lineDeleteDialog.itemId) {
            removeItem(lineDeleteDialog.itemId);
          }
          setLineDeleteDialog({ isOpen: false });
        }}
      />
    </div>
  );
}

// ==========================================
// TASK 7: FULL-PAGE ALL CLIENTS VIEW
// ==========================================
function AllClientsView({
  clients,
  invoices,
  sort,
  onSortChange,
  onBack,
  onSelectClient,
  onAddClient,
}: {
  clients: Client[];
  invoices: Invoice[];
  sort: ClientSortOption;
  onSortChange: (sort: ClientSortOption) => void;
  onBack: () => void;
  onSelectClient: (clientId: string) => void;
  onAddClient: () => void;
}) {
  const [search, setSearch] = useState('');

  const filteredClients = useMemo(() => {
    let list = clients;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => {
        const matchName = c.name.toLowerCase().includes(q);
        const matchPhone = c.phone ? c.phone.toLowerCase().includes(q) : false;
        const matchEmail = c.email ? c.email.toLowerCase().includes(q) : false;
        return matchName || matchPhone || matchEmail;
      });
    }
    return sortClientsList(list, invoices, sort);
  }, [clients, invoices, search, sort]);

  return (
    <div className="flex-1 flex flex-col pb-12">
      {/* Top Bar with Back, Title & Search */}
      <div className="bg-[#0B1528] text-white px-4 py-4 rounded-b-2xl shadow-sm space-y-3 sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-sm font-bold text-yellow-400 truncate">Clients</h1>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-800 text-slate-200 border border-slate-700 shrink-0">
              {clients.length}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={sort}
              onChange={(e) => onSortChange(e.target.value as ClientSortOption)}
              className="text-[11px] font-medium text-slate-200 bg-[#14233D] border border-slate-700/60 rounded-lg px-2 py-1 focus:outline-none focus:border-yellow-400 cursor-pointer"
              aria-label="Sort clients"
            >
              <option value="a-to-z">A to Z</option>
              <option value="z-to-a">Z to A</option>
              <option value="newest">Newest added</option>
              <option value="highest-balance">Highest balance owed</option>
            </select>
            <button
              onClick={onAddClient}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-400 text-slate-950 text-xs font-bold hover:bg-yellow-300 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
        </div>

        {/* Search Bar: name, phone, email */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search by name, phone, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[#14233D] text-white placeholder-slate-400 text-xs rounded-xl pl-10 pr-8 py-2.5 border border-slate-700/60 focus:outline-none focus:border-yellow-400 transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="p-4">
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden divide-y divide-slate-100">
          {filteredClients.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              {search ? 'No clients match your search.' : 'No clients found.'}
            </div>
          ) : (
            filteredClients.map((c) => {
              const clientInvoices = invoices.filter((i) => i.clientId === c.id);
              const totalInvoiced = clientInvoices.reduce(
                (sum, inv) => sum + (Number(inv.total) || 0),
                0
              );
              const totalPaid = clientInvoices.reduce((sum, inv) => {
                const paid = (inv.payments || []).reduce(
                  (pSum, p) => pSum + (Number(p.amount) || 0),
                  0
                );
                return sum + paid;
              }, 0);
              const outstanding = Math.max(0, totalInvoiced - totalPaid);
              const isZero = outstanding === 0;

              return (
                <div
                  key={c.id}
                  onClick={() => onSelectClient(c.id)}
                  className="p-3.5 hover:bg-slate-50/80 cursor-pointer flex items-center justify-between transition-colors"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-xs text-slate-900 truncate">
                        {c.name}
                      </h3>
                      <span
                        className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          isZero
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-amber-50 text-amber-800 border-amber-200'
                        }`}
                      >
                        {formatPenceToGBP(outstanding)}
                      </span>
                      {c.status === 'please_confirm' && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold border border-amber-200">
                          Confirm Details
                        </span>
                      )}
                      {c.contacts.length > 0 && (
                        <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded font-medium">
                          +{c.contacts.length}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 truncate mt-0.5">
                      {c.phone || c.email || c.address || 'No phone/email'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-400 shrink-0">
                    <span className="text-[11px] font-semibold text-slate-600">
                      {clientInvoices.length} {clientInvoices.length === 1 ? 'inv' : 'invs'}
                    </span>
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// TASK 7: FULL-PAGE ALL INVOICES VIEW
// ==========================================
function AllInvoicesView({
  invoices,
  clients,
  sort,
  onSortChange,
  onBack,
  onSelectInvoice,
  onCreateInvoice,
  getStatusBadge,
}: {
  invoices: Invoice[];
  clients: Client[];
  sort: InvoiceSortOption;
  onSortChange: (sort: InvoiceSortOption) => void;
  onBack: () => void;
  onSelectInvoice: (invoiceId: string) => void;
  onCreateInvoice: () => void;
  getStatusBadge: (status: InvoiceStatus) => React.ReactNode;
}) {
  const [search, setSearch] = useState('');

  const filteredInvoices = useMemo(() => {
    let list = invoices;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((inv) => {
        const matchNum = inv.invoiceNumber.toLowerCase().includes(q);
        const client = clients.find((c) => c.id === inv.clientId);
        const matchClient = client ? client.name.toLowerCase().includes(q) : false;
        const matchStatus = inv.status.toLowerCase().includes(q);
        return matchNum || matchClient || matchStatus;
      });
    }
    return sortInvoicesList(list, sort);
  }, [invoices, clients, search, sort]);

  return (
    <div className="flex-1 flex flex-col pb-12">
      {/* Top Bar with Back, Title & Search */}
      <div className="bg-[#0B1528] text-white px-4 py-4 rounded-b-2xl shadow-sm space-y-3 sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-sm font-bold text-yellow-400 truncate">Invoices</h1>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-800 text-slate-200 border border-slate-700 shrink-0">
              {invoices.length}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={sort}
              onChange={(e) => onSortChange(e.target.value as InvoiceSortOption)}
              className="text-[11px] font-medium text-slate-200 bg-[#14233D] border border-slate-700/60 rounded-lg px-2 py-1 focus:outline-none focus:border-yellow-400 cursor-pointer"
              aria-label="Sort invoices"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="number-high-to-low">Number high to low</option>
              <option value="number-low-to-high">Number low to high</option>
              <option value="unpaid-first">Unpaid first</option>
              <option value="overdue-first">Overdue first</option>
            </select>
            <button
              onClick={onCreateInvoice}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-yellow-400 text-slate-950 text-xs font-bold hover:bg-yellow-300 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          </div>
        </div>

        {/* Search Bar: number, client name, status */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search by invoice number, client, or status..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[#14233D] text-white placeholder-slate-400 text-xs rounded-xl pl-10 pr-8 py-2.5 border border-slate-700/60 focus:outline-none focus:border-yellow-400 transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="p-4">
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden divide-y divide-slate-100">
          {filteredInvoices.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              {search ? 'No invoices match your search.' : 'No invoices found.'}
            </div>
          ) : (
            filteredInvoices.map((inv) => {
              const client = clients.find((c) => c.id === inv.clientId);
              return (
                <div
                  key={inv.id}
                  onClick={() => onSelectInvoice(inv.id)}
                  className="p-3.5 hover:bg-slate-50/80 cursor-pointer flex items-center justify-between transition-colors"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-xs text-[#0B1528]">
                        {inv.invoiceNumber}
                      </span>
                      {getStatusBadge(inv.status)}
                    </div>
                    <p className="text-xs font-medium text-slate-700 truncate">
                      {client ? client.name : 'Unknown Client'}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Due: {inv.dueDate || 'Upon receipt'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-sm text-slate-900">
                      {formatPenceToGBP(inv.total)}
                    </p>
                    {inv.balanceDue > 0 && inv.status !== 'paid' && (
                      <p className="text-[10px] font-semibold text-rose-600">
                        Due: {formatPenceToGBP(inv.balanceDue)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// CLIENT DETAIL VIEW (Includes Contextual AI Bar)
// ==========================================
function ClientDetailView({
  clientId,
  onBack,
  onEditClient,
  onCreateInvoice,
  onSelectInvoice,
  getStatusBadge,
  onDataChange,
  onAISuccess,
}: {
  clientId: string;
  onBack: () => void;
  onEditClient: () => void;
  onCreateInvoice: () => void;
  onSelectInvoice: (invoiceId: string) => void;
  getStatusBadge: (status: InvoiceStatus) => React.ReactNode;
  onDataChange: () => void;
  onAISuccess: (data: AIParseResponse) => void;
}) {
  const client = TradePayDB.getClientById(clientId);
  const clientInvoices = TradePayDB.getInvoicesForClient(clientId);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  if (!client) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-slate-500">Client not found.</p>
        <button
          onClick={onBack}
          className="mt-4 px-4 py-2 bg-slate-800 text-white text-xs rounded-xl"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  const totalBilled = clientInvoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalBalanceDue = clientInvoices.reduce((sum, inv) => sum + inv.balanceDue, 0);

  return (
    <div className="flex-1 flex flex-col pb-10">
      {/* Top Bar */}
      <div className="bg-[#0B1528] text-white px-4 py-4 rounded-b-2xl shadow-sm flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-sm font-bold text-yellow-400">Client Profile</h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onEditClient}
            className="text-xs font-semibold px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
          >
            Edit
          </button>
          <button
            onClick={() => setShowDeleteModal(true)}
            className="text-xs font-semibold px-3 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* TASK 2: AI Input Bar Inside Client Page (Auto-Contextualized) */}
        <div>
          <div className="mb-1 text-[11px] font-bold text-slate-500 uppercase flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-yellow-500" /> Fast Voice/Receipt to Invoice for{' '}
            {client.name}
          </div>
          <AIInputBar
            pageContext={{ page: 'client', clientId: client.id, clientName: client.name }}
            onSuccess={onAISuccess}
          />
        </div>

        {/* Main Details Card */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-lg font-black text-slate-900">{client.name}</h1>
              {client.status === 'please_confirm' && (
                <span className="inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                  Please Confirm Details
                </span>
              )}
            </div>
            <div className="w-10 h-10 rounded-2xl bg-yellow-400/20 text-slate-900 font-bold flex items-center justify-center text-sm border border-yellow-400/30">
              {client.name.substring(0, 2).toUpperCase()}
            </div>
          </div>

          <div className="mt-4 space-y-2 text-xs text-slate-600">
            {client.phone && (
              <a
                href={`tel:${client.phone}`}
                className="flex items-center gap-2 text-slate-800 hover:text-slate-950 font-medium"
              >
                <Phone className="w-3.5 h-3.5 text-slate-400" />
                {client.phone}
              </a>
            )}
            {client.email && (
              <a
                href={`mailto:${client.email}`}
                className="flex items-center gap-2 text-slate-800 hover:text-slate-950 font-medium"
              >
                <Mail className="w-3.5 h-3.5 text-slate-400" />
                {client.email}
              </a>
            )}
            {client.address && (
              <div className="flex items-start gap-2 text-slate-700">
                <MapPin className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                <span>{client.address}</span>
              </div>
            )}
          </div>

          {/* Quick Balance Stats */}
          <div className="mt-4 grid grid-cols-2 gap-2 pt-3 border-t border-slate-100">
            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <span className="text-[10px] text-slate-400 font-semibold uppercase">Total Billed</span>
              <p className="font-bold text-sm text-slate-900">{formatPenceToGBP(totalBilled)}</p>
            </div>
            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <span className="text-[10px] text-slate-400 font-semibold uppercase">Balance Due</span>
              <p
                className={`font-bold text-sm ${
                  totalBalanceDue > 0 ? 'text-rose-600' : 'text-emerald-600'
                }`}
              >
                {formatPenceToGBP(totalBalanceDue)}
              </p>
            </div>
          </div>
        </div>

        {/* Extra Contacts List */}
        {client.contacts && client.contacts.length > 0 && (
          <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
              Additional Contacts ({client.contacts.length})
            </h3>
            <div className="space-y-3">
              {client.contacts.map((contact) => (
                <div
                  key={contact.id}
                  className="bg-slate-50 p-3 rounded-xl border border-slate-100 text-xs"
                >
                  <p className="font-bold text-slate-900">{contact.name}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-600">
                    {contact.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3 h-3 text-slate-400" /> {contact.phone}
                      </span>
                    )}
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="w-3 h-3 text-slate-400" /> {contact.email}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Invoices for this Client */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-200/70 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#0B1528]" />
              <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800">
                Invoices ({clientInvoices.length})
              </h3>
            </div>
            <button
              onClick={onCreateInvoice}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0B1528] text-yellow-400 text-xs font-bold hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Manual Invoice
            </button>
          </div>

          <div className="divide-y divide-slate-100">
            {clientInvoices.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                No invoices for this client yet.
              </div>
            ) : (
              clientInvoices.map((inv) => (
                <div
                  key={inv.id}
                  onClick={() => onSelectInvoice(inv.id)}
                  className="p-3.5 hover:bg-slate-50/80 cursor-pointer flex items-center justify-between transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-[#0B1528]">{inv.invoiceNumber}</span>
                      {getStatusBadge(inv.status)}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">Date: {inv.date}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-xs text-slate-900">{formatPenceToGBP(inv.total)}</p>
                    {inv.balanceDue > 0 && inv.status !== 'paid' && (
                      <p className="text-[10px] text-rose-600 font-semibold">
                        Due: {formatPenceToGBP(inv.balanceDue)}
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <ConfirmationDialog
        isOpen={showDeleteModal}
        message={`Delete ${client.name}? This also deletes their ${clientInvoices.length} invoices.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        isDanger={true}
        onCancel={() => setShowDeleteModal(false)}
        onConfirm={() => {
          TradePayDB.deleteClient(client.id);
          onDataChange();
          onBack();
        }}
      />
    </div>
  );
}

// ==========================================
// CLIENT FORM (ADD/EDIT)
// ==========================================
function ClientFormView({
  clientId,
  onBack,
  onSaved,
}: {
  clientId?: string;
  onBack: () => void;
  onSaved: (client: Client) => void;
}) {
  const existing = clientId ? TradePayDB.getClientById(clientId) : undefined;

  const [name, setName] = useState(existing?.name || '');
  const [phone, setPhone] = useState(existing?.phone || '');
  const [email, setEmail] = useState(existing?.email || '');
  const [address, setAddress] = useState(existing?.address || '');
  const [contacts, setContacts] = useState<Contact[]>(existing?.contacts || []);

  const addContact = () => {
    setContacts([
      ...contacts,
      {
        id: 'con_' + Math.random().toString(36).substring(2, 8),
        name: '',
        phone: '',
        email: '',
      },
    ]);
  };

  const updateContact = (id: string, field: keyof Contact, value: string) => {
    setContacts(contacts.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const removeContact = (id: string) => {
    setContacts(contacts.filter((c) => c.id !== id));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const saved = TradePayDB.saveClient({
      id: clientId,
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim(),
      address: address.trim(),
      contacts: contacts.filter((c) => c.name.trim()),
      status: 'confirmed',
    });

    onSaved(saved);
  };

  return (
    <form onSubmit={handleSubmit} className="flex-1 flex flex-col pb-10">
      {/* Top Bar */}
      <div className="bg-[#0B1528] text-white px-4 py-4 rounded-b-2xl shadow-sm flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" /> Cancel
        </button>
        <h2 className="text-sm font-bold text-yellow-400">
          {clientId ? 'Edit Client' : 'Add New Client'}
        </h2>
        <button
          type="submit"
          className="text-xs font-bold px-3 py-1 rounded-lg bg-yellow-400 text-slate-950 hover:bg-yellow-300 cursor-pointer"
        >
          Save
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Core Information Card */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm space-y-3">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Client / Business Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. John Smith or Apex Construction Ltd"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-xs p-2.5 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Telephone</label>
            <input
              type="tel"
              placeholder="e.g. 07700 900123"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full text-xs p-2.5 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Email Address</label>
            <input
              type="email"
              placeholder="e.g. client@example.co.uk"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full text-xs p-2.5 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Physical Address</label>
            <textarea
              rows={2}
              placeholder="e.g. 12 High Street, Bristol, BS1 2AB"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full text-xs p-2.5 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400 resize-none"
            />
          </div>
        </div>

        {/* Extra Contacts Card */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
                Extra Contacts
              </h3>
              <p className="text-[11px] text-slate-400">
                Site managers, quantity surveyors, partners
              </p>
            </div>
            <button
              type="button"
              onClick={addContact}
              className="flex items-center gap-1 text-xs font-bold text-[#0B1528] bg-yellow-400 px-2.5 py-1 rounded-lg hover:bg-yellow-300 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Add Contact
            </button>
          </div>

          {contacts.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-2">
              No extra contacts added yet.
            </p>
          ) : (
            <div className="space-y-3">
              {contacts.map((c, idx) => (
                <div
                  key={c.id}
                  className="p-3 bg-slate-50 rounded-xl border border-slate-200 relative space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500 uppercase">
                      Contact #{idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeContact(c.id)}
                      className="text-slate-400 hover:text-rose-600 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <input
                    type="text"
                    placeholder="Contact name (e.g. Dave Harrison)"
                    value={c.name}
                    onChange={(e) => updateContact(c.id, 'name', e.target.value)}
                    className="w-full text-xs p-2 bg-white rounded-lg border border-slate-200"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="tel"
                      placeholder="Phone"
                      value={c.phone}
                      onChange={(e) => updateContact(c.id, 'phone', e.target.value)}
                      className="w-full text-xs p-2 bg-white rounded-lg border border-slate-200"
                    />
                    <input
                      type="email"
                      placeholder="Email"
                      value={c.email}
                      onChange={(e) => updateContact(c.id, 'email', e.target.value)}
                      className="w-full text-xs p-2 bg-white rounded-lg border border-slate-200"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

// ==========================================
// INVOICE EDITOR VIEW
// ==========================================
function InvoiceEditorView({
  invoiceId,
  prefilledClientId,
  onBack,
  onSaved,
  onDelete,
  onOpenAddClient,
}: {
  invoiceId?: string;
  prefilledClientId?: string;
  onBack: () => void;
  onSaved: (invoice: Invoice) => void;
  onDelete: () => void;
  onOpenAddClient: () => void;
}) {
  const [currentInvoiceId, setCurrentInvoiceId] = useState<string | undefined>(invoiceId);
  const [invoiceVersion, setInvoiceVersion] = useState(0);

  const [editorDialog, setEditorDialog] = useState<{
    isOpen: boolean;
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isDanger?: boolean;
    isAlert?: boolean;
    onConfirm: () => void;
  }>({
    isOpen: false,
    message: '',
    onConfirm: () => {},
  });

  const closeEditorDialog = () => {
    setEditorDialog((prev) => ({ ...prev, isOpen: false }));
  };

  const currentInvoice = useMemo(() => {
    return currentInvoiceId ? TradePayDB.getInvoiceById(currentInvoiceId) : undefined;
  }, [currentInvoiceId, invoiceVersion]);

  const clients = TradePayDB.getClients();

  const [invoiceNumber, setInvoiceNumber] = useState(
    currentInvoice?.invoiceNumber || TradePayDB.getNextInvoiceNumber()
  );
  const [clientId, setClientId] = useState(
    currentInvoice?.clientId || prefilledClientId || (clients[0]?.id ?? '')
  );
  const [date, setDate] = useState(
    currentInvoice?.date || new Date().toISOString().split('T')[0]
  );
  const [dueDate, setDueDate] = useState(() => {
    if (currentInvoice?.dueDate) return currentInvoice.dueDate;
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().split('T')[0];
  });

  // Helper to add days to YYYY-MM-DD
  const addDaysToDate = (baseDate: string, days: number): string => {
    try {
      const parts = baseDate.split('-').map(Number);
      if (parts.length === 3) {
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        d.setDate(d.getDate() + days);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    } catch {
      // fallback
    }
    const d = new Date(baseDate || Date.now());
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  // Payment terms dropdown (7 / 14 / 30 days / custom)
  const [terms, setTerms] = useState<string>(() => {
    if (currentInvoice?.date && currentInvoice?.dueDate) {
      const d1 = new Date(currentInvoice.date);
      const d2 = new Date(currentInvoice.dueDate);
      const diffDays = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 7) return '7';
      if (diffDays === 14) return '14';
      if (diffDays === 30) return '30';
      return 'custom';
    }
    return '14';
  });

  const handleDateChange = (newDate: string) => {
    setDate(newDate);
    if (terms === '7' || terms === '14' || terms === '30') {
      setDueDate(addDaysToDate(newDate, parseInt(terms, 10)));
    }
  };

  const handleTermsChange = (newTerms: string) => {
    setTerms(newTerms);
    if (newTerms === '7' || newTerms === '14' || newTerms === '30') {
      setDueDate(addDaysToDate(date, parseInt(newTerms, 10)));
    }
  };

  const handleDueDateChange = (newDueDate: string) => {
    setDueDate(newDueDate);
    try {
      const d1 = new Date(date);
      const d2 = new Date(newDueDate);
      const diffDays = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 7) {
        setTerms('7');
      } else if (diffDays === 14) {
        setTerms('14');
      } else if (diffDays === 30) {
        setTerms('30');
      } else {
        setTerms('custom');
      }
    } catch {
      setTerms('custom');
    }
  };

  const [vatRate, setVatRate] = useState<number>(currentInvoice?.vatRate ?? 20);
  const [notes, setNotes] = useState(() => {
    if (!currentInvoice?.notes) return 'Thank you for your business.';
    return (
      currentInvoice.notes
        .replace(/Payment terms \d+ days\.?\s*/gi, '')
        .replace(/Terms:? \d+ days\.?\s*/gi, '')
        .replace(/VAT \d+%\.?\s*/gi, '')
        .trim() || 'Thank you for your business.'
    );
  });

  interface EditorLineItem {
    id: string;
    description: string;
    type: 'material' | 'labour' | 'other';
    qtyString: string;
    unitPricePounds: string;
  }

  const [items, setItems] = useState<EditorLineItem[]>(() => {
    if (currentInvoice && currentInvoice.lineItems.length > 0) {
      return currentInvoice.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        type: li.type,
        qtyString: String(li.quantity),
        unitPricePounds: penceToPoundInput(li.unitPrice),
      }));
    }
    return [
      {
        id: 'li_' + Math.random().toString(36).substring(2, 7),
        description: 'First fix labour',
        type: 'labour',
        qtyString: '1',
        unitPricePounds: '150.00',
      },
    ];
  });

  // Payments list stored on invoice
  const payments: Payment[] = useMemo(() => {
    return currentInvoice?.payments || [];
  }, [currentInvoice]);

  // Amount paid & balance due strictly calculated in code from payments list
  const totalPaidPence = useMemo(() => {
    return payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  }, [payments]);

  const liveTotals = useMemo(() => {
    const parsedItems = items.map((item) => ({
      quantity: parseFloat(item.qtyString) || 0,
      unitPrice: poundsToPence(item.unitPricePounds),
    }));
    return calculateInvoiceTotals(parsedItems, vatRate, totalPaidPence);
  }, [items, vatRate, totalPaidPence]);

  // ------------------------------------------
  // MANUAL PAYMENT MODAL STATE
  // ------------------------------------------
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [manualAmountPounds, setManualAmountPounds] = useState('');
  const [manualMethod, setManualMethod] = useState<PaymentMethod>('bank transfer');
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [manualNotes, setManualNotes] = useState('');

  // ------------------------------------------
  // PAYPAL SANDBOX PAYMENT STATE
  // ------------------------------------------
  // PAYPAL SANDBOX PAYMENT & DIAGNOSTICS STATE
  // ------------------------------------------
  interface PayPalSession {
    orderId: string;
    approvalUrl: string;
    amountGbp: string;
    amountPence: number;
    status: 'WAITING_APPROVAL' | 'APPROVED' | 'CAPTURING' | 'COMPLETED' | 'FAILED';
    pollCount: number;
    startTime: number;
    error?: string;
  }

  interface PayPalDiagnostic {
    orderId: string;
    status: string;
    captureSent: boolean;
    httpStatus: number;
    rawResponse: any;
    elapsedMs: number;
  }

  const [paypalSession, setPaypalSession] = useState<PayPalSession | null>(null);
  const [isStartingPayPal, setIsStartingPayPal] = useState(false);
  const [paypalGlobalError, setPaypalGlobalError] = useState<string | null>(null);
  const [diagnosticInfo, setDiagnosticInfo] = useState<PayPalDiagnostic | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [customOrderIdInput, setCustomOrderIdInput] = useState('');
  const [showManualSyncInput, setShowManualSyncInput] = useState(false);

  // Auto-recovery across page refresh / reload: check if invoice has pending order
  useEffect(() => {
    let unmounted = false;

    const checkPendingOrder = async () => {
      // 1. Check if invoice already has a pending order stored
      let pendingId = currentInvoice?.pendingPayPalOrderId;

      // 2. If not stored on invoice, check server in-memory store
      if (!pendingId && currentInvoiceId) {
        try {
          const res = await fetch(`/api/paypal/invoice-order/${currentInvoiceId}`);
          if (res.ok) {
            const data = await res.json();
            if (data.found && data.orderId) {
              pendingId = data.orderId;
            }
          }
        } catch {
          // ignore lookup failure
        }
      }

      if (unmounted || !pendingId) return;

      // If invoice balance is already 0 and paid, no need to re-sync
      if (liveTotals.balanceDue <= 0 && liveTotals.total > 0) return;

      console.log(`[Auto-Recovery] Found pending PayPal order ${pendingId} for invoice ${currentInvoiceId}`);
      runOrderDiagnostic(pendingId);
    };

    checkPendingOrder();

    return () => {
      unmounted = true;
    };
  }, [currentInvoiceId, currentInvoice?.pendingPayPalOrderId]);

  // Diagnostic Runner: queries status directly from PayPal with 15s timeout
  const runOrderDiagnostic = async (orderId: string) => {
    if (!orderId || !orderId.trim()) return;
    const cleanId = orderId.trim();
    setIsDiagnosing(true);
    try {
      console.log(`[Client] Diagnosing order ${cleanId}...`);
      const res = await fetch(`/api/paypal/order-diagnostic/${cleanId}`);
      const data = await res.json();

      const diag: PayPalDiagnostic = {
        orderId: cleanId,
        status: data.status || (res.ok ? 'OK' : 'ERROR'),
        captureSent: Boolean(data.captureSent),
        httpStatus: data.httpStatus || res.status,
        rawResponse: data.rawResponse || data,
        elapsedMs: data.elapsedMs || 0,
      };

      setDiagnosticInfo(diag);
      console.log('[PayPal Diagnostic on Screen]', diag);

      // If already COMPLETED at PayPal:
      // Requirement: if the order is already COMPLETED at PayPal, don't capture again, just record it;
      // capture only once per order (no duplicate payments); when completed, record the payment on the invoice
      if (data.status === 'COMPLETED') {
        const amtPence = data.amountPence || liveTotals.balanceDue;
        let targetInvoiceId = currentInvoiceId;
        if (!targetInvoiceId) {
          const saved = saveCurrentState('sent');
          if (saved) targetInvoiceId = saved.id;
        }

        if (targetInvoiceId) {
          TradePayDB.recordPayment(targetInvoiceId, {
            amount: amtPence,
            method: 'PayPal',
            date: new Date().toISOString().split('T')[0],
            notes: `PayPal Sandbox Order ${cleanId}`,
            paypalOrderId: cleanId,
            paypalCaptureId: data.captureId,
          });
          TradePayDB.setPendingPayPalOrder(targetInvoiceId, undefined);
          setInvoiceVersion((v) => v + 1);
        }

        setPaypalSession({
          orderId: cleanId,
          approvalUrl: '',
          amountGbp: data.amountGbp || penceToPoundInput(amtPence),
          amountPence: amtPence,
          status: 'COMPLETED',
          pollCount: 0,
          startTime: Date.now(),
        });
      } else if (data.status === 'APPROVED') {
        // If approved, trigger capture
        executeCapture(cleanId, data.amountPence || liveTotals.balanceDue);
      }
    } catch (err: unknown) {
      console.error('[Client] Failed to run diagnostic:', err);
    } finally {
      setIsDiagnosing(false);
    }
  };

  // Dedicated Async Capture Handler: Not cancelled by state re-renders!
  const executeCapture = async (orderId: string, amountPence: number) => {
    setPaypalSession({
      orderId,
      approvalUrl: '',
      amountGbp: penceToPoundInput(amountPence),
      amountPence,
      status: 'CAPTURING',
      pollCount: 0,
      startTime: Date.now(),
    });

    try {
      console.log(`[PayPal Capture] Sending capture request to server for order ${orderId}...`);
      const captureRes = await fetch(`/api/paypal/capture-order/${orderId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const captureData = await captureRes.json();

      setDiagnosticInfo({
        orderId,
        status: captureData.status || (captureRes.ok ? 'COMPLETED' : 'ERROR'),
        captureSent: true,
        httpStatus: captureData.httpStatus || captureRes.status,
        rawResponse: captureData.raw || captureData,
        elapsedMs: captureData.elapsedMs || 0,
      });

      if (captureRes.ok && captureData.success) {
        let targetInvoiceId = currentInvoiceId;
        if (!targetInvoiceId) {
          const saved = saveCurrentState('sent');
          if (saved) targetInvoiceId = saved.id;
        }

        if (targetInvoiceId) {
          const finalPence = captureData.amountPence || amountPence;
          TradePayDB.recordPayment(targetInvoiceId, {
            amount: finalPence,
            method: 'PayPal',
            date: new Date().toISOString().split('T')[0],
            notes: `PayPal Sandbox Order ${orderId}`,
            paypalOrderId: orderId,
            paypalCaptureId: captureData.captureId,
          });
          TradePayDB.setPendingPayPalOrder(targetInvoiceId, undefined);
          setInvoiceVersion((v) => v + 1);
        }

        setPaypalSession({
          orderId,
          approvalUrl: '',
          amountGbp: captureData.amountGbp || penceToPoundInput(amountPence),
          amountPence,
          status: 'COMPLETED',
          pollCount: 0,
          startTime: Date.now(),
        });
      } else {
        // Capture failed: stop the spinner, show the real error with a "Retry" button
        setPaypalSession({
          orderId,
          approvalUrl: '',
          amountGbp: penceToPoundInput(amountPence),
          amountPence,
          status: 'FAILED',
          error: captureData.error || 'Failed to capture PayPal order',
          pollCount: 0,
          startTime: Date.now(),
        });
      }
    } catch (err: unknown) {
      const errorMsg = (err as Error).message || 'Network error during PayPal capture';
      setPaypalSession({
        orderId,
        approvalUrl: '',
        amountGbp: penceToPoundInput(amountPence),
        amountPence,
        status: 'FAILED',
        error: errorMsg,
        pollCount: 0,
        startTime: Date.now(),
      });
    }
  };

  // Poll PayPal order status every 3s (max 5 minutes = 100 polls)
  // Fix: Polling loop ONLY polls for approval. Capture is executed independently so it is never aborted!
  useEffect(() => {
    if (!paypalSession || paypalSession.status !== 'WAITING_APPROVAL') {
      return;
    }

    const orderId = paypalSession.orderId;
    const targetAmountPence = paypalSession.amountPence;
    let isPolling = true;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/paypal/order-status/${orderId}`);
        const data = await res.json();
        if (!isPolling) return;

        if (!res.ok) {
          console.error('[PayPal Poll Error]', data);
          return;
        }

        console.log(`[PayPal Poll] Order ${orderId} status: ${data.status}`);

        if (data.status === 'APPROVED' || data.status === 'COMPLETED') {
          clearInterval(interval);
          isPolling = false;
          executeCapture(orderId, targetAmountPence);
        } else {
          setPaypalSession((prev) => {
            if (!prev || prev.orderId !== orderId) return prev;
            const nextCount = prev.pollCount + 1;
            if (nextCount >= 100) {
              clearInterval(interval);
              return {
                ...prev,
                status: 'FAILED',
                error:
                  'Payment polling timed out after 5 minutes. If you completed approval in PayPal, click "Retry Capture / Sync" below.',
              };
            }
            return { ...prev, pollCount: nextCount };
          });
        }
      } catch (err: unknown) {
        console.error('[PayPal Poll Network Error]', err);
      }
    }, 3000);

    return () => {
      isPolling = false;
      clearInterval(interval);
    };
  }, [paypalSession?.orderId, paypalSession?.status]);

  const addLineItem = () => {
    setItems([
      ...items,
      {
        id: 'li_' + Math.random().toString(36).substring(2, 7),
        description: '',
        type: 'labour',
        qtyString: '1',
        unitPricePounds: '0.00',
      },
    ]);
  };

  const updateItem = (id: string, field: keyof EditorLineItem, value: string) => {
    setItems(items.map((it) => (it.id === id ? { ...it, [field]: value } : it)));
  };

  const removeItem = (id: string) => {
    if (items.length <= 1) return;
    setItems(items.filter((it) => it.id !== id));
  };

  const promptRemoveLine = (id: string, desc?: string) => {
    if (items.length <= 1) return;
    setEditorDialog({
      isOpen: true,
      message: desc ? `Delete "${desc}"?` : 'Delete this line item?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      isDanger: true,
      onConfirm: () => {
        setItems((prev) => prev.filter((it) => it.id !== id));
        closeEditorDialog();
      },
    });
  };

  // Helper to compile and save current form state
  const saveCurrentState = (targetStatus: InvoiceStatus): Invoice | null => {
    if (!clientId) {
      setEditorDialog({
        isOpen: true,
        message: 'Please select or add a client first.',
        isAlert: true,
        confirmLabel: 'OK',
        onConfirm: closeEditorDialog,
      });
      return null;
    }

    const compiledLineItems: LineItem[] = items.map((item) => {
      const quantity = Math.max(0, parseFloat(item.qtyString) || 0);
      const unitPrice = poundsToPence(item.unitPricePounds);
      const totalPrice = calculateLineTotal(quantity, unitPrice);
      return {
        id: item.id,
        description: item.description || 'Service/Materials',
        type: item.type,
        quantity,
        unitPrice,
        totalPrice,
      };
    });

    const saved = TradePayDB.saveInvoice({
      id: currentInvoiceId,
      invoiceNumber: invoiceNumber.trim() || TradePayDB.getNextInvoiceNumber(),
      clientId,
      date,
      dueDate,
      lineItems: compiledLineItems,
      vatRate: Number(vatRate) || 0,
      subtotal: liveTotals.subtotal,
      vatAmount: liveTotals.vatAmount,
      total: liveTotals.total,
      amountPaid: totalPaidPence,
      balanceDue: liveTotals.balanceDue,
      status: targetStatus,
      notes,
    });

    setCurrentInvoiceId(saved.id);
    setInvoiceVersion((v) => v + 1);
    return saved;
  };

  const handleSaveAndExit = (targetStatus: InvoiceStatus) => {
    const saved = saveCurrentState(targetStatus);
    if (saved) {
      onSaved(saved);
    }
  };

  const [sendSheetInvoice, setSendSheetInvoice] = useState<Invoice | null>(null);

  const handleSaveAndSend = () => {
    const saved = saveCurrentState('sent');
    if (saved) {
      setSendSheetInvoice(saved);
    }
  };

  const handleDownloadPDF = () => {
    const compiledLineItems: LineItem[] = items.map((item) => {
      const quantity = Math.max(0, parseFloat(item.qtyString) || 0);
      const unitPrice = poundsToPence(item.unitPricePounds);
      const totalPrice = calculateLineTotal(quantity, unitPrice);
      return {
        id: item.id,
        description: item.description || 'Service/Materials',
        type: item.type,
        quantity,
        unitPrice,
        totalPrice,
      };
    });

    const targetClient = clients.find((c) => c.id === clientId);
    const invoiceForPdf: Invoice = {
      id: currentInvoiceId || 'draft',
      invoiceNumber: invoiceNumber.trim() || 'DRAFT',
      clientId,
      date,
      dueDate,
      lineItems: compiledLineItems,
      vatRate: Number(vatRate) || 0,
      subtotal: liveTotals.subtotal,
      vatAmount: liveTotals.vatAmount,
      total: liveTotals.total,
      amountPaid: totalPaidPence,
      balanceDue: liveTotals.balanceDue,
      status: currentInvoice?.status || 'draft',
      notes,
      payments,
      createdAt: currentInvoice?.createdAt || new Date().toISOString(),
    };

    downloadInvoicePDF(invoiceForPdf, targetClient);
  };

  // Open manual record payment modal
  const handleOpenRecordPayment = () => {
    // Default to remaining balance
    setManualAmountPounds(penceToPoundInput(liveTotals.balanceDue));
    setManualMethod('bank transfer');
    setManualDate(new Date().toISOString().split('T')[0]);
    setManualNotes('');
    setShowRecordModal(true);
  };

  // Save manual payment
  const handleConfirmManualPayment = (e: React.FormEvent) => {
    e.preventDefault();
    const amountPence = poundsToPence(manualAmountPounds);
    if (amountPence <= 0) {
      setEditorDialog({
        isOpen: true,
        message: 'Please enter a valid payment amount greater than £0.',
        isAlert: true,
        confirmLabel: 'OK',
        onConfirm: closeEditorDialog,
      });
      return;
    }

    let targetInvoiceId = currentInvoiceId;
    if (!targetInvoiceId) {
      const saved = saveCurrentState('sent');
      if (!saved) return;
      targetInvoiceId = saved.id;
    }

    TradePayDB.recordPayment(targetInvoiceId, {
      amount: amountPence,
      method: manualMethod,
      date: manualDate,
      notes: manualNotes.trim() || undefined,
    });

    setInvoiceVersion((v) => v + 1);
    setShowRecordModal(false);
  };

  // Delete recorded payment
  const handleDeletePayment = (paymentId: string) => {
    if (!currentInvoiceId) return;
    setEditorDialog({
      isOpen: true,
      message: 'Delete this payment record? The balance due and status will be recalculated.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      isDanger: true,
      onConfirm: () => {
        TradePayDB.deletePayment(currentInvoiceId, paymentId);
        setInvoiceVersion((v) => v + 1);
        closeEditorDialog();
      },
    });
  };

  // Initiate PayPal Checkout
  const handlePayWithPayPal = async () => {
    if (liveTotals.balanceDue <= 0) {
      setEditorDialog({
        isOpen: true,
        message: 'Invoice has no balance due to pay.',
        isAlert: true,
        confirmLabel: 'OK',
        onConfirm: closeEditorDialog,
      });
      return;
    }

    setPaypalGlobalError(null);
    setIsStartingPayPal(true);

    let targetInvoiceId = currentInvoiceId;
    let invNum = invoiceNumber;

    if (!targetInvoiceId) {
      const saved = saveCurrentState('sent');
      if (!saved) {
        setIsStartingPayPal(false);
        return;
      }
      targetInvoiceId = saved.id;
      invNum = saved.invoiceNumber;
    }

    try {
      console.log(`[Client] Initiating PayPal order for invoice ${invNum} (£${penceToPoundInput(liveTotals.balanceDue)})...`);
      const res = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: targetInvoiceId,
          invoiceNumber: invNum,
          amountPence: liveTotals.balanceDue,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || `Server responded with status ${res.status}`);
      }

      console.log(`[Client] PayPal Order created: ${data.orderId}`);

      // Save pending order id on the invoice so this persists across page refreshes
      TradePayDB.setPendingPayPalOrder(targetInvoiceId, data.orderId);

      // Try opening approval URL in a new tab
      if (data.approvalUrl) {
        try {
          window.open(data.approvalUrl, '_blank');
        } catch {
          console.warn('[Client] Popup blocked by browser');
        }
      }

      setPaypalSession({
        orderId: data.orderId,
        approvalUrl: data.approvalUrl,
        amountGbp: data.amountGbp,
        amountPence: liveTotals.balanceDue,
        status: 'WAITING_APPROVAL',
        pollCount: 0,
        startTime: Date.now(),
      });
    } catch (err: unknown) {
      const errorMsg = (err as Error).message || 'Failed to initialize PayPal order.';
      console.error('[Client] PayPal create-order error:', errorMsg);
      setPaypalGlobalError(errorMsg);
    } finally {
      setIsStartingPayPal(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col pb-12">
      {/* Top Bar */}
      <div className="bg-[#0B1528] text-white px-4 py-4 rounded-b-2xl shadow-sm flex items-center justify-between sticky top-0 z-20">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="text-center">
          <h2 className="text-sm font-black text-white">Invoice</h2>
          <span className="text-[10px] text-yellow-400 font-bold tracking-wider">
            {invoiceNumber}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleDownloadPDF}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-yellow-400 text-xs font-semibold cursor-pointer transition-colors"
            title="Download PDF"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span className="text-[11px]">PDF</span>
          </button>
          {currentInvoiceId ? (
            <button
              onClick={() => {
                setEditorDialog({
                  isOpen: true,
                  message: 'Delete this invoice?',
                  confirmLabel: 'Delete',
                  cancelLabel: 'Cancel',
                  isDanger: true,
                  onConfirm: () => {
                    TradePayDB.deleteInvoice(currentInvoiceId);
                    closeEditorDialog();
                    onDelete();
                  },
                });
              }}
              className="text-xs text-rose-400 hover:text-rose-300 p-1 cursor-pointer"
              title="Delete invoice"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          ) : (
            <div className="w-1"></div>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Header Details Card */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm space-y-3">
          {/* Client Selection */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-slate-700">Client *</label>
              {!prefilledClientId && (
                <button
                  type="button"
                  onClick={onOpenAddClient}
                  className="text-[11px] font-bold text-slate-900 flex items-center gap-1 hover:underline cursor-pointer"
                >
                  <PlusCircle className="w-3 h-3 text-yellow-500" /> + New Client
                </button>
              )}
            </div>
            {clients.length === 0 ? (
              <button
                onClick={onOpenAddClient}
                className="w-full text-xs py-2 px-3 border border-dashed border-amber-400 bg-amber-50 rounded-xl text-amber-900 font-medium text-left"
              >
                No clients yet. Tap here to add a client first.
              </button>
            ) : prefilledClientId ? (
              <div className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-slate-50 font-semibold text-slate-800">
                {clients.find((c) => c.id === clientId)?.name || 'Client'}
              </div>
            ) : (
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-white font-medium focus:outline-none focus:border-yellow-400"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Row 1: Invoice No. (left) & Payment Terms (right) */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">
                Invoice No.
              </label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full text-xs p-2 rounded-xl border border-slate-200 font-bold focus:outline-none focus:border-yellow-400"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">
                Payment Terms
              </label>
              <select
                value={terms}
                onChange={(e) => handleTermsChange(e.target.value)}
                className="w-full text-xs p-2 rounded-xl border border-slate-200 bg-white font-medium focus:outline-none focus:border-yellow-400"
              >
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>

          {/* Row 2: Invoice Date (left) & Due Date (right) */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">
                Invoice Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => handleDateChange(e.target.value)}
                className="w-full text-xs p-2 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">
                Due Date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => handleDueDateChange(e.target.value)}
                className="w-full text-xs p-2 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
              />
            </div>
          </div>
        </div>

        {/* Line Items Table */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between">
            <h3 className="font-bold text-xs uppercase tracking-wider text-slate-900">
              Line Items ({items.length})
            </h3>
          </div>

          <div className="p-3 space-y-3">
            {items.map((item, index) => {
              const lineQty = parseFloat(item.qtyString) || 0;
              const unitPricePence = poundsToPence(item.unitPricePounds);
              const calculatedTotalPence = calculateLineTotal(lineQty, unitPricePence);

              return (
                <div
                  key={item.id}
                  className="bg-slate-50/70 p-3 rounded-xl border border-slate-200/80 space-y-2 relative"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-500">#{index + 1}</span>
                    <select
                      value={item.type}
                      onChange={(e) =>
                        updateItem(item.id, 'type', e.target.value as 'material' | 'labour' | 'other')
                      }
                      className="text-[11px] bg-white border border-slate-200 rounded-lg px-2 py-0.5 font-medium text-slate-700"
                    >
                      <option value="labour">Labour</option>
                      <option value="material">Material</option>
                      <option value="other">Other</option>
                    </select>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => promptRemoveLine(item.id, item.description)}
                        className="text-slate-400 hover:text-rose-600 transition-colors ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Description */}
                  <input
                    type="text"
                    placeholder="Description (e.g. Copper piping, 8hrs electrical labour)"
                    value={item.description}
                    onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                    className="w-full text-xs p-2 bg-white rounded-lg border border-slate-200 font-medium focus:outline-none focus:border-yellow-400"
                  />

                  {/* Qty, Unit Price, Line Total */}
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-3">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase mb-0.5">
                        Qty
                      </label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={item.qtyString}
                        onChange={(e) => updateItem(item.id, 'qtyString', e.target.value)}
                        className="w-full text-xs p-1.5 bg-white rounded-lg border border-slate-200 text-center font-semibold"
                      />
                    </div>
                    <div className="col-span-4">
                      <label className="block text-[10px] text-slate-400 font-bold uppercase mb-0.5">
                        Price (£)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={item.unitPricePounds}
                        onChange={(e) => updateItem(item.id, 'unitPricePounds', e.target.value)}
                        className="w-full text-xs p-1.5 bg-white rounded-lg border border-slate-200 text-right font-semibold"
                      />
                    </div>
                    <div className="col-span-5 text-right pl-2">
                      <span className="block text-[10px] text-slate-400 font-bold uppercase mb-0.5">
                        Line Total
                      </span>
                      <p className="text-xs font-bold text-slate-900">
                        {formatPenceToGBP(calculatedTotalPence)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addLineItem}
              className="w-full py-2.5 rounded-xl border border-dashed border-slate-300 hover:border-slate-400 bg-white text-slate-700 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-yellow-500" /> Add Another Line
            </button>
          </div>
        </div>

        {/* Calculations & Totals Card */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200/90 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-slate-700">VAT Rate (%)</label>
            <div className="flex items-center gap-1">
              {[0, 5, 20].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setVatRate(rate)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                    vatRate === rate
                      ? 'bg-[#0B1528] text-yellow-400'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {rate}%
                </button>
              ))}
              <input
                type="number"
                min="0"
                max="100"
                value={vatRate}
                onChange={(e) => setVatRate(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 text-xs p-1 text-center font-bold border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-1.5 text-xs">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal:</span>
              <span className="font-semibold text-slate-800">
                {formatPenceToGBP(liveTotals.subtotal)}
              </span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>VAT ({vatRate}%):</span>
              <span className="font-semibold text-slate-800">
                {formatPenceToGBP(liveTotals.vatAmount)}
              </span>
            </div>
            <div className="flex justify-between text-sm font-black text-slate-900 pt-1 border-t border-slate-200">
              <span>Total Invoice Amount:</span>
              <span className="text-[#0B1528]">{formatPenceToGBP(liveTotals.total)}</span>
            </div>

            {/* Total Paid (Calculated strictly in code from payments list) */}
            <div className="flex items-center justify-between text-xs text-slate-700 pt-1">
              <span className="font-medium flex items-center gap-1">
                Amount Paid ({payments.length} {payments.length === 1 ? 'payment' : 'payments'}):
              </span>
              <span className="font-bold text-emerald-700">
                {formatPenceToGBP(totalPaidPence)}
              </span>
            </div>

            {/* Live Balance Due */}
            <div className="flex justify-between items-center text-sm font-black pt-2 bg-yellow-400/15 p-2.5 rounded-xl border border-yellow-400/30">
              <span className="text-slate-900">Balance Due:</span>
              <span className={`text-base font-black ${liveTotals.balanceDue > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                {formatPenceToGBP(liveTotals.balanceDue)}
              </span>
            </div>
          </div>

          {/* Notes */}
          <div className="pt-2">
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Notes
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional notes..."
              className="w-full text-xs p-2 rounded-xl border border-slate-200 resize-none focus:outline-none focus:border-yellow-400"
            />
          </div>
        </div>

        {/* ==========================================
            TASK 3: PAYMENTS & SETTLEMENT SECTION
            ========================================== */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-[#0B1528]" />
              <h3 className="font-bold text-xs uppercase tracking-wider text-slate-900">
                Payments & Settlement
              </h3>
              <span className="px-2 py-0.2 rounded-full text-[10px] font-bold bg-slate-200 text-slate-800">
                {payments.length}
              </span>
            </div>
            {liveTotals.balanceDue === 0 && liveTotals.total > 0 && (
              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Fully Paid
              </span>
            )}
          </div>

          <div className="p-4 space-y-3">
            {/* Payment Action Buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              {/* 1. Pay with PayPal Button */}
              <button
                type="button"
                onClick={handlePayWithPayPal}
                disabled={isStartingPayPal || liveTotals.balanceDue <= 0}
                className={`py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer ${
                  liveTotals.balanceDue <= 0
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                    : 'bg-[#FFC439] hover:bg-[#F2BA36] text-[#003087] border border-[#E0A820] active:scale-[0.98]'
                }`}
                title={
                  liveTotals.balanceDue <= 0
                    ? 'No balance due to pay'
                    : 'Pay balance with PayPal Sandbox'
                }
              >
                {isStartingPayPal ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Connecting...</span>
                  </>
                ) : (
                  <>
                    <span className="font-black italic">Pay</span>
                    <span className="font-bold">Pal</span>
                    <span className="text-[11px] font-normal text-[#003087]/80">Sandbox</span>
                  </>
                )}
              </button>

              {/* 2. Record Payment (Manual) Button */}
              <button
                type="button"
                onClick={handleOpenRecordPayment}
                className="py-2.5 px-3 rounded-xl bg-[#0B1528] hover:bg-slate-800 text-yellow-400 font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-[0.98]"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Record payment</span>
              </button>
            </div>

            {/* PayPal Global Error Banner */}
            {paypalGlobalError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block">PayPal Error</span>
                    <span className="text-[11px]">{paypalGlobalError}</span>
                  </div>
                </div>
                <button
                  onClick={() => setPaypalGlobalError(null)}
                  className="text-rose-500 hover:text-rose-800"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}



            {/* Active PayPal Session Card (Order created, Waiting for payment) */}
            {paypalSession && (
              <div className="p-3.5 rounded-2xl bg-amber-50/70 border border-amber-300 space-y-2.5 animate-fade-in text-xs">
                <div className="flex items-center justify-between border-b border-amber-200/80 pb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#003087]"></span>
                    <span className="font-black text-[#003087]">PayPal Sandbox Order</span>
                  </div>
                  <span className="font-mono text-[11px] font-bold text-slate-700 bg-white px-2 py-0.5 rounded border border-amber-200">
                    {paypalSession.orderId}
                  </span>
                </div>

                <div className="space-y-1 text-[11px] text-slate-700">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Order Amount:</span>
                    <span className="font-bold text-slate-900">£{paypalSession.amountGbp} GBP</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Status:</span>
                    <span
                      className={`font-bold px-2 py-0.2 rounded ${
                        paypalSession.status === 'COMPLETED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : paypalSession.status === 'FAILED'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {paypalSession.status === 'WAITING_APPROVAL' && 'Waiting for Approval'}
                      {paypalSession.status === 'CAPTURING' && 'Capturing Payment...'}
                      {paypalSession.status === 'COMPLETED' && 'Paid & Captured'}
                      {paypalSession.status === 'FAILED' && 'Payment Failed / Timed out'}
                    </span>
                  </div>
                </div>

                {/* Polling state indicator */}
                {paypalSession.status === 'WAITING_APPROVAL' && (
                  <div className="p-2.5 rounded-xl bg-white border border-amber-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />
                      <div>
                        <p className="font-bold text-slate-800 text-[11px]">
                          Waiting for payment approval...
                        </p>
                        <p className="text-[10px] text-slate-500">
                          Polling order every 3s ({paypalSession.pollCount * 3}s / 300s max)
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPaypalSession(null)}
                      className="text-[10px] text-slate-500 hover:text-rose-600 font-semibold px-2 py-1 rounded hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Capturing state */}
                {paypalSession.status === 'CAPTURING' && (
                  <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-200 flex items-center gap-2 text-blue-900">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                    <div>
                      <p className="font-bold text-[11px]">Approved! Capturing payment funds...</p>
                      <p className="text-[10px] text-blue-700">Updating invoice balance in code</p>
                    </div>
                  </div>
                )}

                {/* Completed state */}
                {paypalSession.status === 'COMPLETED' && (
                  <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between text-emerald-900">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span className="font-bold text-[11px]">
                        Payment of £{paypalSession.amountGbp} captured and recorded!
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPaypalSession(null)}
                      className="text-[10px] font-bold text-emerald-700 hover:underline"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Failed state with Spinner stopped and Retry button */}
                {paypalSession.status === 'FAILED' && (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs flex items-center gap-1.5 text-rose-700">
                        <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                        <span>Payment Capture Failed</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setPaypalSession(null)}
                        className="text-[10px] font-bold text-rose-600 hover:underline"
                      >
                        Dismiss
                      </button>
                    </div>
                    <p className="text-[11px] text-rose-800 break-words">{paypalSession.error}</p>
                    <button
                      type="button"
                      onClick={() => executeCapture(paypalSession.orderId, paypalSession.amountPence)}
                      className="w-full py-2 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Retry Capture</span>
                    </button>
                  </div>
                )}

                {/* Action Link to open Sandbox Checkout */}
                {paypalSession.status === 'WAITING_APPROVAL' && (
                  <div>
                    <a
                      href={paypalSession.approvalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-2 px-3 rounded-xl bg-[#003087] hover:bg-[#002568] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                    >
                      <span>Open PayPal Checkout in New Tab</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <p className="text-[10px] text-slate-500 text-center mt-1.5">
                      Log in to your PayPal Sandbox buyer account to approve. Once approved, the app auto-captures and marks invoice paid.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* List of Payments Made */}
            <div className="divide-y divide-slate-100 pt-1">
              {payments.length === 0 ? (
                <div className="py-3 text-center text-xs text-slate-400">
                  No payments recorded yet. Tap "Record payment" or "Pay with PayPal".
                </div>
              ) : (
                payments.map((p) => {
                  let badgeColor = 'bg-slate-100 text-slate-800 border-slate-200';
                  if (p.method === 'PayPal') {
                    badgeColor = 'bg-yellow-100 text-yellow-900 border-yellow-300';
                  } else if (p.method === 'cash') {
                    badgeColor = 'bg-emerald-100 text-emerald-900 border-emerald-300';
                  } else if (p.method === 'card') {
                    badgeColor = 'bg-blue-100 text-blue-900 border-blue-300';
                  } else if (p.method === 'bank transfer') {
                    badgeColor = 'bg-purple-100 text-purple-900 border-purple-300';
                  }

                  return (
                    <div
                      key={p.id}
                      className="py-2.5 flex items-center justify-between text-xs"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.2 rounded text-[10px] font-bold border capitalize ${badgeColor}`}
                          >
                            {p.method}
                          </span>
                          <span className="text-[11px] text-slate-500 font-medium">
                            {p.date}
                          </span>
                        </div>
                        {p.notes && (
                          <p className="text-[11px] text-slate-600 truncate mt-0.5 font-medium">
                            {p.notes}
                          </p>
                        )}
                        {p.paypalOrderId && (
                          <p className="text-[9px] text-slate-400 font-mono">
                            Order: {p.paypalOrderId}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-bold text-xs text-slate-900">
                          {formatPenceToGBP(p.amount)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeletePayment(p.id)}
                          className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                          title="Delete payment record"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons: Download PDF, Save as Draft or Save & Send */}
        <div className="space-y-2.5 pt-2">
          <button
            type="button"
            onClick={handleDownloadPDF}
            className="w-full py-2.5 px-3 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors cursor-pointer"
          >
            <FileDown className="w-4 h-4 text-[#0B1528]" />
            <span>Download PDF</span>
          </button>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleSaveAndExit('draft')}
              className="py-3 px-4 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs transition-colors cursor-pointer text-center"
            >
              Save as Draft
            </button>
            <button
              type="button"
              onClick={handleSaveAndSend}
              className="py-3 px-4 rounded-xl bg-[#0B1528] hover:bg-slate-800 text-yellow-400 font-bold text-xs shadow-md transition-colors cursor-pointer text-center"
            >
              Save & Send
            </button>
          </div>
        </div>
      </div>

      {/* ==========================================
          MANUAL RECORD PAYMENT MODAL
          ========================================== */}
      {showRecordModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-xs animate-fade-in">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl border border-slate-200">
            <div className="bg-[#0B1528] px-4 py-3 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-yellow-400" />
                <h3 className="font-bold text-xs uppercase tracking-wider text-white">
                  Record Manual Payment
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowRecordModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmManualPayment} className="p-4 space-y-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Amount Received (£) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={manualAmountPounds}
                  onChange={(e) => setManualAmountPounds(e.target.value)}
                  className="w-full text-sm font-bold p-2.5 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Remaining balance due: {formatPenceToGBP(liveTotals.balanceDue)}
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Payment Method *
                </label>
                <select
                  value={manualMethod}
                  onChange={(e) => setManualMethod(e.target.value as PaymentMethod)}
                  className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-white font-medium focus:outline-none focus:border-yellow-400"
                >
                  <option value="bank transfer">Bank Transfer (BACS / Faster Payments)</option>
                  <option value="cash">Cash in Hand</option>
                  <option value="card">Card / Terminal</option>
                  <option value="PayPal">PayPal</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Payment Date *
                </label>
                <input
                  type="date"
                  required
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  className="w-full text-xs p-2 rounded-xl border border-slate-200 font-medium focus:outline-none focus:border-yellow-400"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Notes (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Paid on completion, cash receipt given"
                  value={manualNotes}
                  onChange={(e) => setManualNotes(e.target.value)}
                  className="w-full text-xs p-2 rounded-xl border border-slate-200 focus:outline-none focus:border-yellow-400"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowRecordModal(false)}
                  className="px-3 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-bold text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-slate-950 font-bold text-xs shadow-sm cursor-pointer transition-colors"
                >
                  Confirm Payment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmationDialog
        isOpen={editorDialog.isOpen}
        title={editorDialog.title}
        message={editorDialog.message}
        confirmLabel={editorDialog.confirmLabel}
        cancelLabel={editorDialog.cancelLabel}
        isDanger={editorDialog.isDanger}
        isAlert={editorDialog.isAlert}
        onConfirm={editorDialog.onConfirm}
        onCancel={closeEditorDialog}
      />

      {sendSheetInvoice && (
        <SendInvoiceSheet
          isOpen={Boolean(sendSheetInvoice)}
          invoice={sendSheetInvoice}
          client={clients.find((c) => c.id === (sendSheetInvoice?.clientId || clientId))}
          onClose={() => {
            const finalSaved = sendSheetInvoice;
            setSendSheetInvoice(null);
            if (finalSaved) {
              onSaved(finalSaved);
            }
          }}
        />
      )}
    </div>
  );
}

