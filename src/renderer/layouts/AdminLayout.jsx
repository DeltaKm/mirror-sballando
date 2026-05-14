import { motion } from 'framer-motion';

export function AdminLayout({ children }) {
  return (
    <div className="h-full w-full bg-stage text-white">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
        className="mx-auto flex h-full max-w-7xl flex-col gap-4 p-6"
      >
        {children}
      </motion.div>
    </div>
  );
}
