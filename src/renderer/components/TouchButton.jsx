export function TouchButton({ children, className = '', ...props }) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-[72px] items-center justify-center rounded-2xl border border-white/15 bg-white/10 px-6 py-4 text-xl font-semibold tracking-wide text-white shadow-[0_10px_40px_rgba(0,0,0,0.35)] backdrop-blur-md transition active:scale-[0.98] ${className}`}
    >
      {children}
    </button>
  );
}
