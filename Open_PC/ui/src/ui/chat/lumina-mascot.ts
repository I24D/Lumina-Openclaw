// Lumina mascot — SVG rendition of the official OpenClaw character.
// All parts are addressable via CSS classes so the voice overlay can animate
// each one independently (mouth opens while speaking, eyes blink/dart,
// antennae wiggle while thinking, arms bounce while speaking, halo on listening).
//
// Anatomy:
//   - body         large round red blob with subtle radial highlight
//   - antenna-l/r  thin red curves + tip bulbs (top of head)
//   - eye-l/r      black ovals (the white shape around the iris)
//   - iris-l/r     cyan/teal round iris (animates: blink, dart, pulse)
//   - mouth        open smiling mouth (path that can be scaled)
//   - tongue       inner red-pink tongue
//   - arm-l/r      side blobs (the rounded "hands")
//   - leg-l/r      tiny rectangles at the bottom
//   - halo         large soft circle behind the body (only visible on listening)
import { html } from "lit";

export type MascotProps = {
  // Tailwind-ish breakpoints; default 220x260.
  width?: number;
  height?: number;
};

export function renderLuminaMascot(props: MascotProps = {}) {
  const w = props.width ?? 220;
  const h = props.height ?? 260;
  return html`
    <svg
      class="lumina-mascot"
      width=${w}
      height=${h}
      viewBox="0 0 220 260"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="lumina-body-grad" cx="42%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#ff6b6b" />
          <stop offset="60%" stop-color="#e63946" />
          <stop offset="100%" stop-color="#c1272d" />
        </radialGradient>
        <radialGradient id="lumina-iris-grad" cx="40%" cy="35%" r="60%">
          <stop offset="0%" stop-color="#7df7e6" />
          <stop offset="100%" stop-color="#10b9a8" />
        </radialGradient>
        <radialGradient id="lumina-halo-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.5" />
          <stop offset="60%" stop-color="#10b981" stop-opacity="0.18" />
          <stop offset="100%" stop-color="#10b981" stop-opacity="0" />
        </radialGradient>
      </defs>

      <!-- Listening halo (hidden by default; activated by overlay state) -->
      <circle class="lumina-mascot__halo" cx="110" cy="135" r="105" fill="url(#lumina-halo-grad)" />

      <!-- Antennae -->
      <g class="lumina-mascot__antennae">
        <g class="lumina-mascot__antenna lumina-mascot__antenna--left">
          <path d="M 88 60 Q 78 38 84 18" stroke="#e63946" stroke-width="6" stroke-linecap="round" fill="none" />
          <circle cx="84" cy="14" r="6" fill="#e63946" />
        </g>
        <g class="lumina-mascot__antenna lumina-mascot__antenna--right">
          <path d="M 132 60 Q 142 38 136 18" stroke="#e63946" stroke-width="6" stroke-linecap="round" fill="none" />
          <circle cx="136" cy="14" r="6" fill="#e63946" />
        </g>
      </g>

      <!-- Arms (behind body so the body covers their attachment) -->
      <g class="lumina-mascot__arms">
        <ellipse class="lumina-mascot__arm lumina-mascot__arm--left" cx="32" cy="160" rx="22" ry="26" fill="#e63946" />
        <ellipse class="lumina-mascot__arm lumina-mascot__arm--right" cx="188" cy="160" rx="22" ry="26" fill="#e63946" />
      </g>

      <!-- Body -->
      <ellipse class="lumina-mascot__body" cx="110" cy="135" rx="86" ry="82" fill="url(#lumina-body-grad)" />

      <!-- Eyes (the dark whites of the eye that don't move) -->
      <g class="lumina-mascot__eyes">
        <ellipse class="lumina-mascot__eye lumina-mascot__eye--left" cx="84" cy="118" rx="14" ry="15" fill="#1a1a1a" />
        <ellipse class="lumina-mascot__eye lumina-mascot__eye--right" cx="136" cy="118" rx="14" ry="15" fill="#1a1a1a" />
        <!-- Irises (these are the parts that blink/dart) -->
        <g class="lumina-mascot__pupil lumina-mascot__pupil--left">
          <circle class="lumina-mascot__iris lumina-mascot__iris--left" cx="84" cy="118" r="6" fill="url(#lumina-iris-grad)" />
          <circle class="lumina-mascot__iris-spark" cx="82" cy="116" r="1.6" fill="#fff" opacity="0.9" />
        </g>
        <g class="lumina-mascot__pupil lumina-mascot__pupil--right">
          <circle class="lumina-mascot__iris lumina-mascot__iris--right" cx="136" cy="118" r="6" fill="url(#lumina-iris-grad)" />
          <circle class="lumina-mascot__iris-spark" cx="134" cy="116" r="1.6" fill="#fff" opacity="0.9" />
        </g>
      </g>

      <!-- Mouth: separate closed/open shapes make speech visibly readable. -->
      <g class="lumina-mascot__mouth-wrap">
        <path
          class="lumina-mascot__mouth-closed"
          d="M 88 151 Q 110 167 132 151"
          fill="none"
          stroke="#1a1a1a"
          stroke-width="6"
          stroke-linecap="round"
        />
        <ellipse
          class="lumina-mascot__mouth-open"
          cx="110"
          cy="158"
          rx="25"
          ry="16"
          fill="#1a1a1a"
        />
        <!-- Tongue inside the mouth (only visible when open) -->
        <path
          class="lumina-mascot__tongue"
          d="M 95 158 Q 110 170 125 158 Q 110 164 95 158 Z"
          fill="#ff7186"
        />
      </g>

      <!-- Legs -->
      <g class="lumina-mascot__legs">
        <rect class="lumina-mascot__leg" x="92" y="215" width="10" height="22" rx="4" fill="#e63946" />
        <rect class="lumina-mascot__leg" x="118" y="215" width="10" height="22" rx="4" fill="#e63946" />
      </g>
    </svg>
  `;
}
