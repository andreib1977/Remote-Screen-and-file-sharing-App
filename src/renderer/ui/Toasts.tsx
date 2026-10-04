export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
  detail?: string;
}

/** Toasts auto-expire in App; clicking one dismisses it early. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.level}`} onClick={() => onDismiss(toast.id)}>
          <div className="toast__text">{toast.text}</div>
          {toast.detail && <div className="toast__detail">{toast.detail}</div>}
        </div>
      ))}
    </div>
  );
}
