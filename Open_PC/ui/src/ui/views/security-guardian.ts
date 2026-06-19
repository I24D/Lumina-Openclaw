// Security Guardian panel — Phase 5.
//
// Live dashboard fed by the Lumina Security Service running on
// 127.0.0.1:18792. The endpoint /public/dashboard is unauthenticated
// (localhost-only bind), refreshed every 60s by the service itself.
//
// If the service is not installed/running, the panel shows install
// instructions instead of fake data — same honesty rule as Phase 1.
import { html, nothing, type TemplateResult } from "lit";

type DashboardData = {
  ok: boolean;
  generatedAt: string | null;
  payload: {
    av?: Array<{ displayName: string; productState: number }>;
    defender?: {
      AntivirusEnabled?: boolean;
      RealTimeProtectionEnabled?: boolean;
      IsTamperProtected?: boolean;
      AntivirusSignatureLastUpdated?: string;
      AMServiceEnabled?: boolean;
    } | null;
    firewall?: Array<{ Name: string; Enabled: boolean }>;
    threats?: Array<{ ThreatName: string; SeverityID: number; IsActive: boolean }>;
  } | null;
};

export type SecurityGuardianProps = {
  data: DashboardData | null;
  error: string | null;
  loading: boolean;
  lastFetchedAt: string | null;
  onRefresh: () => void;
};

function badge(label: string, variant: "ok" | "warn" | "err" | "neutral"): TemplateResult {
  return html`<span class="sg-badge sg-badge--${variant}">${label}</span>`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function renderInstallPrompt(reason: string | null): TemplateResult {
  return html`
    <div class="sg-empty">
      <div class="sg-empty__icon">🛡️</div>
      <h3>Servicio de Seguridad no disponible</h3>
      <p class="sg-empty__detail">${reason ?? "No se pudo contactar 127.0.0.1:18792"}</p>
      <p class="sg-empty__hint">
        Para activar el dashboard live, ejecuta como administrador:<br />
        <code>C:\\Users\\dal_n\\.lumina\\bin\\lumina-security-service\\install-service.cmd</code>
      </p>
      <p class="sg-empty__note">
        Mientras tanto, puedes pedirle a Lumina en el chat: <em>"audita la seguridad de mi PC"</em>
        — Lumina invoca <code>security_status</code> del MCP y te da el reporte completo.
      </p>
    </div>
  `;
}

export function renderSecurityGuardian(props: SecurityGuardianProps): TemplateResult {
  if (props.loading && !props.data) {
    return html`<div class="sg-loading">Cargando estado de seguridad…</div>`;
  }
  if (props.error || !props.data) {
    return renderInstallPrompt(props.error);
  }

  const d = props.data;
  const payload = d.payload ?? {};
  const av = payload.av ?? [];
  const def = payload.defender ?? null;
  const fw = payload.firewall ?? [];
  const threats = payload.threats ?? [];

  // Identify the primary AV (active, non-Defender).
  const primaryAv =
    av.find((p) => (p.productState & 0x1000) !== 0 && !/defender/i.test(p.displayName ?? "")) ??
    av.find((p) => (p.productState & 0x1000) !== 0) ??
    av[0] ??
    null;

  const fwEnabledCount = fw.filter((p) => p.Enabled === true).length;
  const fwTotal = fw.length;
  const activeThreatCount = threats.filter((t) => t.IsActive).length;

  return html`
    <section class="sg-panel">
      <header class="sg-panel__header">
        <div>
          <h2 class="sg-panel__title">🛡️ Security Guardian</h2>
          <p class="sg-panel__sub">
            Actualizado: ${formatDate(d.generatedAt)} ·
            <button type="button" class="sg-link" @click=${props.onRefresh}>refrescar</button>
          </p>
        </div>
      </header>

      <div class="sg-grid">
        <!-- AV principal -->
        <div class="sg-card">
          <div class="sg-card__label">Antivirus principal</div>
          <div class="sg-card__value">${primaryAv?.displayName ?? "—"}</div>
          <div class="sg-card__meta">
            ${primaryAv
              ? badge(
                  (primaryAv.productState & 0x1000) !== 0 ? "activo" : "inactivo",
                  (primaryAv.productState & 0x1000) !== 0 ? "ok" : "err",
                )
              : badge("ninguno", "err")}
            ${av.length > 1 ? html`<span class="sg-card__hint">${av.length} AV registrados</span>` : nothing}
          </div>
        </div>

        <!-- Defender RTP -->
        <div class="sg-card">
          <div class="sg-card__label">Microsoft Defender</div>
          <div class="sg-card__value">
            ${def?.AMServiceEnabled ? "Servicio activo" : "Servicio inactivo"}
          </div>
          <div class="sg-card__meta">
            ${badge(`RTP ${def?.RealTimeProtectionEnabled ? "ON" : "OFF"}`, def?.RealTimeProtectionEnabled ? "ok" : "warn")}
            ${badge(`Tamper ${def?.IsTamperProtected ? "ON" : "OFF"}`, def?.IsTamperProtected ? "ok" : "warn")}
          </div>
          <div class="sg-card__hint">
            Última firma: ${formatDate(def?.AntivirusSignatureLastUpdated)}
          </div>
        </div>

        <!-- Firewall -->
        <div class="sg-card">
          <div class="sg-card__label">Firewall</div>
          <div class="sg-card__value">${fwEnabledCount}/${fwTotal} perfiles</div>
          <div class="sg-card__meta">
            ${fw.map(
              (p) =>
                html`<span class="sg-pill sg-pill--${p.Enabled ? "on" : "off"}">${p.Name}</span>`,
            )}
          </div>
        </div>

        <!-- Amenazas -->
        <div class="sg-card">
          <div class="sg-card__label">Amenazas (Defender)</div>
          <div class="sg-card__value">${threats.length}</div>
          <div class="sg-card__meta">
            ${activeThreatCount > 0
              ? badge(`${activeThreatCount} activas`, "err")
              : badge("ninguna activa", "ok")}
          </div>
          ${threats.length > 0
            ? html`
                <ul class="sg-list">
                  ${threats.slice(0, 5).map(
                    (t) => html`
                      <li>
                        <strong>${t.ThreatName}</strong> —
                        ${badge(
                          `severity ${t.SeverityID}`,
                          t.SeverityID >= 4 ? "err" : t.SeverityID >= 2 ? "warn" : "neutral",
                        )}
                      </li>
                    `,
                  )}
                </ul>
              `
            : nothing}
        </div>
      </div>

      <div class="sg-actions">
        <p class="sg-hint">
          🔍 Para más detalle en cualquier campo, dile a Lumina en el chat:
          <em>"audita la seguridad de mi PC"</em>,
          <em>"haz un FIM check"</em>,
          <em>"escanea con Defender"</em>,
          <em>"dame el inventario de procesos y red"</em>.
        </p>
      </div>
    </section>
  `;
}
