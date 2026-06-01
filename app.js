const { useState, useEffect, useRef, useCallback } = React;

const API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU = "claude-haiku-4-5-20251001";
const LETTERS = ["A", "B", "C", "D"];
const STORAGE_KEY = "examia_fallos";
const APIKEY_STORAGE = "examia_apikey";
const SUBTOKEN_STORAGE = "examia_subtoken";
const PRICE_DISPLAY = "9€";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── localStorage ──
function loadFallos() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; } }
function saveFallos(arr) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch {} }
function loadApiKey() { try { return localStorage.getItem(APIKEY_STORAGE) || ""; } catch { return ""; } }
function saveApiKey(k) { try { localStorage.setItem(APIKEY_STORAGE, k); } catch {} }

// ── IndexedDB (saved PDFs) ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("examia_db", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("pdfs", { keyPath: "id", autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSavePdf(pdf) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("pdfs", "readwrite").objectStore("pdfs").add({ name: pdf.name, size: pdf.size, base64: pdf.base64, textContent: pdf.textContent || null, savedAt: Date.now() });
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function idbLoadPdfs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("pdfs", "readonly").objectStore("pdfs").getAll();
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function idbDeletePdf(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("pdfs", "readwrite").objectStore("pdfs").delete(id);
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
  });
}
async function idbUpdatePdf(id, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction("pdfs", "readwrite").objectStore("pdfs");
    const g = store.get(id);
    g.onsuccess = () => { const p = store.put({ ...g.result, ...updates }); p.onsuccess = () => resolve(); p.onerror = () => reject(p.error); };
    g.onerror = () => reject(g.error);
  });
}

// ── retry on rate limit ──
async function withRetry(fn, onWait) {
  try { return await fn(); }
  catch (err) {
    const msg = (err && err.message) ? err.message : "";
    const rl = msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("Too Many") || /\b429\b/.test(msg) || /\b529\b/.test(msg);
    if (!rl) throw err;
    for (let s = 65; s > 0; s--) { onWait("Límite alcanzado. Reintentando en " + s + "s…"); await sleep(1000); }
    onWait("Reintentando…");
    return await fn();
  }
}

// ── FREE mode (backend proxy, owner pays) ──
class FreeExhausted extends Error { constructor() { super("free_exhausted"); this.code = "free_exhausted"; } }

async function freeExtract(base64, subToken) {
  const res = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64, subToken }) });
  if (res.status === 429) throw new FreeExhausted();
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Error en el servidor");
  return data.text;
}
async function freeGenerate(textContent, numQ, subToken) {
  const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ textContent, numQ, subToken }) });
  if (res.status === 429) throw new FreeExhausted();
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Error en el servidor");
  return data;
}
async function fetchUsage() {
  try { const r = await fetch("/api/usage"); return await r.json(); }
  catch { return { remaining: 0 }; }
}

// ── BYOK mode (user's own key, direct) ──
async function byokExtract(base64, apiKey) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: HAIKU, max_tokens: 8000, messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Extrae todo el contenido textual de este documento PDF manteniendo la estructura. Devuelve unicamente el texto extraido, sin comentarios." }
    ] }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e.error && e.error.message) || ("Error " + res.status)); }
  const data = await res.json();
  return (data.content.find(b => b.type === "text") || {}).text || "";
}
async function byokGenerate(textContent, numQ, apiKey) {
  const safeText = textContent.length > 12000 ? textContent.slice(0, 12000) : textContent;
  const prompt = "Basandote en el siguiente temario, genera exactamente " + numQ + " preguntas de examen tipo test en espanol. " +
    "Devuelve UNICAMENTE un array JSON valido, sin markdown ni texto extra. Cada elemento debe tener: " +
    '"question": string (pregunta completa), "options": array de exactamente 4 strings (sin letra de prefijo), ' +
    '"correct": number (indice 0-3 de la respuesta correcta), "explanation": string (explicacion breve). ' +
    "Varia los temas y la dificultad. Opciones incorrectas plausibles.\n\nTEMARIO:\n" + safeText;
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: HAIKU, max_tokens: 4096, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e.error && e.error.message) || ("Error " + res.status)); }
  const data = await res.json();
  const raw = (data.content.find(b => b.type === "text") || {}).text || "[]";
  const parsed = JSON.parse(raw.replace(/^```json\s*|^```\s*|```\s*$/gm, "").trim());
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("Respuesta inesperada");
  return parsed;
}

async function startCheckout() {
  try {
    const r = await fetch("/api/checkout", { method: "POST" });
    const d = await r.json();
    if (d.url) window.location.href = d.url;
    else alert("No se pudo iniciar el pago: " + (d.error || "inténtalo más tarde"));
  } catch { alert("Error de red al iniciar el pago."); }
}

// ── Components ──
function Header({ view, fallos, freeRemaining, mode, onLogo, onPanel, onFallos, onApiKey }) {
  return (
    <div className="header">
      <div className="logo" onClick={onLogo}>
        <span className="logo-badge">🎓</span>
        <span className="logo-text">exam<b>IA</b></span>
      </div>
      <div className="header-right">
        <span className="header-meta">🌐 🇪🇸 ES</span>
        <span className="header-icon">☀️</span>
        {view !== "landing" && (
          <>
            <button className={"nav-pill " + (view === "fallos" ? "active" : "")} onClick={onFallos}>📋 Fallos {fallos.length > 0 && <span className="badge">{fallos.length}</span>}</button>
            <button className="nav-pill" onClick={onApiKey} title="Mi clave de API">🔑</button>
          </>
        )}
        <button className="panel-btn" onClick={onPanel}>Panel</button>
      </div>
    </div>
  );
}

function ApiKeyModal({ onSave, onClose }) {
  const [key, setKey] = useState("");
  const [step, setStep] = useState(0);
  if (step === 0) return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔑</div>
        <div className="modal-title">Usa tu propia clave de API</div>
        <div className="modal-sub">Con tu clave de Anthropic puedes generar exámenes ilimitados pagando tú directamente a Anthropic (1–3 céntimos por examen). Se guarda solo en tu navegador.</div>
        <div style={{ display: "grid", gap: 10, marginBottom: 24 }}>
          {[["🔒", "Tu clave nunca sale de tu navegador."], ["💸", "Coste real ~1–3 céntimos por examen."], ["⚡", "Sin límites de exámenes."]].map((it, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "12px 14px", background: "var(--surface2)", borderRadius: 8, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              <span style={{ fontSize: 18 }}>{it[0]}</span><span>{it[1]}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-gold btn-lg" style={{ flex: 1 }} onClick={() => setStep(1)}>Continuar →</button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">🔑 Introduce tu clave</div>
        <div className="modal-sub">Créala gratis en <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: "var(--gold)", textDecoration: "none" }}>console.anthropic.com</a>, pulsa <b>Create Key</b> y pégala aquí.</div>
        <input className="modal-input" type="password" placeholder="sk-ant-api03-..." value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => e.key === "Enter" && key.startsWith("sk-") && onSave(key)} autoFocus />
        <div style={{ fontSize: 12, color: "var(--hint)", marginBottom: 20 }}>🔒 Se guarda solo en tu navegador.</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => setStep(0)}>← Volver</button>
          <button className="btn btn-gold btn-lg" style={{ flex: 1 }} onClick={() => onSave(key)} disabled={!key.startsWith("sk-")}>Guardar →</button>
        </div>
      </div>
    </div>
  );
}

function ExhaustedModal({ onSubscribe, onByok, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🚀</div>
        <div className="modal-title">Has usado tus exámenes gratis</div>
        <div className="modal-sub">Suscríbete al plan Pro y genera exámenes sin límites para aprobar antes.</div>
        <div style={{ padding: 24, background: "var(--surface2)", borderRadius: 12, border: "1px solid var(--gold)", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 16 }}>
            <span style={{ fontFamily: "var(--font-head)", fontSize: 22, fontWeight: 700 }}>Pro</span>
            <span style={{ fontFamily: "var(--font-head)", fontSize: 34, fontWeight: 700, marginLeft: "auto" }}>{PRICE_DISPLAY}</span>
            <span style={{ color: "var(--muted)", fontSize: 15 }}>/mes</span>
          </div>
          {["Exámenes ilimitados", "Hasta 20 preguntas por examen", "Repaso de fallos sin límite", "Cancela cuando quieras"].map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, marginBottom: 10 }}>
              <span style={{ color: "var(--green)", fontWeight: 700 }}>✓</span>{t}
            </div>
          ))}
          <button className="btn btn-gold btn-lg" style={{ width: "100%", marginTop: 14 }} onClick={onSubscribe}>Suscribirme por {PRICE_DISPLAY}/mes →</button>
        </div>
        <div style={{ textAlign: "center" }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>¿Tienes tu propia clave de API? </span>
          <a onClick={onByok} style={{ fontSize: 13, color: "var(--gold)", cursor: "pointer", textDecoration: "none" }}>Úsala aquí</a>
        </div>
        <button className="btn btn-outline" style={{ width: "100%", marginTop: 14 }} onClick={onClose}>Quizá más tarde</button>
      </div>
    </div>
  );
}

function Landing({ onStart, onSubscribe }) {
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-badge">✦ Estudia más rápido con IA</div>
        <h1>Convierte cualquier PDF en un <em>examen tipo test</em> en segundos</h1>
        <p className="hero-sub">Sube tus apuntes, oposiciones o libros y deja que la IA cree exámenes personalizados para que apruebes a la primera.</p>
        <div className="hero-cta">
          <button className="btn btn-gold btn-lg" onClick={onStart}>Crear mi primer examen →</button>
          <button className="btn btn-ghost btn-lg" onClick={onStart}>Ver demo</button>
        </div>
        <div className="hero-note">Sin tarjeta · 3 exámenes gratis</div>
      </section>

      <div className="preview-card">
        <div className="preview-inner">
          <div className="preview-label">⚡ Crear examen</div>
          <div className="preview-title">Tema 5 — Constitución</div>
          <div className="preview-file">⬆ apuntes_t5.pdf</div>
        </div>
        <div className="preview-row">
          <div className="preview-stat">
            <div className="preview-stat-label">Puntuación media</div>
            <div className="preview-stat-value" style={{ color: "var(--green)" }}>8,7<small> /10</small></div>
            <div className="preview-bar"><span style={{ width: "87%", background: "var(--green)" }} /></div>
          </div>
          <div className="preview-stat">
            <div className="preview-stat-label">Créditos</div>
            <div className="preview-stat-value">42<small> /50</small></div>
            <div className="preview-bar"><span style={{ width: "84%", background: "var(--gold)" }} /></div>
          </div>
        </div>
      </div>

      <section className="section">
        <h2 className="section-title">Todo lo que necesitas para aprobar</h2>
        <div className="feature">
          <div className="feature-icon">✨</div>
          <h3>Generación con IA</h3>
          <p>Preguntas tipo test creadas a partir de tu material en segundos.</p>
        </div>
        <div className="feature">
          <div className="feature-icon">📊</div>
          <h3>Estadísticas reales</h3>
          <p>Mide tu progreso, identifica puntos débiles y mejora.</p>
        </div>
        <div className="feature">
          <div className="feature-icon">🕘</div>
          <h3>Historial completo</h3>
          <p>Repasa tus fallos las veces que necesites hasta dominarlos.</p>
        </div>
      </section>

      <section className="section">
        <div className="testimonial">
          <div className="stars">★★★★★</div>
          <div className="testimonial-quote">"Aprobé las oposiciones a la primera. examIA me ahorró meses."</div>
          <div className="testimonial-author">— María L., opositora</div>
        </div>
        <div className="ad-box">
          <div className="ad-tag">AD</div>
          <div className="ad-text">Tu marca aquí — llega a miles de estudiantes</div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Precios simples</h2>
        <p className="section-sub">Empieza gratis. Sube cuando lo necesites.</p>
        <div className="pricing-grid">
          <div className="price-card">
            <div className="price-name">Gratis</div>
            <div className="price-amount">0€<small> /mes</small></div>
            <div className="price-feat"><span className="check">✓</span> 3 exámenes gratis</div>
            <div className="price-feat"><span className="check">✓</span> Hasta 15 preguntas</div>
            <div className="price-feat"><span className="check">✓</span> Repaso de fallos</div>
            <button className="btn btn-ghost" onClick={onStart}>Empezar</button>
          </div>
          <div className="price-card popular">
            <div className="price-popular-tag">Popular</div>
            <div className="price-name">Pro</div>
            <div className="price-amount">{PRICE_DISPLAY}<small> /mes</small></div>
            <div className="price-feat"><span className="check">✓</span> Exámenes ilimitados</div>
            <div className="price-feat"><span className="check">✓</span> Hasta 20 preguntas</div>
            <div className="price-feat"><span className="check">✓</span> Exámenes ilimitados</div>
            <button className="btn btn-gold" onClick={onSubscribe}>Suscribirme</button>
          </div>
          <div className="price-card">
            <div className="price-name">Equipos</div>
            <div className="price-amount">Próximamente</div>
            <div className="price-feat"><span className="check">✓</span> Cuentas compartidas</div>
            <div className="price-feat"><span className="check">✓</span> Estadísticas de grupo</div>
            <div className="price-feat"><span className="check">✓</span> Soporte prioritario</div>
            <button className="btn btn-ghost" disabled>Lista de espera</button>
          </div>
        </div>
      </section>

      <section className="section final-cta">
        <div className="shield">🛡</div>
        <h2>¿Listo para aprobar?</h2>
        <button className="btn btn-gold btn-lg" onClick={onStart}>Crear mi primer examen →</button>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <div className="logo"><span className="logo-badge">🎓</span><span className="logo-text">exam<b>IA</b></span></div>
            <p>Aprueba antes con exámenes hechos a tu medida.</p>
          </div>
          <div className="footer-col"><h4>Producto</h4><a onClick={onStart}>Crear examen</a><a onClick={onStart}>Precios</a></div>
          <div className="footer-col"><h4>Compañía</h4><a>Contacto</a></div>
          <div className="footer-col"><h4>Legal</h4><a>Privacidad</a><a>Términos</a></div>
        </div>
        <div className="footer-bottom">© 2026 examIA. Made with ✦ for students.</div>
      </footer>
    </div>
  );
}

// ── Main App ──
function App() {
  const [view, setView] = useState("landing");
  const [apiKey, setApiKey] = useState(() => loadApiKey());
  const [subToken, setSubToken] = useState(() => { try { return localStorage.getItem(SUBTOKEN_STORAGE) || ""; } catch { return ""; } });
  const [mode, setMode] = useState(() => { try { return localStorage.getItem(SUBTOKEN_STORAGE) ? "pro" : (loadApiKey() ? "byok" : "free"); } catch { return "free"; } });
  const [freeRemaining, setFreeRemaining] = useState(null);
  const [showApiModal, setShowApiModal] = useState(false);
  const [showExhausted, setShowExhausted] = useState(false);
  const [pdf, setPdf] = useState(null);
  const [numQ, setNumQ] = useState(10);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [fallos, setFallos] = useState(() => loadFallos());
  const [savedPdfs, setSavedPdfs] = useState([]);
  const [isReview, setIsReview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [retryMsg, setRetryMsg] = useState("");
  const [error, setError] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    idbLoadPdfs().then(setSavedPdfs).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success" && params.get("session_id")) {
      fetch("/api/activate?session_id=" + encodeURIComponent(params.get("session_id")))
        .then(r => r.json())
        .then(d => {
          if (d.active && d.token) {
            try { localStorage.setItem(SUBTOKEN_STORAGE, d.token); } catch {}
            setSubToken(d.token); setMode("pro"); setView("home");
          }
        }).catch(() => {})
        .finally(() => window.history.replaceState({}, "", "/"));
    } else if (params.get("checkout") === "cancel") {
      window.history.replaceState({}, "", "/");
    } else {
      const t = (() => { try { return localStorage.getItem(SUBTOKEN_STORAGE) || ""; } catch { return ""; } })();
      if (t) {
        fetch("/api/sub-status?token=" + encodeURIComponent(t)).then(r => r.json()).then(d => {
          if (d.active) { setSubToken(t); setMode("pro"); }
          else { try { localStorage.removeItem(SUBTOKEN_STORAGE); } catch {} setMode(loadApiKey() ? "byok" : "free"); fetchUsage().then(u => setFreeRemaining(u.remaining)).catch(() => {}); }
        }).catch(() => {});
      } else if (mode === "free") {
        fetchUsage().then(u => setFreeRemaining(u.remaining)).catch(() => {});
      }
    }
  }, []);

  const updateFallos = useCallback(arr => { setFallos(arr); saveFallos(arr); }, []);

  const handleSaveApiKey = key => {
    saveApiKey(key); setApiKey(key); setMode("byok"); setShowApiModal(false); setShowExhausted(false); setError(null);
  };

  const goToApp = () => { setView("home"); window.scrollTo(0, 0); };

  const handleExhausted = () => { setExtracting(false); setLoading(false); setShowExhausted(true); setFreeRemaining(0); };

  const handleFile = useCallback(file => {
    if (!file) return;
    if (file.type !== "application/pdf") { setError("Solo se admiten archivos PDF."); return; }
    setError(null);
    const reader = new FileReader();
    reader.onload = e => {
      const b64 = e.target.result.split(",")[1];
      const newPdf = { name: file.name, size: (file.size / 1024 / 1024).toFixed(2) + " MB", base64: b64 };
      setPdf(newPdf);
      startExtraction(newPdf, null);
    };
    reader.readAsDataURL(file);
  }, [mode, apiKey, subToken]);

  const startExtraction = useCallback(async (pdfData, existingId) => {
    setExtracting(true); setError(null); setRetryMsg("");
    try {
      const text = await withRetry(
        () => mode === "byok" ? byokExtract(pdfData.base64, apiKey || loadApiKey()) : freeExtract(pdfData.base64, subToken),
        m => setRetryMsg(m)
      );
      const enriched = { ...pdfData, textContent: text };
      setPdf(enriched);
      if (existingId) { await idbUpdatePdf(existingId, { textContent: text }); setSavedPdfs(p => p.map(x => x.id === existingId ? { ...x, textContent: text } : x)); }
      else { const id = await idbSavePdf(enriched); setSavedPdfs(p => [...p, { ...enriched, id }]); }
      setView("config");
    } catch (err) {
      if (err.code === "free_exhausted") { handleExhausted(); }
      else { setError("Error al procesar el PDF: " + err.message); setView("home"); }
    }
    setExtracting(false);
  }, [mode, apiKey, subToken]);

  const startExam = useCallback(async () => {
    setLoading(true); setError(null); setRetryMsg("");
    try {
      const result = await withRetry(
        () => mode === "byok" ? byokGenerate(pdf.textContent, numQ, apiKey || loadApiKey()).then(qs => ({ questions: qs })) : freeGenerate(pdf.textContent, numQ, subToken),
        m => setRetryMsg(m)
      );
      setRetryMsg("");
      if (result.remaining !== undefined) setFreeRemaining(result.remaining);
      setQuestions(result.questions); setAnswers({}); setSubmitted(false); setIsReview(false);
      setView("exam");
    } catch (e) {
      if (e.code === "free_exhausted") { handleExhausted(); }
      else { setError("Error al generar preguntas: " + e.message); }
    }
    setLoading(false);
  }, [pdf, numQ, mode, apiKey, subToken]);

  const startReview = useCallback(() => {
    if (!fallos.length) return;
    setQuestions(fallos.map(f => ({ question: f.question, options: f.options, correct: f.correct, explanation: f.explanation })));
    setAnswers({}); setSubmitted(false); setIsReview(true); setView("exam");
  }, [fallos]);

  const handleAnswer = useCallback((qi, oi) => { if (!submitted) setAnswers(p => ({ ...p, [qi]: oi })); }, [submitted]);

  const handleSubmit = useCallback(() => {
    const un = questions.filter((_, i) => answers[i] === undefined).length;
    if (un > 0 && !window.confirm("Tienes " + un + " pregunta(s) sin responder. ¿Enviar igualmente?")) return;
    setSubmitted(true);
    const wrongNow = questions.map((q, i) => ({ ...q, userAnswer: answers[i] })).filter(q => q.userAnswer !== q.correct);
    if (isReview) {
      const corrected = new Set(questions.filter((q, i) => answers[i] === q.correct).map(q => q.question));
      const wrongT = new Set(wrongNow.map(w => w.question));
      updateFallos([...fallos.filter(f => !corrected.has(f.question) && !wrongT.has(f.question)), ...wrongNow]);
    } else {
      const ex = new Set(fallos.map(f => f.question));
      const add = wrongNow.filter(w => !ex.has(w.question));
      if (add.length) updateFallos([...fallos, ...add]);
    }
    setView("results");
  }, [questions, answers, isReview, fallos, updateFallos]);

  const useSavedPdf = saved => {
    setPdf(saved);
    if (saved.textContent && mode === "free") setView("config");
    else if (saved.textContent && mode === "byok") setView("config");
    else startExtraction(saved, saved.id);
  };
  const deleteSavedPdf = async (id, e) => { e.stopPropagation(); await idbDeletePdf(id).catch(() => {}); setSavedPdfs(p => p.filter(x => x.id !== id)); };

  const correctCount = questions.filter((q, i) => answers[i] === q.correct).length;
  const answeredCount = Object.keys(answers).length;
  const pct = questions.length ? Math.round((correctCount / questions.length) * 100) : 0;
  const wrongCount = questions.length - correctCount;
  const scoreMsg = pct >= 90 ? "🏆 ¡Resultado excelente!" : pct >= 70 ? "👍 Buen trabajo" : pct >= 50 ? "📖 Sigue estudiando" : "💪 ¡A repasar más!";

  const headerProps = { view, fallos, freeRemaining, mode, onLogo: () => setView("landing"), onPanel: goToApp, onFallos: () => setView("fallos"), onApiKey: () => setShowApiModal(true) };
  const modals = (
    <>
      {showApiModal && <ApiKeyModal onSave={handleSaveApiKey} onClose={() => setShowApiModal(false)} />}
      {showExhausted && <ExhaustedModal onSubscribe={startCheckout} onByok={() => { setShowExhausted(false); setShowApiModal(true); }} onClose={() => setShowExhausted(false)} />}
    </>
  );
  const orbs = <><div className="glow-orb glow-orb-1" /><div className="glow-orb glow-orb-2" /></>;

  // LANDING
  if (view === "landing") return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} /><Landing onStart={goToApp} onSubscribe={startCheckout} /></div>
  );

  // LOADING / EXTRACTING
  if (extracting || loading) return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} />
      <div className="main"><div className="loading-view">
        <div className="spinner" />
        <div>
          <div className="loading-title">{extracting ? "Procesando PDF…" : "Generando preguntas…"}</div>
          <div className="loading-sub">{retryMsg || (extracting ? "Extrayendo el texto del temario — solo ocurre una vez" : "Creando tu examen")}</div>
          <div className="loading-dots"><div className="loading-dot" /><div className="loading-dot" /><div className="loading-dot" /></div>
        </div>
      </div></div>
    </div>
  );

  // CONFIG
  if (view === "config") return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} />
      {mode === "free" && freeRemaining !== null && <div className="free-banner">🎁 Te quedan <b style={{ margin: "0 4px" }}>{freeRemaining}</b> exámenes gratis</div>}
      <div className="main"><div className="config-wrap">
        <div className="config-title">Configurar examen</div>
        <div className="config-sub">Elige cuántas preguntas quieres responder</div>
        {pdf && <div className="file-pill"><div className="file-pill-icon">📄</div><div style={{ overflow: "hidden" }}><div className="file-pill-name">{pdf.name}</div><div className="file-pill-size">{pdf.size}</div></div></div>}
        {error && <div className="error-box">{error}</div>}
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Número de preguntas</div>
        <div className="qty-grid">{[5, 10, 15, 20].map(n => <button key={n} className={"qty-btn " + (numQ === n ? "selected" : "")} onClick={() => setNumQ(n)}>{n}</button>)}</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => { setView("home"); setError(null); }}>← Volver</button>
          <button className="btn btn-gold btn-lg" style={{ flex: 1 }} onClick={startExam}>Comenzar examen →</button>
        </div>
      </div></div>
    </div>
  );

  // EXAM
  if (view === "exam") return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} onLogo={() => { if (window.confirm("¿Salir del examen?")) { setView("landing"); setSubmitted(false); } }} />
      <div className="main" style={{ paddingBottom: 120 }}>
        <div className="q-header-row">
          <div className="q-header-title">{questions.length} preguntas {isReview && <span className="q-mode-badge">🔁 Repaso</span>}</div>
          {!submitted && <div style={{ fontSize: 13, color: "var(--muted)" }}>Respondidas: <strong style={{ color: "var(--text)" }}>{answeredCount}/{questions.length}</strong></div>}
        </div>
        {questions.map((q, qi) => {
          const ua = answers[qi]; const ok = ua === q.correct;
          return (
            <div key={qi} className={"q-card " + (submitted ? (ok ? "correct-card" : "wrong-card") : "")}>
              <div className="q-num">Pregunta {qi + 1} de {questions.length}{submitted && <span className={"tag " + (ok ? "tag-green" : "tag-red")} style={{ marginLeft: 8 }}>{ok ? "✓ Correcta" : "✗ Incorrecta"}</span>}</div>
              <div className="q-text">{q.question}</div>
              <div className="options-grid">
                {q.options.map((opt, oi) => {
                  let cls = "opt-btn";
                  if (submitted) { if (oi === q.correct) cls += " opt-correct"; else if (oi === ua) cls += " opt-wrong"; }
                  else if (ua === oi) cls += " opt-selected";
                  return <button key={oi} className={cls} onClick={() => handleAnswer(qi, oi)} disabled={submitted}><span className="opt-letter">{LETTERS[oi]}</span>{opt}</button>;
                })}
              </div>
              {submitted && <div className="explanation"><strong>Explicación:</strong> {q.explanation}</div>}
            </div>
          );
        })}
        {submitted && (
          <div className="actions-bar">
            <button className="btn btn-gold" onClick={() => setView("home")}>🏠 Inicio</button>
            {!isReview && pdf && <button className="btn btn-ghost" onClick={() => { setView("config"); setSubmitted(false); }}>🔄 Nuevo examen</button>}
            {fallos.length > 0 && <button className="btn btn-outline" onClick={() => setView("fallos")}>📋 Ver fallos</button>}
          </div>
        )}
      </div>
      <div className="sticky-bar">
        {submitted ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><span className="tag tag-green">✓ {correctCount} correctas</span>{wrongCount > 0 && <span className="tag tag-red">✗ {wrongCount} incorrectas</span>}</div>
            <button className="btn btn-gold" onClick={() => setView("results")}>Ver resultados →</button>
          </>
        ) : (
          <>
            <div className="progress-info"><strong>{answeredCount}</strong> / {questions.length} respondidas</div>
            <button className="btn btn-gold btn-lg" onClick={handleSubmit} disabled={answeredCount === 0}>Enviar examen ✓</button>
          </>
        )}
      </div>
    </div>
  );

  // RESULTS
  if (view === "results") return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} />
      <div className="main">
        <div className="results-hero">
          <div className="score-circle"><div className="score-num">{pct}%</div><div className="score-pct">puntuación</div></div>
          <div className="score-msg">{scoreMsg}</div>
          <div className="score-sub">{correctCount} correctas de {questions.length} preguntas</div>
          <div className="stats-row">
            <div className="stat-box g"><div className="stat-n">{correctCount}</div><div className="stat-l">Correctas</div></div>
            <div className="stat-box r"><div className="stat-n">{wrongCount}</div><div className="stat-l">Incorrectas</div></div>
          </div>
        </div>
        {wrongCount > 0 && <div className="fallos-notice">📌 <span><strong style={{ color: "var(--red)" }}>{wrongCount} pregunta(s)</strong> guardada(s) en Fallos para repasar</span></div>}
        {isReview && <div className={"review-banner " + (correctCount === questions.length ? "success" : "warning")}>{correctCount === questions.length ? "🎉 ¡Has corregido todos los fallos!" : "🔁 Aún quedan " + wrongCount + " por dominar. ¡Sigue repasando!"}</div>}
        <div className="actions-bar">
          <button className="btn btn-gold btn-lg" onClick={() => setView("home")}>🏠 Inicio</button>
          <button className="btn btn-ghost" onClick={() => setView("exam")}>👁 Revisar respuestas</button>
          {fallos.length > 0 && <button className="btn btn-outline" onClick={() => setView("fallos")}>📋 Ver mis fallos</button>}
        </div>
      </div>
    </div>
  );

  // FALLOS
  if (view === "fallos") return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} />
      <div className="main">
        <div className="fallos-page-header">
          <div><div className="page-title">Mis fallos</div><div className="page-sub">{fallos.length} pregunta(s) pendiente(s)</div></div>
          {fallos.length > 0 && <div style={{ display: "flex", gap: 8 }}><button className="btn btn-gold" onClick={startReview}>🔁 Repasar</button><button className="btn btn-danger-outline" onClick={() => { if (window.confirm("¿Eliminar todos los fallos?")) updateFallos([]); }}>🗑 Borrar</button></div>}
        </div>
        {fallos.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">🎯</div><div className="empty-title">¡Sin errores guardados!</div><div className="empty-sub">Cuando falles preguntas aparecerán aquí</div><button className="btn btn-ghost" style={{ marginTop: 24 }} onClick={() => setView("home")}>Hacer un examen</button></div>
        ) : fallos.map((f, i) => <div key={i} className="fallo-item"><div className="fallo-q">{f.question}</div><div className="fallo-correct">Respuesta correcta: <span>{f.options[f.correct]}</span></div></div>)}
      </div>
    </div>
  );

  // HOME (upload)
  return (
    <div className="examia-app">{orbs}{modals}<Header {...headerProps} />
      {mode === "free" && freeRemaining !== null && <div className="free-banner">🎁 Te quedan <b style={{ margin: "0 4px" }}>{freeRemaining}</b> exámenes gratis{freeRemaining === 0 && <button className="nav-pill" style={{ marginLeft: 10 }} onClick={() => setShowExhausted(true)}>Ver planes</button>}</div>}
      {mode === "pro" && <div className="free-banner" style={{ color: "var(--green)", background: "var(--green-dim)", borderColor: "rgba(74,222,128,0.2)" }}>✨ Plan Pro activo · exámenes ilimitados</div>}
      <div className="main">
        <div className="app-hero-label">Examinador con IA</div>
        <div className="app-hero-title">Convierte tu temario<br />en un <em>examen tipo test</em></div>
        <div className="app-hero-sub">Sube el PDF de tus apuntes, elige cuántas preguntas y la IA te examina al instante.</div>
        {error && <div className="error-box" style={{ marginBottom: 20 }}>{error}</div>}
        {savedPdfs.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>PDFs guardados</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
              {savedPdfs.map(p => (
                <div key={p.id} onClick={() => useSavedPdf(p)} style={{ background: "var(--surface)", border: "1.5px solid var(--border)", borderRadius: "var(--r)", padding: 16, cursor: "pointer", position: "relative" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--gold)"; }} onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 24 }}>{p.name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>{p.size}{p.textContent ? <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ listo</span> : <span style={{ color: "var(--gold)" }}>⏳</span>}</div>
                  <button onClick={e => deleteSavedPdf(p.id, e)} title="Eliminar" style={{ position: "absolute", top: 10, right: 10, background: "transparent", border: "none", cursor: "pointer", fontSize: 14, color: "var(--hint)" }}>✕</button>
                </div>
              ))}
            </div>
            <div className="divider">o sube uno nuevo</div>
          </div>
        )}
        <div className={"upload-zone " + (dragOver ? "dragover" : "")} onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}>
          <div className="upload-icon">📄</div>
          <div className="upload-title">Arrastra tu PDF aquí</div>
          <div className="upload-hint">o haz clic para buscar el archivo</div>
          <input ref={fileRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
        </div>
        {fallos.length > 0 && <>
          <div className="divider">o</div>
          <div className="card"><div className="fallos-cta"><div className="fallos-cta-info"><h3>📋 Repasar mis fallos <span className="badge" style={{ verticalAlign: "middle" }}>{fallos.length}</span></h3><p>Practica las preguntas que fallaste</p></div><button className="btn btn-gold" onClick={startReview}>Repasar →</button></div></div>
        </>}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
