/**
 * themeTokens.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bridges AppContext's THEMES (tokens.bg, tokens.accent, etc.) into the full
 * grey-cascade + semantic palette used across ECGViewer, Sidebar, TimelineBar,
 * PatientBanner, StatusBar, PatientTabs, PatientPicker.
 *
 * These components were originally written with hardcoded dark-theme hex
 * literals (a deep grey cascade for hierarchy/disabled states, plus a handful
 * of semantic accents). getEcgTheme() reproduces that same *structure* but
 * derives every value from tokens, so light mode inverts correctly.
 *
 * Usage:
 *   const { tokens, theme } = useApp();
 *   const T = getEcgTheme(tokens, theme);
 *   ... style={{ color: T.grey6, background: T.surface0 }}
 */

// ─── Color helpers ──────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const c = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear-interpolate between two hex colors. t=0 → a, t=1 → b */
function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );
}

export function withAlpha(hex, alpha) {
  if (!hex) return `rgba(0,0,0,${alpha})`;
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Main mapper ──────────────────────────────────────────────────────────────

/**
 * getEcgTheme(tokens, theme)
 *
 * Returns a flat palette object. Every field has a meaningful name describing
 * its role (not its original hex value), so components read naturally:
 *   T.surface0   — deepest background (was #090909 / #070707 / #0a0a0a)
 *   T.surface1   — toolbar/panel background (was #0f0f0f / #0d0d0d / #0b0b0b)
 *   T.surface2   — secondary panel (was #141414 / #090909)
 *   T.border0    — faint structural border (was #111 / #121212)
 *   T.border1    — standard border (was #1a1a1a / #1e1e1e)
 *   T.border2    — stronger border (was #222)
 *
 *   Grey text cascade, light → dark in dark mode (inverted in light mode):
 *   T.grey1 (was #888, most visible muted text)
 *   T.grey2 (was #666)
 *   T.grey3 (was #555)
 *   T.grey4 (was #444)
 *   T.grey5 (was #3a3a3a)
 *   T.grey6 (was #333)
 *   T.grey7 (was #2a2a2a / #2e2e2e)
 *   T.grey8 (was #222 / #252525)
 *   T.grey9 (was #1e1e1e)
 *   T.grey10 (was #181818)
 *   T.grey11 (was #141414 / #161616, near-invisible)
 *   T.grey12 (was #111 / #121212, structural lines)
 *
 *   T.textPrimary   — brightest readable text (was #d0d0d0 / #e8e8e8 / #ccc)
 *
 *   Semantic accents (theme-aware versions of the app's signature colors):
 *   T.accent      — primary blue   (was #4f8ef7 / #378ADD)
 *   T.accentSoft  — secondary blue (was #00d68f-ish slot for sidebar logo —
 *                   mapped to accentGreen for consistency)
 *   T.green       — success/sinus  (was #34c77b / #00d68f)
 *   T.red         — danger/HR      (was #e05050 / #e8614a)
 *   T.amber       — warning        (was #f5a623 / #e8a230 / #faad14)
 *   T.purple      — HRV/atrial     (was #a78bfa)
 *   T.cyan        — pause marker   (was #38bdf8 / #56b6c2)
 *
 *   Tab color cycle:
 *   T.tabColors   — array of 6 colors for PatientTabs / TAB_COLORS
 *
 *   Marker colors (TimelineBar event strip):
 *   T.markerColors — { arrhythmia, st, qt, pause, custom }
 */
export function getEcgTheme(tokens, theme) {
  const isLight = theme === "light";

  // bg = darkest point in dark mode, lightest in light mode (tokens.bg)
  // textPrimary = lightest point in dark mode, darkest in light mode
  const bg   = tokens.bg;
  const fg   = tokens.textPrimary;

  // Grey cascade: interpolate from bg (0%) to fg (100%).
  // In the original dark UI, greys ranged roughly from 7% to 55% brightness.
  // We replicate that same proportional range, inverted automatically when
  // bg/fg are inverted (light theme).
  const greyStops = {
    grey1:  0.55,  // most visible muted text  (#888 equivalent)
    grey2:  0.42,  // (#666)
    grey3:  0.35,  // (#555)
    grey4:  0.28,  // (#444)
    grey5:  0.24,  // (#3a3a3a)
    grey6:  0.20,  // (#333)
    grey7:  0.17,  // (#2a2a2a)
    grey8:  0.15,  // (#222)
    grey9:  0.12,  // (#1e1e1e)
    grey10: 0.10,  // (#181818)
    grey11: 0.08,  // (#141414)
    grey12: 0.06,  // (#111)
  };

  const greys = {};
  for (const [key, t] of Object.entries(greyStops)) {
    greys[key] = mix(bg, fg, t);
  }

  // Surfaces: subtle steps above bg, biased toward fg slightly.
  const surface0 = bg;
  const surface1 = mix(bg, fg, isLight ? 0.0 : 0.04);  // tokens.surface already close
  const surface2 = mix(bg, fg, isLight ? 0.02 : 0.07); // tokens.surface2

  // Borders
  const border0 = greys.grey12; // faintest structural lines
  const border1 = greys.grey9;  // standard borders
  const border2 = greys.grey7;  // stronger borders

  return {
    // Surfaces
    surface0: tokens.bg,
    surface1: tokens.surface,
    surface2: tokens.surface2,

    // Borders
    border0,
    border1: tokens.border,
    border2: tokens.border2,

    // Grey text cascade
    ...greys,

    // Brightest text
    textPrimary:   tokens.textPrimary,
    textSecondary: tokens.textSecondary,
    textMuted:     tokens.textMuted,
    textLabel:     tokens.textLabel,

    // Semantic accents — theme-aware
    accent:     tokens.accent,
    accentSoft: tokens.accentGreen,
    green:      tokens.accentGreen,
    red:        tokens.accentRed,
    amber:      tokens.accentAmber,
    purple:     isLight ? "#5C51B0" : "#a78bfa",
    cyan:       isLight ? "#0284C7" : "#56b6c2",

    // Tab color cycle (PatientTabs)
    tabColors: [
      tokens.accent,
      tokens.accentGreen,
      tokens.accentAmber,
      tokens.accentRed,
      isLight ? "#5C51B0" : "#c678dd",
      isLight ? "#0284C7" : "#56b6c2",
    ],

    // Event marker colors (TimelineBar)
    markerColors: {
      arrhythmia: tokens.accentRed,
      st:         tokens.accentAmber,
      qt:         isLight ? "#5C51B0" : "#a78bfa",
      pause:      tokens.accent,
      custom:     tokens.accentGreen,
    },

    // Convenience alpha helper, re-exported so components don't need a
    // separate import
    withAlpha,

    isLight,
  };
}