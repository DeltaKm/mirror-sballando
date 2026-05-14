import { KioskLayout } from '../layouts/KioskLayout';
import { TouchButton } from '../components/TouchButton';
import { motion } from 'framer-motion';

export function KioskScreen() {
  return (
    <KioskLayout>
      <div className="mx-auto flex h-full w-full max-w-[1200px] flex-col gap-5 p-5">
        <motion.header
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-white/60">Mirror Sballando</p>
              <h1 className="mt-1 text-4xl font-black tracking-tight">Photobooth Kiosk</h1>
            </div>
            <span className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-4 py-2 text-sm font-bold uppercase tracking-wider text-emerald-300">
              Kiosk mode
            </span>
          </div>
        </motion.header>

        <main className="grid flex-1 grid-cols-1 gap-5 lg:grid-cols-12">
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05 }}
            className="relative lg:col-span-8"
          >
            <div className="absolute inset-0 rounded-3xl bg-gradient-to-b from-[#ff51681a] to-transparent blur-2xl" />
            <div className="relative h-full min-h-[880px] rounded-3xl border border-white/10 bg-black/45 p-4 shadow-[0_30px_100px_rgba(0,0,0,0.55)] backdrop-blur-xl">
              <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/20 bg-black/50 text-center text-white/60">
                <div>
                  <p className="text-sm uppercase tracking-[0.22em]">Live mirror area</p>
                  <p className="mt-2 text-2xl font-semibold text-white/70">Preview Camera</p>
                </div>
              </div>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.12 }}
            className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-black/35 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl lg:col-span-4"
          >
            <p className="px-2 text-xs font-bold uppercase tracking-[0.22em] text-white/60">Control Panel</p>
            <TouchButton className="bg-gradient-to-r from-[#f43f5e] to-[#ef4444] text-white">Scatta foto</TouchButton>
            <TouchButton>Countdown</TouchButton>
            <TouchButton>Template</TouchButton>
            <TouchButton>Stampa</TouchButton>
            <TouchButton onClick={() => (window.location.hash = '#/admin')} className="mt-auto border-[#f43f5e66] bg-[#f43f5e22]">
              Apri Admin
            </TouchButton>
          </motion.section>
        </main>
      </div>
    </KioskLayout>
  );
}
