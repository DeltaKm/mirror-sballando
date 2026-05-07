import { motion } from 'framer-motion';

export function KioskLayout({ children }) {
  return (
    <div className="kiosk-premium-bg h-full w-full overflow-hidden text-white">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="relative flex h-full w-full flex-col"
      >
        {children}
      </motion.div>
    </div>
  );
}
