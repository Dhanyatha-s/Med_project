/**
 * NotificationSystem.jsx — Global toast notification system
 *
 * Usage:
 *   1. Wrap your app root in <NotificationProvider>
 *   2. const { notify, dismiss } = useNotifications()
 *   3. notify({ type, title, message, duration? })
 *      type: "success" | "warning" | "error" | "info"
 *      Returns the numeric id of the created toast.
 *
 * Requires: lucide-react
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { CheckCircle, AlertTriangle, XCircle, Info, X } from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  success: {
    Icon: CheckCircle,
    colorVar: "--notif-success",
    borderVar: "--notif-success-border",
    bgVar: "--notif-success-bg",
  },
  warning: {
    Icon: AlertTriangle,
    colorVar: "--notif-warning",
    borderVar: "--notif-warning-border",
    bgVar: "--notif-warning-bg",
  },
  error: {
    Icon: XCircle,
    colorVar: "--notif-error",
    borderVar: "--notif-error-border",
    bgVar: "--notif-error-bg",
  },
  info: {
    Icon: Info,
    colorVar: "--notif-info",
    borderVar: "--notif-info-border",
    bgVar: "--notif-info-bg",
  },
};

const DEFAULT_DURATION = {
  success: 4000,
  info:    4000,
  warning: 6000,
  error:   8000,
};

const MAX_TOASTS = 5;

// ─── Stylesheet ───────────────────────────────────────────────────────────────

const STYLES = `
  :root {
    --notif-success:        #34c77b;
    --notif-success-border: #34c77b;
    --notif-success-bg:     rgba(27, 94, 32, 0.95);

    --notif-warning:        #f5a623;
    --notif-warning-border: #f5a623;
    --notif-warning-bg:     rgba(230, 81, 0, 0.95);

    --notif-error:          #e05050;
    --notif-error-border:   #e05050;
    --notif-error-bg:       rgba(183, 28, 28, 0.95);

    --notif-info:           #4f8ef7;
    --notif-info-border:    #4f8ef7;
    --notif-info-bg:        rgba(21, 101, 192, 0.95);

    --notif-text:           rgba(255, 255, 255, 0.95);
    --notif-text-muted:     rgba(255, 255, 255, 0.65);
    --notif-dismiss-hover:  rgba(255, 255, 255, 0.15);
    --notif-font-ui:        "Inter", "SF Pro Text", system-ui, sans-serif;
    --notif-font-mono:      "SF Mono", "Fira Code", "Consolas", monospace;
    --notif-radius:         6px;
    --notif-shadow:         0 4px 24px rgba(0, 0, 0, 0.45), 0 1px 4px rgba(0, 0, 0, 0.2);
  }

  .notif-region {
    position: fixed;
    bottom: 28px;
    right: 24px;
    z-index: 99999;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    pointer-events: none;
    /* Width cap matches toast max-width so region doesn't block interaction */
    width: 380px;
  }

  .notif-toast {
    pointer-events: all;
    position: relative;
    min-width: 280px;
    max-width: 380px;
    border-radius: var(--notif-radius);
    box-shadow: var(--notif-shadow);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    overflow: hidden;
    animation: notif-enter 0.18s cubic-bezier(0.16, 1, 0.3, 1) both;
    font-family: var(--notif-font-ui);
  }

  .notif-toast__inner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 12px 13px 14px;
    border: 1px solid transparent;
    border-left-width: 4px;
    border-radius: var(--notif-radius);
  }

  /* Per-type color application */
  .notif-toast--success .notif-toast__inner {
    background: var(--notif-success-bg);
    border-color: var(--notif-success-border);
  }
  .notif-toast--warning .notif-toast__inner {
    background: var(--notif-warning-bg);
    border-color: var(--notif-warning-border);
  }
  .notif-toast--error .notif-toast__inner {
    background: var(--notif-error-bg);
    border-color: var(--notif-error-border);
  }
  .notif-toast--info .notif-toast__inner {
    background: var(--notif-info-bg);
    border-color: var(--notif-info-border);
  }

  .notif-toast__icon {
    flex-shrink: 0;
    margin-top: 1px;
    opacity: 0.9;
  }
  .notif-toast--success .notif-toast__icon { color: var(--notif-success); }
  .notif-toast--warning .notif-toast__icon { color: var(--notif-warning); }
  .notif-toast--error   .notif-toast__icon { color: var(--notif-error);   }
  .notif-toast--info    .notif-toast__icon { color: var(--notif-info);    }

  .notif-toast__body {
    flex: 1;
    min-width: 0;
  }

  .notif-toast__title {
    font-family: var(--notif-font-mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--notif-text);
    margin-bottom: 3px;
    line-height: 1.3;
  }

  .notif-toast__message {
    font-size: 12px;
    color: var(--notif-text);
    opacity: 0.88;
    line-height: 1.5;
    word-break: break-word;
  }

  .notif-toast__dismiss {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-top: -1px;
    margin-right: -2px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--notif-text-muted);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    padding: 0;
  }
  .notif-toast__dismiss:hover {
    background: var(--notif-dismiss-hover);
    color: var(--notif-text);
  }
  .notif-toast__dismiss:focus-visible {
    outline: 2px solid rgba(255,255,255,0.5);
    outline-offset: 1px;
  }

  /* Progress bar — sits at the bottom of the toast */
  .notif-toast__progress {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 2px;
    border-radius: 0 0 0 var(--notif-radius);
    transform-origin: left center;
    animation: notif-progress linear forwards;
  }
  .notif-toast--success .notif-toast__progress { background: var(--notif-success); }
  .notif-toast--warning .notif-toast__progress { background: var(--notif-warning); }
  .notif-toast--error   .notif-toast__progress { background: var(--notif-error);   }
  .notif-toast--info    .notif-toast__progress { background: var(--notif-info);    }

  @keyframes notif-enter {
    from { opacity: 0; transform: translateX(20px) scale(0.97); }
    to   { opacity: 1; transform: translateX(0)    scale(1);    }
  }

  @keyframes notif-progress {
    from { width: 100%; }
    to   { width: 0%;   }
  }

  @media (prefers-reduced-motion: reduce) {
    .notif-toast        { animation: none; }
    .notif-toast__progress { animation: none; display: none; }
  }

  @media (max-width: 440px) {
    .notif-region {
      left: 12px;
      right: 12px;
      bottom: 16px;
      width: auto;
    }
    .notif-toast { max-width: 100%; }
  }
`;

// ─── Context ──────────────────────────────────────────────────────────────────

const NotificationContext = createContext(null);

// ─── Toast component ──────────────────────────────────────────────────────────

function Toast({ toast, onDismiss }) {
  const cfg = TYPE_CONFIG[toast.type] ?? TYPE_CONFIG.info;
  const { Icon } = cfg;

  return (
    <div
      role="alert"
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`notif-toast notif-toast--${toast.type}`}
    >
      <div className="notif-toast__inner">
        <Icon className="notif-toast__icon" size={16} strokeWidth={2.2} />

        <div className="notif-toast__body">
          {toast.title && (
            <div className="notif-toast__title">{toast.title}</div>
          )}
          {toast.message && (
            <div className="notif-toast__message">{toast.message}</div>
          )}
        </div>

        <button
          className="notif-toast__dismiss"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
        >
          <X size={13} strokeWidth={2.5} />
        </button>
      </div>

      {/* Progress bar — duration injected as inline style so the CSS animation
          duration matches the actual auto-dismiss timeout exactly */}
      <div
        className="notif-toast__progress"
        style={{ animationDuration: `${toast.duration}ms` }}
        aria-hidden="true"
      />
    </div>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function NotificationProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers  = useRef({});
  const counter = useRef(0);

  // Inject stylesheet once on mount
  useEffect(() => {
    const id  = "notif-system-styles";
    if (document.getElementById(id)) return;
    const tag = document.createElement("style");
    tag.id        = id;
    tag.textContent = STYLES;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    ({ type = "info", title, message, duration }) => {
      const id  = ++counter.current;
      const dur = duration ?? DEFAULT_DURATION[type] ?? 4000;

      setToasts((prev) =>
        [...prev, { id, type, title, message, duration: dur }].slice(-MAX_TOASTS)
      );

      timers.current[id] = setTimeout(() => dismiss(id), dur);
      return id;
    },
    [dismiss]
  );

  return (
    <NotificationContext.Provider value={{ notify, dismiss }}>
      {children}

      <div
        className="notif-region"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be called within a <NotificationProvider>.");
  }
  return ctx;
}