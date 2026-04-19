import { html }          from "lit";
import {
  luminaLogin,
  luminaRegister,
  LuminaAuthError,
} from "../../lumina/auth-client.ts";

export type LuminaAuthMode = "login" | "register";

export interface LuminaAuthGateState {
  luminaAuthMode: LuminaAuthMode;
  luminaEmail:    string;
  luminaPassword: string;
  luminaLoading:  boolean;
  luminaError:    string | null;
  requestUpdate:  () => void;
}

export function renderLuminaAuthGate(state: LuminaAuthGateState) {
  const isLogin = state.luminaAuthMode === "login";

  async function handleSubmit() {
    if (state.luminaLoading) return;

    const email    = state.luminaEmail.trim();
    const password = state.luminaPassword;

    if (!email || !password) {
      state.luminaError = "Email and password are required.";
      state.requestUpdate();
      return;
    }

    if (!isLogin && password.length < 8) {
      state.luminaError = "Password must be at least 8 characters.";
      state.requestUpdate();
      return;
    }

    state.luminaLoading = true;
    state.luminaError   = null;
    state.requestUpdate();

    try {
      if (isLogin) {
        await luminaLogin(email, password);
      } else {
        await luminaRegister(email, password);
      }
      state.luminaLoading = false;
      // JWT is now in localStorage — re-render exits the gate automatically
      state.requestUpdate();
    } catch (err) {
      state.luminaLoading = false;
      state.luminaError   =
        err instanceof LuminaAuthError
          ? err.message
          : "Something went wrong. Please try again.";
      state.requestUpdate();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") void handleSubmit();
  }

  return html`
    <div class="login-gate lumina-auth-gate">
      <div class="login-gate__card">

        <div class="login-gate__header">
          <div class="lumina-auth-gate__wordmark">LUMINA</div>
          <div class="login-gate__sub">
            ${isLogin ? "Sign in to your account" : "Create your account"}
          </div>
        </div>

        <div class="login-gate__form">
          <label class="field">
            <span>Email</span>
            <input
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              .value=${state.luminaEmail}
              ?disabled=${state.luminaLoading}
              @input=${(e: Event) => {
                state.luminaEmail = (e.target as HTMLInputElement).value;
              }}
              @keydown=${handleKeydown}
            />
          </label>

          <label class="field">
            <span>Password</span>
            <input
              type="password"
              autocomplete=${isLogin ? "current-password" : "new-password"}
              placeholder=${isLogin ? "Your password" : "Min. 8 characters"}
              .value=${state.luminaPassword}
              ?disabled=${state.luminaLoading}
              @input=${(e: Event) => {
                state.luminaPassword = (e.target as HTMLInputElement).value;
              }}
              @keydown=${handleKeydown}
            />
          </label>

          <button
            class="btn primary login-gate__connect"
            ?disabled=${state.luminaLoading}
            @click=${() => void handleSubmit()}
          >
            ${state.luminaLoading
              ? "Please wait…"
              : isLogin
                ? "Sign In"
                : "Create Account"}
          </button>
        </div>

        ${state.luminaError
          ? html`<div class="callout danger" style="margin-top:14px">
                   <div>${state.luminaError}</div>
                 </div>`
          : ""}

        <div class="login-gate__help" style="margin-top:20px;text-align:center">
          ${isLogin
            ? html`<span>Don't have an account?</span>
                   <button
                     class="btn btn--link"
                     style="margin-left:6px"
                     @click=${() => {
                       state.luminaAuthMode = "register";
                       state.luminaError    = null;
                       state.requestUpdate();
                     }}
                   >Create one</button>`
            : html`<span>Already have an account?</span>
                   <button
                     class="btn btn--link"
                     style="margin-left:6px"
                     @click=${() => {
                       state.luminaAuthMode = "login";
                       state.luminaError    = null;
                       state.requestUpdate();
                     }}
                   >Sign In</button>`}
        </div>

      </div>
    </div>
  `;
}
