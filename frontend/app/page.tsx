"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5001/api";
const lkr = new Intl.NumberFormat("en-LK", {
  style: "currency",
  currency: "LKR",
  maximumFractionDigits: 2,
});

type Product = {
  id: number;
  sku: string;
  name: string;
  category: string;
  price: number;
  stock_quantity: number;
};
type CartLine = { product: Product; quantity: number };
type SaleItem = {
  product_id: number | null;
  product_name: string;
  sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};
type Sale = {
  id: number;
  invoice_number: string;
  customer_name: string | null;
  payment_method: string;
  subtotal: number;
  discount: number;
  total: number;
  created_at: string;
  items: SaleItem[];
};

type ApiSession = {
  authenticated?: boolean;
  csrf_token?: string | null;
  otp_required?: boolean;
  challenge_id?: string;
  expires_in?: number;
};

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function request<T>(path: string, init?: RequestInit, csrfToken?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error("Cannot connect to the POS server. Check that the Flask API is running.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error ?? "The request could not be completed.", response.status);
  return body as T;
}

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

export default function Home() {
  const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated" | "unavailable">("checking");
  const [authStage, setAuthStage] = useState<"password" | "otp">("password");
  const [csrfToken, setCsrfToken] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginNotice, setLoginNotice] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"checkout" | "sales">("checkout");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [customerName, setCustomerName] = useState("");
  const [discountInput, setDiscountInput] = useState("0");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showProductForm, setShowProductForm] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);

  const refresh = useCallback(async () => {
    const [productData, saleData] = await Promise.all([
      request<Product[]>("/products"),
      request<Sale[]>("/sales"),
    ]);
    setProducts(productData);
    setSales(saleData);
  }, []);

  useEffect(() => {
    let active = true;
    request<ApiSession>("/auth/session")
      .then((result) => {
        if (!active) return;
        setCsrfToken(result.csrf_token ?? "");
        setAuthStatus(result.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch((error) => {
        if (!active) return;
        setLoginNotice(messageFrom(error));
        setAuthStatus("unavailable");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    refresh().catch((error) => {
      if (error instanceof ApiError && error.status === 401) {
        setAuthStatus("unauthenticated");
        setCsrfToken("");
        return;
      }
      setNotice(messageFrom(error));
    });
  }, [authStatus, refresh]);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginNotice("");
    setLoginBusy(true);
    try {
      const result = await request<ApiSession>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      if (!result.otp_required || !result.challenge_id) {
        throw new Error("The server could not start authenticator verification. Please try again.");
      }
      setChallengeId(result.challenge_id);
      setOtpCode("");
      setAuthStage("otp");
    } catch (error) {
      setLoginNotice(messageFrom(error));
    } finally {
      setLoginBusy(false);
    }
  }

  async function verifyOtp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginNotice("");
    setLoginBusy(true);
    try {
      const result = await request<ApiSession>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ challenge_id: challengeId, code: otpCode }),
      });
      if (!result.authenticated || !result.csrf_token) {
        throw new Error("The server could not complete sign-in. Please try again.");
      }
      setOtpCode("");
      setChallengeId("");
      setCsrfToken(result.csrf_token);
      setAuthStatus("authenticated");
    } catch (error) {
      setLoginNotice(messageFrom(error));
    } finally {
      setLoginBusy(false);
    }
  }

  function returnToPassword() {
    setAuthStage("password");
    setChallengeId("");
    setOtpCode("");
    setLoginNotice("");
  }

  async function signOut() {
    setNotice("");
    try {
      await request("/auth/logout", { method: "POST" }, csrfToken);
      setCsrfToken("");
      setAuthStatus("unauthenticated");
      setProducts([]);
      setSales([]);
      setCart([]);
      setShowProductForm(false);
      setReceipt(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCsrfToken("");
        setAuthStatus("unauthenticated");
      } else {
        setNotice(messageFrom(error));
      }
    }
  }

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return products.filter((product) =>
      `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(normalized),
    );
  }, [products, query]);
  const subtotal = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const discount = Math.max(0, Number(discountInput) || 0);
  const total = Math.max(0, subtotal - discount);
  const todaySales = sales.filter(
    (sale) => new Date(sale.created_at).toDateString() === new Date().toDateString(),
  );
  const todayTotal = todaySales.reduce((sum, sale) => sum + sale.total, 0);

  function addToCart(product: Product) {
    setNotice("");
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock_quantity) {
          setNotice(`Only ${product.stock_quantity} in stock for ${product.name}.`);
          return current;
        }
        return current.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      if (product.stock_quantity < 1) {
        setNotice(`${product.name} is out of stock.`);
        return current;
      }
      return [...current, { product, quantity: 1 }];
    });
  }

  function setQuantity(productId: number, quantity: number) {
    const product = products.find((entry) => entry.id === productId);
    if (!product) return;
    if (quantity <= 0) {
      setCart((current) => current.filter((line) => line.product.id !== productId));
      return;
    }
    if (quantity > product.stock_quantity) {
      setNotice(`Only ${product.stock_quantity} in stock for ${product.name}.`);
      return;
    }
    setCart((current) =>
      current.map((line) => line.product.id === productId ? { ...line, quantity } : line),
    );
  }

  async function completeSale() {
    setNotice("");
    if (cart.length === 0) {
      setNotice("Add at least one saree to the bill.");
      return;
    }
    if (!Number.isFinite(discount) || discount > subtotal) {
      setNotice("Discount must be a valid amount no greater than the subtotal.");
      return;
    }
    setBusy(true);
    try {
      const createdSale = await request<Sale>("/sales", {
        method: "POST",
        body: JSON.stringify({
          items: cart.map(({ product, quantity }) => ({ product_id: product.id, quantity })),
          customer_name: customerName,
          payment_method: paymentMethod,
          discount,
        }),
      }, csrfToken);
      setReceipt(createdSale);
      setCart([]);
      setCustomerName("");
      setDiscountInput("0");
      await refresh().catch((error) => {
        setNotice(`Sale saved, but the latest product and sales data could not be refreshed: ${messageFrom(error)}`);
      });
    } catch (error) {
      setNotice(messageFrom(error));
      if (error instanceof ApiError && error.status === 401) {
        setCsrfToken("");
        setAuthStatus("unauthenticated");
      }
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setNotice("");
    try {
      await request<Product>("/products", {
        method: "POST",
        body: JSON.stringify({
          sku: form.get("sku"),
          name: form.get("name"),
          category: form.get("category"),
          price: Number(form.get("price")),
          stock_quantity: Number(form.get("stock_quantity")),
        }),
      }, csrfToken);
      setShowProductForm(false);
      await refresh();
    } catch (error) {
      setNotice(messageFrom(error));
      if (error instanceof ApiError && error.status === 401) {
        setCsrfToken("");
        setAuthStatus("unauthenticated");
      }
    }
  }

  if (authStatus !== "authenticated") {
    return (
      <main className="auth-page">
        <div className="auth-glow auth-glow-one" />
        <div className="auth-glow auth-glow-two" />
        <section className="auth-card" aria-labelledby="login-title">
          <div className="auth-brand-mark">A</div>
          <div className="auth-wordmark">AURA FABRICS</div>
          <div className="auth-eyebrow">
            {authStage === "otp" ? "STEP 2 OF 2 · AUTHENTICATOR CODE" : "STEP 1 OF 2 · PASSWORD"}
          </div>
          <h1 id="login-title">
            {authStatus === "checking" ? "Securing your workspace" : authStage === "otp" ? "Check your authenticator." : "Welcome back."}
          </h1>
          <p className="auth-description">
            {authStatus === "checking"
              ? "Checking your secure sign-in session."
              : authStatus === "unavailable"
                ? "Your secure sign-in service is unavailable."
                : authStage === "otp"
                ? "Open your authenticator app and enter the current 6-digit code to open the POS."
                : "Enter your password first, then verify with the code from your authenticator app."}
          </p>
          {authStatus === "checking" ? (
            <div className="auth-progress" role="status">Verifying session…</div>
          ) : authStatus === "unavailable" ? (
            <div className="auth-error" role="alert">
              {loginNotice}
              <span className="auth-setup-help">
                Set up your authenticator: in the backend folder, run <code>python3 setup_authenticator.py</code>,
                scan its QR code, then restart the API with <code>python3 app.py</code>.
              </span>
              <button className="auth-retry" onClick={() => window.location.reload()}>Try again</button>
            </div>
          ) : authStage === "otp" ? (
            <form className="auth-form" onSubmit={verifyOtp}>
              <label htmlFor="pos-otp">Verification code</label>
              <input
                autoComplete="one-time-code"
                autoFocus
                className="otp-input"
                id="pos-otp"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                pattern="[0-9]{6}"
                placeholder="000000"
                required
                value={otpCode}
              />
              {loginNotice && <div className="auth-error" role="alert">{loginNotice}</div>}
              <button className="auth-submit" disabled={loginBusy || otpCode.length !== 6} type="submit">
                {loginBusy ? "Verifying…" : "Verify & continue"}
                {!loginBusy && <span aria-hidden="true">→</span>}
              </button>
              <button className="auth-back" onClick={returnToPassword} type="button">← Back to password</button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={signIn}>
              <label htmlFor="pos-password">Password</label>
              <div className="password-field">
                <input
                  autoComplete="current-password"
                  autoFocus
                  id="pos-password"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your store password"
                  required
                  type={showPassword ? "text" : "password"}
                  value={password}
                />
                <button
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="password-visibility"
                  onClick={() => setShowPassword((current) => !current)}
                  type="button"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
              {loginNotice && <div className="auth-error" role="alert">{loginNotice}</div>}
              <button className="auth-submit" disabled={loginBusy || !password} type="submit">
                {loginBusy ? "Signing in…" : "Sign in"}
                {!loginBusy && <span aria-hidden="true">→</span>}
              </button>
            </form>
          )}
          <div className="auth-security">
            <span className="auth-lock" aria-hidden="true">●</span>
            Protected access for your store
          </div>
        </section>
        <footer className="auth-footer">AURA FABRICS <span>·</span> POINT OF SALE</footer>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">A</div>
          <div><strong>AURA</strong><span>FABRICS · POS</span></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button className={`nav-item ${activeTab === "checkout" ? "selected" : ""}`} onClick={() => setActiveTab("checkout")}>
          <Icon>▦</Icon> Point of sale
        </button>
        <button className={`nav-item ${activeTab === "sales" ? "selected" : ""}`} onClick={() => setActiveTab("sales")}>
          <Icon>◷</Icon> Sales history
        </button>
        <div className="sidebar-bottom">
          <div className="today-card">
            <div className="today-icon">↗</div>
            <span>Today&apos;s sales</span>
            <strong>{lkr.format(todayTotal)}</strong>
            <small>{todaySales.length} {todaySales.length === 1 ? "transaction" : "transactions"}</small>
          </div>
          <div className="store-status"><span className="status-dot" /> Store is open</div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> {activeTab === "checkout" ? "Point of sale" : "Sales history"}</div>
          <div className="topbar-right">
            <span className="date-label">{new Intl.DateTimeFormat("en-LK", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date())}</span>
            <button aria-label="Sign out" className="avatar sign-out" onClick={signOut} title="Sign out">AF</button>
          </div>
        </header>

        {activeTab === "checkout" ? (
          <div className="workspace">
            <section className="catalog">
              <div className="page-heading">
                <div><div className="eyebrow">YOUR STORE, AT A GLANCE</div><h1>Point of sale</h1><p>Create a bill and take payment in a few steps.</p></div>
                <button className="button button-outline" onClick={() => setShowProductForm(true)}><span>＋</span> Add product</button>
              </div>
              <div className="search-row">
                <label className="search-box"><Icon>⌕</Icon><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sarees by name, SKU or collection..." /></label>
                <div className="product-count">{filteredProducts.length} products</div>
              </div>
              {products.length === 0 ? (
                <div className="empty-catalog"><div className="empty-icon">✿</div><h3>Your collection starts here</h3><p>Add your first saree to start creating customer bills.</p><button className="button button-primary" onClick={() => setShowProductForm(true)}>Add your first product</button></div>
              ) : filteredProducts.length === 0 ? (
                <div className="empty-catalog compact"><h3>No matching sarees</h3><p>Try a different search term.</p></div>
              ) : (
                <div className="product-grid">
                  {filteredProducts.map((product, index) => (
                    <button className="product-card" key={product.id} onClick={() => addToCart(product)} disabled={product.stock_quantity === 0}>
                      <div className={`product-art art-${index % 6}`}><span className="fabric-glyph">✿</span><span className="art-category">{product.category}</span></div>
                      <div className="product-info"><div className="product-name">{product.name}</div><div className="product-sku">{product.sku}</div><div className="product-card-bottom"><strong>{lkr.format(product.price)}</strong><span className={product.stock_quantity < 4 ? "low-stock" : "stock"}>{product.stock_quantity} in stock</span></div></div>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <aside className="checkout-panel">
              <div className="checkout-heading"><div><div className="eyebrow">NEW TRANSACTION</div><h2>Current bill</h2></div><span className="bill-number">#{String(sales.length + 1).padStart(3, "0")}</span></div>
              <label className="field-label" htmlFor="customer">Customer name <span>OPTIONAL</span></label>
              <input id="customer" className="text-input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Walk-in customer" />
              <div className="cart-list">
                {cart.length === 0 ? <div className="cart-empty"><div className="cart-empty-icon">▤</div><strong>Your bill is empty</strong><span>Select a saree to add it here</span></div> : cart.map(({ product, quantity }) => (
                  <div className="cart-line" key={product.id}>
                    <div className="line-swatch">✿</div>
                    <div className="line-detail"><strong>{product.name}</strong><span>{lkr.format(product.price)} each</span><div className="quantity-control"><button aria-label={`Remove one ${product.name}`} onClick={() => setQuantity(product.id, quantity - 1)}>−</button><span>{quantity}</span><button aria-label={`Add one ${product.name}`} onClick={() => setQuantity(product.id, quantity + 1)}>+</button></div></div>
                    <div className="line-total">{lkr.format(product.price * quantity)}<button className="remove-line" aria-label={`Remove ${product.name}`} onClick={() => setQuantity(product.id, 0)}>×</button></div>
                  </div>
                ))}
              </div>
              <div className="totals">
                <div className="total-row"><span>Subtotal</span><span>{lkr.format(subtotal)}</span></div>
                <label className="total-row discount-row"><span>Discount</span><span className="discount-field">LKR <input type="number" min="0" max={subtotal} step="0.01" value={discountInput} onChange={(event) => setDiscountInput(event.target.value)} /></span></label>
                <div className="total-row grand-total"><strong>Total due</strong><strong>{lkr.format(total)}</strong></div>
              </div>
              <div className="payment-section"><div className="field-label">Payment method</div><div className="payment-options">
                {[["cash", "Cash", "▤"], ["card", "Card", "▭"], ["bank_transfer", "Bank", "⇄"]].map(([value, label, icon]) => <button key={value} className={`payment-option ${paymentMethod === value ? "active" : ""}`} onClick={() => setPaymentMethod(value)}><span>{icon}</span>{label}</button>)}
              </div></div>
              {notice && <div className="notice" role="alert">{notice}</div>}
              <button className="button button-primary complete-button" onClick={completeSale} disabled={busy || cart.length === 0}>{busy ? "Saving payment..." : <>Complete Payment <span>→</span></>}</button>
              <div className="secure-note"><span>✓</span> Payment details are recorded securely</div>
            </aside>
          </div>
        ) : (
          <section className="history-page">
            <div className="page-heading"><div><div className="eyebrow">YOUR BUSINESS, IN ORDER</div><h1>Sales history</h1><p>Review and reprint your recent customer bills.</p></div><button className="button button-outline" onClick={() => setActiveTab("checkout")}>＋ New sale</button></div>
            {sales.length === 0 ? <div className="empty-catalog history-empty"><div className="empty-icon">◷</div><h3>No sales yet</h3><p>Completed bills will appear here.</p><button className="button button-primary" onClick={() => setActiveTab("checkout")}>Create your first bill</button></div> : <div className="history-table-wrap"><table className="history-table"><thead><tr><th>INVOICE</th><th>CUSTOMER</th><th>DATE &amp; TIME</th><th>PAYMENT</th><th>AMOUNT</th><th></th></tr></thead><tbody>{sales.map((sale) => <tr key={sale.id}><td><strong className="invoice-id">{sale.invoice_number}</strong></td><td>{sale.customer_name || "Walk-in customer"}</td><td>{new Date(sale.created_at).toLocaleString("en-LK", { dateStyle: "medium", timeStyle: "short" })}</td><td><span className="payment-badge">{sale.payment_method.replace("_", " ")}</span></td><td><strong>{lkr.format(sale.total)}</strong></td><td><button className="reprint-button" onClick={() => setReceipt(sale)}>View bill ↗</button></td></tr>)}</tbody></table></div>}
          </section>
        )}
      </section>

      {showProductForm && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProductForm(false); }}><form className="form-modal" onSubmit={createProduct}><button type="button" className="modal-close" onClick={() => setShowProductForm(false)}>×</button><div className="eyebrow">INVENTORY</div><h2>Add a saree</h2><p>Enter the product details and available stock.</p><label>Product name<input name="name" required maxLength={160} placeholder="e.g. Kanchipuram silk saree" /></label><div className="form-grid"><label>SKU / code<input name="sku" required maxLength={40} placeholder="e.g. KAN-001" /></label><label>Collection<input name="category" maxLength={80} defaultValue="Saree" /></label></div><div className="form-grid"><label>Price (LKR)<input name="price" type="number" min="0.01" step="0.01" required /></label><label>Stock quantity<input name="stock_quantity" type="number" min="0" step="1" defaultValue="1" required /></label></div><button className="button button-primary modal-submit" type="submit">Save product</button></form></div>}

      {receipt && <div className="modal-backdrop receipt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReceipt(null); }}><div className="receipt-modal"><div className="receipt-actions"><button className="button button-outline" onClick={() => window.print()}>▤ Print / Save PDF</button><button className="modal-close inline-close" onClick={() => setReceipt(null)}>×</button></div><div className="receipt-paper" id="receipt"><div className="receipt-brand"><div className="brand-mark">A</div><strong>AURA FABRICS</strong><span>Thank you for shopping with us</span></div><div className="receipt-title">SALES INVOICE</div><div className="receipt-meta"><span>Invoice<strong>{receipt.invoice_number}</strong></span><span>Date<strong>{new Date(receipt.created_at).toLocaleString("en-LK", { dateStyle: "medium", timeStyle: "short" })}</strong></span><span>Customer<strong>{receipt.customer_name || "Walk-in customer"}</strong></span></div><div className="receipt-items"><div className="receipt-item header"><span>ITEM</span><span>QTY</span><span>PRICE</span><span>AMOUNT</span></div>{receipt.items.map((item, index) => <div className="receipt-item" key={`${item.sku}-${index}`}><span>{item.product_name}<small>{item.sku}</small></span><span>{item.quantity}</span><span>{lkr.format(item.unit_price)}</span><span>{lkr.format(item.line_total)}</span></div>)}</div><div className="receipt-totals"><div><span>Subtotal</span><span>{lkr.format(receipt.subtotal)}</span></div>{receipt.discount > 0 && <div><span>Discount</span><span>− {lkr.format(receipt.discount)}</span></div>}<div className="receipt-grand"><strong>Total paid</strong><strong>{lkr.format(receipt.total)}</strong></div><div><span>Payment method</span><strong>{receipt.payment_method.replace("_", " ")}</strong></div></div><div className="receipt-thanks">We appreciate your visit. Come back soon!</div></div></div></div>}
    </main>
  );
}
