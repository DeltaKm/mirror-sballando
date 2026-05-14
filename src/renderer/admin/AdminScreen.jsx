import { AdminLayout } from '../layouts/AdminLayout';
import { useSyncStatus } from '../hooks/useSyncStatus';
import { motion } from 'framer-motion';

const cards = [
  'Selezione evento',
  'Gestione webcam',
  'Gestione stampante',
  'Gestione upload',
  'Gestione template',
  'Configurazione countdown',
  'Configurazione suoni',
  'Monitor pending upload'
];

export function AdminScreen() {
  const sync = useSyncStatus();

  return (
    <AdminLayout>
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="rounded-3xl border border-white/10 bg-black/35 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.5)] backdrop-blur-xl"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-white/60">Mirror Sballando</p>
            <h1 className="mt-1 text-4xl font-black tracking-tight">Control Panel</h1>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold">
            Sync: <span className={sync.online ? 'text-emerald-300' : 'text-rose-300'}>{sync.online ? 'ONLINE' : 'OFFLINE'}</span>
            <span className="text-white/50"> | </span>
            Pending: <span className="text-white">{sync.pending}</span>
          </div>
        </div>
      </motion.header>

      <main className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <motion.section
            key={card}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-[0_10px_40px_rgba(0,0,0,0.45)] backdrop-blur-lg"
          >
            <h2 className="mb-2 text-xl font-bold tracking-tight">{card}</h2>
            <p className="text-sm text-white/60">Modulo base pronto per integrazione servizi.</p>
          </motion.section>
        ))}
      </main>

      <footer className="mt-auto">
        <button
          className="rounded-2xl border border-white/15 bg-white/10 px-7 py-4 text-lg font-semibold shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
          onClick={() => (window.location.hash = '#/')}
        >
          Torna al Kiosk
        </button>
      </footer>
    </AdminLayout>
  );
}
